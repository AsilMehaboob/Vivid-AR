import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// `npm run dev`        – http://localhost:5173 (camera works on localhost)
// `npm run dev:phone`  – https://<your-LAN-ip>:5173 with a self-signed cert,
//                        so a phone on the same Wi-Fi can open it.
export default defineConfig(({ mode }) => ({
  // Relative asset URLs: the build works from any sub-path or CDN prefix.
  base: "./",
  plugins: mode === "phone" ? [basicSsl()] : [],
  server: {
    host: mode === "phone" ? true : undefined,
  },
  build: {
    target: "es2020",
    // The tracking engine (TensorFlow.js inside MindAR) is one large chunk by nature.
    chunkSizeWarningLimit: 2600,
    assetsInlineLimit: 0,
    sourcemap: false,
  },
}));
