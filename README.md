# Vivid AR

Web AR "living photos": point a phone camera at a printed image and a video plays on top of it, locked to the print. No app install — it runs in Safari (iOS) and Chrome (Android).

- **Many image → video pairs** per experience ("collections"), and many collections per deployment.
- **Exact, steady overlay**: realistic lens model, camera/pose frame sync, adaptive pose smoothing, glitch rejection.
- **Seamless photo → video**: the video's exact first frame is shown the instant the print is recognised, then cross-fades to the playing video once real frames decode.
- **Fast**: 4 KB of JS for first paint; the tracker warms up while the visitor reads the intro; videos are H.264 at ~2 MB, loaded only when needed.
- **Static hosting**: any CDN. Security headers and cache rules included.

---

## Quick start

Requires Node 22.18+ (24 recommended, see `.nvmrc`).

```bash
npm install
npm run dev            # http://localhost:5173 — camera works on localhost
```

Open on a phone (same Wi-Fi) — phones only allow the camera over HTTPS:

```bash
npm run dev:phone      # https://<your-computer-ip>:5173, self-signed certificate
```

Accept the certificate warning on the phone, tap **Start camera**, and point it at the print (or at the poster image on another screen).

| Command | What it does |
| --- | --- |
| `npm run dev` / `dev:phone` | Dev server (HTTP localhost / HTTPS on the LAN) |
| `npm run build` | Typecheck → validate all content → production build in `dist/` |
| `npm run serve:dist` | Serve `dist/` with the real production headers (CSP, caching, Range) |
| `npm run content -- …` | Add items, compile targets, optimise media, validate (below) |
| `npm run test:tracking -- …` | Automated accuracy/jitter test with a simulated camera (below) |
| `npm run typecheck` | TypeScript only |

---

## Content

### Concepts

A **collection** is a set of printed images that can be scanned in one session. Its URL is `/?c=<collection-id>` (the default collection is `default`, or set `VITE_DEFAULT_COLLECTION` at build time). Each **item** is one printed image + one video.

```
content/<collection>/<item>.jpg                   print images — source only, never deployed
public/experiences/<collection>/
  collection.json                                 manifest (below)
  targets.mind                                    all print images compiled together (gzipped)
  <item>/video.mp4                                H.264, ≤1280px, fast-start
  <item>/poster.webp                              the video's exact first frame
```

### Add an image + video

```bash
npm run content -- add <collection> <item-id> --image print.jpg --video clip.mp4
#   optional: --title "…"  --fit cover|contain|stretch  --audio  --no-loop
```

This one command:

1. resizes the print image to ≤1280 px into `content/<collection>/`,
2. encodes the video (H.264 Main, BT.709, CRF 20, ≤1280 px, ≤30 fps, fast-start; audio only with `--audio`),
3. extracts the poster from the **encoded** video so it is pixel-identical to frame 0,
4. adds/updates the item in `collection.json`,
5. recompiles `targets.mind` for the whole collection (headless Chrome, MindAR compiler),
6. validates the collection.

The first run downloads Chrome Headless Shell into `.cache/` if no Chrome/Chromium is installed (or set `BROWSER_PATH`).

Other commands:

```bash
npm run content -- build <collection>      # recompile targets.mind, make missing posters
npm run content -- optimize <collection>   # re-encode videos that weren't made by this tool, gzip targets
npm run content -- check [collection]      # validate (also runs in `npm run build`)
```

### collection.json

```jsonc
{
  "id": "default",
  "title": "EXCEL 2026",              // shown on the intro screen and as the page title
  "targets": "targets.mind",
  "items": [                          // ORDER MATTERS: item N = image N in targets.mind
    {
      "id": "excel-2026-poster",
      "video": "excel-2026-poster/video.mp4",
      "poster": "excel-2026-poster/poster.webp",
      "image": "excel-2026-poster.jpg",   // in content/<collection>/, for recompiling
      "fit": "cover",                     // cover | contain | stretch
      "loop": true,
      "audio": false                      // true shows a "Tap for sound" button
    }
  ],
  // Optional per-collection overrides (defaults in src/content.ts):
  "tracking": { "cameraFov": 63, "warmupFrames": 3, "missFrames": 6,
                "smoothing": { "minCutoff": 1.2, "beta": 20, "rotMinCutoff": 1.0, "rotBeta": 10 } },
  "playback": { "pauseAfterLostMs": 1200, "restartAfterLostMs": 4000, "maxLoadedVideos": 3 }
}
```

