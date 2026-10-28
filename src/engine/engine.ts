import {
  Camera as ThreeCamera,
  CanvasTexture,
  LinearFilter,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShaderMaterial,
  Texture,
  Vector3,
  VideoTexture,
  WebGLRenderer,
} from "three";
import { Controller, type ControllerEvent } from "../vendor/mindar/mindar-image.prod.js";
import { ContentError, resolveUrl, type ResolvedCollection } from "../content";
import type { Camera } from "./camera";
import { VideoOverlay } from "./overlay";
import { PoseFilter } from "./pose-filter";

export interface EngineEvents {
  onFound?: (overlay: VideoOverlay) => void;
  onLost?: (overlay: VideoOverlay) => void;
  onContextLost?: () => void;
}

export interface EngineOptions {
  /**
   * Show exactly the camera frame the tracker analysed (default). The overlay
   * then sits on the print with zero lag, at the cost of the camera feed
   * updating at tracking rate instead of camera rate.
   */
  syncCamera: boolean;
}

interface TargetSlot {
  overlay: VideoOverlay;
  filter: PoseFilter;
  /** Converts MindAR's pixel-space marker pose to a centred, width-scaled anchor. */
  post: Matrix4;
  markerWidth: number;
  /** Consecutive rejected samples. */
  outliers: number;
}

// A frame-to-frame jump larger than this (fraction of the distance to the
// print, ≈ fraction of the screen) or rotation (radians) is treated as a glitch.
const OUTLIER_JUMP = 0.35;
const OUTLIER_ANGLE = (35 * Math.PI) / 180;
const MAX_OUTLIER_FRAMES = 2;

const bgVertex = /* glsl */ `
  uniform vec4 uvTransform;
  varying vec2 vUv;
  void main() {
    vUv = uv * uvTransform.xy + uvTransform.zw;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const bgFragment = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0); }
`;

export class ArEngine {
  readonly renderer: WebGLRenderer;
  readonly slots: TargetSlot[] = [];
  private readonly scene = new Scene();
  private readonly arCamera = new ThreeCamera();
  private readonly bgScene = new Scene();
  private readonly bgCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bgMaterial: ShaderMaterial;
  private bgTexture: Texture | null = null;

  private controller: Controller | null = null;
  private targetsBuffer: ArrayBuffer | null = null;
  private dimensions: [number, number][] = [];
  private trackCanvas = document.createElement("canvas");
  private trackCtx: CanvasRenderingContext2D;
  private frameTime = 0;
  private pending = new Map<number, number[] | null>();

  private raf = 0;
  private lastRender = 0;
  private resizeObserver: ResizeObserver;
  private projection = new Matrix4();
  private coverScale = 1;
  private muted = true;
  private running = false;
  /** Dev only (?slowtrack=ms). */
  devTrackDelayMs = 0;

  // Scratch objects (avoid per-frame allocation).
  private readonly m = new Matrix4();
  private readonly p = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();

