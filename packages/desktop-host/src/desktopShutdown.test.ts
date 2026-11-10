import { expect, test } from "bun:test";
import { onceDesktopHostShutdown } from "./desktopShutdown";

test("desktop host shutdown runs cleanup once across close and exit notifications", () => {
  let cleanups = 0;
  const shutdown = onceDesktopHostShutdown(() => cleanups++);

  shutdown();
  shutdown();

  expect(cleanups).toBe(1);
});
