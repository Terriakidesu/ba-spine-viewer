import { SpineRenderer, type SpineMeta } from "../../packages/spine-runtime/src/spine/spineRuntime";
import { LOBBY_THUMBNAIL_HEIGHT, LOBBY_THUMBNAIL_WIDTH } from "../../packages/spine-runtime/src/spine/spineThumbnail";

declare global {
  interface Window {
    renderLobbyThumbnail: (directory: string, names: string[]) => Promise<string>;
  }
}

window.renderLobbyThumbnail = async (directory, names) => {
  const files = new Map<string, File>();
  // Read one file at a time; do not duplicate every compressed atlas page in flight.
  for (const [index, name] of names.entries()) {
    const response = await fetch(`asset/${index}`);
    if (!response.ok) throw new Error(`Could not load ${name}.`);
    files.set(name, new File([await response.blob()], name));
  }
  const canvas = document.createElement("canvas");
  canvas.width = LOBBY_THUMBNAIL_WIDTH;
  canvas.height = LOBBY_THUMBNAIL_HEIGHT;
  canvas.style.cssText = `width:${canvas.width}px;height:${canvas.height}px;display:block`;
  document.body.append(canvas);
  let renderer: SpineRenderer | null = null;
  try {
    let meta: SpineMeta | null = null;
    let failure: Error | null = null;
    renderer = new SpineRenderer(canvas, {
      onMeta: (value) => { meta = value; }, onProgress: () => {}, onLoading: () => {},
      onError: (error) => { failure = error; },
    }, { preserveDrawingBuffer: true });
    renderer.setPlaying(false);
    await renderer.load(files, directory);
    if (failure) throw failure;
    if (!(meta as SpineMeta | null)?.animations.includes("Idle_01")) throw new Error("Missing release Idle_01 animation; no fallback was used.");
    renderer.setCameraMode("fit");
    renderer.sampleEditorAnimation("Idle_01", "", 0, false);
    renderer.resetCamera();
    // Let the shared renderer settle its viewport/camera before the readback.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (!renderer.renderFrameForCapture()) throw new Error("Renderer was not ready for capture.");
    const output = document.createElement("canvas");
    output.width = LOBBY_THUMBNAIL_WIDTH;
    output.height = LOBBY_THUMBNAIL_HEIGHT;
    const context = output.getContext("2d");
    if (!context) throw new Error("Could not create thumbnail output canvas.");
    // Refuse empty renders instead of saving an apparently valid blank PNG.
    context.drawImage(canvas, 0, 0, output.width, output.height);
    const pixels = context.getImageData(0, 0, output.width, output.height).data;
    if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) throw new Error("Idle_01 rendered no visible pixels.");
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#102432";
    context.fillRect(0, 0, output.width, output.height);
    return output.toDataURL("image/png").split(",")[1]!;
  } finally {
    renderer?.dispose();
    // This standalone canvas is never reused, so release its context explicitly.
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.remove();
    files.clear();
  }
};
