// Content model: a *collection* is a set of printed images that can be scanned
// in one session. It lives in public/experiences/<id>/ as:
//
//   collection.json   – this manifest
//   targets.mind      – all item images compiled together (order = items order)
//   <item files>      – video + poster per item
//
// Keep collections focused (≲ 30 images): detection cost grows with the number
// of images in targets.mind. Use separate collections for separate campaigns.

export type Fit = "cover" | "contain" | "stretch";

export interface ExperienceItem {
  /** Stable id, used in analytics/logs. */
  id: string;
  title?: string;
  /** Video URL, relative to the collection folder. */
  video: string;
  /** Still of the video's first frame; shown instantly while the video loads. */
  poster?: string;
  /** Print image used to compile targets.mind, relative to content/<collection>/ (never deployed). */
  image?: string;
  /** How the video fills the printed image. Default "cover". */
  fit?: Fit;
  /** Default true. */
  loop?: boolean;
  /** Offer a "tap for sound" button. Default false (video plays muted). */
  audio?: boolean;
}

export interface TrackingConfig {
  /** Camera field of view across the long side of the frame, degrees (typical phones: 60–70). */
  cameraFov: number;
  /** Frames a target must be seen before the overlay appears. */
  warmupFrames: number;
  /** Frames a target may be missed before the overlay hides. */
  missFrames: number;
  /** Pose smoothing: lower = steadier when still, higher = less lag when moving. */
  smoothing: { minCutoff: number; beta: number; rotMinCutoff: number; rotBeta: number };
}

export interface PlaybackConfig {
  /** Keep playing this long after the image is lost (ms) so brief dropouts don't pause. */
  pauseAfterLostMs: number;
  /** Restart from the beginning if the image was gone this long (ms). */
  restartAfterLostMs: number;
  /** Max videos kept decoded at once (mobile browsers have few hardware decoders). */
  maxLoadedVideos: number;
}

export interface Collection {
  id: string;
  title?: string;
  targets: string;
  items: ExperienceItem[];
  tracking?: Partial<TrackingConfig>;
  playback?: Partial<PlaybackConfig>;
}

export interface ResolvedCollection extends Omit<Collection, "tracking" | "playback"> {
  baseUrl: string;
  tracking: TrackingConfig;
  playback: PlaybackConfig;
}

export const DEFAULT_TRACKING: TrackingConfig = {
  cameraFov: 63,
  warmupFrames: 3,
  missFrames: 6,
  // Tuned with tools/track-test.mjs (handheld + tremor scenarios, 4x CPU throttle).
  smoothing: { minCutoff: 1.2, beta: 20, rotMinCutoff: 1.0, rotBeta: 10 },
};

export const DEFAULT_PLAYBACK: PlaybackConfig = {
  pauseAfterLostMs: 1200,
  restartAfterLostMs: 4000,
  maxLoadedVideos: 3,
};

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const FITS: Fit[] = ["cover", "contain", "stretch"];

export class ContentError extends Error {}

export function collectionIdFromUrl(search: string, fallback: string): string {
  const id = new URLSearchParams(search).get("c") || fallback;
  if (!ID_PATTERN.test(id)) throw new ContentError(`Invalid collection id "${id}"`);
  return id;
}

export async function loadCollection(id: string, root = "experiences/"): Promise<ResolvedCollection> {
  const baseUrl = new URL(`${root}${id}/`, document.baseURI).href;
  let res: Response;
  try {
    res = await fetch(new URL("collection.json", baseUrl), { cache: "no-cache" });
  } catch {
    throw new ContentError("Network error while loading the experience.");
  }
  if (res.status === 404) throw new ContentError(`Experience "${id}" was not found.`);
  if (!res.ok) throw new ContentError(`Could not load experience (HTTP ${res.status}).`);
  const raw = (await res.json()) as Collection;
  return validateCollection(raw, baseUrl);
}

export function validateCollection(raw: Collection, baseUrl: string): ResolvedCollection {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") throw new ContentError("collection.json is not an object");
  if (typeof raw.targets !== "string" || !raw.targets) problems.push("`targets` must be a file name");
  if (!Array.isArray(raw.items) || raw.items.length === 0) problems.push("`items` must be a non-empty array");
  const seen = new Set<string>();
  (raw.items || []).forEach((item, i) => {
    const where = `items[${i}]`;
    if (!item || typeof item.id !== "string" || !ID_PATTERN.test(item.id)) problems.push(`${where}.id is missing or invalid`);
    else if (seen.has(item.id)) problems.push(`${where}.id "${item.id}" is duplicated`);
    else seen.add(item.id);
    if (typeof item?.video !== "string" || !item.video) problems.push(`${where}.video is required`);
    if (item?.fit && !FITS.includes(item.fit)) problems.push(`${where}.fit must be one of ${FITS.join(", ")}`);
  });
  if (problems.length) throw new ContentError(`collection.json is invalid:\n- ${problems.join("\n- ")}`);

  return {
    ...raw,
    baseUrl,
    tracking: {
      ...DEFAULT_TRACKING,
      ...raw.tracking,
      smoothing: { ...DEFAULT_TRACKING.smoothing, ...raw.tracking?.smoothing },
    },
    playback: { ...DEFAULT_PLAYBACK, ...raw.playback },
  };
}

export const resolveUrl = (collection: ResolvedCollection, path: string) => new URL(path, collection.baseUrl).href;