If you edit `items` by hand, run `npm run content -- build <collection>` so `targets.mind` matches. The app refuses to start if the counts differ.

### Making great targets (this decides tracking quality)

- **Detailed, high-contrast, non-repeating artwork** works best (illustrations, photos with texture, text). Flat colour areas, gradients, and repeating patterns (grids, stripes, test cards) track badly or not at all.
- **The video's first frame must be the print**, same crop and framing. That is what makes the photo appear to come alive with no jump. Export the clip from the same artwork.
- Keep the print's aspect ratio and the video's aspect ratio the same where possible (`fit: cover` crops any difference).
- Matte paper beats glossy (reflections hide features). Print at least ~10 cm on the short side.
- Keep collections to **≲ 30 items**. Detection time grows with the number of images in one `targets.mind`. Use separate collections (separate QR codes) for separate campaigns.
- Avoid near-duplicate prints in the same collection.

> ⚠ The `default` collection's original print image isn't in the repo (`content/default/` is empty), so its `targets.mind` can't be recompiled yet. Add the original artwork as `content/default/excel-2026-poster.jpg` and set `"image": "excel-2026-poster.jpg"` on the item. A ≤1280 px source also makes the target file about half its current size.

---

## How it works

```
index.html + src/main.ts      UI (intro, status, errors, sound), startup, lifecycle — 4 KB gz
src/content.ts                collection schema, defaults, validation
src/engine/ (lazy chunk)      ~424 KB gz, mostly TensorFlow.js inside MindAR
  camera.ts                   getUserMedia with fallbacks and typed errors
  engine.ts                   tracker ↔ renderer, frame sync, lens model, poses, LRU videos
  pose-filter.ts              One-Euro filter for position + rotation
  overlay.ts                  per-item plane: poster → video cross-fade, fit, fades, playback
src/vendor/mindar/            MindAR 1.2.5 dist (MIT), see its README for why it's vendored
tools/                        content CLI, target compiler page, simulated camera, tests
```

