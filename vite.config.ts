import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer dev/build。Electron 壳（electron/）加载下面端口的 dev server，
// 保持 strictPort —— 壳的 DEV_URL / wait-on 假定 5274。
export default defineConfig({
  root: "renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../dist-renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5274,
    strictPort: true,
  },
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
