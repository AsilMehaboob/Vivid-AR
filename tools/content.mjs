#!/usr/bin/env node
// Content pipeline for Vivid AR collections.
//
//   npm run content -- add <collection> <id> --image print.jpg --video clip.mp4
//                      [--title "…"] [--fit cover|contain|stretch] [--audio] [--no-loop]
//   npm run content -- build <collection>      recompile targets.mind, make missing posters
//   npm run content -- optimize <collection>   re-encode videos for fast mobile playback
//                      (skips videos it already encoded; [--force] [--crf 20])
//   npm run content -- check [collection]      validate collections (runs before `npm run build`)
//
// Layout:
//   content/<collection>/<id>.jpg                print images (source only, not deployed)
//   public/experiences/<collection>/collection.json
//   public/experiences/<collection>/targets.mind
//   public/experiences/<collection>/<id>/video.mp4 + poster.webp
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { decode } from "@msgpack/msgpack";
import { validateCollection } from "../src/content.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public", "experiences");
const sourceDir = path.join(root, "content");
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

// Budgets that keep first detection fast on mobile data. Exceeding them warns.
const BUDGET = { video: 4 * 1024 * 1024, poster: 300 * 1024, mind: 1.5 * 1024 * 1024, itemsPerCollection: 30 };
// Long side of the image used for compiling. Larger adds download size and
// detection time without improving tracking (the print rarely covers more
// than ~1000 camera pixels).
const TARGET_MAX_SIDE = 1280;
const VIDEO_MAX_SIDE = 1280;
// Marks videos this tool produced, so `optimize` doesn't re-encode (and degrade) them.
const ENCODED_TAG = "vivid-ar-encoded";

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith("--no-")) flags[a.slice(5)] = false;
  else if (a.startsWith("--")) flags[a.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  else positional.push(a);
}

const log = (...m) => console.log(...m);
const tempFile = (ext) => path.join(os.tmpdir(), `vivid-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`);
const kb = (n) => `${Math.round(n / 1024)} KB`;
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error(`${path.basename(bin)} failed:\n${err.slice(-1500)}`))));
  });
}
const ffmpeg = (args) => run(ffmpegPath, ["-hide_banner", "-y", ...args]);

async function probe(file) {
  // ffmpeg prints stream info to stderr and exits non-zero without an output; that's expected.
  const out = await run(ffmpegPath, ["-hide_banner", "-i", file]).catch((e) => e.message);
  const v = out.match(/Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})/);
  const d = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return {
    codec: v?.[1],
    width: Number(v?.[2]),
    height: Number(v?.[3]),
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    hasAudio: /Audio: /.test(out),
    encodedByUs: out.includes(ENCODED_TAG),
  };
}

const scaleFilter = (max) =>
  `scale=w='if(gte(iw,ih),min(${max},iw),-2)':h='if(gte(iw,ih),-2,min(${max},ih))':flags=lanczos`;

/** H.264 Main, BT.709-tagged, fast-start: plays instantly on every mobile browser. */
async function encodeVideo(input, output, { audio }) {
  // Work outside public/ so a running dev server never watches half-written files.
  const tmp = tempFile(".mp4");
  await ffmpeg([
    "-i", input,
    "-map", "0:v:0",
    ...(audio ? ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "96k", "-ac", "2"] : ["-an"]),
    "-vf", `${scaleFilter(VIDEO_MAX_SIDE)},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`,
    "-fpsmax", "30",
    "-c:v", "libx264", "-profile:v", "main", "-level:v", "4.0", "-preset", "slow",
    // CRF 20 measured SSIM ≈ 0.965 vs source at ~5x smaller; override with --crf.
    "-crf", String(flags.crf ?? 20), "-maxrate", "4000k", "-bufsize", "8000k",
    "-g", "60", "-keyint_min", "30",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-movflags", "+faststart", "-tag:v", "avc1",
    "-metadata", `comment=${ENCODED_TAG}`,
    tmp,
  ]);
  await replaceFile(tmp, output);
}

// Windows refuses to rename over a file another process has open (a dev
// server or browser streaming the video), so retry, then copy over it.
async function replaceFile(from, to) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await rename(from, to);
    } catch (e) {
      if (e.code === "EXDEV") break; // temp dir on another drive: copy instead
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  await copyFile(from, to);
  await rm(from, { force: true });
}

/** Poster = the encoded video's exact first frame, so the poster→video switch is invisible. */
async function makePoster(video, output) {
  await ffmpeg([
    "-i", video, "-frames:v", "1",
    "-vf", "scale=in_color_matrix=bt709:in_range=tv,format=rgb24",
    "-c:v", "libwebp", "-quality", "86", "-compression_level", "6",
    output,
  ]);
}

async function prepareTargetImage(input, output) {
  await ffmpeg(["-i", input, "-frames:v", "1", "-vf", scaleFilter(TARGET_MAX_SIDE), "-q:v", "2", output]);
}

