import { describe, expect, test } from "bun:test";
import { BlendMode, BoneData, Physics, RegionAttachment, Skeleton, SkeletonData, SlotData, Vector2 } from "@esotericsoftware/spine-core";
import { authoredViewport, fitScene, interactionBounds, interactionHit, interactionKindAtPoint, sceneBounds } from "./spineCamera";
import { SpineRenderer } from "./spineRuntime";

function scene() {
  const data = new SkeletonData();
  const root = new BoneData(0, "root", null);
  data.bones.push(root);
  for (const name of ["background", "hidden", "additive", "screen", "fx_glow", "transparent"]) {
    data.slots.push(new SlotData(data.slots.length, name, root));
  }
  const skeleton = new Skeleton(data);
  for (const [index, slot] of skeleton.slots.entries()) {
    const attachment = new RegionAttachment(slot.data.name, slot.data.name);
    const size = index === 0 ? 100 : 1000;
    attachment.offset = [0, 0, 0, size, size * 2, size, size * 2, 0];
    slot.setAttachment(attachment);
  }
  skeleton.slots[1]!.color.a = 0;
  skeleton.slots[2]!.data.blendMode = BlendMode.Additive;
  skeleton.slots[3]!.data.blendMode = BlendMode.Screen;
  (skeleton.slots[5]!.getAttachment() as RegionAttachment).color.a = 0;
  skeleton.updateWorldTransform(Physics.update);
  return skeleton;
}

function authoredScene() {
  const data = new SkeletonData();
  const root = new BoneData(0, "root", null);
  const layer = new BoneData(1, "All_Layer", root);
  layer.y = 962;
  const offstage = new BoneData(2, "All_Layer_00", layer);
  offstage.x = -5000;
  const onstage = new BoneData(3, "All_Layer_01", layer);
  const characterLayer = new BoneData(4, "PC_Layer", onstage);
  data.bones.push(root, layer, offstage, onstage, characterLayer);

  data.slots.push(
    new SlotData(0, "02-BG", offstage),
    new SlotData(1, "BG", onstage),
    new SlotData(2, "BG_detail", onstage),
    new SlotData(3, "character", characterLayer),
  );
  const skeleton = new Skeleton(data);
  const makeAttachment = (slotIndex: number, name: string, width: number, height: number, x = -width / 2) => {
    const attachment = new RegionAttachment(name, name);
    attachment.offset = [x, 0, x, height, x + width, height, x + width, 0];
    skeleton.slots[slotIndex]!.setAttachment(attachment);
  };
  makeAttachment(0, "02/BG", 400, 200);
  makeAttachment(1, "01/BG", 200, 100);
  makeAttachment(2, "01/BG_detail", 20, 20, 100);
  makeAttachment(3, "character", 40, 80, -20);
  skeleton.updateWorldTransform(Physics.update);
  return skeleton;
}

