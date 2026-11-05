import type { ElectrobunConfig } from "electrobun";
import { existsSync } from "node:fs";
import { join } from "node:path";

const bundledFfmpeg = existsSync(join(import.meta.dir, "build", "ffmpeg", "ffmpeg.exe"));

export default {
  app: {
    name: "BA Spine Viewer",
    identifier: "dev.ba-spine.viewer",
    version: "0.1.0",
    description: "Browse and preview Blue Archive Spine lobby assets.",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      "build/viewer": "views/viewer",
      ...(bundledFfmpeg ? { "build/ffmpeg": "views/ffmpeg" } : {}),
    },
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
} satisfies ElectrobunConfig;
