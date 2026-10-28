import "./styles.css";
import { collectionIdFromUrl, ContentError, loadCollection, resolveUrl, type ResolvedCollection } from "./content";
import { Camera, CameraError } from "./engine/camera";
import type { ArEngine } from "./engine/engine";

const DEFAULT_COLLECTION = import.meta.env.VITE_DEFAULT_COLLECTION || "default";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  stage: $("stage"),
  intro: $("intro"),
  introTitle: $("introTitle"),
  start: $<HTMLButtonElement>("startButton"),
  status: $("status"),
  statusText: $("statusText"),
  error: $("error"),
  errorTitle: $("errorTitle"),
  errorText: $("errorText"),
  retry: $<HTMLButtonElement>("retryButton"),
  scanHint: $("scanHint"),
  sound: $<HTMLButtonElement>("soundButton"),
};

type Screen = "intro" | "status" | "error" | "ar";
const show = (screen: Screen) => {
  ui.intro.hidden = screen !== "intro";
  ui.status.hidden = screen !== "status";
  ui.error.hidden = screen !== "error";
  if (screen !== "ar") {
    ui.scanHint.hidden = true;
    ui.sound.hidden = true;
  }
};
const setStatus = (text: string) => {
  ui.statusText.textContent = text;
  show("status");
};

let retryAction: () => void = () => location.reload();
const showError = (title: string, text: string, retryLabel = "Try again", onRetry = () => location.reload()) => {
  ui.errorTitle.textContent = title;
  ui.errorText.textContent = text;
  ui.retry.textContent = retryLabel;
  retryAction = onRetry;
  show("error");
};
ui.retry.addEventListener("click", () => retryAction());

const cameraErrorCopy = (error: CameraError): [string, string] => {
  switch (error.kind) {
    case "denied":
      return [
        "Camera access needed",
        "Allow camera access for this site in your browser settings, then try again.",
      ];
    case "insecure":
      return ["Secure connection needed", "Open this page with https:// to use the camera."];
    case "unsupported":
      return ["Browser not supported", "Open this page in Safari (iPhone) or Chrome (Android)."];
    case "not-found":
      return ["No camera found", "This experience needs a device with a rear camera."];
    case "busy":
      return ["Camera is busy", "Close other apps that are using the camera, then try again."];
    default:
      return ["Camera problem", error.message];
  }
};

// Start downloading the heavy AR engine (tracking + 3D) while the user reads
// the intro; the first paint only needs this small file.
const engineModule = import("./engine/engine");
const camera = new Camera();
let engine: ArEngine | null = null;
let collection: ResolvedCollection | null = null;
let targetsBuffer: Promise<ArrayBuffer> | null = null;
let wantsRunning = false;
let soundOn = false;
let syncCamera = true;

async function boot() {
  // Dev only: ?sim swaps the camera for tools/sim-camera.js (stripped from production builds).
  const sim = import.meta.env.DEV && new URLSearchParams(location.search).has("sim");
  if (sim) await loadScript("/tools/sim-camera.js");

  try {
    setStatus("Loading…");
    collection = await loadCollection(collectionIdFromUrl(location.search, DEFAULT_COLLECTION));
    if (import.meta.env.DEV) applyDevOverrides(collection);
    targetsBuffer = fetchTargets(collection);
    targetsBuffer.catch(() => undefined); // surfaced later in startAr()
    if (collection.title) {
      document.title = collection.title;
      ui.introTitle.textContent = collection.title;
    }
  } catch (error) {
    report(error);
    return;
  }

  // Skip the intro for returning visitors who already allowed the camera.
  if (sim || (await cameraAlreadyAllowed())) startAr();
  else show("intro");
}

async function fetchTargets(c: ResolvedCollection): Promise<ArrayBuffer> {
  const res = await fetch(resolveUrl(c, c.targets));
  if (!res.ok) throw new ContentError(`Could not load the image targets (HTTP ${res.status}).`);
  return res.arrayBuffer();
}