  constructor(
    private readonly container: HTMLElement,
    private readonly collection: ResolvedCollection,
    private readonly camera: Camera,
    private readonly events: EngineEvents = {},
    private readonly options: EngineOptions = { syncCamera: true },
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    // Pass colours straight through: the video and camera pixels are shown
    // exactly as decoded, so the overlay matches the print's colours.
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.autoClear = false;
    const canvas = this.renderer.domElement;
    canvas.className = "ar-canvas";
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.events.onContextLost?.();
    });
    container.appendChild(canvas);

    this.trackCtx = this.trackCanvas.getContext("2d", { alpha: false, desynchronized: true })!;

    this.bgMaterial = new ShaderMaterial({
      uniforms: { map: { value: null }, uvTransform: { value: [1, 1, 0, 0] } },
      vertexShader: bgVertex,
      fragmentShader: bgFragment,
      depthTest: false,
      depthWrite: false,
    });
    const bg = new Mesh(new PlaneGeometry(2, 2), this.bgMaterial);
    bg.frustumCulled = false;
    this.bgScene.add(bg);
    this.arCamera.matrixAutoUpdate = false;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
  }

  /** Parse targets and build one overlay per item. Call once. */
  load(targetsBuffer: ArrayBuffer) {
    this.targetsBuffer = targetsBuffer;
    const { items, playback, tracking } = this.collection;
    // A throwaway controller just to read the file's target dimensions.
    const probe = new Controller({ inputWidth: 64, inputHeight: 64 });
    try {
      this.dimensions = probe.addImageTargetsFromBuffer(targetsBuffer).dimensions;
    } catch {
      throw new ContentError("targets.mind is corrupt or from an unsupported MindAR version.");
    } finally {
      probe.dispose();
    }
    if (this.dimensions.length !== items.length) {
      throw new ContentError(
        `targets.mind has ${this.dimensions.length} image(s) but collection.json lists ${items.length}. Recompile the targets.`,
      );
    }

    items.forEach((item, i) => {
      const [w, h] = this.dimensions[i];
      const overlay = new VideoOverlay(
        item,
        i,
        { video: resolveUrl(this.collection, item.video), poster: item.poster && resolveUrl(this.collection, item.poster) },
        w / h,
        playback,
      );
      overlay.setMuted(this.muted);
      // Same convention as MindAR's three.js wrapper: origin at the print's
      // centre, 1 unit = print width.
      const post = new Matrix4().compose(new Vector3(w / 2, w / 2 + (h - w) / 2, 0), new Quaternion(), new Vector3(w, w, w));
      this.slots.push({ overlay, filter: new PoseFilter(tracking.smoothing), post, markerWidth: w, outliers: 0 });
      this.scene.add(overlay.anchor);
    });

    // Posters are tiny; fetch them up front for small collections so the
    // first detection is instant. Larger collections load on demand.
    if (items.length <= 12) this.slots.forEach((s) => s.overlay.preloadPoster());
  }

  /** Builds the tracker for the current camera size and warms up the GPU. */
  async start() {
    if (!this.targetsBuffer) throw new Error("load() first");
    this.stopTracking();
    const { width, height } = this.camera;
    this.trackCanvas.width = width;
    this.trackCanvas.height = height;
    this.trackCtx.drawImage(this.camera.video, 0, 0);
    this.frameTime = performance.now();

    const { tracking } = this.collection;
    this.controller = new Controller({
      inputWidth: width,
      inputHeight: height,
      maxTrack: 1,
      warmupTolerance: tracking.warmupFrames,
      missTolerance: tracking.missFrames,
      // Disable MindAR's per-matrix-element filter; PoseFilter does it properly.
      filterMinCF: 1e9,
      filterBeta: 0,
      onUpdate: (e) => this.onTrackerEvent(e),
    });
    // MindAR assumes a 45° field of view across the frame *height*, which is
    // far narrower than real phone cameras in portrait and differs between
    // portrait and landscape. A wrong lens model makes the overlay drift off
    // the print's corners whenever the phone is tilted, so use a realistic one.
    const f = Math.max(width, height) / 2 / Math.tan((tracking.cameraFov * Math.PI) / 360);
    const K = [
      [f, 0, width / 2],
      [0, f, height / 2],
      [0, 0, 1],
    ];
    this.controller.projectionTransform = K;
    this.controller.projectionMatrix = this.controller._glProjectionMatrix({
      projectionTransform: K,
      width,
      height,
      near: 10,
      far: 100000,
    });
    this.controller.addImageTargetsFromBuffer(this.targetsBuffer);

    if (this.options.syncCamera) {
      const tex = new CanvasTexture(this.trackCanvas);
      this.setBackground(tex);
    } else {
      this.setBackground(new VideoTexture(this.camera.video));
    }
    this.resize();

    // First run compiles GPU kernels (can take a second on phones).
    await new Promise((r) => setTimeout(r, 0));
    this.controller.dummyRun(this.trackCanvas);

    this.running = true;
    this.controller.processVideo(this.options.syncCamera ? this.trackCanvas : this.camera.video);
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  private setBackground(tex: Texture) {
    this.bgTexture?.dispose();
    tex.generateMipmaps = false;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    this.bgTexture = tex;
    this.bgMaterial.uniforms.map.value = tex;
  }

  private onTrackerEvent(e: ControllerEvent) {
    if (e.type === "updateMatrix") {
      this.pending.set(e.targetIndex, e.worldMatrix);
      return;
    }
    // processDone: the tracker finished the frame in trackCanvas.
    if (import.meta.env.DEV && this.devTrackDelayMs) {
      // Simulate a slow phone: tracking results arrive later than the camera frame.
      const until = performance.now() + this.devTrackDelayMs;
      while (performance.now() < until);
    }
    const now = performance.now();
    const t = this.frameTime / 1000;
    for (const [index, world] of this.pending) this.applyPose(index, world, t, now);
    this.pending.clear();

    if (this.options.syncCamera && this.bgTexture) {
      // Upload the analysed frame *now*, before it is overwritten, so the
      // background and the poses always describe the same instant.
      this.bgTexture.needsUpdate = true;
      this.renderer.initTexture(this.bgTexture);
    }

    // Phone rotated: the stream's dimensions swap and the tracker must be rebuilt.
    if (this.camera.width && (this.camera.width !== this.trackCanvas.width || this.camera.height !== this.trackCanvas.height)) {
      this.start().catch((err) => console.error("[vivid] tracker restart failed", err));
      return;
    }
    if (this.options.syncCamera) {
      this.trackCtx.drawImage(this.camera.video, 0, 0);
      this.frameTime = performance.now();
    }
  }

  private applyPose(index: number, world: number[] | null, t: number, now: number) {
    const slot = this.slots[index];
    if (!slot) return;
    const { overlay, filter, post, markerWidth } = slot;
    if (!world) {
      if (overlay.visible) {
        overlay.lost(now);
        this.events.onLost?.(overlay);
      }
      return;
    }
    this.m.fromArray(world).multiply(post);
    this.m.decompose(this.p, this.q, this.s);
    this.p.divideScalar(markerWidth);
    if (!overlay.visible) {
      filter.reset();
      slot.outliers = 0;
    } else if (this.isOutlier(slot)) {
      // Ignore a one-off wild pose (seen as a sudden jump); accept it only if it persists.
      if (++slot.outliers <= MAX_OUTLIER_FRAMES) return;
      filter.reset();
    }
    slot.outliers = 0;
    filter.update(t, this.p, this.q);
    this.p.copy(filter.position).multiplyScalar(markerWidth);
    overlay.anchor.matrix.compose(this.p, filter.rotation, this.s);
    overlay.anchor.matrixWorldNeedsUpdate = true;

    if (!overlay.visible) {
      overlay.found(now);
      this.unloadIdleVideos();
      this.events.onFound?.(overlay);
    }
  }

  /** A pose that moved implausibly far from the smoothed one in a single frame. */
  private isOutlier({ filter }: TargetSlot) {
    // Distance in print widths relative to depth (≈ fraction of the view), and rotation.
    const depth = Math.max(Math.abs(filter.position.z), 1e-3);
    const jump = this.p.distanceTo(filter.position) / depth;
    return jump > OUTLIER_JUMP || filter.rotation.angleTo(this.q) > OUTLIER_ANGLE;
  }

  /** Keep at most N decoders alive (least recently used are released). */
  private unloadIdleVideos() {
    const loaded = this.slots
      .map((s) => s.overlay)
      .filter((o) => o.hasVideoLoaded && !o.visible)
      .sort((a, b) => b.lastUsed - a.lastUsed);
    const keep = Math.max(0, this.collection.playback.maxLoadedVideos - 1);
    loaded.slice(keep).forEach((o) => o.unloadVideo());
  }

  private loop = (time: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.lastRender ? Math.min((time - this.lastRender) / 1000, 0.1) : 0;
    this.lastRender = time;
    const now = performance.now();
    for (const slot of this.slots) slot.overlay.tick(now, dt);
    this.renderer.clear();
    this.renderer.render(this.bgScene, this.bgCamera);
    this.renderer.render(this.scene, this.arCamera);
  };

  resize() {
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    if (!cw || !ch) return;
    this.renderer.setSize(cw, ch, false);
    const W = this.trackCanvas.width || this.camera.width;
    const H = this.trackCanvas.height || this.camera.height;
    if (!W || !H || !this.controller) return;

    // Camera frame fills the screen like CSS object-fit: cover.
    const s = Math.max(cw / W, ch / H);
    this.coverScale = s;
    const sx = (W * s) / cw;
    const sy = (H * s) / ch;
    this.bgMaterial.uniforms.uvTransform.value = [1 / sx, 1 / sy, (1 - 1 / sx) / 2, (1 - 1 / sy) / 2];

    // MindAR's projection covers the whole camera frame; zoom it by the same
    // crop so 3D content lines up with the cropped background exactly.
    this.projection.fromArray(this.controller.getProjectionMatrix());
    this.projection.premultiply(new Matrix4().makeScale(sx, sy, 1));
    this.arCamera.projectionMatrix.copy(this.projection);
    this.arCamera.projectionMatrixInverse.copy(this.projection).invert();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.slots.forEach((s) => s.overlay.setMuted(muted));
  }

  get activeOverlay(): VideoOverlay | null {
    return this.slots.find((s) => s.overlay.visible)?.overlay ?? null;
  }

  private stopTracking() {
    this.running = false;
    if (this.controller) {
      this.controller.stopProcessVideo();
      this.controller.dispose();
      this.controller = null;
    }
    this.pending.clear();
  }

  /** Pause everything (e.g. tab hidden). Call start() to resume. */
  pause() {
    this.stopTracking();
    const now = performance.now();
    for (const { overlay } of this.slots) {
      if (overlay.visible) overlay.lost(now - this.collection.playback.restartAfterLostMs);
    }
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get isRunning() {
    return this.running;
  }

  dispose() {
    this.pause();
    this.resizeObserver.disconnect();
    this.slots.forEach((s) => s.overlay.dispose());
    this.bgTexture?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** Dev/test only: screen-space corners of the visible overlay vs the true print corners. */
  debugCorners(): { drawn: number[][]; truth: number[][] } | null {
    const sim = (window as unknown as { __sim?: { cornersShownIn(src: CanvasImageSource): number[][] | null } }).__sim;
    const slot = this.slots.find((s) => s.overlay.visible);
    if (!sim || !slot) return null;
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    const [hw, hh] = slot.overlay.planeHalfSize;
    const v = new Vector3();
    const drawn = [
      [-hw, hh],
      [hw, hh],
      [hw, -hh],
      [-hw, -hh],
    ].map(([x, y]) => {
      v.set(x, y, 0).applyMatrix4(slot.overlay.anchor.matrix).applyMatrix4(this.projection);
      return [((v.x + 1) / 2) * cw, ((1 - v.y) / 2) * ch];
    });
    const source = this.options.syncCamera ? this.debugFrame() : this.camera.video;
    const shown = sim.cornersShownIn(source);
    if (!shown) return null;
    const W = this.trackCanvas.width;
    const H = this.trackCanvas.height;
    const s = this.coverScale;
    const truth = shown.map(([x, y]) => [cw / 2 + (x - W / 2) * s, ch / 2 + (y - H / 2) * s]);
    return { drawn, truth };
  }

  // In sync mode the on-screen frame lives only in the GPU texture; keep a CPU
  // copy for the test harness (dev only, created lazily).
  private debugCanvas: HTMLCanvasElement | null = null;
  private debugFrame() {
    if (!this.debugCanvas) {
      this.debugCanvas = document.createElement("canvas");
      const original = this.onTrackerEvent.bind(this);
      this.onTrackerEvent = (e) => {
        if (e.type === "processDone" && this.debugCanvas) {
          this.debugCanvas.width = this.trackCanvas.width;
          this.debugCanvas.height = this.trackCanvas.height;
          this.debugCanvas.getContext("2d")!.drawImage(this.trackCanvas, 0, 0);
        }
        original(e);
      };
    }
    return this.debugCanvas;
  }
}
