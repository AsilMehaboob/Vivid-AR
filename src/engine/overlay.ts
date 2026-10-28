import {
  Group,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Texture,
  TextureLoader,
  VideoTexture,
  type IUniform,
} from "three";
import type { ExperienceItem, Fit, PlaybackConfig } from "../content";

// One overlay per printed image: a plane exactly the size of the print, showing
// a poster (the video's first frame) the instant the image is found, then
// cross-fading to the video once it is actually decoding frames. Because the
// poster matches the print and the video starts on that same frame, the photo
// appears to come alive with no flash or jump.

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D posterMap;
  uniform sampler2D videoMap;
  uniform vec4 posterUv;   // xy = scale, zw = offset
  uniform vec4 videoUv;
  uniform float hasPoster;
  uniform float mixAmount; // 0 = poster, 1 = video
  uniform float opacity;
  varying vec2 vUv;

  float inside(vec2 uv) {
    vec2 s = step(vec2(0.0), uv) * step(uv, vec2(1.0));
    return s.x * s.y;
  }

  void main() {
    vec2 pUv = vUv * posterUv.xy + posterUv.zw;
    vec2 vUv2 = vUv * videoUv.xy + videoUv.zw;
    vec4 poster = texture2D(posterMap, pUv);
    vec4 video = texture2D(videoMap, vUv2);
    float pA = hasPoster * inside(pUv);
    float vA = inside(vUv2);
    vec3 color = mix(poster.rgb, video.rgb, mixAmount);
    float a = mix(pA, vA, mixAmount);

    // Anti-aliased edge (~1 screen pixel) so the overlay blends into the print.
    vec2 fw = max(fwidth(vUv), vec2(1e-5));
    float edge = min(min(vUv.x, 1.0 - vUv.x) / fw.x, min(vUv.y, 1.0 - vUv.y) / fw.y);
    a *= clamp(edge, 0.0, 1.0) * opacity;

    gl_FragColor = vec4(color, a);
  }