Image detection and tracking come from [MindAR](https://github.com/hiukim/mind-ar-js) (the best free web image tracker that works on iOS). Everything above it is custom, because the stock integration was the source of the shaking and misalignment:

1. **Lens model.** MindAR assumes a 45° field of view across the frame *height*. Real phone cameras in portrait see ~63–70° across that (long) side, and the assumption even changes between portrait and landscape. With the wrong lens, no pose fits a tilted print, so the overlay slides off the corners whenever the phone tilts. The engine sets a realistic lens (`tracking.cameraFov`, default 63° across the long side).
2. **Frame sync.** The camera image normally shows the newest frame while the pose belongs to a frame 1–3 frames older, so the video trails the print on any movement, worse on slow phones. The engine shows exactly the frame the tracker analysed, so background and overlay always describe the same instant.
3. **Pose smoothing.** MindAR's filter smooths the 16 raw matrix numbers with settings that barely filter while moving. It's disabled; `PoseFilter` applies a One-Euro filter to position (in print widths) and rotation (slerp): strong when still, light when moving. Single-frame wild poses are rejected unless they persist.
4. **Startup.** The tracker compiles its GPU kernels (~1–2 s) while the visitor reads the intro or answers the camera prompt, not after.
5. **Video.** Videos load on first detection; at most `maxLoadedVideos` stay decoded (phones have few hardware decoders). Losing the print briefly doesn't pause; after `restartAfterLostMs` it restarts from the poster.

---

## Testing

### Automated tracking test (no phone needed)

`tools/sim-camera.js` replaces the camera with a synthetic feed: the print on a textured desk with sensor noise, and optionally tremor, 3D tilt, distance change and motion blur. Each frame carries a barcode so the test knows exactly which camera frame is on screen and where the print's corners really are. It is dev-only (`?sim`) and never in production builds.

```bash
npm run dev    # in one terminal
npm run test:tracking -- --url http://localhost:5173/ \
  --src experiences/default/excel-2026-poster/poster.webp \
  --scenarios static,shake,handheld --cpu 4 --extra simnoise=1
```

Reports per scenario: `errMean/errP95` (px between drawn video corners and real print corners), `wobbleMean/P95` (px of frame-to-frame shake relative to the print), `activeItem`, and startup timings. `--cpu 4` throttles the CPU like a mid-range phone; `--screenshot <prefix>` saves frames.

Dev-only URL switches for tuning: `?sim&smooth=minCutoff,beta,rotMinCutoff,rotBeta`, `&fov=63`, `&sync=0`, `&slowtrack=45`, `&warmup=3&miss=6`, `&simfov=72`, `&simmotion=handheld`.

**Results** (handheld scenario, 4× CPU throttle, 390×844 phone viewport):

| | Original A-Frame build | This engine |
| --- | --- | --- |
| Overlay error, mean / p95 | 9.1 px / 31.5 px | 2.5–3.7 px / 5.4–8.4 px |
| Wobble, mean / p95 | 2.5 px / 6.0 px | 1.1–1.5 px / 2.2–2.8 px |
| Video size | 12 MB | 2.3 MB (+190 KB poster) |
| Target file | 1.2 MB | 650 KB (gzipped) |

Multi-target was verified with a 3-item collection (two landscape crops and a mirrored near-duplicate): the correct item was recognised every time, with the same accuracy.

To try multi-target yourself, add a few items to a scratch collection (`npm run content -- add e2e …`), run the test with `--url "http://localhost:5173/?c=e2e"` and each item's poster as `--src`, then delete `public/experiences/e2e` and `content/e2e`.

### On real phones (before every launch)

The simulator can't reproduce real optics, autofocus or lighting. Check on at least one recent iPhone (Safari) and one mid-range Android (Chrome):

- [ ] Intro → camera prompt → scanning hint; denying the camera shows the help screen and **Try again** works.
- [ ] Each print is recognised within ~1 s; the right video plays; edges sit on the print while tilting.
- [ ] Holding still: no visible shaking. Moving: the video stays glued, no trailing.
- [ ] No flash or jump when the poster switches to video; loops cleanly.
- [ ] Switch apps and come back: camera resumes. Rotate the phone: tracking continues.
- [ ] Items with `audio: true` show **Tap for sound** and play sound.
- [ ] If overlays slide at the corners when tilting on a particular phone model, try `tracking.cameraFov` 58–70.

---

## Deploying

`npm run build` produces a static site in `dist/`. Any static host or CDN works; the host must serve **HTTPS** (camera requirement) and support **Range requests** (iOS video), which all major ones do.

- **Netlify**: `netlify.toml` is included; headers come from `public/_headers`.
- **Cloudflare Pages**: build `npm run build`, output `dist`; `_headers` is applied automatically.
- **Vercel**: `vercel.json` is included (keep its headers in sync with `public/_headers`).
- **Anything else** (S3 + CloudFront, nginx, …): copy the headers from `public/_headers`.

What the headers do: a strict Content-Security-Policy (only same-origin code; `blob:`/`data:` workers for the tracker), camera allowed for this origin only, `assets/*` cached for a year (file names are content-hashed), `experiences/*` cached for 5 minutes with stale-while-revalidate (content updates go live without a rebuild), `index.html` always revalidated.

Check a build locally with the exact production headers before deploying:

```bash
npm run build && npm run serve:dist     # http://localhost:4173
```

**Scale.** Everything is static, so concurrent visitors cost only CDN bandwidth: about 0.45 MB engine + 0.65 MB targets on the first visit (cached afterwards), plus ~2.3 MB per video actually watched. No server, no per-user compute.

**Share links / QR codes:** `https://<your-domain>/?c=<collection-id>`.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| "Secure connection needed" | Open over `https://` (or `npm run dev:phone` locally). |
| "Camera access needed" | Camera blocked for the site: browser site settings → Camera → Allow, then **Try again**. |
| Never detects a print | Weak target artwork (see *Making great targets*), glare, too far away, or `targets.mind` built from a different image. |
| Detects, but overlay offset at the corners when tilting | Lens mismatch for that phone: adjust `tracking.cameraFov`. |
| Video jumps at the start | Video's first frame doesn't match the print; re-export the clip from the print artwork. |
| "targets.mind has N image(s) but collection.json lists M" | Run `npm run content -- build <collection>`. |
| `content` tool can't find a browser | Install Chrome or set `BROWSER_PATH`; it otherwise downloads Chrome Headless Shell into `.cache/`. |

## License notes

MindAR is MIT licensed (`src/vendor/mindar/LICENSE`). The FFmpeg binary from `ffmpeg-static` is used only by the local content tool and is never shipped to visitors.