async function cameraAlreadyAllowed() {
  try {
    const status = await navigator.permissions?.query({ name: "camera" as PermissionName });
    return status?.state === "granted";
  } catch {
    return false;
  }
}

let starting = false;
async function startAr() {
  if (starting || !collection || !targetsBuffer) return;
  starting = true;
  wantsRunning = true;
  try {
    setStatus("Starting camera…");
    const [{ ArEngine }] = await Promise.all([engineModule, camera.start()]);

    setStatus("Preparing AR…");
    if (!engine) {
      engine = new ArEngine(ui.stage, collection, camera, {
        onFound: (overlay) => {
          ui.scanHint.hidden = true;
          ui.sound.hidden = !overlay.wantsAudio;
        },
        onLost: () => {
          if (!engine?.activeOverlay) {
            ui.scanHint.hidden = false;
            ui.sound.hidden = true;
          }
        },
        onContextLost: () =>
          showError("Display was interrupted", "Your browser reset the graphics. Reload to continue.", "Reload"),
      }, { syncCamera });
      engine.load(await targetsBuffer);
      exposeDebugHooks();
    }
    await engine.start();
    show("ar");
    ui.scanHint.hidden = !!engine.activeOverlay;
  } catch (error) {
    wantsRunning = false;
    camera.stop();
    report(error);
  } finally {
    starting = false;
  }
}

function report(error: unknown) {
  console.error("[vivid]", error);
  if (error instanceof CameraError) {
    const [title, text] = cameraErrorCopy(error);
    showError(title, text, "Try again", () => startAr());
  } else if (error instanceof ContentError) {
    showError("Experience unavailable", error.message);
  } else if (isWebGLError(error)) {
    showError("Device not supported", "This device's browser can't run the 3D view. Try a newer browser.");
  } else {
    showError("Something went wrong", "Please check your connection and try again.");
  }
}

const isWebGLError = (error: unknown) => /webgl|context/i.test((error as Error)?.message ?? "");

ui.start.addEventListener("click", () => startAr());

ui.sound.addEventListener("click", () => {
  soundOn = !soundOn;
  engine?.setMuted(!soundOn);
  ui.sound.textContent = soundOn ? "Sound on" : "Tap for sound";
  ui.sound.setAttribute("aria-pressed", String(soundOn));
});

// Release the camera in the background (battery, privacy, other apps) and
// resume when the user comes back.
document.addEventListener("visibilitychange", () => {
  if (!engine) return;
  if (document.hidden) {
    engine.pause();
    camera.stop();
  } else if (wantsRunning && !starting) {
    startAr();
  }
});
window.addEventListener("pagehide", () => camera.stop());

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// Dev only: ?smooth=minCutoff,beta,rotMinCutoff,rotBeta  &sync=0  &fov=deg  &warmup=N &miss=N
function applyDevOverrides(c: ResolvedCollection) {
  const p = new URLSearchParams(location.search);
  const smooth = p.get("smooth")?.split(",").map(Number);
  if (smooth?.length === 4) {
    const [minCutoff, beta, rotMinCutoff, rotBeta] = smooth;
    c.tracking.smoothing = { minCutoff, beta, rotMinCutoff, rotBeta };
  }
  if (p.has("fov")) c.tracking.cameraFov = Number(p.get("fov"));
  if (p.has("warmup")) c.tracking.warmupFrames = Number(p.get("warmup"));
  if (p.has("miss")) c.tracking.missFrames = Number(p.get("miss"));
  if (p.get("sync") === "0") syncCamera = false;
}

function exposeDebugHooks() {
  if (!import.meta.env.DEV) return;
  Object.assign(window, { __engine: engine, __overlayCorners: () => engine?.debugCorners() ?? null });
  const slow = new URLSearchParams(location.search).get("slowtrack");
  if (engine && slow) engine.devTrackDelayMs = Number(slow);
}

boot();
