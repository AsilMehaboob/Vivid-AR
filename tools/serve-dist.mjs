// Serves dist/ the way a static host will: applies public/_headers (CSP,
// caching) and supports HTTP Range requests (iOS needs them for video).
// Use it to verify a production build before deploying:
//
//   npm run build && npm run serve:dist     → http://localhost:4173
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const port = Number(process.env.PORT || 4173);
if (!existsSync(root)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".mind": "application/octet-stream",
};

// Netlify-style _headers: a path pattern line, then indented "Name: value" lines.
const rules = [];
const headersFile = path.join(root, "_headers");
if (existsSync(headersFile)) {
  let current = null;
  for (const line of readFileSync(headersFile, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const pattern = new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      current = { pattern, headers: {} };
      rules.push(current);
    } else if (current) {
      const i = line.indexOf(":");
      current.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
}

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!existsSync(file)) return res.writeHead(404).end("Not found");

  for (const rule of rules) if (rule.pattern.test(url.pathname)) for (const [k, v] of Object.entries(rule.headers)) res.setHeader(k, v);
  res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");

  const { size } = statSync(file);
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Length": size });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Serving dist/ with production headers at http://localhost:${port}`));
