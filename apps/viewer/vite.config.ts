import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@ba-spine/spine-runtime/ui", replacement: `${root}/packages/spine-runtime/src/spine` },
      { find: "@ba-spine/spine-runtime", replacement: `${root}/packages/spine-runtime/src` },
      { find: "@ba-spine/app-ui", replacement: `${root}/packages/app-ui/src` },
      { find: "@ba-spine/viewer-feature", replacement: `${root}/packages/viewer-feature/src` },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@esotericsoftware/spine-core")) return "spine-core";
          if (id.includes("@esotericsoftware/spine-webgl")) return "spine-webgl";
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/")) return "react-vendor";
        },
      },
    },
  },
});
