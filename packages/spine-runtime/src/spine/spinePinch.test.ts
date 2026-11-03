import { describe, expect, test } from "bun:test";
import { cheekControlNames } from "./spinePinch";

const controls = (names: string[], parents: Record<string, string> = {}) => cheekControlNames(names.map((name) => ({ name, parentName: parents[name] ?? "head" })));

describe("Pinch rig controls", () => {
  test("recognizes sided controls and both side-name orders", () => {
    expect(controls(["L_chin", "L_chin_inter", "L_chin_rot", "R_chin", "R_chin_rot"])).toEqual(["L_chin_rot", "R_chin_rot"]);
    expect(controls(["R_Chin_Root", "L_Chin_Root", "L_Chin", "R_Chin", "Chin_Con"])).toEqual(["L_Chin_Root", "R_Chin_Root"]);
    expect(controls(["Chin_R_Root", "Chin_L_Root", "Chin_L", "Chin_R"])).toEqual(["Chin_L_Root", "Chin_R_Root"]);
  });
  test("distinguishes numbered cheek pairs from a deformation chain", () => {
    expect(controls(["chin", "cheek_01", "cheek_02"], { cheek_01: "chin", cheek_02: "chin" })).toEqual(["cheek_01", "cheek_02"]);
    expect(controls(["cheek_01", "cheek_02"], { cheek_02: "cheek_01" })).toEqual(["cheek_01"]);
    expect(controls(["Touch_Point", "head"])).toEqual([]);
  });
});
