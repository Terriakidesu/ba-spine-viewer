import { findIdleAnimation } from "./spineAnimation";

export const LOBBY_THUMBNAIL_WIDTH = 640;
export const LOBBY_THUMBNAIL_HEIGHT = 360;

/** Prefer Idle_01, but support release exports named Idle/Idle_1 without using Dev clips. */
export function thumbnailIdleAnimation(animations: string[]): string | null {
  return findIdleAnimation(animations.filter((name) => !/(?:^|[/_ -])dev(?:[/_ -]|$)/i.test(name)));
}

export function lobbyThumbnailPath(directory: string): string {
  if (!directory || directory === "." || directory === ".." || /[\\/:*?"<>|\x00-\x1f]/.test(directory) || /[. ]$/.test(directory)) {
    throw new Error("A single lobby directory name is required.");
  }
  return `lobbies/${directory}/thumbnail.png`;
}
