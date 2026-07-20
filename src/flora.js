import * as THREE from "three";
// flora.js — procedural beach props for Three.js r0.185
// Paste into a module that already has: import * as THREE from "three"
// Fully deterministic: every value derives from an inline LCG keyed on seedIndex.

function createPalmTree(seedIndex = 0) {
  // ---- deterministic PRNG (LCG keyed on seedIndex) ----
  let _s = (Math.imul(seedIndex + 1, 2654435761) ^ 0x9e3779b9) >>> 0;
  function rand() {
    _s = (Math.imul(_s, 1664525) + 1013904223) >>> 0;
    return _s / 4294967296;
  }
  function randRange(a, b) {
    return a + (b - a) * rand();
  }

  const group = new THREE.Group();
  const up = new THREE.Vector3(0, 1, 0);

  // ================= trunk =================
  // Crown fronds add roughly 1.3–1.6 above the trunk tip, so total tree
  // height lands in ~5.2–7.0 units.
  const trunkHeight = randRange(3.9, 5.3);
  const lean = randRange(0.5, 1.2); // total horizontal offset of the tip
  const leanDir = rand() * Math.PI * 2;
  const leanX = Math.cos(leanDir);
  const leanZ = Math.sin(leanDir);
  const segCount = 6 + Math.floor(rand() * 4); // 6–9 stacked segments
  const baseRadius = randRange(0.16, 0.2);
  const topRadius = baseRadius * 0.55;

  // Smooth curve: nearly straight at the base, bending more toward the top.
  function trunkPoint(t) {
    const bend = Math.pow(t, 1.7);
    return new THREE.Vector3(leanX * lean * bend, t * trunkHeight, leanZ * lean * bend);
  }
  function trunkRadius(t) {
    return baseRadius + (topRadius - baseRadius) * t;
  }

  const barkA = new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.95 });
  const barkB = new THREE.MeshStandardMaterial({ color: 0x75593e, roughness: 0.95 });

  for (let i = 0; i < segCount; i++) {
    const t0 = i / segCount;
    const t1 = (i + 1) / segCount;
    const p0 = trunkPoint(t0);
    const p1 = trunkPoint(t1);
    const dir = new THREE.Vector3().subVectors(p1, p0);
    const len = dir.length();
    dir.normalize();
    // Radii match at shared curve points (trunkRadius(t) is continuous), and
    // the 8% length overlap hides the tiny outer wedge where angled
    // neighbours meet — segments read as one continuous curved trunk.
    const geo = new THREE.CylinderGeometry(trunkRadius(t1), trunkRadius(t0), len * 1.08, 7, 1, true);
    const seg = new THREE.Mesh(geo, i % 2 === 0 ? barkA : barkB);
    seg.quaternion.setFromUnitVectors(up, dir); // cylinder axis -> segment direction
    seg.position.copy(p0).add(p1).multiplyScalar(0.5); // centred on the segment midpoint
    group.add(seg);
  }

  // ================= crown =================
  const crown = new THREE.Group();
  const pTop = trunkPoint(1);
  const pNear = trunkPoint(1 - 1 / segCount);
  const topTangent = new THREE.Vector3().subVectors(pTop, pNear).normalize();
  crown.position.copy(pTop);
  // Tilt the whole crown to follow the trunk's tip direction.
  crown.quaternion.setFromUnitVectors(up, topTangent);
  group.add(crown);

  const greenA = new THREE.Color(0x2d5c2a).lerp(new THREE.Color(0x3a7a35), rand());
  const greenB = greenA.clone().offsetHSL(0.01, 0.05, 0.035);
  const frondMatA = new THREE.MeshStandardMaterial({
    color: greenA,
    roughness: 0.9,
    side: THREE.DoubleSide
  });
  const frondMatB = new THREE.MeshStandardMaterial({
    color: greenB,
    roughness: 0.9,
    side: THREE.DoubleSide
  });

  // Bend a fresh (unshared) plane into a tapered, drooping, V-folded frond.
  // Local space: base at origin, length along +Y, curling toward +Z.
  function buildFrondGeometry(arcAngle, foldK) {
    const geo = new THREE.PlaneGeometry(0.55, 2.4, 1, 10);
    geo.translate(0, 1.2, 0); // base of the frond at y = 0
    const pos = geo.attributes.position;
    const R = 2.4 / arcAngle; // circular arc of matching arclength
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const y = pos.getY(v);
      const s = y / 2.4; // 0 at base -> 1 at tip
      const xt = x * (1 - 0.82 * s); // taper toward the tip
      const a = arcAngle * s;
      const ny = R * Math.sin(a); // drooping arc
      const nz = R * (1 - Math.cos(a)) + Math.abs(xt) * foldK; // arc + midrib V-fold
      pos.setXYZ(v, xt, ny, nz);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  const frondCount = 7 + Math.floor(rand() * 4); // 7–10 fronds
  for (let i = 0; i < frondCount; i++) {
    // Even radial spread with jitter, plus per-frond droop variation.
    const azimuth = (i / frondCount) * Math.PI * 2 + randRange(-0.25, 0.25);
    const droopBias = rand(); // 0 = upright top frond, 1 = saggy lower frond
    const tilt = 0.4 + droopBias * 0.95; // pitch away from vertical
    const arcAngle = 0.85 + droopBias * 0.8 + randRange(-0.1, 0.1);
    const frond = new THREE.Mesh(
      buildFrondGeometry(arcAngle, randRange(0.15, 0.3)),
      i % 2 === 0 ? frondMatA : frondMatB
    );
    frond.scale.setScalar(randRange(0.85, 1.1));
    // "YXZ": yaw around the crown axis first, then pitch outward/down.
    frond.rotation.order = "YXZ";
    frond.rotation.y = azimuth;
    frond.rotation.x = tilt;
    frond.rotation.z = randRange(-0.15, 0.15); // slight roll for variety
    frond.position.y = 0.05;
    crown.add(frond);
  }

  // ================= coconuts =================
  const cocoMat = new THREE.MeshStandardMaterial({ color: 0x5c4529, roughness: 0.85 });
  const cocoGeo = new THREE.SphereGeometry(0.11, 7, 5);
  const cocoCount = 2 + Math.floor(rand() * 3); // 2–4
  for (let i = 0; i < cocoCount; i++) {
    const nut = new THREE.Mesh(cocoGeo, cocoMat);
    const a = rand() * Math.PI * 2;
    const r = randRange(0.12, 0.22);
    nut.position.set(Math.cos(a) * r, randRange(-0.14, -0.04), Math.sin(a) * r);
    nut.scale.setScalar(randRange(0.8, 1.1));
    crown.add(nut);
  }

  group.traverse(function (obj) {
    if (obj.isMesh) obj.castShadow = true;
  });

  return group;
}

