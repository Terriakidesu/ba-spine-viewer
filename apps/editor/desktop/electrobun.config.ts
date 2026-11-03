import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "BA Spine Editor",
    identifier: "dev.ba-spine.editor",
    version: "0.1.0",
    description: "Author Blue Archive Spine lobby interactions and timelines.",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      "build/editor": "views/editor",
    },
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
} satisfies ElectrobunConfig;
