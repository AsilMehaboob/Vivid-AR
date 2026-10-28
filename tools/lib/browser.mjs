// Finds (or installs) a Chromium for the headless tools: target compiling and
// the tracking test. Order: $BROWSER_PATH → cached headless shell → system
// Chrome/Edge → download Chrome Headless Shell into .cache/browsers.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, computeExecutablePath, detectBrowserPlatform, install, resolveBuildId } from "@puppeteer/browsers";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cacheDir = path.join(root, ".cache", "browsers");
const BUILD = "stable";

const systemBrowsers = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];

export async function findBrowser() {
  if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
  const platform = detectBrowserPlatform();
  const buildId = await resolveBuildId(Browser.CHROMEHEADLESSSHELL, platform, BUILD).catch(() => null);
  if (buildId) {
    const cached = computeExecutablePath({ browser: Browser.CHROMEHEADLESSSHELL, buildId, cacheDir });
    if (existsSync(cached)) return cached;
  }
  const system = systemBrowsers.find((p) => existsSync(p));
  if (system) return system;
  if (!buildId) throw new Error("No browser found and offline. Set BROWSER_PATH to Chrome/Chromium.");
  console.log(`Downloading Chrome Headless Shell ${buildId} into .cache/browsers (one time)…`);
  const installed = await install({ browser: Browser.CHROMEHEADLESSSHELL, buildId, cacheDir });
  return installed.executablePath;
}

export async function launchBrowser({ headless = true, extraArgs = [] } = {}) {
  return puppeteer.launch({
    executablePath: await findBrowser(),
    headless,
    args: [
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--ignore-gpu-blocklist",
      "--enable-gpu",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      ...(process.platform === "win32" ? ["--use-angle=d3d11"] : []),
      ...extraArgs,
    ],
  });
}
