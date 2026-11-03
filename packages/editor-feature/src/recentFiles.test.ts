import { expect, test } from "bun:test";
import { normalizeRecentFiles, rememberRecentFile, removeRecentFile } from "./recentFiles";

test("recent files deduplicate, sort, and keep the newest entry", () => {
  const items = normalizeRecentFiles([
    { kind: "project", path: "Airi.spine-project.json", rootPath: "D:/assets", label: "Airi", lastOpened: 2 },
    { kind: "project", path: "Airi.spine-project.json", rootPath: "D:/assets", label: "Old Airi", lastOpened: 1 },
    { kind: "folder", path: "D:/other", rootPath: "D:/other", label: "Other", lastOpened: 4 },
    { kind: "invalid", path: "bad", rootPath: "D:/bad", lastOpened: 99 },
  ]);
  expect(items.map((item) => item.label)).toEqual(["Other", "Airi"]);
});

test("remembering a file moves it to the front and removal is stable", () => {
  const first = rememberRecentFile([], { kind: "folder", path: "D:/assets", rootPath: "D:/assets", label: "Assets" }, 3);
  const second = rememberRecentFile(first, { kind: "project", path: "project.json", rootPath: "D:/assets", label: "Project", lastOpened: 10 }, 3);
  const refreshed = rememberRecentFile(second, { ...first[0]!, lastOpened: 11 }, 3);
  expect(refreshed[0]?.kind).toBe("folder");
  expect(removeRecentFile(refreshed, refreshed[0]!)).toHaveLength(1);
});
