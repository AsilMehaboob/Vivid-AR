// Automated tracking test: drives a real browser against the simulated camera
// (tools/sim-camera.js) and reports overlay accuracy and wobble per scenario.
//
//   node tools/track-test.mjs --url http://localhost:5173/ [--scenarios static,shake,pan]
//        [--viewport 390x844] [--res 720x1280] [--src /path/to/target.jpg] [--headed]
//
// The page must expose window.__overlayCorners() returning
// { drawn: [[x,y]x4], truth: [[x,y]x4] } in CSS pixels, or null when nothing is shown.
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]]);
    return acc;
  }, []),
);

const url = args.url || "http://localhost:5173/";
const scenarios = (args.scenarios || "static,shake,pan").split(",");
const [vw, vh] = (args.viewport || "390x844").split("x").map(Number);
const res = args.res || "720x1280";
const src = args.src || "/__sim/target";
const measureMs = Number(args.ms || 8000);
const extra = args.extra ? `&${args.extra}` : "";
const inject = args.inject; // optional JS file defining window.__overlayCorners (used for the legacy page)

const browserPath = [
  process.env.BROWSER_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!browserPath) throw new Error("No Chrome/Edge found; set BROWSER_PATH");

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: !args.headed,
  args: [
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--ignore-gpu-blocklist",
    "--enable-gpu",
    ...(process.platform === "win32" ? ["--use-angle=d3d11"] : []),
    "--enable-gpu-rasterization",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});

const results = {};
try {
  for (const motion of scenarios) {
    const page = await browser.newPage();
    await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    // --cpu N slows the CPU N times to approximate a mid-range phone.
    if (args.cpu) await page.emulateCPUThrottling(Number(args.cpu));
    const logs = [];
    page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
    const sep = url.includes("?") ? "&" : "?";
    await page.goto(`${url}${sep}sim=1&simsrc=${encodeURIComponent(src)}&simmotion=${motion}&simres=${res}${extra}`);
    if (inject) await page.addScriptTag({ path: inject });

    const gl = await page.evaluate(() => {
      const c = document.createElement("canvas").getContext("webgl2");
      const ext = c && c.getExtension("WEBGL_debug_renderer_info");
      return ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
    });

    const t0 = Date.now();
    let detectedAfter = null;
    while (Date.now() - t0 < 40000) {
      const shown = await page.evaluate(() => !!(window.__overlayCorners && window.__overlayCorners()));
      if (shown) {
        detectedAfter = Date.now() - t0;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    const marks = await page.evaluate(() =>
      Object.fromEntries(performance.getEntriesByType("mark").map((m) => [m.name.replace("vivid:", ""), Math.round(m.startTime)])),
    );
    let metrics = null;
    if (detectedAfter != null) {
      await new Promise((r) => setTimeout(r, 1500)); // let filters settle
      metrics = await page.evaluate((ms) => window.__sim.measure(ms, window.__overlayCorners), measureMs);
    }
    if (args.screenshot) await page.screenshot({ path: `${args.screenshot}-${motion}.png` });
    results[motion] = { detectedAfterMs: detectedAfter, ...metrics, startupMarksMs: marks };
    if (detectedAfter == null || args.verbose) results[motion].logs = logs.slice(-15);
    results[motion].gpu = gl;
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