`;

/** UV scale/offset so content of `contentAspect` fills a plane of `planeAspect` (both w/h). */
export function fitUv(fit: Fit, contentAspect: number, planeAspect: number): [number, number, number, number] {
  if (fit === "stretch" || !contentAspect || !planeAspect) return [1, 1, 0, 0];
  const contentWider = contentAspect > planeAspect;
  let sx = 1;
  let sy = 1;
  if (fit === "cover") {
    if (contentWider) sx = planeAspect / contentAspect;
    else sy = contentAspect / planeAspect;
  } else {
    if (contentWider) sy = contentAspect / planeAspect;
    else sx = planeAspect / contentAspect;
  }
  return [sx, sy, (1 - sx) / 2, (1 - sy) / 2];
}

const FADE_IN_S = 0.12;
const FADE_OUT_S = 0.18;
const CROSSFADE_S = 0.25;

const emptyTexture = new Texture();

export class VideoOverlay {
  readonly anchor = new Group();
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  visible = false;
  lastUsed = 0;

  private uniforms: Record<string, IUniform>;
  private video: HTMLVideoElement | null = null;
  private videoTexture: VideoTexture | null = null;
  private posterTexture: Texture | null = null;
  private posterRequested = false;
  private videoReady = false;
  private lostAt = 0;
  private targetMix = 0;
  private muted = true;

  constructor(
    readonly item: ExperienceItem,
    readonly index: number,
    private readonly urls: { video: string; poster?: string },
    /** Print aspect ratio, width / height. */
    readonly aspect: number,
    private readonly playback: PlaybackConfig,
  ) {
    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;
    this.uniforms = {
      posterMap: { value: emptyTexture },
      videoMap: { value: emptyTexture },
      posterUv: { value: [1, 1, 0, 0] },
      videoUv: { value: [1, 1, 0, 0] },
      hasPoster: { value: 0 },
      mixAmount: { value: 0 },
      opacity: { value: 0 },
    };
    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    // Plane is 1 unit wide = the print's width (the anchor is scaled to pixels).
    this.mesh = new Mesh(new PlaneGeometry(1, 1 / aspect), material);
    this.mesh.frustumCulled = false;
    this.anchor.add(this.mesh);
  }

  get hasVideoLoaded() {
    return !!this.video;
  }

  get wantsAudio() {
    return !!this.item.audio;
  }

  /** Start fetching the poster (small) ahead of time. */
  preloadPoster() {
    if (this.posterRequested || !this.urls.poster) return;
    this.posterRequested = true;
    new TextureLoader()
      .loadAsync(this.urls.poster)
      .then((texture) => {
        texture.generateMipmaps = false;
        texture.minFilter = LinearFilter;
        this.posterTexture = texture;
        const img = texture.image as HTMLImageElement;
        this.uniforms.posterMap.value = texture;
        this.uniforms.posterUv.value = fitUv(this.item.fit ?? "cover", img.width / img.height, this.aspect);
        this.uniforms.hasPoster.value = 1;
      })
      .catch(() => {
        // Without a poster the print itself shows until the video is ready.
        this.posterRequested = false;
      });
  }

  private loadVideo() {
    if (this.video) return;
    const video = document.createElement("video");
    video.muted = this.muted;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.crossOrigin = "anonymous";
    video.loop = this.item.loop !== false;
    video.preload = "auto";
    video.src = this.urls.video;
    video.addEventListener("loadedmetadata", () => {
      this.uniforms.videoUv.value = fitUv(this.item.fit ?? "cover", video.videoWidth / video.videoHeight, this.aspect);
    });
    video.addEventListener("error", () => {
      console.warn(`[vivid] video failed to load: ${this.urls.video}`);
      this.unloadVideo();
    });

    const texture = new VideoTexture(video);
    texture.generateMipmaps = false;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    this.video = video;
    this.videoTexture = texture;
    this.uniforms.videoMap.value = texture;
  }

  /** Release the decoder; mobile browsers only allow a few at once. */
  unloadVideo() {
    if (!this.video) return;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.videoTexture?.dispose();
    this.video = null;
    this.videoTexture = null;
    this.videoReady = false;
    this.targetMix = 0;
    this.uniforms.mixAmount.value = 0;
    this.uniforms.videoMap.value = emptyTexture;
  }

  /** Cross-fade to video only after a real frame has been decoded. */
  private waitForFrameThenShow() {
    const video = this.video;
    if (!video) return;
    const show = () => {
      if (this.video !== video) return;
      this.videoReady = true;
      this.targetMix = 1;
    };
    if ("requestVideoFrameCallback" in video) {
      video.requestVideoFrameCallback(() => show());
    } else {
      const v = video as HTMLVideoElement;
      const onTime = () => {
        if (v.currentTime > 0) {
          v.removeEventListener("timeupdate", onTime);
          show();
        }
      };
      v.addEventListener("timeupdate", onTime);
    }
  }

  found(now: number) {
    const lostFor = this.lostAt ? now - this.lostAt : Infinity;
    this.visible = true;
    this.anchor.visible = true;
    this.lastUsed = now;
    this.preloadPoster();
    this.loadVideo();
    const video = this.video!;

    const restart = lostFor > this.playback.restartAfterLostMs || video.ended;
    if (restart && video.currentTime > 0) {
      // Show the poster while seeking back so the old frame never flashes.
      this.videoReady = false;
      this.targetMix = 0;
      this.uniforms.mixAmount.value = 0;
      video.currentTime = 0;
    }
    if (video.paused || !this.videoReady) {
      video
        .play()
        .then(() => this.waitForFrameThenShow())
        .catch(() => {
          // Autoplay refused (rare for muted inline video): keep the poster up.
        });
    }
  }

  lost(now: number) {
    this.visible = false;
    this.lostAt = now;
    this.lastUsed = now;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.video) this.video.muted = muted;
  }

  /** Per render frame: fades and pause timing. */
  tick(now: number, dt: number) {
    const u = this.uniforms;
    const targetOpacity = this.visible ? 1 : 0;
    const fade = dt / (this.visible ? FADE_IN_S : FADE_OUT_S);
    u.opacity.value = approach(u.opacity.value as number, targetOpacity, fade);
    u.mixAmount.value = approach(u.mixAmount.value as number, this.targetMix, dt / CROSSFADE_S);
    if (!this.visible && u.opacity.value === 0) this.anchor.visible = false;

    if (!this.visible && this.video && !this.video.paused && now - this.lostAt > this.playback.pauseAfterLostMs) {
      this.video.pause();
    }
  }

  /** Used by the dev test harness. */
  get planeHalfSize(): [number, number] {
    return [0.5, 0.5 / this.aspect];
  }

  dispose() {
    this.unloadVideo();
    this.posterTexture?.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

const approach = (value: number, target: number, step: number) =>
  value < target ? Math.min(target, value + step) : Math.max(target, value - step);