const collectionDir = (c) => path.join(publicDir, c);
const manifestPath = (c) => path.join(collectionDir(c), "collection.json");

async function readManifest(c) {
  if (!existsSync(manifestPath(c))) return null;
  return JSON.parse(await readFile(manifestPath(c), "utf8"));
}
async function writeManifest(c, manifest) {
  await writeFile(manifestPath(c), `${JSON.stringify(manifest, null, 2)}\n`);
}

function requireCollectionId(c) {
  if (!c || !ID.test(c)) fail("Give a collection id (letters, digits, - or _).");
  return c;
}

// ---------------------------------------------------------------- compile

async function compileTargets(c, manifest) {
  const images = manifest.items.map((item) => {
    const file = item.image && path.join(sourceDir, c, item.image);
    if (!file || !existsSync(file)) {
      fail(
        `Item "${item.id}" has no source image (expected content/${c}/${item.image ?? `${item.id}.jpg`}).\n` +
          `  Add the print image there and set "image" in collection.json, then run build again.`,
      );
    }
    return `/content/${c}/${item.image}`;
  });

  log(`Compiling ${images.length} target image(s)…`);
  const { createServer } = await import("vite");
  const { launchBrowser } = await import("./lib/browser.mjs");
  const server = await createServer({ root, logLevel: "error", server: { port: 0, strictPort: false } });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error("[compile page]", e.message));
    await page.goto(new URL("tools/compile.html", url).href);
    await page.waitForFunction(() => window.__ready, { timeout: 60000 });
    const job = page.evaluate((list) => window.compileTargets(list), images);
    const timer = setInterval(async () => {
      const p = await page.evaluate(() => window.__progress).catch(() => null);
      if (p != null) process.stdout.write(`\r  ${Math.min(100, Math.round(p))}%   `);
    }, 1000);
    const base64 = await job.finally(() => clearInterval(timer));
    process.stdout.write("\r  100%   \n");
    const bytes = Buffer.from(base64, "base64");
    const out = path.join(collectionDir(c), manifest.targets || "targets.mind");
    await writeFile(out, bytes);
    log(`  → ${path.relative(root, out)} (${kb(bytes.length)})`);
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------------------------------------------------------------- commands

async function add() {
  const [c, id] = positional;
  requireCollectionId(c);
  if (!id || !ID.test(id)) fail("Give an item id (letters, digits, - or _).");
  if (!flags.image || !existsSync(flags.image)) fail("--image <print image> is required and must exist.");
  if (!flags.video || !existsSync(flags.video)) fail("--video <video file> is required and must exist.");
  if (flags.fit && !["cover", "contain", "stretch"].includes(flags.fit)) fail("--fit must be cover, contain or stretch.");

  const manifest = (await readManifest(c)) ?? { id: c, title: flags["collection-title"] ?? c, targets: "targets.mind", items: [] };
  const itemDir = path.join(collectionDir(c), id);
  await mkdir(itemDir, { recursive: true });
  await mkdir(path.join(sourceDir, c), { recursive: true });

  log(`Preparing print image…`);
  await prepareTargetImage(flags.image, path.join(sourceDir, c, `${id}.jpg`));

  const audio = flags.audio === true;
  log(`Encoding video${audio ? " (with audio)" : ""}…`);
  const videoOut = path.join(itemDir, "video.mp4");
  await encodeVideo(flags.video, videoOut, { audio });
  await makePoster(videoOut, path.join(itemDir, "poster.webp"));
  const [before, after] = [await stat(flags.video), await stat(videoOut)];
  log(`  video ${kb(before.size)} → ${kb(after.size)}`);

  const item = {
    id,
    ...(flags.title ? { title: flags.title } : {}),
    video: `${id}/video.mp4`,
    poster: `${id}/poster.webp`,
    image: `${id}.jpg`,
    fit: flags.fit ?? "cover",
    loop: flags.loop !== false,
    audio,
  };
  const existing = manifest.items.findIndex((i) => i.id === id);
  if (existing >= 0) manifest.items[existing] = { ...manifest.items[existing], ...item };
  else manifest.items.push(item);
  await writeManifest(c, manifest);

  await compileTargets(c, manifest);
  await check([c]);
}

async function build() {
  const c = requireCollectionId(positional[0]);
  const manifest = await readManifest(c);
  if (!manifest) fail(`No collection at public/experiences/${c}/collection.json`);
  for (const item of manifest.items) {
    const video = path.join(collectionDir(c), item.video);
    if (!item.poster && existsSync(video)) {
      item.poster = path.posix.join(path.posix.dirname(item.video), "poster.webp");
      log(`Making poster for ${item.id}…`);
      await makePoster(video, path.join(collectionDir(c), item.poster));
    }
  }
  await writeManifest(c, manifest);
  await compileTargets(c, manifest);
  await check([c]);
}

