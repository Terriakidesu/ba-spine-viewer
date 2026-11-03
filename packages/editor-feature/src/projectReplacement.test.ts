import { describe, expect, test } from "bun:test";
import { confirmProjectReplacement } from "./projectReplacement";

describe("incoming project replacement guard", () => {
  test("keeps a dirty project when the user declines the handoff", async () => {
    let prompted = 0;
    const accepted = await confirmProjectReplacement("dirty", () => {
      prompted += 1;
      return false;
    });
    expect(accepted).toBe(false);
    expect(prompted).toBe(1);
  });

  test("accepts a dirty project only after explicit confirmation", async () => {
    await expect(confirmProjectReplacement("dirty", () => true)).resolves.toBe(true);
    await expect(confirmProjectReplacement("dirty", () => false)).resolves.toBe(false);
  });

  test("does not discard a project while its save is pending or failed", async () => {
    const confirmDiscard = () => { throw new Error("confirmation must not override an unsafe save state"); };
    await expect(confirmProjectReplacement("saving", confirmDiscard)).resolves.toBe(false);
    await expect(confirmProjectReplacement("error", confirmDiscard)).resolves.toBe(false);
  });
});
