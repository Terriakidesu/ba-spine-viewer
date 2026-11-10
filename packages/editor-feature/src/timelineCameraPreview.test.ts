import { expect, test } from "bun:test";
import { timelinePreviewCameraFrame } from "./timelineCameraPreview";

const artworkFrame = { centerX: 10, centerY: 20, height: 300 };
const authoredFrame = { centerX: 30, centerY: 40, height: 100 };

test("timeline previews share the authored camera frame when enabled", () => {
  expect(timelinePreviewCameraFrame(true, authoredFrame, artworkFrame)).toEqual(authoredFrame);
});

test("timeline previews share the reference artwork frame when the authored camera is disabled", () => {
  expect(timelinePreviewCameraFrame(false, authoredFrame, artworkFrame)).toEqual(artworkFrame);
});

test("timeline previews wait for a reference camera frame while layers load", () => {
  expect(timelinePreviewCameraFrame(false, null, null)).toBeNull();
});