async function optimize() {
  const c = requireCollectionId(positional[0]);
  const manifest = await readManifest(c);
  if (!manifest) fail(`No collection at public/experiences/${c}/collection.json`);
  for (const item of manifest.items) {
    const video = path.join(collectionDir(c), item.video);
    if (!existsSync(video)) fail(`Missing ${path.relative(root, video)}`);
    const before = (await stat(video)).size;
    if ((await probe(video)).encodedByUs && !flags.force) {
      log(`Skipping ${item.id}: already optimized (use --force to re-encode from it anyway).`);
      continue;
    }
    const tmpIn = tempFile(".mp4");
    await copyFile(video, tmpIn);
    log(`Encoding ${item.id}…`);
    try {
      await encodeVideo(tmpIn, video, { audio: !!item.audio });
    } finally {
      await rm(tmpIn, { force: true });
    }
    item.poster ??= path.posix.join(path.posix.dirname(item.video) === "." ? item.id : path.posix.dirname(item.video), "poster.webp");
    await mkdir(path.dirname(path.join(collectionDir(c), item.poster)), { recursive: true });
    await makePoster(video, path.join(collectionDir(c), item.poster));
    log(`  ${kb(before)} → ${kb((await stat(video)).size)}`);
  }
  await writeManifest(c, manifest);
  await check([c]);
}

async function check(ids) {
  const all = existsSync(publicDir) ? (await readdir(publicDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  const targets = ids?.length ? ids : all;
  if (!targets.length) fail("No collections found in public/experiences/.");
  let errors = 0;
  let warnings = 0;
  const err = (c, m) => (errors++, console.error(`  ✖ [${c}] ${m}`));
  const warn = (c, m) => (warnings++, console.warn(`  ⚠ [${c}] ${m}`));

  for (const c of targets) {
    const raw = await readManifest(c);
    if (!raw) {
      err(c, "collection.json missing");
      continue;
    }
    let manifest;
    try {
      manifest = validateCollection(raw, "file:///");
    } catch (e) {
      err(c, e.message);
      continue;
    }
    if (raw.id !== c) warn(c, `"id" is "${raw.id}" but the folder is "${c}" (the URL uses the folder name: ?c=${c})`);
    if (manifest.items.length > BUDGET.itemsPerCollection) {
      warn(c, `${manifest.items.length} items; detection slows down past ~${BUDGET.itemsPerCollection}. Consider splitting.`);
    }

    const mindFile = path.join(collectionDir(c), manifest.targets);
    if (!existsSync(mindFile)) err(c, `${manifest.targets} missing — run: npm run content -- build ${c}`);
    else {
      const buf = await readFile(mindFile);
      try {
        const count = decode(buf).dataList.length;
        if (count !== manifest.items.length) {
          err(c, `${manifest.targets} has ${count} image(s) but collection.json lists ${manifest.items.length}`);
        }
      } catch {
        err(c, `${manifest.targets} is not a valid MindAR file`);
      }
      if (buf.length > BUDGET.mind) warn(c, `${manifest.targets} is ${kb(buf.length)}; recompile from smaller images (≤${TARGET_MAX_SIDE}px)`);
    }

    for (const item of manifest.items) {
      const video = path.join(collectionDir(c), item.video);
      if (!existsSync(video)) {
        err(c, `${item.id}: video ${item.video} missing`);
        continue;
      }
      const size = (await stat(video)).size;
      const info = await probe(video);
      if (info.codec && info.codec !== "h264") err(c, `${item.id}: video codec is ${info.codec}; use H.264 (run optimize)`);
      if (size > BUDGET.video) warn(c, `${item.id}: video is ${kb(size)}; run: npm run content -- optimize ${c}`);
      if (info.hasAudio && !item.audio) warn(c, `${item.id}: video has an audio track but "audio" is false (wasted bytes)`);
      if (!item.poster) warn(c, `${item.id}: no poster — the photo→video switch may flash. Run build or optimize.`);
      else if (!existsSync(path.join(collectionDir(c), item.poster))) err(c, `${item.id}: poster ${item.poster} missing`);
      else if ((await stat(path.join(collectionDir(c), item.poster))).size > BUDGET.poster) warn(c, `${item.id}: poster is large`);
      if (!item.image || !existsSync(path.join(sourceDir, c, item.image))) {
        warn(c, `${item.id}: source print image not in content/${c}/ (needed to recompile targets)`);
      }
    }
    if (!errors) log(`  ✔ ${c}: ${manifest.items.length} item(s)`);
  }
  if (errors) fail(`${errors} error(s), ${warnings} warning(s)`);
  log(warnings ? `Checked with ${warnings} warning(s).` : "All collections OK.");
}

const commands = { add, build, optimize, check: () => check(positional) };
if (!commands[command]) {
  log("Usage: npm run content -- <add|build|optimize|check> … (see the top of tools/content.mjs)");
  process.exit(command ? 1 : 0);
}
await commands[command]();
