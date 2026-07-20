import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
function createGalleon() {
  const group = new THREE.Group();
  group.name = "galleon";

  // ------------------------------------------------------------------
  // Helpers (all local -- nothing leaks)
  // ------------------------------------------------------------------
  function sstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }

  const HALF_W = 1.75; // hull half-width amidships

  // Plan-view taper: pinches hard toward the bow (-Z), gently toward the stern (+Z)
  function widthFactor(z) {
    const bow = 1 - 0.88 * sstep(-2.5, -8.2, z);
    const stern = 1 - 0.28 * sstep(4.5, 8.2, z);
    return bow * stern;
  }
  function hullHalfAt(z) {
    return HALF_W * widthFactor(z);
  }
  // Sheer line: deck rises toward bow and (more) toward the stern castle
  function sheerAt(z) {
    return 0.32 * sstep(-2.5, -8.2, z) + 0.5 * sstep(3.0, 8.2, z);
  }

  // ------------------------------------------------------------------
  // Materials (MeshStandardMaterial only, aged wood palette)
  // ------------------------------------------------------------------
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x6b5540, roughness: 0.92, metalness: 0.0 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x7d6248, roughness: 0.95, metalness: 0.0 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x42332a, roughness: 0.9, metalness: 0.0 });
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x5c4a34, roughness: 0.88, metalness: 0.0 });
  const sailMat = new THREE.MeshStandardMaterial({
    color: 0xe8e0cc, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide
  });
  const furledMat = new THREE.MeshStandardMaterial({ color: 0xb9ad92, roughness: 0.9, metalness: 0.0 });
  // three pane looks: warm lamplit, dim ember, and unlit dark glass —
  // uniform identical windows are the #1 "fake ship" tell
  const paneBrightMat = new THREE.MeshStandardMaterial({
    color: 0x0d0803, emissive: 0xffb054, emissiveIntensity: 1.25, roughness: 0.35, side: THREE.DoubleSide
  });
  const paneDimMat = new THREE.MeshStandardMaterial({
    color: 0x0d0803, emissive: 0xc06a28, emissiveIntensity: 0.5, roughness: 0.35, side: THREE.DoubleSide
  });
  const paneDarkMat = new THREE.MeshStandardMaterial({
    color: 0x0a0c10, emissive: 0x000000, roughness: 0.18, metalness: 0.4, side: THREE.DoubleSide
  });
  const flagMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9, side: THREE.DoubleSide });
  const brassMat = new THREE.MeshStandardMaterial({ color: 0x8a6b2f, roughness: 0.45, metalness: 0.65 });
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0x442200, emissive: 0xffc978, emissiveIntensity: 1.6, roughness: 0.5
  });

  const noShadow = []; // meshes that must NOT cast shadows (emissive planes / glow)

  function addMesh(geo, mat, x, y, z) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    group.add(m);
    return m;
  }

  // ------------------------------------------------------------------
  // Hull: displaced box, 16 units long. Local y in [-1, 1] before translate.
  // Bow at -Z, stern at +Z. Top face is the deck (material group index 2).
  // ------------------------------------------------------------------
  const hullGeo = new THREE.BoxGeometry(HALF_W * 2, 2.0, 16, 8, 6, 24);
  {
    const p = hullGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      let nx = x * widthFactor(z);
      const below = Math.max(0, -y);           // 0 at deck line, 1 at keel
      nx *= 1 - 0.5 * Math.pow(below, 1.6);    // round the bottom inward
      let ny = y;
      // rake: lift the underside up toward bow stem and stern counter
      const rake = 0.55 * sstep(-5.5, -8.2, z) + 0.35 * sstep(6.0, 8.2, z);
      ny += rake * below;
      // sheer: lift topsides toward bow / stern
      ny += sheerAt(z) * Math.max(0, y);
      p.setXYZ(i, nx, ny, z);
    }
    hullGeo.translate(0, 0.1, 0); // keel bottom -> y = -0.9, deck line -> y = 1.1 (+sheer)
    hullGeo.computeVertexNormals();
  }
  // Box material groups: +x, -x, +y (deck), -y, +z, -z
  const hull = new THREE.Mesh(hullGeo, [hullMat, hullMat, deckMat, hullMat, hullMat, hullMat]);
  group.add(hull);

  // ------------------------------------------------------------------
  // Bulwarks: two thin strips following the hull curve + sheer
  // ------------------------------------------------------------------
  for (const side of [-1, 1]) {
    const bg = new THREE.BoxGeometry(1, 0.5, 12.4, 1, 1, 24);
    const p = bg.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i) - 1.5; // mesh sits at z = -1.5, work in world z
      const hw = hullHalfAt(z);
      p.setX(i, side * (hw - 0.1 + p.getX(i) * 0.11));
      p.setY(i, p.getY(i) + sheerAt(z));
    }
    bg.computeVertexNormals();
    addMesh(bg, trimMat, 0, 1.32, -1.5);
  }

  // ------------------------------------------------------------------
  // Forecastle, deck furniture, raked stem
  // ------------------------------------------------------------------
  addMesh(new THREE.BoxGeometry(1.2, 0.4, 1.8), trimMat, 0, 1.42, -5.2); // forecastle deck
  addMesh(new THREE.BoxGeometry(0.85, 0.12, 1.3), trimMat, 0, 1.16, -1.8); // main hatch
  addMesh(new THREE.CylinderGeometry(0.14, 0.2, 0.34, 10), mastMat, 0, 1.27, 2.3); // capstan
  const stem = addMesh(new THREE.BoxGeometry(0.14, 1.7, 0.5), hullMat, 0, 1.0, -8.0);
  stem.rotation.x = -0.42;

  // ------------------------------------------------------------------
  // Stern castle: three stepped tiers
  // ------------------------------------------------------------------
  addMesh(new THREE.BoxGeometry(3.2, 1.0, 4.0), hullMat, 0, 1.95, 5.9);  // tier 1: y 1.45..2.45
  addMesh(new THREE.BoxGeometry(2.95, 0.8, 2.9), hullMat, 0, 2.85, 6.7); // tier 2: y 2.45..3.25
  addMesh(new THREE.BoxGeometry(2.6, 0.6, 1.8), hullMat, 0, 3.55, 7.3);  // tier 3: y 3.25..3.85

  // Stern-gallery windows: a protruding wooden frame with a recessed,
  // warmly lit pane behind cross mullions — reads as a real opening
  // with lamplight inside rather than a glowing sticker.
  const slatHGeo = new THREE.BoxGeometry(0.34, 0.05, 0.07);  // top + bottom
  const slatVGeo = new THREE.BoxGeometry(0.05, 0.3, 0.07);   // left + right
  const sillGeo = new THREE.BoxGeometry(0.4, 0.045, 0.1);
  const paneGeo = new THREE.PlaneGeometry(0.26, 0.32);
  const mullVGeo = new THREE.BoxGeometry(0.026, 0.3, 0.02);
  const mullHGeo = new THREE.BoxGeometry(0.26, 0.026, 0.02);
  // all windows collapse into merged meshes (one trim + one per pane
  // look) so the stern gallery stays a handful of draw calls
  const windowTrimGeos = [];
  const windowPaneGeos = [[], [], []]; // bright / dim / dark buckets
  let windowIndex = 0;
  const winMatrix = new THREE.Matrix4();
  const winQuat = new THREE.Quaternion();
  const winEuler = new THREE.Euler();
  const ONE = new THREE.Vector3(1, 1, 1);
  function pushPart(list, geo, ox, oy, oz) {
    const g = geo.clone();
    g.translate(ox, oy, oz);
    g.applyMatrix4(winMatrix);
    list.push(g);
  }
  function addWindow(x, y, z, ry) {
    winEuler.set(0, ry, 0);
    winQuat.setFromEuler(winEuler);
    winMatrix.compose(new THREE.Vector3(x, y, z), winQuat, ONE);
    pushPart(windowTrimGeos, slatHGeo, 0, 0.175, 0);
    pushPart(windowTrimGeos, slatHGeo, 0, -0.175, 0);
    pushPart(windowTrimGeos, slatVGeo, -0.145, 0, 0);
    pushPart(windowTrimGeos, slatVGeo, 0.145, 0, 0);
    pushPart(windowTrimGeos, sillGeo, 0, -0.215, 0.012);
    pushPart(windowTrimGeos, mullVGeo, 0, 0, 0.008);
    pushPart(windowTrimGeos, mullHGeo, 0, 0, 0.008);
    // deterministic scatter of lamplit / ember / dark rooms
    const bucket = [0, 2, 0, 1, 0, 2, 1, 0, 1, 0, 2, 0, 1, 0, 0, 2, 1][windowIndex % 17];
    windowIndex++;
    pushPart(windowPaneGeos[bucket], paneGeo, 0, 0, -0.02); // recessed behind slat fronts
  }
  function buildWindows() {
    const trim = new THREE.Mesh(mergeGeometries(windowTrimGeos), trimMat);
    group.add(trim);
    const paneMats = [paneBrightMat, paneDimMat, paneDarkMat];
    for (let b = 0; b < 3; b++) {
      if (!windowPaneGeos[b].length) continue;
      const panes = new THREE.Mesh(mergeGeometries(windowPaneGeos[b]), paneMats[b]);
      group.add(panes);
      noShadow.push(panes);
    }
    // gallery ledges between the stern tiers ground the window rows
    addMesh(new THREE.BoxGeometry(3.15, 0.09, 0.16), trimMat, 0, 2.45, 7.94);
    addMesh(new THREE.BoxGeometry(2.75, 0.08, 0.16), trimMat, 0, 3.25, 8.18);
    group.userData.paneMats = { bright: paneBrightMat, dim: paneDimMat };
  }
  for (const x of [-1.05, -0.35, 0.35, 1.05]) addWindow(x, 1.95, 7.93, 0); // tier 1 stern
  for (const x of [-0.7, 0, 0.7]) addWindow(x, 2.85, 8.18, 0);             // tier 2 stern
  for (const x of [-0.45, 0.45]) addWindow(x, 3.55, 8.23, 0);              // tier 3 stern
  for (const z of [4.7, 5.9, 7.1]) {                                       // tier 1 sides
    addWindow(1.62, 1.95, z, Math.PI / 2);
    addWindow(-1.62, 1.95, z, -Math.PI / 2);
  }
  buildWindows();

  // Stern lantern (brass + glow)
  addMesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 6), brassMat, 0, 4.05, 7.9);
  const lampGlow = addMesh(new THREE.SphereGeometry(0.13, 10, 8), glowMat, 0, 4.32, 7.9);
  noShadow.push(lampGlow);
  addMesh(new THREE.ConeGeometry(0.11, 0.14, 8), brassMat, 0, 4.5, 7.9);

  // ------------------------------------------------------------------
  // Bowsprit: angled spar off the bow
  // rotation.x = phi - PI/2 maps cylinder +Y to (0, sin(phi), -cos(phi))
  // center (0, 1.9, -7.8), len 4.6 -> tip at (0, 2.75, -9.93)
  // ------------------------------------------------------------------
  const bowsprit = addMesh(new THREE.CylinderGeometry(0.055, 0.09, 4.6, 8), mastMat, 0, 1.9, -7.8);
  bowsprit.rotation.x = 0.38 - Math.PI / 2;

  // ------------------------------------------------------------------
  // Masts (fore 9u @ z=-4.2, main 11u @ z=0.5, mizzen 7.5u @ z=4.6)
  // ------------------------------------------------------------------
  addMesh(new THREE.CylinderGeometry(0.09, 0.14, 9, 10), mastMat, 0, 5.0, -4.2);  // fore: 0.5..9.5
  addMesh(new THREE.CylinderGeometry(0.1, 0.16, 11, 10), mastMat, 0, 5.9, 0.5);   // main: 0.4..11.4
  addMesh(new THREE.CylinderGeometry(0.08, 0.12, 7.5, 10), mastMat, 0, 4.35, 4.6); // mizzen: 0.6..8.1

  // Fighting-top platforms
  addMesh(new THREE.CylinderGeometry(0.36, 0.36, 0.1, 12), trimMat, 0, 6.35, -4.2);
  addMesh(new THREE.CylinderGeometry(0.38, 0.38, 0.1, 12), trimMat, 0, 7.65, 0.5);
  addMesh(new THREE.CylinderGeometry(0.32, 0.32, 0.1, 12), trimMat, 0, 5.45, 4.6);

  // ------------------------------------------------------------------
  // Yards and square sails (fore + main, two each)
  // ------------------------------------------------------------------
  function addYard(z, y, len, radius) {
    const yd = addMesh(new THREE.CylinderGeometry(radius, radius, len, 8), trimMat, 0, y, z);
    yd.rotation.z = Math.PI / 2;
    return yd;
  }

  function addSquareSail(z, y, w, h) {
    const geo = new THREE.PlaneGeometry(w, h, 10, 10);
    const p = geo.attributes.position;
    const depth = w * 0.22;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / w + 0.5;
      const v = p.getY(i) / h + 0.5;
      const b = Math.sin(u * Math.PI) * (0.3 + 0.7 * Math.sin(v * Math.PI));
      p.setZ(i, -depth * b); // billow bulges toward -Z (toward the bow)
    }
    geo.computeVertexNormals();
    addMesh(geo, sailMat, 0, y, z);
  }

  // Fore mast (z = -4.2)
  addYard(-4.34, 5.0, 3.8, 0.05);
  addSquareSail(-4.38, 3.95, 3.4, 2.0);  // course: top edge y=4.95 under the yard
  addYard(-4.34, 7.2, 3.0, 0.045);
  addSquareSail(-4.37, 6.32, 2.7, 1.7);  // topsail

  // Main mast (z = 0.5)
  addYard(0.36, 5.8, 4.4, 0.055);
  addSquareSail(0.32, 4.55, 4.0, 2.4);   // course
  addYard(0.36, 8.6, 3.4, 0.05);
  addSquareSail(0.33, 7.55, 3.0, 2.0);   // topsail

  // Furled sails: yard + rolled canvas cylinder wrapped on it
  addYard(0.38, 10.3, 2.6, 0.045);       // main topgallant yard, furled
  const furlA = addMesh(new THREE.CylinderGeometry(0.1, 0.1, 2.35, 8), furledMat, 0, 10.3, 0.38);
  furlA.rotation.z = Math.PI / 2;
  addYard(4.48, 4.9, 2.9, 0.045);        // mizzen cro'jack yard, furled
  const furlB = addMesh(new THREE.CylinderGeometry(0.1, 0.1, 2.6, 8), furledMat, 0, 4.9, 4.48);
  furlB.rotation.z = Math.PI / 2;

  // ------------------------------------------------------------------
  // Mizzen gaff sail (triangular, fore-aft) + gaff spar + boom
  // Shape x maps to world +Z via rotation.y = -PI/2; origin at (0, 3.9, 4.6)
  // ------------------------------------------------------------------
  const gaffShape = new THREE.Shape();
  gaffShape.moveTo(0, 0);        // mast, y = 3.9
  gaffShape.lineTo(2.3, 0.5);    // aft clew, z = 6.9, y = 4.4
  gaffShape.lineTo(0, 2.6);      // mast, y = 6.5
  gaffShape.lineTo(0, 0);
  const gaffSail = addMesh(new THREE.ShapeGeometry(gaffShape), sailMat, 0, 3.9, 4.6);
  gaffSail.rotation.y = -Math.PI / 2;
  const gaffSpar = addMesh(new THREE.CylinderGeometry(0.04, 0.04, 3.1, 8), trimMat, 0, 5.45, 5.75);
  gaffSpar.rotation.x = Math.atan2(2.3, -2.1); // +Y -> (0,cos,sin): along (0,-2.1,2.3) edge
  const boom = addMesh(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 8), trimMat, 0, 4.15, 5.75);
  boom.rotation.x = Math.atan2(2.3, 0.5); // along (0,0.5,2.3) edge

  // ------------------------------------------------------------------
  // Black pennant at the main masthead, streaming toward -Z (with the wind)
  // ------------------------------------------------------------------
  const flagGeo = new THREE.PlaneGeometry(1.4, 0.34, 8, 2);
  {
    const p = flagGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / 1.4 + 0.5;      // 0 at hoist, 1 at fly
      p.setY(i, p.getY(i) * (1 - 0.6 * u)); // taper to a pennant point
      p.setZ(i, 0.1 * Math.sin(u * 6.0) * u); // wind ripple grows toward the fly
    }
    flagGeo.translate(0.7, 0, 0); // hoist edge at local x = 0
    flagGeo.computeVertexNormals();
  }
  const flag = addMesh(flagGeo, flagMat, 0, 11.35, 0.5);
  flag.rotation.y = Math.PI / 2; // local +X -> world -Z

  // ------------------------------------------------------------------
  // Rigging web: 42 LineSegments (shrouds, stays, lifts, braces, bobstay)
  // ------------------------------------------------------------------
  const rig = [];
  function line(ax, ay, az, bx, by, bz) {
    rig.push(ax, ay, az, bx, by, bz);
  }

  // Shrouds: masthead down to the hull sides (4 per side per mast = 24)
  const shroudPlan = [
    { z: -4.2, top: 6.3, feet: [-5.1, -4.5, -3.9, -3.3] }, // fore
    { z: 0.5, top: 7.6, feet: [-0.4, 0.1, 0.7, 1.3] },     // main
    { z: 4.6, top: 5.4, feet: [3.7, 4.2, 4.8, 5.3] }       // mizzen
  ];
  for (const m of shroudPlan) {
    for (const side of [-1, 1]) {
      for (const fz of m.feet) {
        line(side * 0.1, m.top, m.z, side * (hullHalfAt(fz) + 0.02), 1.45 + sheerAt(fz), fz);
      }
    }
  }

  // Stays + bobstay (6)
  line(0, 2.75, -9.93, 0, 9.4, -4.2);   // bowsprit tip -> fore masthead
  line(0, 2.14, -8.4, 0, 6.3, -4.2);    // bowsprit mid -> fore top
  line(0, 9.4, -4.2, 0, 11.3, 0.5);     // fore head -> main head
  line(0, 11.3, 0.5, 0, 8.0, 4.6);      // main head -> mizzen head
  line(0, 8.0, 4.6, 0, 3.95, 7.5);      // mizzen head -> poop deck
  line(0, 2.75, -9.93, 0, 0.35, -7.9);  // bobstay -> stem at the waterline

  // Lifts: lower yard tips up to mastheads (4)
  for (const side of [-1, 1]) {
    line(side * 1.9, 5.0, -4.34, 0, 8.8, -4.2);
    line(side * 2.2, 5.8, 0.36, 0, 10.6, 0.5);
  }

  // Braces: yard tips angled aft to the next mast (8)
  for (const side of [-1, 1]) {
    line(side * 1.9, 5.0, -4.34, 0, 6.5, 0.5);  // fore course -> main mast
    line(side * 1.5, 7.2, -4.34, 0, 8.2, 0.5);  // fore topsail -> main mast
    line(side * 2.2, 5.8, 0.36, 0, 5.8, 4.6);   // main course -> mizzen mast
    line(side * 1.7, 8.6, 0.36, 0, 7.7, 4.6);   // main topsail -> mizzen head
  }

  const rigGeo = new THREE.BufferGeometry();
  rigGeo.setAttribute("position", new THREE.Float32BufferAttribute(rig, 3));
  const rigging = new THREE.LineSegments(
    rigGeo,
    new THREE.LineBasicMaterial({ color: 0x14100c, transparent: true, opacity: 0.8 })
  );
  group.add(rigging);

  // ------------------------------------------------------------------
  // Shadows: all solid meshes cast/receive; emissive planes and glow do not cast
  // ------------------------------------------------------------------
  group.traverse(function (o) {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  for (const m of noShadow) m.castShadow = false;

  return group;
}

export { createGalleon };
