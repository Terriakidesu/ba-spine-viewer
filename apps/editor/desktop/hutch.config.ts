export default {
  packageManager: "bun",
  electrobun: { version: "2.0.5" },
  scripts: {
    install: ["hutch", "pm", "install"],
    dev: ["bun", "scripts/run-electrobun.ts", "dev"],
    build: ["bun", "scripts/run-electrobun.ts", "build"],
  },
};
