import { chromium, type Browser } from "playwright-core";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { checkedThumbnailRoot, saveThumbnail, thumbnailDirectories, thumbnailExists, thumbnailJob } from "./thumbnails/thumbnailFiles";

export async function generateLobbyThumbnails(args: string[]) {
  let rootArgument = "", directory: string | undefined, executablePath: string | undefined, force = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help") {
      console.log("bun run thumbnails:generate --root <library> [--directory <lobby>] [--force] [--browser <executable>]\nWrites 640×360 Idle_01 PNGs to lobbies/<lobby>/thumbnail.png, one lobby at a time. Defaults to *_home lobbies only; --directory explicitly targets any set. Requires installed Edge/Chrome. Existing thumbnails are skipped unless --force is supplied.");
      return;
    }
    if (arg === "--force") { force = true; continue; }
    if (!["--root", "--directory", "--browser"].includes(arg ?? "") || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`Invalid argument: ${arg}`);
    const value = args[++index]!;
    if (arg === "--root") rootArgument = value;
    if (arg === "--directory") directory = value;
    if (arg === "--browser") executablePath = value;
  }
  if (!rootArgument) throw new Error("Supply --root <external asset library>. See --help.");
  const root = await checkedThumbnailRoot(rootArgument);
  const directories = await thumbnailDirectories(root, directory);
  const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./thumbnails/render.ts", import.meta.url))], target: "browser", minify: true });
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  const bundle = await build.outputs[0]!.text();
  const token = crypto.randomUUID();
  let activeFiles: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const prefix = `/${token}/`;
      if (!url.pathname.startsWith(prefix)) return new Response("Not found", { status: 404 });
      const route = url.pathname.slice(prefix.length);
      const headers = { "cache-control": "no-store" };
      if (route === "") return new Response('<!doctype html><style>html,body{margin:0}</style><script src="render.js"></script>', { headers: { ...headers, "content-type": "text/html" } });
      if (route === "render.js") return new Response(bundle, { headers: { ...headers, "content-type": "text/javascript" } });
      const match = /^asset\/(\d+)$/.exec(route);
      const file = match ? activeFiles[Number(match[1])] : undefined;
      return file ? new Response(Bun.file(file), { headers }) : new Response("Not found", { status: 404 });
    },
  });
  let browser: Browser | undefined;
  let generated = 0, skipped = 0, failed = 0;
  try {
    for (const name of directories) {
      try {
        // Check the cheap destination first; skips never load source files or a browser.
        const output = `${root}/lobbies/${name}/thumbnail.png`;
        if (!force && await thumbnailExists(output)) { skipped++; console.log(`SKIP ${name}: thumbnail.png exists`); continue; }
        const job = await thumbnailJob(root, name);
        browser ??= await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: process.platform === "win32" ? "msedge" : "chrome" }) });
        activeFiles = job.files;
        // A fresh context per lobby drops JS objects, decoded images and browser caches.
        const context = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
        try {
          const page = await context.newPage();
          await page.goto(`http://127.0.0.1:${server.port}/${token}/`, { waitUntil: "load" });
          let timer: ReturnType<typeof setTimeout> | undefined;
          const image = await Promise.race([
            page.evaluate(({ directory, names }) => window.renderLobbyThumbnail(directory, names), { directory: name, names: job.files.map((path) => basename(path)) }),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Thumbnail render timed out after 90 seconds.")), 90_000); }),
          ]).finally(() => clearTimeout(timer));
          const saved = await saveThumbnail(root, job.output, Buffer.from(image, "base64"), force);
          if (saved) { generated++; console.log(`OK ${name}: 640x360 Idle_01 -> thumbnail.png`); }
          else { skipped++; console.log(`SKIP ${name}: thumbnail appeared during generation`); }
        } finally { await context.close(); activeFiles = []; }
      } catch (error) {
        failed++;
        console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await browser?.close();
    server.stop(true);
  }
  console.log(JSON.stringify({ root, generated, skipped, failed, total: directories.length }));
  if (failed) process.exitCode = 1;
}

if (import.meta.main) {
  await generateLobbyThumbnails(Bun.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
}