function createBeachRock(seedIndex = 0) {
  // ---- deterministic PRNG (LCG keyed on seedIndex) ----
  let _s = (Math.imul(seedIndex + 1, 2246822519) ^ 0x85ebca6b) >>> 0;
  function rand() {
    _s = (Math.imul(_s, 1664525) + 1013904223) >>> 0;
    return _s / 4294967296;
  }

  // Position-keyed hash: IcosahedronGeometry is non-indexed (vertex soup),
  // so coincident vertices MUST get identical displacement or the surface
  // cracks open. Rounding to 3 decimals welds them; seedIndex is folded in
  // so every rock is different.
  const seedFold = Math.imul(seedIndex + 1, 374761393) >>> 0;
  function vertexHash01(x, y, z) {
    const kx = Math.round(x * 1000);
    const ky = Math.round(y * 1000);
    const kz = Math.round(z * 1000);
    let h = (2166136261 ^ seedFold) >>> 0;
    h = Math.imul(h ^ kx, 16777619);
    h = Math.imul(h ^ ky, 16777619);
    h = Math.imul(h ^ kz, 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }

  const geo = new THREE.IcosahedronGeometry(0.6, 1);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const u = vertexHash01(v.x, v.y, v.z);
    v.multiplyScalar(1 + (u - 0.5) * 0.5); // radial displacement, ±25%
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.scale(1, 0.75, 1); // flatten into a squat boulder
  geo.computeVertexNormals(); // after displacement AND flatten

  const color = new THREE.Color(0x7d6650);
  color.offsetHSL((rand() - 0.5) * 0.03, (rand() - 0.5) * 0.08, (rand() - 0.5) * 0.07);
  const mat = new THREE.MeshStandardMaterial({ color: color, roughness: 1 });

  const rock = new THREE.Mesh(geo, mat);
  rock.rotation.y = rand() * Math.PI * 2; // free extra variety
  rock.castShadow = true;
  rock.receiveShadow = true;
  return rock;
}

export { createPalmTree, createBeachRock };
