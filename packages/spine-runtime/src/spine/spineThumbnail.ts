export const LOBBY_THUMBNAIL_WIDTH = 640;
export const LOBBY_THUMBNAIL_HEIGHT = 360;

export function lobbyThumbnailPath(directory: string): string {
  if (!directory || directory === "." || directory === ".." || /[\\/:*?"<>|\x00-\x1f]/.test(directory) || /[. ]$/.test(directory)) {
    throw new Error("A single lobby directory name is required.");
  }
  return `lobbies/${directory}/thumbnail.png`;
}
