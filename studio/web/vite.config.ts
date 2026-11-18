import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `bun run dev` serves on :5173 and proxies the API to a running `gooey-studio --port 7878`.
const api = process.env.STUDIO_API ?? "http://localhost:7878";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: api, changeOrigin: false } } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
