import { expect, test } from "bun:test";
import { thumbnailIdleAnimation } from "./spineThumbnail";

test("thumbnail generation prefers Idle_01 regardless of animation order", () => {
  expect(thumbnailIdleAnimation(["Idle", "Idle_1", "Idle_01"])).toBe("Idle_01");
});

test("supports the CH0264_home release idle without selecting intro or Dev clips", () => {
  expect(thumbnailIdleAnimation(["Dummy", "Start_Idle_01", "Dev_Talk/Talk_03_M3", "Idle", "Talk_01_M"])).toBe("Idle");
  expect(thumbnailIdleAnimation(["Idle_1"])).toBe("Idle_1");
});

test("never substitutes development, intro or interaction animations", () => {
  expect(thumbnailIdleAnimation(["Dev/Idle_01", "Dev_Idle", "Idle_Dev", "Start_Idle_01", "Idle_Talk", "Idle_Look", "Talk_01_M"])).toBeNull();
});
