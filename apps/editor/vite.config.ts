import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL("../..", import.meta.url));
const waveformProfileEnabled = process.env.BA_SPINE_EDITOR_WAVEFORM_PROFILE === "1";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  define: {
    __EDITOR_WAVEFORM_PROFILE__: JSON.stringify(waveformProfileEnabled),
  },
  resolve: {
    alias: [
      { find: "@ba-spine/spine-runtime/ui", replacement: `${root}/packages/spine-runtime/src/spine` },
      { find: "@ba-spine/spine-runtime", replacement: `${root}/packages/spine-runtime/src` },
      { find: "@ba-spine/app-ui", replacement: `${root}/packages/app-ui/src` },
      { find: "@ba-spine/editor-feature", replacement: `${root}/packages/editor-feature/src` },
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