describe("Spine scene framing", () => {
  test("ignores invisible attachments and oversized effect quads", () => {
    const bounds = sceneBounds(scene());
    expect(bounds.x).toBeCloseTo(0);
    expect(bounds.y).toBeCloseTo(0);
    expect(bounds.width).toBeCloseTo(200);
    expect(bounds.height).toBeCloseTo(100);
  });

  test("fits the same scene to the larger fullscreen viewport", () => {
    const bounds = { x: -100, y: -50, width: 200, height: 100 };
    const embedded = fitScene(bounds, 800, 450);
    const fullscreen = fitScene(bounds, 1920, 1080);
    expect(embedded.x).toBe(0);
    expect(embedded.y).toBe(0);
    expect(fullscreen.zoom / embedded.zoom).toBeCloseTo(800 / 1920);
    expect(bounds.width / fullscreen.zoom / 1920).toBeCloseTo(1 / 1.02);
  });

  test("fits portrait viewports without cropping the scene", () => {
    const fit = fitScene({ x: 20, y: 30, width: 200, height: 100 }, 300, 600);
    expect(fit.x).toBe(120);
    expect(fit.y).toBe(80);
    expect(fit.zoom * 300).toBeGreaterThanOrEqual(200);
    expect(fit.zoom * 600).toBeGreaterThanOrEqual(100);
  });

  test("fills the end-frame viewport by cropping instead of letterboxing", () => {
    const bounds = { x: 0, y: 0, width: 1440, height: 1080 };
    const fit = fitScene(bounds, 1920, 1080, true);
    expect(fit.zoom).toBe(0.75);
    expect(fit.x).toBe(720);
    expect(fit.y).toBe(540);
    expect(1920 * fit.zoom).toBeLessThanOrEqual(bounds.width);
    expect(1080 * fit.zoom).toBeLessThanOrEqual(bounds.height);
  });

  test("frames the onstage background rather than both cuts of a multi-scene lobby", () => {
    const skeleton = scene();
    const cut = skeleton.slots[1]!;
    cut.color.a = 1;
    cut.data.name = "02-BG";
    const attachment = cut.getAttachment() as RegionAttachment;
    attachment.name = "02/BG";
    attachment.offset = [-5000, 0, -5000, 100, -4800, 100, -4800, 0];
    const bounds = sceneBounds(skeleton);
    expect(bounds.x).toBeCloseTo(0);
    expect(bounds.width).toBeCloseTo(200);
  });

  test("uses the owned onstage child and its widest backdrop for an authored viewport", () => {
    const skeleton = authoredScene();
    const viewport = authoredViewport(skeleton);
    expect(viewport.authored).toBe(true);
    expect(viewport.anchorX).toBeCloseTo(0);
    expect(viewport.anchorY).toBeCloseTo(962);
    expect(viewport.width).toBeCloseTo(200);
    expect(viewport.height).toBeCloseTo(200 * 9 / 16);
    expect(viewport.x).toBeCloseTo(-100);
    expect(viewport.y).toBeCloseTo(962 - 200 * 9 / 32);
  });

  test("breaks near-equal backdrop widths by height, not export rounding", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const layer = new BoneData(1, "All_Layer", root);
    layer.y = 962;
    data.bones.push(root, layer);
    data.slots.push(new SlotData(0, "BG_short", layer), new SlotData(1, "BG_tall", layer));
    const skeleton = new Skeleton(data);
    const short = new RegionAttachment("BG_short", "BG_short");
    short.offset = [-100, 0, -100, 100, 100.0005, 100, 100.0005, 0];
    const tall = new RegionAttachment("BG_tall", "BG_tall");
    tall.offset = [-100, -100, -100, 300, 100, 300, 100, -100];
    skeleton.slots[0]!.setAttachment(short);
    skeleton.slots[1]!.setAttachment(tall);
    skeleton.updateWorldTransform(Physics.update);
    const viewport = authoredViewport(skeleton);
    expect(viewport.width).toBeCloseTo(200);
    expect(viewport.height).toBeCloseTo(200 * 9 / 16);
  });

  test("combines separated panels from one background branch", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const layer = new BoneData(1, "All_Layer", root);
    layer.y = 962;
    const background = new BoneData(2, "BG", layer);
    data.bones.push(root, layer, background);
    data.slots.push(new SlotData(0, "left panel", background), new SlotData(1, "right panel", background));
    const skeleton = new Skeleton(data);
    const panel = (name: string, x: number) => {
      const attachment = new RegionAttachment(name, name);
      attachment.offset = [x, 0, x, 100, x + 200, 100, x + 200, 0];
      return attachment;
    };
    skeleton.slots[0]!.setAttachment(panel("left", -200));
    skeleton.slots[1]!.setAttachment(panel("right", 0));
    skeleton.updateWorldTransform(Physics.update);
    const viewport = authoredViewport(skeleton);
    expect(viewport.authored).toBe(true);
    expect(viewport.width).toBeCloseTo(400);
    expect(viewport.x).toBeCloseTo(-200);
    expect(viewport.anchorY).toBeCloseTo(962);
  });

  test("ignores normal-blend clouds and other detached decoration", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const layer = new BoneData(1, "All_Layer", root);
    layer.y = 962;
    const background = new BoneData(2, "BG", layer);
    data.bones.push(root, layer, background);
    data.slots.push(new SlotData(0, "wall", background), new SlotData(1, "Cloud", background));
    const skeleton = new Skeleton(data);
    const wall = new RegionAttachment("wall", "wall");
    wall.offset = [-200, 0, -200, 100, 200, 100, 200, 0];
    const cloud = new RegionAttachment("Cloud", "Cloud");
    cloud.offset = [-2000, -500, -2000, 500, 2000, 500, 2000, -500];
    skeleton.slots[0]!.setAttachment(wall);
    skeleton.slots[1]!.setAttachment(cloud);
    skeleton.updateWorldTransform(Physics.update);
    const scene = sceneBounds(skeleton);
    const viewport = authoredViewport(skeleton);
    expect(scene.width).toBeCloseTo(400);
    expect(viewport.width).toBeCloseTo(400);
  });

  test("accepts a generic attachment below a named background root", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const layer = new BoneData(1, "All_Layer", root);
    layer.y = 962;
    const background = new BoneData(2, "Background_Root", layer);
    data.bones.push(root, layer, background);
    data.slots.push(new SlotData(0, "art", background));
    const skeleton = new Skeleton(data);
    const art = new RegionAttachment("art", "art");
    art.offset = [-150, 0, -150, 100, 150, 100, 150, 0];
    skeleton.slots[0]!.setAttachment(art);
    skeleton.updateWorldTransform(Physics.update);
    const viewport = authoredViewport(skeleton);
    expect(viewport.authored).toBe(true);
    expect(viewport.width).toBeCloseTo(300);
  });

  test("recognizes an explicitly named backdrop attached to a PC layer", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const layer = new BoneData(1, "All_Layer", root);
    layer.y = 962;
    const characterLayer = new BoneData(2, "PC_Layer", layer);
    data.bones.push(root, layer, characterLayer);
    data.slots.push(new SlotData(0, "Back_Ground_01", characterLayer));
    const skeleton = new Skeleton(data);
    const background = new RegionAttachment("Back_Ground_01", "Back_Ground_01");
    background.offset = [-160, 0, -160, 100, 160, 100, 160, 0];
    skeleton.slots[0]!.setAttachment(background);
    skeleton.updateWorldTransform(Physics.update);
    const viewport = authoredViewport(skeleton);
    expect(viewport.authored).toBe(true);
    expect(viewport.width).toBeCloseTo(320);
    expect(viewport.anchorY).toBeCloseTo(962);
  });

  test("keeps the authored anchor fixed when a scene parent is animated", () => {
    const setup = authoredScene();
    const animated = authoredScene();
    animated.findBone("All_Layer_01")!.x = 700;
    animated.updateWorldTransform(Physics.update);
    const viewport = authoredViewport(animated, setup);
    expect(viewport.anchorX).toBeCloseTo(0);
    expect(viewport.anchorY).toBeCloseTo(962);
    expect(viewport.width).toBeCloseTo(200);
  });

  test("resolves a camera rig nested under a scaled and offset wrapper", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const wrapper = new BoneData(1, "Scale", root);
    wrapper.x = -178;
    wrapper.y = 43;
    wrapper.scaleX = wrapper.scaleY = 1.13;
    const camera = new BoneData(2, "Main_Camera", wrapper);
    camera.y = 962;
    const layer = new BoneData(3, "All_Layer", camera);
    data.bones.push(root, wrapper, camera, layer);
    data.slots.push(new SlotData(0, "BG", layer));
    const setup = new Skeleton(data);
    const background = new RegionAttachment("BG", "BG");
    background.offset = [-1700, -1300, -1700, 1300, 1700, 1300, 1700, -1300];
    setup.slots[0]!.setAttachment(background);
    setup.updateWorldTransform(Physics.update);
    const animated = new Skeleton(data);
    animated.slots[0]!.setAttachment(background);
    animated.findBone("Main_Camera")!.y += 500;
    animated.updateWorldTransform(Physics.update);
    const viewport = authoredViewport(animated, setup);
    expect(viewport.authored).toBe(true);
    expect(viewport.anchorX).toBeCloseTo(-178);
    expect(viewport.anchorY).toBeCloseTo(43 + 962 * 1.13);
    expect(viewport.width).toBeCloseTo(3400 * 1.13, 2);
    expect(viewport.y + viewport.height / 2).toBeCloseTo(viewport.anchorY);
  });

  test("does not use an independent background layer's offstage origin as the camera center", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const character = new BoneData(1, "PC_Layer", root);
    character.y = -300;
    const backgroundLayer = new BoneData(2, "Background_Layer", root);
    backgroundLayer.y = -500;
    data.bones.push(root, character, backgroundLayer);
    data.slots.push(new SlotData(0, "sky", backgroundLayer), new SlotData(1, "street lamp", backgroundLayer));
    const skeleton = new Skeleton(data);
    const sky = new RegionAttachment("sky", "sky");
    sky.offset = [-1580, 351, -1580, 2531, 1580, 2531, 1580, 351];
    const prop = new RegionAttachment("street lamp", "street lamp");
    prop.offset = [-100, -200, -100, 300, 100, 300, 100, -200];
    skeleton.slots[0]!.setAttachment(sky);
    skeleton.slots[1]!.setAttachment(prop);
    skeleton.updateWorldTransform(Physics.update);
    const viewport = authoredViewport(skeleton);
    expect(viewport.authored).toBe(true);
    expect(viewport.anchorY).toBeCloseTo(941);
    expect(viewport.width).toBeCloseTo(3160);
    expect(viewport.y).toBeGreaterThan(-149);
    expect(viewport.y + viewport.height).toBeLessThan(2031);
  });

  test("keeps backdrops out of the game interaction hit region", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const layer = new BoneData(1, "All_Layer", root);
    data.bones.push(root, layer);
    data.slots.push(new SlotData(0, "background", layer), new SlotData(1, "character", layer));
    const skeleton = new Skeleton(data);
    const background = new RegionAttachment("background", "background");
    background.offset = [-1000, -500, -1000, 500, 1000, 500, 1000, -500];
    const character = new RegionAttachment("character", "character");
    character.offset = [-100, -200, -100, 200, 100, 200, 100, -200];
    skeleton.slots[0]!.setAttachment(background);
    skeleton.slots[1]!.setAttachment(character);
    skeleton.updateWorldTransform(Physics.update);
    const bounds = interactionBounds(skeleton)!;
    expect(bounds.x).toBeCloseTo(-100);
    expect(bounds.y).toBeCloseTo(-200);
    expect(bounds.width).toBeCloseTo(200);
    expect(bounds.height).toBeCloseTo(400);
  });

  test("limits interaction hits to the authored character subtree", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const character = new BoneData(1, "PC", root);
    const prop = new BoneData(2, "Umbrella", root);
    data.bones.push(root, character, prop);
    data.slots.push(new SlotData(0, "character", character), new SlotData(1, "prop", prop));
    const skeleton = new Skeleton(data);
    const characterAttachment = new RegionAttachment("character", "character");
    characterAttachment.offset = [-100, -100, -100, 100, 100, 100, 100, -100];
    const propAttachment = new RegionAttachment("prop", "prop");
    propAttachment.offset = [300, -100, 300, 100, 500, 100, 500, -100];
    skeleton.slots[0]!.setAttachment(characterAttachment);
    skeleton.slots[1]!.setAttachment(propAttachment);
    skeleton.updateWorldTransform(Physics.update);
    expect(interactionHit(skeleton, 0, 0)).toBe(true);
    expect(interactionHit(skeleton, 400, 0)).toBe(false);
  });

  test("uses the authored touch point for patting instead of the whole body", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const character = new BoneData(1, "PC", root);
    const touchPoint = new BoneData(2, "Touch_Point", character);
    touchPoint.y = 300;
    data.bones.push(root, character, touchPoint);
    data.slots.push(new SlotData(0, "Face", character), new SlotData(1, "Body", character));
    const skeleton = new Skeleton(data);
    const face = new RegionAttachment("Face", "Face");
    face.offset = [-100, -100, -100, 100, 100, 100, 100, -100];
    const body = new RegionAttachment("Body", "Body");
    body.offset = [-250, -700, -250, -300, 250, -300, 250, -700];
    skeleton.slots[0]!.setAttachment(face);
    skeleton.slots[1]!.setAttachment(body);
    skeleton.updateWorldTransform(Physics.update);
    expect(interactionHit(skeleton, 0, 300, "pat")).toBe(true);
    expect(interactionHit(skeleton, 0, -500, "pat")).toBe(false);
  });

  test("restricts pinch and touch gestures to cheek areas", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const character = new BoneData(1, "PC", root);
    const cheek = new BoneData(2, "cheek_01", character);
    cheek.x = -80;
    cheek.y = 300;
    data.bones.push(root, character, cheek);
    data.slots.push(new SlotData(0, "Face", character));
    const skeleton = new Skeleton(data);
    const face = new RegionAttachment("Face", "Face");
    face.offset = [-150, 150, -150, 450, 150, 450, 150, 150];
    skeleton.slots[0]!.setAttachment(face);
    skeleton.updateWorldTransform(Physics.update);
    expect(interactionHit(skeleton, -80, 300, "pinch")).toBe(true);
    expect(interactionHit(skeleton, 250, 300, "touch")).toBe(false);
    expect(interactionHit(skeleton, 250, 300, "pinch")).toBe(false);
  });

  test("shared pat and cheek edges choose the nearest region, not pinch priority", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const character = new BoneData(1, "PC", root);
    const point = new BoneData(2, "Touch_Point", character);
    const cheek = new BoneData(3, "cheek_01", character);
    point.y = 300;
    cheek.x = -60;
    cheek.y = 260;
    data.bones.push(root, character, point, cheek);
    data.slots.push(new SlotData(0, "Face", character));
    const skeleton = new Skeleton(data);
    const face = new RegionAttachment("Face", "Face");
    face.offset = [-150, 150, -150, 450, 150, 450, 150, 150];
    skeleton.slots[0]!.setAttachment(face);
    skeleton.updateWorldTransform(Physics.update);
    expect(interactionKindAtPoint(skeleton, -30, 290, ["pinch", "pat"])).toBe("pat");
    expect(interactionKindAtPoint(skeleton, -60, 260, ["pinch", "pat"])).toBe("pinch");
    expect(interactionKindAtPoint(skeleton, -60, 260, ["pat"])).toBe("pat");
    expect(interactionKindAtPoint(skeleton, 500, 0, ["pinch", "pat"])).toBeNull();
  });

  test("uses saved interaction regions when a project provides them", () => {
    const data = new SkeletonData();
    const root = new BoneData(0, "root", null);
    const character = new BoneData(1, "PC", root);
    const cheek = new BoneData(2, "cheek_01", character);
    cheek.x = -80;
    cheek.y = 300;
    data.bones.push(root, character, cheek);
    const skeleton = new Skeleton(data);
    skeleton.updateWorldTransform(Physics.update);
    const regions = [{
      id: "saved-cheek",
      kind: "pinch" as const,
      name: "Saved cheek",
      enabled: true,
      shape: "ellipse" as const,
      anchorBone: "root/PC/cheek_01",
      offsetX: 20,
      offsetY: 10,
      radiusX: 30,
      radiusY: 20,
      rotation: 25,
    }];
    const center = skeleton.findBone("cheek_01")!.localToWorld(new Vector2(20, 10));
    expect(interactionKindAtPoint(skeleton, center.x, center.y, ["pinch"], regions)).toBe("pinch");
    expect(interactionKindAtPoint(skeleton, -150, 300, ["pinch"], regions)).toBeNull();
  });

  test("renderer refits on fullscreen resize while preserving manual zoom", () => {
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    const fit = fitScene(bounds, 800, 450);
    const camera = { viewportWidth: 800, viewportHeight: 450, position: { x: 110, y: 45 }, zoom: fit.zoom / 2, update() {} };
    // Exercise the real resize method without needing a WebGL context.
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      destroyed: false,
      pendingFit: false,
      cameraMode: "fit",
      fitCameraPose: { x: fit.x, y: fit.y, scaleX: fit.zoom, scaleY: fit.zoom },
      bundle: { bounds },
      canvas: { width: 1920, height: 1080 },
      renderer: { camera, resize() { camera.viewportWidth = 1920; camera.viewportHeight = 1080; } },
    });
    renderer.resize();
    expect(camera.zoom).toBeCloseTo(fitScene(bounds, 1920, 1080).zoom / 2);
    expect(camera.position.x).toBe(110);
    expect(camera.position.y).toBe(45);
  });

  test("only interaction mode locks the camera to the authored game view", () => {
    const renderer = Object.assign(Object.create(SpineRenderer.prototype), {
      cameraMode: "game",
      interactionMode: "free",
      pendingFit: false,
    }) as SpineRenderer;
    const state = renderer as unknown as { cameraMode: string; interactionMode: string };
    renderer.setCameraMode("fit");
    expect(state.cameraMode).toBe("fit");
    state.interactionMode = "interaction";
    renderer.setCameraMode("fill");
    expect(state.cameraMode).toBe("fit");
  });
});
