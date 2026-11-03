import type { ElectrobunConfig } from "electrobun";

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
    },
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
} satisfies ElectrobunConfig;
