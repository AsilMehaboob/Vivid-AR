export type CameraErrorKind = "insecure" | "unsupported" | "denied" | "not-found" | "busy" | "unknown";

export class CameraError extends Error {
  constructor(
    readonly kind: CameraErrorKind,
    message: string,
  ) {
    super(message);
  }
}

// 720p is the sweet spot: enough detail for stable tracking at arm's length,
// cheap enough to track at camera rate on mid-range phones.
const ATTEMPTS: MediaStreamConstraints[] = [
  {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  },
  { audio: false, video: { facingMode: { ideal: "environment" } } },
  { audio: false, video: true },
];

const toCameraError = (error: unknown): CameraError => {
  const name = (error as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return new CameraError("denied", "Camera access was blocked.");
    case "NotFoundError":
    case "DevicesNotFoundError":
      return new CameraError("not-found", "No camera was found on this device.");
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return new CameraError("busy", "The camera is being used by another app.");
    default:
      return new CameraError("unknown", (error as Error)?.message || "The camera could not be started.");
  }
};

export class Camera {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;

  constructor() {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute("playsinline", "");
    this.video.setAttribute("muted", "");
    this.video.autoplay = true;
  }

  get width() {
    return this.video.videoWidth;
  }

  get height() {
    return this.video.videoHeight;
  }

  get running() {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === "live");
  }

  async start(): Promise<void> {
    if (!window.isSecureContext) throw new CameraError("insecure", "The camera needs a secure (https://) connection.");
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError("unsupported", "This browser cannot use the camera.");
    }
    this.stop();

    let lastError: unknown = null;
    for (const constraints of ATTEMPTS) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (error) {
        lastError = error;
        const name = (error as { name?: string })?.name;
        // Only fall back to looser constraints when the device can't satisfy them.
        if (name !== "OverconstrainedError" && name !== "ConstraintNotSatisfiedError") break;
      }
    }
    if (!this.stream) throw toCameraError(lastError);

    this.video.srcObject = this.stream;
    await new Promise<void>((resolve, reject) => {
      const done = () => (this.video.videoWidth ? resolve() : undefined);
      this.video.addEventListener("loadedmetadata", done, { once: true });
      this.video.addEventListener("resize", done);
      setTimeout(() => reject(new CameraError("unknown", "The camera did not start in time.")), 10000);
      done();
    });
    // MindAR reads the element's width/height attributes when given the video directly.
    this.video.width = this.video.videoWidth;
    this.video.height = this.video.videoHeight;
    await this.video.play().catch(() => undefined);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
