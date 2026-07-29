import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createPalmTree, createBeachRock } from "./flora.js";
import { createGalleon } from "./galleon.js";

const PRESETS = {
  Calm: { wind: 0.8, waveHeight: 0.34, foam: 0.14, time: 9.2, clouds: 0.18, exposure: 1.02, rain: 0 },
  Azure: { wind: 2.6, waveHeight: 0.72, foam: 0.42, time: 13.6, clouds: 0.22, exposure: 1.05, rain: 0 },
  Golden: { wind: 1.9, waveHeight: 0.6, foam: 0.3, time: 17.9, clouds: 0.34, exposure: 1.1, rain: 0 },
  Rain: { wind: 3.4, waveHeight: 0.85, foam: 0.5, time: 15.2, clouds: 0.8, exposure: 0.95, rain: 0.6 },
  Storm: { wind: 6.6, waveHeight: 1.5, foam: 0.9, time: 16.4, clouds: 0.94, exposure: 0.82, rain: 0.2 },
  Tempest: { wind: 7.4, waveHeight: 1.75, foam: 0.95, time: 17.4, clouds: 0.98, exposure: 0.72, rain: 1 },
};

const state = { ...PRESETS.Azure, autopilot: true };

/* ------------------------------------------------------------------ */
/* Wave spectrum — shared between GLSL and the JS sampler for props.  */
/* angle (deg), wavelength (m), base amplitude (m), steepness Q       */
/* ------------------------------------------------------------------ */
const WAVE_SPEC = [
  [-8, 62, 0.205, 0.34],
  [14, 39, 0.167, 0.38],
  [58, 30, 0.075, 0.4],
  [-28, 24, 0.135, 0.44],
  [-50, 18.5, 0.062, 0.48],
  [33, 15.5, 0.108, 0.5],
  [5, 10.2, 0.088, 0.55],
  [40, 8.3, 0.045, 0.58],
  [-42, 6.8, 0.071, 0.62],
  [24, 4.4, 0.055, 0.68],
  [-33, 3.5, 0.028, 0.69],
  [-15, 2.9, 0.045, 0.7],
  [49, 1.9, 0.034, 0.72],
  [-55, 1.25, 0.026, 0.74],
];
const NW = WAVE_SPEC.length;
const BASE_HEIGHT = 0.72; // slider value at which base amplitudes apply
const G = 9.81;
const ENV_EPS = 0.35; // group-envelope wavenumber ratio (sets are ~1/0.35 wavelengths long)

// Static per-wave data. Group envelopes travel at half the phase speed
// (deep-water group velocity), which is what makes wave "sets" look real.
const WAVE_STATIC = WAVE_SPEC.map(([deg, L, A, Q], i) => {
  const k = (2 * Math.PI) / L;
  const a = (deg * Math.PI) / 180;
  return {
    kx: Math.cos(a) * k,
    ky: Math.sin(a) * k,
    k,
    omega: Math.sqrt(G * k),
    amp: A,
    q: Q,
    seed: (i * 2.399963) % (2 * Math.PI),
    // long waves ride in pronounced groups; capillary chop barely does
    envDepth: THREE.MathUtils.lerp(0.45, 0.16, THREE.MathUtils.smoothstep(k, 0.3, 2.2)),
  };
});

// Live per-frame wave data (amp/q scaled by sliders, phases wrapped in
// float64 so float32 uniforms never lose precision), mirrored into uniforms.
const waveLive = WAVE_STATIC.map(() => ({ kx: 0, ky: 0, amp: 0, q: 0, phase: 0, gphase: 0, omega: 0, envDepth: 0 }));

const TWO_PI = Math.PI * 2;

function updateWaveLive(waveHeight, wind, t) {
  const heightScale = (waveHeight / BASE_HEIGHT) * 0.85;
  const windAmp = THREE.MathUtils.clamp(0.3 + wind * 0.24, 0.3, 1.55);
  const chop = THREE.MathUtils.clamp(0.48 + wind * 0.15, 0.5, 1.35);
  for (let i = 0; i < NW; i++) {
    const s = WAVE_STATIC[i];
    const live = waveLive[i];
    // short waves fade out in low wind (glassy calm), grow in high wind
    const shortness = THREE.MathUtils.smoothstep(s.k, 0.28, 2.6);
    live.kx = s.kx;
    live.ky = s.ky;
    live.omega = s.omega;
    live.amp = s.amp * heightScale * THREE.MathUtils.lerp(1, windAmp, shortness);
    live.q = Math.min(s.q * chop, 1.15);
    live.envDepth = s.envDepth;
    live.phase = (s.omega * t + s.seed) % TWO_PI;
    live.gphase = (ENV_EPS * 0.5 * s.omega * t + s.seed * 1.7) % TWO_PI;
  }
}

/* ------------------------------------------------------------------ */
/* Terrain — one island rising from a sandy seabed. The profile is    */
/* shared by the floor meshes, the water shader (refraction + shore   */
/* foam), and JS prop placement.                                      */
/* ------------------------------------------------------------------ */
const SEA_DEPTH = 7.2;
const ISLAND = { x: -26, z: -52, r: 30, peak: 8.9 }; // peak-SEA_DEPTH = +1.7m cay

function islandProfile(x, z) {
  const d = Math.hypot(x - ISLAND.x, z - ISLAND.z) / ISLAND.r;
  if (d >= 1) return 0;
  return Math.pow(Math.cos(d * Math.PI * 0.5), 1.7) * ISLAND.peak;
}

function duneNoise(x, z) {
  return (
    Math.sin(x * 0.051 + z * 0.083) * 0.3 +
    Math.sin(x * 0.11 - z * 0.061 + 2.1) * 0.17 +
    Math.sin(-x * 0.023 + z * 0.037 + 4.2) * 0.22
  );
}

function floorHeight(x, z) {
  const island = islandProfile(x, z);
  // dunes fade out on the island slope so the beach stays clean
  const duneFade = Math.max(0, 1 - island / 2.5);
  return -SEA_DEPTH + island + duneNoise(x, z) * 0.4 * duneFade;
}

// GLSL twin of islandProfile + base depth (dunes omitted — invisible through refraction)
const glslFloorHeight = /* glsl */ `
  float floorHeightApprox(vec2 p) {
    float d = distance(p, vec2(${ISLAND.x.toFixed(1)}, ${ISLAND.z.toFixed(1)})) / ${ISLAND.r.toFixed(1)};
    float island = d < 1.0 ? pow(cos(d * 1.5707963), 1.7) * ${ISLAND.peak.toFixed(2)} : 0.0;
    return -${SEA_DEPTH.toFixed(1)} + island;
  }
`;

function sampleWave(x, z, t) {
  let h = 0;
  for (let i = 0; i < NW; i++) {
    const w = waveLive[i];
    const along = w.kx * x + w.ky * z;
    const env = 1 + w.envDepth * Math.sin(ENV_EPS * along - w.gphase);
    h += w.amp * env * Math.sin(along - w.phase);
  }
  return h;
}

function sampleSlope(x, z, t, step) {
  const h = sampleWave(x, z, t);
  return {
    h,
    dx: sampleWave(x + step, z, t) - h,
    dz: sampleWave(x, z + step, t) - h,
  };
}

/* ------------------------------------------------------------------ */
/* Sky shader — Rayleigh/Mie scattering (Preetham-style, adapted from */
/* the three.js Sky example) + procedural clouds, stars and moon.     */
/* ------------------------------------------------------------------ */
const skyVertex = /* glsl */ `
  varying vec3 vWorldPosition;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
    gl_Position.z = gl_Position.w; // pin to far plane
  }
`;

const skyFragment = /* glsl */ `
  varying vec3 vWorldPosition;
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform float uTurbidity;
  uniform float uRayleigh;
  uniform float uMieCoefficient;
  uniform float uMieDirectionalG;
  uniform float uTime;
  uniform float uCloudCover;
  uniform float uDay;
  uniform float uSkyGamma;
  uniform float uSkyGain;
  uniform float uSkyLift;
  uniform float uSkySat;
  uniform float uHazeBand;
  uniform float uHazeMix;
  uniform float uCloudScale;
  uniform float uCloudSharp;
  uniform vec3 uSunTint;
  uniform vec3 uCloudAmbient;
  uniform vec3 uFogColor;
  uniform vec3 uUnderFog;
  uniform float uUnderwater;
  uniform float uLightning;
  uniform float uRainSky;

  const vec3 up = vec3(0.0, 1.0, 0.0);
  const float pi = 3.141592653589793;
  const vec3 totalRayleigh = vec3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5);
  const vec3 mieConst = vec3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14);
  const float cutoffAngle = 1.6110731556870734;
  const float steepness = 1.5;
  const float EE = 1000.0;

  float sunIntensity(float zenithAngleCos) {
    zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
    return EE * max(0.0, 1.0 - pow(2.718281828, -((cutoffAngle - acos(zenithAngleCos)) / steepness)));
  }
  vec3 totalMie(float t) {
    float c = (0.2 * t) * 10e-18;
    return 0.434 * c * mieConst;
  }
  float rayleighPhase(float cosTheta) { return (3.0 / (16.0 * pi)) * (1.0 + cosTheta * cosTheta); }
  float hgPhase(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 / (4.0 * pi)) * ((1.0 - g2) / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5));
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
      mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < FBM_OCT; i++) { v += a * vnoise(p); p = p * 2.11 + vec2(13.7, 7.3); a *= 0.52; }
    return v;
  }
  float vnoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i);
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
  }
  float fbm3(vec3 p) {
    return vnoise3(p) * 0.62 + vnoise3(p * 2.73 + 11.3) * 0.38;
  }

  const float CLOUD_BASE = 700.0;
  const float CLOUD_TOP = 1750.0;
  // dedicated 3-octave coverage noise — the full FBM_OCT fbm is too
  // expensive inside a raymarch loop
  float cloudFbm(vec2 p) {
    float v = vnoise(p) * 0.52;
    p = p * 2.11 + vec2(13.7, 7.3);
    v += vnoise(p) * 0.28;
    p = p * 2.11 + vec2(13.7, 7.3);
    return v + vnoise(p) * 0.2;
  }
  // coarse mass only — used by the shadow probes
  float cloudMass(vec3 pos, vec2 windDrift, float covLo) {
    float y01 = clamp((pos.y - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE), 0.0, 1.0);
    vec2 cuv = pos.xz * 0.00042 * uCloudScale + windDrift * 0.001;
    float mass = smoothstep(covLo, covLo + 0.42, cloudFbm(cuv));
    float prof = smoothstep(0.0, 0.08, y01) * smoothstep(1.0, 0.35 + mass * 0.45, y01);
    return mass * prof;
  }
  float cloudField(vec3 pos, vec2 windDrift, float covLo, float rayDist) {
    float y01 = clamp((pos.y - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE), 0.0, 1.0);
    vec2 cuv = pos.xz * 0.00042 * uCloudScale + windDrift * 0.001;
    float mass = smoothstep(covLo, covLo + 0.42, cloudFbm(cuv));
    if (mass < 0.015) return 0.0; // empty air: skip the expensive 3D work
    // true 3D base modulation: without this the 2D coverage smears into
    // striation lines along the view ray
    float m3 = vnoise3(vec3(pos.x + windDrift.x * 2.4, pos.y * 1.45, pos.z + windDrift.y * 2.4) * 0.0011);
    mass *= 0.58 + 0.62 * m3;
    float prof = smoothstep(0.0, 0.08, y01) * smoothstep(1.0, 0.22 + mass * 0.62, y01);
    float shape = mass * prof;
    if (shape < 0.01) return 0.0;
    float eroAmp = 0.62 * (1.0 + (1.0 - covLo) * 0.55);
    float ero = fbm3(vec3(pos.x + windDrift.x * 2.4, pos.y * 1.6, pos.z + windDrift.y * 2.4) * 0.0023);
    float d = clamp((shape - (ero - 0.38) * eroAmp * (1.15 - shape)) * 1.7 - 0.22, 0.0, 1.0);
    return d * smoothstep(0.04, 0.3, mass);
  }

  void main() {
    vec3 direction = normalize(vWorldPosition - cameraPosition);

    /* ---- Rayleigh / Mie scattering ---- */
    float sunfade = 1.0 - clamp(1.0 - exp(uSunDir.y * 2.4), 0.0, 1.0);
    float rayleighCoefficient = uRayleigh - (1.0 - sunfade);
    vec3 betaR = totalRayleigh * rayleighCoefficient;
    vec3 betaM = totalMie(uTurbidity) * uMieCoefficient;
    float sunE = sunIntensity(dot(uSunDir, up));

    // lift low elevations toward the zenith hue so the visible band stays blue
    float yAtmo = mix(max(direction.y, 0.0), 0.42, uSkyLift * (1.0 - max(direction.y, 0.0)));
    float zenithAngle = acos(min(yAtmo, 1.0));
    float inverseZ = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
    float sR = 8400.0 * inverseZ;
    float sM = 1250.0 * inverseZ;
    vec3 Fex = exp(-(betaR * sR + betaM * sM));

    float cosTheta = dot(direction, uSunDir);
    vec3 betaRTheta = betaR * rayleighPhase(cosTheta * 0.5 + 0.5);
    vec3 betaMTheta = betaM * hgPhase(cosTheta, uMieDirectionalG);
    vec3 Lin = pow(sunE * ((betaRTheta + betaMTheta) / (betaR + betaM)) * (1.0 - Fex), vec3(1.5));
    Lin *= mix(vec3(1.0),
      pow(sunE * ((betaRTheta + betaMTheta) / (betaR + betaM)) * Fex, vec3(0.5)),
      clamp(pow(1.0 - dot(up, uSunDir), 5.0), 0.0, 1.0));

    vec3 L0 = vec3(0.1) * Fex;
    vec3 sky = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
    sky = pow(sky, vec3(1.0 / (uSkyGamma + uSkyGamma * sunfade)));
    sky *= uSkyGain; // the Preetham fit is calibrated for ~0.5 exposure; rescale for ours
    float skyLuma = dot(sky, vec3(0.2126, 0.7152, 0.0722));
    sky = max(mix(vec3(skyLuma), sky, uSkySat), 0.0);
    sky *= 1.0 - uCloudCover * 0.66; // heavy overcast blocks direct scattering
    sky *= 1.0 - uRainSky * 0.45;    // a downpour blackens the whole vault

    /* ---- night sky base ---- */
    float night = 1.0 - uDay;
    float deepNight = smoothstep(0.72, 1.0, night);
    vec3 nightSky = mix(vec3(0.012, 0.021, 0.045), vec3(0.001, 0.003, 0.01), clamp(direction.y * 1.4 + 0.2, 0.0, 1.0));
    sky += nightSky * night;

    /* ---- stars + milky way (skipped in the mirror pass) ---- */
    #ifndef MIRROR_PASS
    if (deepNight > 0.02 && direction.y > 0.0) {
      vec3 sd = floor(direction * 340.0);
      float star = step(0.9986, hash13(sd));
      float mag = hash13(sd + 17.0);
      float twinkle = 0.72 + 0.28 * sin(uTime * (1.5 + mag * 4.0) + mag * 40.0);
      sky += vec3(0.9, 0.94, 1.0) * star * pow(mag, 3.0) * twinkle * deepNight * smoothstep(0.0, 0.18, direction.y) * 0.55;
      // milky way: soft granular band along a tilted great circle
      vec3 mwNormal = normalize(vec3(0.42, 0.55, 0.72));
      float bandDist = abs(dot(direction, mwNormal));
      float band = exp(-bandDist * bandDist * 26.0);
      vec2 mwUv = vec2(dot(direction, normalize(cross(mwNormal, vec3(0.0, 1.0, 0.0)))),
                       dot(direction, normalize(cross(mwNormal, cross(mwNormal, vec3(0.0, 1.0, 0.0))))));
      float grain = fbm(mwUv * 7.0) * 0.65 + fbm(mwUv * 19.0) * 0.35;
      float lanes = smoothstep(0.35, 0.75, grain);
      sky += vec3(0.5, 0.56, 0.72) * band * lanes * 0.085 * deepNight * smoothstep(0.0, 0.2, direction.y);
    }
    #endif

    /* ---- moon ---- */
    float moonNight = smoothstep(0.45, 0.95, night);
    float moonDot = dot(direction, uMoonDir);
    float moonDisc = smoothstep(0.99965, 0.99985, moonDot);
    float moonGlow = pow(max(moonDot, 0.0), 220.0) * 0.2 + pow(max(moonDot, 0.0), 24.0) * 0.02;
    sky += (vec3(0.9, 0.93, 1.0) * moonDisc * 1.4 + vec3(0.55, 0.65, 0.85) * moonGlow) * moonNight;

    /* ---- sun disc + 22-degree halo (before clouds so cover occludes) ---- */
    float sundisk = smoothstep(0.99925, 0.99972, cosTheta);
    sky += (sunE * 1900.0 * Fex) * sundisk * 0.00022 * uDay * (1.0 - uCloudCover) * (1.0 - uCloudCover);
    float haloBand = exp(-pow((cosTheta - 0.927) * 220.0, 2.0));
    sky += uSunTint * haloBand * 0.05 * uDay * (1.0 - uCloudCover * 0.8);

    /* ---- volumetric cumulus: raymarched slab with sun lighting ---- */
    float horizonFade = smoothstep(0.0, 0.045, direction.y);
    float cloudFade = smoothstep(0.05, 0.17, direction.y); // haze owns the horizon band
    float cover = clamp(uCloudCover, 0.0, 1.0);
    float cloudShadow = 0.0;
    #if defined(MIRROR_PASS) || defined(CLOUD_FLAT)
    /* mirror pass / low-power tier: a flat deck is enough */
    if (direction.y > 0.02 && cover > 0.02) {
      vec2 mcuv = direction.xz / (direction.y + 0.15) * 0.9 * uCloudScale
        + vec2(1.0, 0.35) * uTime * 0.0045;
      float flatCloud = smoothstep(1.0 - cover * 0.95, 1.32 - cover * 0.95, cloudFbm(mcuv));
      sky = mix(sky, (uCloudAmbient * (0.55 + 0.5 * uDay) + uSunTint * 0.2) * (1.0 - uRainSky * 0.5),
        flatCloud * horizonFade * 0.9);
      cloudShadow = flatCloud * 0.8;
      sky += uLightning * vec3(0.72, 0.78, 1.0) * (0.22 + flatCloud * 0.9);
    }
    #else
    if (direction.y > 0.05 && uUnderwater < 0.9 && cover > 0.02) {
      vec2 windDrift = vec2(1.0, 0.35) * uTime * 4.5;

      float t0 = CLOUD_BASE / max(direction.y, 0.05);
      float t1 = CLOUD_TOP / max(direction.y, 0.05);
      t1 = min(t1, t0 + 6500.0);
      float dt = (t1 - t0) / float(CLOUD_STEPS);
      // interleaved gradient noise: clean ordered dither, static so it never crawls
      float jitter = hash12(gl_FragCoord.xy * 1.37); // white noise: no ordered moire
      float t = t0 + dt * jitter * 0.45;

      float transmittance = 1.0;
      vec3 scattered = vec3(0.0);

      // day: the sun drives cloud lighting; night: the moon does
      float dayPick = step(0.35, uDay);
      vec3 skyLightDir = normalize(mix(uMoonDir, uSunDir, dayPick));
      float cosPh = dot(direction, skyLightDir);

      // dual-lobe Henyey-Greenstein: strong forward (silver lining) + mild back
      float g1 = 0.62, g2 = -0.18;
      float ph1 = (1.0 - g1 * g1) / pow(1.0 + g1 * g1 - 2.0 * g1 * cosPh, 1.5);
      float ph2 = (1.0 - g2 * g2) / pow(1.0 + g2 * g2 - 2.0 * g2 * cosPh, 1.5);
      float phase = mix(ph2, ph1, 0.62) * 0.3;

      vec3 sunCol = (uSunTint * (2.6 * uDay + 0.04)
        + vec3(0.55, 0.65, 0.85) * (1.0 - uDay) * 0.25) // moonlight at night
        * (1.0 - uRainSky * 0.55);
      vec3 ambient = uCloudAmbient * (0.7 + 0.6 * uDay) * (1.0 - uRainSky * 0.5) * (0.26 + 0.74 * clamp(skyLightDir.y * 2.2, 0.0, 1.0));

      float covLo = 1.0 - cover * 0.88;
      // shadow probes stretch when the light sits low so decks stay coherent
      float lt = 120.0 / clamp(skyLightDir.y + 0.2, 0.35, 1.0);

      for (int i = 0; i < CLOUD_STEPS; i++) {
        vec3 pos = direction * t;
        float density = cloudField(pos, windDrift, covLo, t);
        if (density > 0.004) {
          // short probe = the cloud shades its own far side; long probe = neighbours
          float shadowAcc = cloudField(pos + skyLightDir * 55.0, windDrift, covLo, t) * 1.5;
          for (int j = 1; j <= CLOUD_LSTEPS; j++) {
            shadowAcc += cloudMass(pos + skyLightDir * lt * float(j), windDrift, covLo);
          }
          float sunLight = exp(-shadowAcc * 2.3);
          // powder term keeps rims bright, cores shaded
          float powder = 1.0 - exp(-density * 3.5);
          float y01 = clamp((pos.y - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE), 0.0, 1.0);
          vec3 sampleLight = sunCol * sunLight * phase * mix(1.0, powder, 0.55) + ambient * (0.35 + 0.65 * y01);
          float stepOpacity = 1.0 - exp(-density * dt * 0.012);
          scattered += sampleLight * stepOpacity * transmittance;
          transmittance *= 1.0 - stepOpacity;
          if (transmittance < 0.015) break;
        }
        t += dt;
      }

      float cloudAmount = (1.0 - transmittance) * cloudFade;
      cloudShadow = cloudAmount;
      // fade the thinnest fringes — at low opacity the march dither shows
      float fringe = smoothstep(0.02, 0.14, cloudAmount);
      cloudAmount *= fringe;
      sky = sky * (1.0 - cloudAmount) + scattered * cloudFade * fringe;
      // lightning lights the deck from inside
      sky += uLightning * vec3(0.72, 0.78, 1.0) * (0.22 + cloudAmount * 1.2);
      // moonlit rims
      sky += vec3(0.6, 0.68, 0.85) * pow(max(moonDot, 0.0), 14.0) * cloudAmount * night * 0.12;
    } else {
      sky += uLightning * vec3(0.72, 0.78, 1.0) * 0.22 * (1.0 - uUnderwater);
    }
    #endif

    /* ---- thin cirrus veil above everything ---- */
    if (direction.y > 0.02) {
      vec2 ciruv = direction.xz / (direction.y + 0.22) * 0.85 + vec2(uTime * 0.004, uTime * 0.0015);
      float cir = fbm(ciruv * vec2(1.0, 2.6));
      float cirMask = smoothstep(0.62, 0.9, cir) * (0.35 + cover * 0.3);
      sky = mix(sky, uSunTint * 0.9 + uCloudAmbient * 0.5, cirMask * 0.4 * horizonFade * uDay);
    }

    /* ---- crepuscular rays fan out when the sun sits low ---- */
    float lowSun = clamp(1.0 - uSunDir.y * 3.0, 0.0, 1.0) * uDay;
    if (lowSun > 0.05 && cosTheta > 0.15) {
      vec3 basisA = normalize(cross(uSunDir, up));
      vec3 basisB = normalize(cross(uSunDir, basisA));
      vec3 rel = normalize(direction - uSunDir * cosTheta);
      float phi = atan(dot(rel, basisB), dot(rel, basisA));
      float spokes = vnoise(vec2(phi * 3.5 + 7.0, 0.5)) * 0.6 + vnoise(vec2(phi * 9.0, 2.5)) * 0.4;
      spokes = smoothstep(0.45, 0.85, spokes);
      sky += uSunTint * spokes * pow(max(cosTheta, 0.0), 5.0) * lowSun
        * (1.0 - cloudShadow) * (1.0 - uCloudCover * 0.45) * 0.5;
    }

    /* ---- distant rain curtains smear the horizon in a downpour ---- */
    float rainVeil = uRainSky * smoothstep(0.35, 0.02, direction.y)
      * (0.35 + 0.5 * vnoise(vec2(atan(direction.z, direction.x) * 6.0, direction.y * 1.2 - uTime * 0.1)));
    sky = mix(sky, uFogColor * 1.06, clamp(rainVeil, 0.0, 1.0) * 0.55);

    /* ---- horizon haze — matches the water fog color for a seamless line ---- */
    float haze = smoothstep(uHazeBand, 0.0, max(direction.y, 0.0));
    haze *= 1.0 - pow(max(cosTheta, 0.0), 6.0) * 0.85 * uDay; // sun glow burns through
    vec3 hazeCol = uFogColor * mix(0.55, 1.35, pow(max(cosTheta, 0.0), 3.0) * uDay);
    sky = mix(sky, hazeCol, haze * uHazeMix);

    /* ---- residual sun glow that penetrates haze and thin cloud ---- */
    sky += uSunTint * pow(max(cosTheta, 0.0), 160.0) * 0.35 * uDay * (1.0 - uCloudCover * 0.7) * (1.0 - uRainSky * 0.85);

    /* ---- submerged: the sky dome becomes the water column itself —
       bright downwelling ceiling above, deep gloom below, a blurred
       sun ball and god-ray spokes fanning down from the surface ---- */
    if (uUnderwater > 0.002) {
      float upness = clamp(direction.y, -1.0, 1.0);
      vec3 uw = mix(uUnderFog, uUnderFog * vec3(0.30, 0.42, 0.55), smoothstep(0.0, -0.65, upness));
      uw = mix(uw, uUnderFog * vec3(2.3, 2.15, 1.9) + vec3(0.010, 0.028, 0.034) * uDay,
        smoothstep(0.02, 0.65, upness));
      float cosSun = dot(direction, uSunDir);
      // near the horizontal the dome must equal the flat under-fog exactly,
      // or it shows as a bright seam through the far edge of the water plane
      float horizonGate = smoothstep(0.015, 0.1, abs(upness));
      // sun ball diffused by the water, plus wide forward scatter
      uw += uSunTint * (pow(max(cosSun, 0.0), 34.0) * 3.2 + pow(max(cosSun, 0.0), 5.0) * 0.5)
        * uDay * horizonGate;
      if (cosSun > 0.15) {
        // god rays: noise spokes around the sun axis, drifting slowly
        vec3 gA = normalize(cross(uSunDir, up));
        vec3 gB = normalize(cross(uSunDir, gA));
        vec3 gRel = normalize(direction - uSunDir * cosSun);
        float gPhi = atan(dot(gRel, gB), dot(gRel, gA));
        float rays = vnoise(vec2(gPhi * 5.5 + uTime * 0.06, 1.7)) * 0.6
                   + vnoise(vec2(gPhi * 12.0 - uTime * 0.045, 6.1)) * 0.4;
        rays = smoothstep(0.44, 0.9, rays);
        uw += uSunTint * rays * pow(max(cosSun, 0.0), 7.0) * 2.4 * uDay * horizonGate;
      }
      sky = mix(sky, uw, uUnderwater);
    }

    // dither against banding
    sky += (hash12(gl_FragCoord.xy) - 0.5) * 0.004;

    gl_FragColor = vec4(sky, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* Water shader — Gerstner displacement, per-pixel analytic normals,  */
/* planar mirror reflection, Jacobian whitecaps, crest scattering.    */
/* ------------------------------------------------------------------ */
const waterVertex = /* glsl */ `
  uniform vec4 uWaveData[NW];  // kx, ky, amp, Q
  uniform vec4 uWavePhase[NW]; // phase, groupPhase, omega, envDepth
  varying vec3 vWorldPosition;
  varying vec2 vUndisplaced;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec2 p = world.xz;
    vec3 displaced = world.xyz;
    #ifndef FAR_PLANE
      float fade = 1.0 - smoothstep(150.0, 200.0, length(p));
      for (int i = 0; i < NW; i++) {
        vec4 w = uWaveData[i];
        vec4 ph = uWavePhase[i];
        float k = length(w.xy);
        float along = dot(w.xy, p);
        float env = 1.0 + ph.w * sin(${ENV_EPS} * along - ph.y);
        float amp = w.z * env * fade;
        float phase = along - ph.x;
        displaced.y += amp * sin(phase);
        displaced.xz += (w.xy / k) * (w.w * amp * cos(phase));
      }
    #endif
    vWorldPosition = displaced;
    vUndisplaced = p;
    gl_Position = projectionMatrix * viewMatrix * vec4(displaced, 1.0);
  }
`;

const waterFragment = /* glsl */ `
  uniform vec4 uWaveData[NW];  // kx, ky, amp, Q
  uniform vec4 uWavePhase[NW]; // phase, groupPhase, omega, envDepth
  uniform float uTime;
  uniform sampler2D uMirror;
  uniform mat4 uMirrorMatrix;
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uScatterColor;
  uniform vec3 uFogColor;
  uniform vec3 uFoamColor;
  uniform float uFoamAmount;
  uniform float uFogDensity;
  uniform float uDetailAmp;
  uniform vec3 uUnderFog;
  uniform vec3 uSkyZenith;
  uniform sampler2D uRefraction;
  uniform vec2 uScreenSize;
  uniform float uCloudCover2;
  uniform float uSubmerged;
  uniform float uRain;
  uniform float uDay;

  varying vec3 vWorldPosition;
  varying vec2 vUndisplaced;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
      mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.13 + vec2(11.3, 5.7); a *= 0.5; }
    return v;
  }
  ${glslFloorHeight}
  float ridge(float n) { return 1.0 - abs(2.0 * n - 1.0); }
  float caustic(vec2 uv) {
    float c1 = ridge(vnoise(uv * 0.9 + vec2(uTime * 0.21, uTime * 0.17)));
    float c2 = ridge(vnoise(uv * 1.15 - vec2(uTime * 0.16, -uTime * 0.19)));
    return pow(c1 * c2, 2.4) * 2.6;
  }

  void main() {
    vec2 p = vUndisplaced;
    float dist = length(cameraPosition - vWorldPosition);

    /* ---- analytic Gerstner normal + Jacobian, evaluated per-pixel ---- */
    vec2 slope = vec2(0.0);
    float jxx = 1.0, jyy = 1.0, jxy = 0.0;
    float jxxOld = 1.0, jyyOld = 1.0, jxyOld = 0.0;
    float qSum = 0.0;
    float elevation = 0.0;
    for (int i = 0; i < NW; i++) {
      vec4 w = uWaveData[i];
      vec4 ph = uWavePhase[i];
      float k = length(w.xy);
      vec2 d = w.xy / k;
      float along = dot(w.xy, p);
      float env = 1.0 + ph.w * sin(${ENV_EPS} * along - ph.y);
      float amp = w.z * env;
      float phase = along - ph.x;
      float s = sin(phase), c = cos(phase);
      float qak = w.w * amp * k;
      slope += d * (amp * k * c);
      elevation += amp * s;
      jxx -= qak * d.x * d.x * s;
      jyy -= qak * d.y * d.y * s;
      jxy -= qak * d.x * d.y * s;
      qSum -= qak * s;
      // Jacobian a moment ago — fakes lingering foam decay
      float sOld = sin(phase + ph.z * 0.85);
      jxxOld -= qak * d.x * d.x * sOld;
      jyyOld -= qak * d.y * d.y * sOld;
      jxyOld -= qak * d.x * d.y * sOld;
    }
    vec3 normal = normalize(vec3(-slope.x, 1.0 + qSum * 0.5, -slope.y));

    /* ---- high-frequency detail ripples (finite-difference fbm) ----
       Sampled on the DISPLACED surface so ripples ride the swells
       instead of sliding underneath them. */
    vec2 q = vWorldPosition.xz;
    vec2 wdir = vec2(0.9578, 0.2873);
    vec2 wperp = vec2(-0.2873, 0.9578);
    float detailFade = uDetailAmp / (1.0 + dist * 0.055);
    vec2 duv = q * 0.9 + wdir * (uTime * 0.42);
    vec2 duv2 = q * 2.7 - wdir * (uTime * 0.33) + wperp * (uTime * 0.12);
    float e = 0.09;
    float n0 = fbm(duv) + fbm(duv2) * 0.5;
    float nx = fbm(duv + vec2(e, 0.0)) + fbm(duv2 + vec2(e * 3.0, 0.0)) * 0.5;
    float ny = fbm(duv + vec2(0.0, e)) + fbm(duv2 + vec2(0.0, e * 3.0)) * 0.5;
    vec2 detailHF = vec2(n0 - nx, n0 - ny) * 3.2;
    normal.xz += detailHF * detailFade;
    normal = normalize(normal);

    /* ---- raindrop impacts: expanding rings + splash crowns that ride
       the displaced surface. Cells activate with rain intensity, so
       light rain plips sparsely and a downpour boils. ---- */
    float rainCrown = 0.0;
    if (uRain > 0.02) {
      vec2 rippleGrad = vec2(0.0);
      float proximity = smoothstep(95.0, 20.0, dist);
      for (int l = 0; l < 2; l++) {
        float sc = l == 0 ? 2.1 : 0.9;
        vec2 uv = q * sc + float(l) * 17.7;
        vec2 cell = floor(uv);
        vec2 f = fract(uv) - 0.5;
        float h = hash12(cell + float(l) * 31.0);
        // only a rain-dependent share of cells fires this cycle
        float cellOn = step(hash12(cell + 57.3), uRain * (l == 0 ? 1.15 : 0.75));
        float life = fract(uTime * (1.4 + h * 1.3) + h * 11.0);
        vec2 center = (vec2(hash12(cell + 3.1), hash12(cell + 5.7)) - 0.5) * 0.62;
        vec2 rel = f - center;
        float r = length(rel) + 1e-4;
        float radius = life * 0.34;
        float env = (1.0 - life) * (1.0 - life) * cellOn;
        float gauss = exp(-pow((r - radius) * 11.0, 2.0));
        float dring = -242.0 * (r - radius) * gauss * env;
        rippleGrad += (rel / r) * dring * 0.014;
        // white crown right at the impact point, brief and bright
        rainCrown += exp(-r * sc * 26.0) * pow(1.0 - life, 3.0) * env;
      }
      normal = normalize(normal + vec3(rippleGrad.x, 0.0, rippleGrad.y) * uRain * proximity);
      rainCrown *= uRain * proximity;
    }

    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 color;

    if (gl_FrontFacing) {
    /* ================= surface seen from above ================= */
    float facing = clamp(dot(normal, viewDir), 0.0, 1.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);

    /* ---- mirror reflection ---- */
    vec4 mirrorCoord = uMirrorMatrix * vec4(vWorldPosition, 1.0);
    vec2 mUv = mirrorCoord.xy / mirrorCoord.w;
    float distortion = 0.13 / (1.0 + dist * 0.045);
    mUv += normal.xz * distortion;
    mUv = clamp(mUv, vec2(0.002), vec2(0.998));
    vec3 reflection = texture2D(uMirror, mUv).rgb;

    /* ---- water body: depth tint + crest subsurface scattering ---- */
    float transmission = pow(facing, 1.8);
    vec3 body = mix(uDeepColor, uShallowColor, transmission * 0.65 + clamp(elevation * 0.35 + 0.15, 0.0, 0.55));
    float towardLight = pow(max(dot(viewDir, -uLightDir), 0.0), 3.0);
    float crest = clamp(elevation * 0.65 + 0.2, 0.0, 1.0);
    body += uScatterColor * (towardLight * crest * 1.4 + crest * 0.08) * (1.0 - fresnel);

    /* ---- true refraction: the rendered underwater scene sampled
       through the rippled surface, attenuated by the water column ---- */
    vec3 refr = refract(-viewDir, normal, 0.7519);
    float floorY = floorHeightApprox(p);
    float tDist = (vWorldPosition.y - floorY) / max(-refr.y, 0.08);
    vec2 hitP = p + refr.xz * clamp(tDist, 0.0, 140.0);
    floorY = floorHeightApprox(hitP);
    tDist = clamp((vWorldPosition.y - floorY) / max(-refr.y, 0.08), 0.0, 140.0);
    vec2 screenUv = gl_FragCoord.xy / uScreenSize;
    float wobble = clamp(6.0 / (1.0 + dist * 0.35), 0.12, 1.2);
    vec2 refrUv = clamp(screenUv + normal.xz * 0.16 * wobble, vec2(0.004), vec2(0.996));
    vec3 bottomCol = texture2D(uRefraction, refrUv).rgb;
    vec3 transmit = exp(-vec3(0.24, 0.08, 0.055) * tDist);
    body = mix(body, bottomCol, transmit);

    color = mix(body, reflection, fresnel);

    /* ---- sun/moon specular + glitter ---- */
    vec3 halfDir = normalize(uLightDir + viewDir);
    float ndh = max(dot(normal, halfDir), 0.0);
    float specPower = mix(360.0, 60.0, clamp(dist / 500.0, 0.0, 1.0));
    float spec = pow(ndh, specPower) * (0.35 + fresnel * 3.2);
    float glitterGate = smoothstep(0.55, 0.95, vnoise(q * 5.5 + vec2(uTime * 0.7, -uTime * 0.5)));
    float glitter = pow(ndh, 1400.0 * detailFade + 90.0) * glitterGate * 7.0 * detailFade;
    color += uLightColor * (spec * 1.6 + glitter) * max(uLightDir.y * 3.5 + 0.15, 0.0);

    /* ---- whitecap foam from wave-pinch Jacobian ---- */
    float j = jxx * jyy - jxy * jxy;
    float jOld = jxxOld * jyyOld - jxyOld * jxyOld;
    float foamThreshold = mix(-0.1, 0.42, uFoamAmount);
    float foamFresh = smoothstep(foamThreshold, foamThreshold - 0.38, j);
    float foamTrail = smoothstep(foamThreshold, foamThreshold - 0.38, jOld) * 0.35;
    float foamMask = max(foamFresh, foamTrail);
    float mottle = fbm(q * 1.5 + vec2(uTime * 0.1, -uTime * 0.07));
    foamMask *= smoothstep(0.28, 0.72, mottle + foamMask * 0.32);
    // wind streaks at high foam settings
    float streaks = fbm(vec2(q.x * 0.18 + q.y * 0.06, q.y * 0.9) + vec2(uTime * 0.05, 0.0));
    foamMask = max(foamMask, smoothstep(1.12, 1.5, streaks + uFoamAmount * 0.45) * 0.28);
    /* breaking wash where the water shoals against the beach */
    float columnDepth = vWorldPosition.y - floorY;
    float shoreFoam = smoothstep(0.55, 0.06, columnDepth)
      * (0.35 + 0.65 * ridge(vnoise(hitP * 2.4 + vec2(uTime * 0.35, uTime * 0.22))));
    foamMask = max(foamMask, shoreFoam * 0.7);
    /* rain roughens the surface with fizzing micro-splash */
    foamMask = max(foamMask, uRain * 0.14 * smoothstep(0.55, 0.9, vnoise(q * 6.0 + vec2(uTime * 1.7, -uTime * 1.3))));
    foamMask = clamp(foamMask, 0.0, 1.0) * smoothstep(420.0, 55.0, dist);
    vec3 foamCol = uFoamColor * (0.55 + 0.45 * max(uLightDir.y, 0.12));
    color = mix(color, foamCol, foamMask * 0.92);
    /* splash crowns flash white where drops strike */
    color += foamCol * rainCrown * 0.85;

    /* ---- aerial fog toward horizon ---- */
    float fog = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
    color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));
    /* a submerged camera sees distant front faces through murk, not air */
    float fogW = 1.0 - exp(-pow(dist * 0.03, 2.0));
    color = mix(color, uUnderFog, uSubmerged * clamp(fogW, 0.0, 1.0));

    } else {
    /* ================= surface seen from below =================
       Refract the eye ray through the rippled surface into the air
       and evaluate a live sky (gradient + clouds + sun glare); rays
       past the critical angle mirror the murky水 interior instead. */
    /* the underside normal field must read as flowing molten glass:
       large, smooth, wind-stretched swirls (domain-warped low-octave
       noise), not fractal speckle. A whisper of the fine churn is
       blended back in close to the camera only. */
    vec2 sq = vec2(dot(q, wdir), dot(q, wperp));
    vec2 su = sq * vec2(0.27, 0.4) + vec2(uTime * 0.2, uTime * 0.03);
    su += (vec2(vnoise(su * 1.6 + 3.1), vnoise(su * 1.6 + 9.7)) - 0.5) * 1.1;
    float s0 = vnoise(su);
    vec2 sg = vec2(s0 - vnoise(su + vec2(0.14, 0.0)), s0 - vnoise(su + vec2(0.0, 0.14))) * 6.5;
    sg = wdir * sg.x + wperp * sg.y; // rotate the gradient back to world xz
    float swirlAmp = 1.15 / (1.0 + dist * 0.045);
    float underDetail = uDetailAmp * 0.3 / (1.0 + dist * 0.12);
    vec3 nUnder = normalize(normal
      + vec3(sg.x * swirlAmp + detailHF.x * underDetail, 0.0, sg.y * swirlAmp + detailHF.y * underDetail));
    vec3 airDir = refract(-viewDir, -nUnder, 1.33);
    float tir = step(dot(airDir, airDir), 1e-6); // 1 = total internal reflection
    airDir = normalize(airDir + vec3(0.0, 1e-4, 0.0));

    /* Snell's window: the sky seen through the surface stays close to
       its TRUE brightness and hue — bright, milky, with clouds legible */
    float skyLift = clamp(airDir.y, 0.0, 1.0);
    vec3 skyCol = mix(uFogColor * 2.2, uSkyZenith * 3.6, pow(skyLift, 0.6));
    vec2 cuv = airDir.xz / (airDir.y + 0.25);
    float cl = fbm(cuv * 0.7 + vec2(uTime * 0.012, uTime * 0.004));
    float cloudMask = smoothstep(mix(0.74, 0.32, uCloudCover2), mix(0.95, 0.62, uCloudCover2), cl);
    skyCol = mix(skyCol, vec3(0.95, 0.97, 1.0) * (0.4 + 0.9 * uDay), cloudMask * 0.85);
    // submerged: the refraction target holds the real world above the
    // surface — ship, island, sky — wobbled hard by the ripples so the
    // window churns the way real footage does
    vec2 wUv = clamp(gl_FragCoord.xy / uScreenSize + nUnder.xz * 0.38, vec2(0.004), vec2(0.996));
    skyCol = mix(skyCol, texture2D(uRefraction, wUv).rgb * 1.15, uSubmerged);
    // grazing paths cross more churned surface — the window edge burns milky
    skyCol *= 1.0 + 0.85 * pow(1.0 - skyLift, 2.0) * (0.3 + 0.7 * uDay);
    float sunGlare = pow(max(dot(airDir, uLightDir), 0.0), 60.0);
    skyCol += uLightColor * sunGlare * 8.0;

    /* total internal reflection: past the critical angle the underside is
       a true mirror of the underwater scene — deep water, seabed and
       kelp reflected — with caustic webs playing across it */
    float bounce = min(caustic(q * 0.35 + vec2(3.7, 1.3)), 1.6) * 0.5
      + min(caustic(q * 1.4 + vec2(9.1, 5.2)), 1.6) * 0.45;
    vec4 mCo = uMirrorMatrix * vec4(vWorldPosition, 1.0);
    vec2 mUv2 = clamp(mCo.xy / max(mCo.w, 1e-4) + nUnder.xz * (0.4 / (1.0 + dist * 0.05)),
      vec2(0.002), vec2(0.998));
    vec3 sceneRefl = texture2D(uMirror, mUv2).rgb;
    // procedural fallback for the rare back faces seen from above the water
    vec3 tirProc = uUnderFog * (1.85 + 1.25 * bounce)
      + vec3(0.055, 0.10, 0.115) * (0.25 + 0.75 * uDay);
    vec3 tirCol = mix(tirProc, sceneRefl, uSubmerged);
    tirCol += uUnderFog * bounce * (0.7 + 1.1 * max(uLightDir.y, 0.0));
    // silvery sparkle on steep ripple flanks — near the camera only
    float crest = smoothstep(0.2, 0.55, length(nUnder.xz)) * smoothstep(55.0, 12.0, dist);
    tirCol += vec3(0.5, 0.68, 0.66) * crest * (0.2 + 0.5 * uDay);

    float edge = smoothstep(0.0, 0.3, airDir.y) * (1.0 - tir);
    color = mix(tirCol, skyCol, edge);
    // silvery rim where rays graze the critical angle — softens with range
    float rim = pow(1.0 - abs(edge * 2.0 - 1.0), 3.0) * smoothstep(90.0, 18.0, dist);
    color += vec3(0.75, 0.86, 0.87) * rim * 0.42 * (0.3 + 0.7 * uDay);
    float fogU = 1.0 - exp(-pow(dist * 0.028, 2.0));
    color = mix(color, uUnderFog, clamp(fogU, 0.0, 1.0));
    }

    color += (hash12(gl_FragCoord.xy * 1.7) - 0.5) * 0.003;

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* Seabed shader — sand, stone paving, caustics, depth absorption     */
/* ------------------------------------------------------------------ */
const floorVertex = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const floorFragment = /* glsl */ `
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uAmbient;
  uniform vec3 uFogColor2;
  uniform float uFogDensity2;
  uniform float uTime;
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
      mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float ridge(float n) { return 1.0 - abs(2.0 * n - 1.0); }
  float caustic(vec2 uv) {
    float c1 = ridge(vnoise(uv * 0.9 + vec2(uTime * 0.21, uTime * 0.17)));
    float c2 = ridge(vnoise(uv * 1.15 - vec2(uTime * 0.16, -uTime * 0.19)));
    return pow(c1 * c2, 2.4) * 2.6;
  }

  void main() {
    vec2 p = vWorldPos.xz;
    float h = vWorldPos.y;

    /* sand with grain — extra contrast so it survives depth absorption */
    float grain = vnoise(p * 6.3) * 0.55 + vnoise(p * 23.0) * 0.45;
    grain = grain * grain * 1.4;
    vec3 albedo = mix(vec3(0.47, 0.4, 0.27), vec3(0.8, 0.72, 0.52), grain);

    /* scattered flat paving stones in patches */
    vec2 cellUv = p / 1.9;
    vec2 cell = floor(cellUv);
    vec2 f = fract(cellUv) - 0.5;
    float cellHash = hash12(cell);
    vec2 offs = vec2(hash12(cell + 7.1), hash12(cell + 3.7)) - 0.5;
    float stoneR = 0.13 + cellHash * 0.13;
    float dStone = length(f - offs * 0.4);
    float stonePatch = smoothstep(0.6, 0.72, vnoise(p * 0.045 + 11.0))
      * smoothstep(0.2, -0.3, h); // submerged pavement only — the cay stays clean sand
    float stoneMask = smoothstep(stoneR, stoneR - 0.07, dStone) * stonePatch;
    vec3 stoneCol = mix(vec3(0.3, 0.28, 0.25), vec3(0.44, 0.39, 0.33), cellHash);
    albedo = mix(albedo, stoneCol, stoneMask * 0.92);

    /* wet band at the shoreline */
    albedo *= 1.0 - 0.26 * smoothstep(0.55, 0.05, abs(h));

    /* caustic light webs under water */
    float underwaterFactor = smoothstep(0.12, -0.35, h);
    float cf = caustic(p) * underwaterFactor * exp(h * 0.1) * max(uLightDir.y, 0.0);

    float diff = max(dot(vNormal, uLightDir), 0.0);
    vec3 color = albedo * (uAmbient + uLightColor * (diff * 0.85 + min(cf, 1.5) * 1.15));

    /* sunlight loses red with depth */
    color *= mix(vec3(1.0), exp(vec3(0.30, 0.11, 0.075) * h * 0.6), underwaterFactor);

    float fog = 1.0 - exp(-pow(length(cameraPosition - vWorldPos) * uFogDensity2, 2.0));
    color = mix(color, uFogColor2, clamp(fog, 0.0, 1.0));

    color += (hash12(gl_FragCoord.xy * 1.3) - 0.5) * 0.004;
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #ifdef DEBUG_MAGENTA
    gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
    #endif
  }
`;

/* ------------------------------------------------------------------ */
/* Kelp shader — swaying ragged blades                                */
/* ------------------------------------------------------------------ */
const kelpVertex = /* glsl */ `
  uniform float uTime;
  varying float vBlade;
  varying float vT;
  varying vec3 vWorldPos;
  void main() {
    vT = clamp(position.y / 3.2 + 0.5, 0.0, 1.0);
    vBlade = position.x / 0.8 + 0.5;
    vec4 world = modelMatrix * vec4(position, 1.0);
    float sway = sin(uTime * 0.7 + world.x * 0.45 + world.z * 0.5);
    world.x += sway * vT * vT * 0.65;
    world.z += cos(uTime * 0.55 + world.x * 0.35) * vT * vT * 0.4;
    vWorldPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const kelpFragment = /* glsl */ `
  uniform vec3 uFogColor2;
  uniform float uFogDensity2;
  uniform vec3 uAmbient;
  uniform vec3 uLightColor;
  varying float vBlade;
  varying float vT;
  varying vec3 vWorldPos;
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
      mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    float seed = floor(vWorldPos.x * 0.3 + vWorldPos.z * 0.7);
    float halfW = (1.0 - vT * 0.72) * (0.5 + 0.5 * vnoise(vec2(vT * 7.0 + seed, seed * 1.3)));
    if (abs(vBlade - 0.5) * 2.0 > halfW) discard;
    vec3 color = mix(vec3(0.024, 0.05, 0.024), vec3(0.05, 0.1, 0.038), vT)
      * (uAmbient * 1.2 + uLightColor * 0.3);
    /* same depth absorption as the seabed */
    color *= exp(vec3(0.30, 0.11, 0.075) * min(vWorldPos.y, 0.0) * 0.6);
    float fog = 1.0 - exp(-pow(length(cameraPosition - vWorldPos) * uFogDensity2, 2.0));
    color = mix(color, uFogColor2, clamp(fog, 0.0, 1.0));
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* Sun position and light color curves                                */
/* ------------------------------------------------------------------ */
function directionForHour(hour, target) {
  const angle = ((hour - 6) / 12) * Math.PI;
  return target.set(Math.cos(angle) * 0.74, Math.sin(angle) * 0.82, -0.55).normalize();
}

const COL = {
  white: new THREE.Color(1, 0.97, 0.92),
  ember: new THREE.Color(1.25, 0.42, 0.15),
  grey: new THREE.Color(0.6, 0.63, 0.66),
  moon: new THREE.Color(0.5, 0.62, 0.85),
  dayFog: new THREE.Color(0.44, 0.57, 0.7),
  duskFog: new THREE.Color(0.83, 0.51, 0.32),
  nightFog: new THREE.Color(0.05, 0.075, 0.115),
  stormFog: new THREE.Color(0.3, 0.34, 0.39),
  dayAmbient: new THREE.Color(0.78, 0.84, 0.9),
  duskAmbient: new THREE.Color(0.55, 0.4, 0.38),
  nightAmbient: new THREE.Color(0.05, 0.07, 0.12),
  deepDay: new THREE.Color(0.011, 0.052, 0.083),
  shallowDay: new THREE.Color(0.05, 0.33, 0.42),
  scatterDay: new THREE.Color(0.05, 0.42, 0.45),
  deepStorm: new THREE.Color(0.022, 0.042, 0.05),
  shallowStorm: new THREE.Color(0.1, 0.16, 0.18),
  underFogDay: new THREE.Color(0.05, 0.205, 0.26),
  shaftTint: new THREE.Color(0.45, 0.85, 0.9),
};

const scratch = { a: new THREE.Color(), b: new THREE.Color() };

function computeAtmosphere(sunDir, clouds) {
  const e = sunDir.y;
  const day = THREE.MathUtils.smoothstep(e, -0.1, 0.16);
  const warm = Math.pow(THREE.MathUtils.clamp(1 - Math.abs(e - 0.05) / 0.3, 0, 1), 1.4);
  const overcast = THREE.MathUtils.clamp(clouds * 0.85, 0, 1);

  const sunTint = scratch.a.copy(COL.white).lerp(COL.ember, warm).lerp(COL.grey, overcast * 0.75);
  const fogOvercast = THREE.MathUtils.smoothstep(clouds, 0.5, 0.95);
  const fog = scratch.b.copy(COL.dayFog).lerp(COL.duskFog, warm * 0.85).lerp(COL.stormFog, fogOvercast * 0.85);
  fog.lerp(COL.nightFog, 1 - day);
  return { day, warm, overcast, sunTint, fog };
}

/* ------------------------------------------------------------------ */
/* Props (kept from the original scene — now they reflect in water)   */
/* ------------------------------------------------------------------ */
function standard(color, roughness = 0.7, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function createBuoy() {
  const group = new THREE.Group();
  const red = standard(0xf45b3f, 0.42, 0.08), white = standard(0xf0eee5, 0.55), dark = standard(0x14242b, 0.6);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.38, 0.72, 20), red); body.position.y = 0.37; body.castShadow = true; group.add(body);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.285, 0.385, 0.18, 20), white); band.position.y = 0.35; group.add(band);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.86, 10), dark); mast.position.y = 1.05; group.add(mast);
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.23, 0.38, 16), red); marker.position.y = 1.57; group.add(marker);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.045, 8, 28), dark); ring.rotation.x = Math.PI / 2; ring.position.y = 0.52; group.add(ring);
  return group;
}

/* ------------------------------------------------------------------ */
/* UI wiring                                                          */
/* ------------------------------------------------------------------ */
function setupControls() {
  const configs = {
    wind: { display: (v) => `${v.toFixed(1)} m/s` },
    waveHeight: { display: (v) => `${v.toFixed(2)} m` },
    foam: { display: (v) => `${Math.round(v * 100)}%` },
    time: { display: (v) => `${Math.floor(v)}:${Math.round((v % 1) * 60).toString().padStart(2, "0")}` },
    clouds: { display: (v) => `${Math.round(v * 100)}%` },
    rain: { display: (v) => `${Math.round(v * 100)}%` },
    exposure: { display: (v) => v.toFixed(2) },
  };
  const refresh = (key) => {
    const input = document.getElementById(key), config = configs[key], value = state[key];
    input.value = String(value);
    input.style.setProperty("--fill", `${((value - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
    document.getElementById(`${key}-out`).textContent = config.display(value);
  };
  Object.keys(configs).forEach((key) => {
    const input = document.getElementById(key);
    refresh(key);
    input.addEventListener("input", () => {
      state[key] = Number(input.value);
      refresh(key);
      document.querySelectorAll(".preset").forEach((button) => button.classList.remove("active"));
    });
  });
  document.querySelectorAll(".preset").forEach((button) => button.addEventListener("click", () => {
    Object.assign(state, PRESETS[button.dataset.preset]);
    Object.keys(configs).forEach(refresh);
    document.querySelectorAll(".preset").forEach((item) => item.classList.toggle("active", item === button));
  }));
  const panel = document.getElementById("panel"), collapse = document.getElementById("collapse");
  collapse.addEventListener("click", () => {
    const closed = panel.classList.toggle("collapsed");
    collapse.setAttribute("aria-expanded", String(!closed));
    collapse.setAttribute("aria-label", closed ? "Open controls" : "Close controls");
  });
  const drift = document.getElementById("drift");
  drift.addEventListener("click", () => {
    state.autopilot = !state.autopilot;
    drift.classList.toggle("on", state.autopilot);
    drift.setAttribute("aria-pressed", String(state.autopilot));
    drift.querySelector("span").textContent = state.autopilot ? "Camera drift on" : "Camera drift off";
  });
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */
function init() {
  setupControls();
  const mount = document.getElementById("stage"), error = document.getElementById("error");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  } catch {
    error.classList.add("show");
    return;
  }

  const mobile = innerWidth < 700;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 20000);
  camera.position.set(6.8, 3.1, 13);

  let degraded = 0;
  const basePixelRatio = () => Math.min(devicePixelRatio, mobile ? 1.3 : 1.75) * Math.pow(0.75, degraded);
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(basePixelRatio());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = state.exposure;
  renderer.shadowMap.enabled = !mobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mount.appendChild(renderer.domElement);

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.045;
  controls.target.set(0, 0.7, -7);
  controls.minDistance = 4;
  controls.maxDistance = 46;
  controls.minPolarAngle = 0.55;
  controls.maxPolarAngle = Math.PI * 0.985; // orbit below the surface to dive
  controls.autoRotate = state.autopilot && !reducedMotion.matches;
  controls.autoRotateSpeed = 0.2;

  const sun = new THREE.Vector3(0, 1, 0);
  const moon = new THREE.Vector3(0, 1, 0);
  const lightDir = new THREE.Vector3(0, 1, 0);

  /* ---- sky ---- */
  const skyUniforms = {
    uSunDir: { value: sun },
    uMoonDir: { value: moon },
    uTurbidity: { value: 2.5 },
    uRayleigh: { value: 2.2 },
    uMieCoefficient: { value: 0.005 },
    uMieDirectionalG: { value: 0.8 },
    uTime: { value: 0 },
    uCloudCover: { value: state.clouds },
    uDay: { value: 1 },
    uSkyGamma: { value: 1.05 },
    uSkyGain: { value: 0.22 },
    uSkyLift: { value: 0.65 },
    uSkySat: { value: 1.35 },
    uHazeBand: { value: 0.07 },
    uHazeMix: { value: 0.75 },
    uCloudScale: { value: 1.2 },
    uCloudSharp: { value: 0.2 },
    uUnderFog: { value: new THREE.Color(0.02, 0.1, 0.13) },
    uUnderwater: { value: 0 },
    uLightning: { value: 0 },
    uRainSky: { value: 0 },
    uSunTint: { value: new THREE.Color(1, 1, 1) },
    uCloudAmbient: { value: new THREE.Color(0.5, 0.55, 0.62) },
    uFogColor: { value: new THREE.Color(0.7, 0.79, 0.86) },
  };
  const skyMaterial = new THREE.ShaderMaterial({
    vertexShader: skyVertex, fragmentShader: skyFragment, uniforms: skyUniforms,
    side: THREE.BackSide, depthWrite: false,
    defines: { FBM_OCT: 5, CLOUD_STEPS: 20, CLOUD_LSTEPS: 2 },
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 28), skyMaterial);
  scene.add(sky);
  let mainSkyMaterial = skyMaterial;
  // cheaper sky variant for the reflection pass (shared uniforms)
  const skyMirrorMaterial = new THREE.ShaderMaterial({
    vertexShader: skyVertex, fragmentShader: skyFragment, uniforms: skyUniforms,
    side: THREE.BackSide, depthWrite: false,
    defines: { FBM_OCT: 3, MIRROR_PASS: 1, CLOUD_STEPS: 5, CLOUD_LSTEPS: 1 },
  });
  // low-power fallback: flat 2D deck instead of the volumetric march
  const skyLiteMaterial = new THREE.ShaderMaterial({
    vertexShader: skyVertex, fragmentShader: skyFragment, uniforms: skyUniforms,
    side: THREE.BackSide, depthWrite: false,
    defines: { FBM_OCT: 4, CLOUD_FLAT: 1, CLOUD_STEPS: 2, CLOUD_LSTEPS: 1 },
  });

  /* ---- mirror render target ---- */
  const mirrorSize = mobile ? 512 : 768;
  const mirrorRT = new THREE.WebGLRenderTarget(mirrorSize, mirrorSize, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const mirrorCamera = new THREE.PerspectiveCamera();
  const mirrorMatrix = new THREE.Matrix4();

  /* ---- refraction target: the underwater world seen straight through ---- */
  const refractionRT = new THREE.WebGLRenderTarget(1024, 576, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });

  /* ---- water ---- */
  const waterUniforms = {
    uWaveData: { value: waveLive.map(() => new THREE.Vector4()) },
    uWavePhase: { value: waveLive.map(() => new THREE.Vector4()) },
    uTime: { value: 0 },
    uMirror: { value: mirrorRT.texture },
    uMirrorMatrix: { value: mirrorMatrix },
    uLightDir: { value: lightDir },
    uLightColor: { value: new THREE.Color(1, 1, 1) },
    uDeepColor: { value: new THREE.Color() },
    uShallowColor: { value: new THREE.Color() },
    uScatterColor: { value: new THREE.Color() },
    uFogColor: { value: skyUniforms.uFogColor.value },
    uFoamColor: { value: new THREE.Color(0.92, 0.97, 0.98) },
    uFoamAmount: { value: state.foam },
    uFogDensity: { value: 0.0035 },
    uDetailAmp: { value: 1 },
    uUnderFog: { value: new THREE.Color(0.02, 0.1, 0.13) },
    uSkyZenith: { value: new THREE.Color(0.1, 0.28, 0.55) },
    uRefraction: { value: refractionRT.texture },
    uScreenSize: { value: new THREE.Vector2(innerWidth, innerHeight) },
    uCloudCover2: { value: state.clouds },
    uSubmerged: { value: 0 },
    uRain: { value: 0 },
    uDay: { value: 1 },
  };
  const waterDefines = { NW };
  const nearSegments = mobile ? 256 : 448;
  const waterNear = new THREE.Mesh(
    new THREE.PlaneGeometry(420, 420, nearSegments, nearSegments),
    new THREE.ShaderMaterial({ vertexShader: waterVertex, fragmentShader: waterFragment, uniforms: waterUniforms, side: THREE.DoubleSide, defines: { ...waterDefines } })
  );
  waterNear.rotation.x = -Math.PI / 2;
  scene.add(waterNear);
  const waterFar = new THREE.Mesh(
    new THREE.RingGeometry(204, 5200, 96, 12),
    new THREE.ShaderMaterial({ vertexShader: waterVertex, fragmentShader: waterFragment, uniforms: waterUniforms, side: THREE.DoubleSide, defines: { ...waterDefines, FAR_PLANE: 1 } })
  );
  waterFar.rotation.x = -Math.PI / 2;
  waterFar.position.y = -0.04;
  scene.add(waterFar);

  /* ---- seabed + island landmass ---- */
  const floorUniforms = {
    uLightDir: { value: lightDir },
    uLightColor: { value: new THREE.Color(1, 1, 1) },
    uAmbient: { value: new THREE.Color(0.35, 0.4, 0.45) },
    uFogColor2: { value: new THREE.Color(0.05, 0.1, 0.13) },
    uFogDensity2: { value: 0.0035 },
    uTime: { value: 0 },
  };
  const floorMaterial = new THREE.ShaderMaterial({ vertexShader: floorVertex, fragmentShader: floorFragment, uniforms: floorUniforms });

  // high-res patch under/around the island, coarse abyssal plane beyond
  // (plane rotated -90° about X: local (x, y, z) -> world (x, z, -y))
  const islandPatchGeo = new THREE.PlaneGeometry(150, 150, 150, 150);
  {
    const pos = islandPatchGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + ISLAND.x;
      const wz = -pos.getY(i) + ISLAND.z;
      pos.setZ(i, floorHeight(wx, wz));
    }
    pos.needsUpdate = true;
    islandPatchGeo.computeVertexNormals();
  }
  const islandPatch = new THREE.Mesh(islandPatchGeo, floorMaterial);
  islandPatch.rotation.x = -Math.PI / 2;
  islandPatch.position.set(ISLAND.x, 0, ISLAND.z);
  islandPatch.receiveShadow = true;
  scene.add(islandPatch);

  const abyssGeo = new THREE.PlaneGeometry(2600, 2600, 48, 48);
  {
    const pos = abyssGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i);
      const wz = -pos.getY(i);
      const nearIsland = Math.hypot(wx - ISLAND.x, wz - ISLAND.z) < 72;
      pos.setZ(i, nearIsland ? -SEA_DEPTH - 0.35 : floorHeight(wx, wz) - 0.15);
    }
    pos.needsUpdate = true;
    abyssGeo.computeVertexNormals();
  }
  const abyss = new THREE.Mesh(abyssGeo, floorMaterial);
  abyss.rotation.x = -Math.PI / 2;
  scene.add(abyss);

  /* ---- island flora + rocks ---- */
  const palmSpots = [
    [-4.5, -2, 0], [3.5, 1.5, 1], [-1, 4.5, 2], [6.5, -4, 3], [-8, 3, 4],
  ];
  for (const [px, pz, seed] of palmSpots) {
    const palm = createPalmTree(seed);
    const wx = ISLAND.x + px, wz = ISLAND.z + pz;
    palm.position.set(wx, floorHeight(wx, wz) - 0.12, wz);
    const s = 0.85 + (seed % 3) * 0.14;
    palm.scale.setScalar(s);
    scene.add(palm);
  }
  const rockSpots = [
    [11, 6, 0, 1.6], [13, 2, 1, 2.2], [9.5, 9, 2, 1.2], [-12.5, -7, 3, 1.8],
    [-10, -10.5, 4, 1.1], [15.5, -3, 5, 1.4], [2, 12.5, 6, 1.9],
  ];
  for (const [px, pz, seed, s] of rockSpots) {
    const rock = createBeachRock(seed);
    const wx = ISLAND.x + px, wz = ISLAND.z + pz;
    // embed against the local slope so no edge floats
    const base = Math.min(
      floorHeight(wx, wz),
      floorHeight(wx + s * 0.6, wz), floorHeight(wx - s * 0.6, wz),
      floorHeight(wx, wz + s * 0.6), floorHeight(wx, wz - s * 0.6)
    );
    rock.position.set(wx, base + 0.02 * s, wz);
    rock.scale.set(s * 1.35, s * 1.6, s * 1.35);
    rock.rotation.y = seed * 1.9;
    scene.add(rock);
  }

  /* ---- kelp ---- */
  const kelpUniforms = {
    uTime: { value: 0 },
    uFogColor2: floorUniforms.uFogColor2,
    uFogDensity2: floorUniforms.uFogDensity2,
    uAmbient: floorUniforms.uAmbient,
    uLightColor: floorUniforms.uLightColor,
  };
  const kelpMaterial = new THREE.ShaderMaterial({ vertexShader: kelpVertex, fragmentShader: kelpFragment, uniforms: kelpUniforms, side: THREE.DoubleSide });
  const kelpBladeGeo = new THREE.PlaneGeometry(0.8, 3.2, 1, 14);
  const kelpSpots = [
    [4, -16, 1.1], [-6, -20, 0.9], [12, -26, 1.4], [-14, -34, 1.0], [20, -44, 1.2],
    [-44, -34, 1.3], [-52, -62, 1.0], [-8, -50, 0.8], [30, -66, 1.1], [0, -38, 1.3],
  ];
  for (const [kx, kz, ks] of kelpSpots) {
    const clump = new THREE.Group();
    for (let b = 0; b < 3; b++) {
      const blade = new THREE.Mesh(kelpBladeGeo, kelpMaterial);
      blade.rotation.y = b * 1.05 + kx;
      blade.position.set((b - 1) * 0.3, 1.5, ((b + 1) % 3 - 1) * 0.3);
      blade.scale.setScalar(0.8 + b * 0.18);
      clump.add(blade);
    }
    clump.position.set(kx, floorHeight(kx, kz) - 0.15, kz);
    clump.scale.setScalar(ks);
    scene.add(clump);
  }

  /* ---- ship + buoy ---- */
  const galleon = createGalleon();
  galleon.position.set(9, 0, -30);
  galleon.rotation.y = -0.5;
  scene.add(galleon);
  const buoy = createBuoy(); buoy.position.set(-10, 0, -18); buoy.scale.setScalar(0.9); scene.add(buoy);

  /* ---- rain: instanced quad streaks, each aligned exactly along its
     own fall velocity (gravity + wind), in a box following the camera ---- */
  const RAIN_COUNT = 1500;
  const RAIN_BOX = 34, RAIN_H = 26;
  const rainGeo = new THREE.InstancedBufferGeometry();
  rainGeo.setAttribute("position", new THREE.Float32BufferAttribute(
    [-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
  rainGeo.setIndex([0, 1, 2, 2, 1, 3]);
  {
    const offsets = new Float32Array(RAIN_COUNT * 3);
    const seeds = new Float32Array(RAIN_COUNT);
    for (let i = 0; i < RAIN_COUNT; i++) {
      offsets[i * 3] = (Math.random() - 0.5) * RAIN_BOX;
      offsets[i * 3 + 1] = Math.random() * RAIN_H;
      offsets[i * 3 + 2] = (Math.random() - 0.5) * RAIN_BOX;
      seeds[i] = Math.random();
    }
    rainGeo.setAttribute("aOffset", new THREE.InstancedBufferAttribute(offsets, 3));
    rainGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
    rainGeo.instanceCount = RAIN_COUNT;
  }
  const rainUniforms = {
    uTime: { value: 0 },
    uRainAmt: { value: 0 },
    uCenter: { value: new THREE.Vector2() },
    uWindVel: { value: new THREE.Vector2(-1.2, -0.4) },
  };
  const rainMaterial = new THREE.ShaderMaterial({
    uniforms: rainUniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec3 aOffset;
      attribute float aSeed;
      uniform float uTime;
      uniform vec2 uCenter;
      uniform vec2 uWindVel;
      varying vec2 vQuad;
      void main() {
        float speed = 13.0 + aSeed * 6.0;
        vec3 vel = vec3(uWindVel.x, -speed, uWindVel.y);
        vec3 axis = normalize(vel);
        float yFall = mod(aOffset.y + aSeed * 43.0 - uTime * speed, ${RAIN_H}.0);
        float dropped = ${RAIN_H}.0 - yFall; // distance fallen since the top
        vec3 base = vec3(
          aOffset.x + dropped * (vel.x / speed) + uCenter.x,
          yFall,
          aOffset.z + dropped * (vel.z / speed) + uCenter.y);
        float len = 0.45 + aSeed * 0.45;
        float wid = 0.013 + aSeed * 0.015;
        vec3 toCam = normalize(cameraPosition - base);
        vec3 side = normalize(cross(axis, toCam));
        vec3 world = base + axis * (position.y * len) + side * (position.x * wid);
        vQuad = vec2(position.x * 2.0, position.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uRainAmt;
      varying vec2 vQuad;
      void main() {
        float across = 1.0 - abs(vQuad.x);
        float ends = smoothstep(0.0, 0.2, vQuad.y) * smoothstep(1.0, 0.7, vQuad.y);
        float a = across * across * ends * uRainAmt * 0.55;
        gl_FragColor = vec4(0.7, 0.77, 0.86, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const rain = new THREE.Mesh(rainGeo, rainMaterial);
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);

  /* ---- lightning bolt: a jagged camera-facing ribbon (hot core +
     wide additive glow), spawned inside the camera's field of view ---- */
  const BOLT_NODES = 56;
  const BOLT_BRANCH = 22;
  function makeRibbonGeo(nodes) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(nodes * 2 * 3);
    const idx = [];
    for (let i = 0; i < nodes - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return geo;
  }
  const boltCoreGeo = makeRibbonGeo(BOLT_NODES);
  const boltGlowGeo = makeRibbonGeo(BOLT_NODES);
  const branchCoreGeo = makeRibbonGeo(BOLT_BRANCH);
  const branchGlowGeo = makeRibbonGeo(BOLT_BRANCH);
  const boltCorePos = boltCoreGeo.attributes.position.array;
  const boltGlowPos = boltGlowGeo.attributes.position.array;
  const branchCorePos = branchCoreGeo.attributes.position.array;
  const branchGlowPos = branchGlowGeo.attributes.position.array;
  const boltCoreMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  boltCoreMat.toneMapped = false; // full-bright white, never dimmed by ACES
  const boltGlowMat = new THREE.MeshBasicMaterial({
    color: 0x7fa8ff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const bolt = new THREE.Group();
  const boltCore = new THREE.Mesh(boltCoreGeo, boltCoreMat);
  const boltGlow = new THREE.Mesh(boltGlowGeo, boltGlowMat);
  const branchCore = new THREE.Mesh(branchCoreGeo, boltCoreMat);
  const branchGlow = new THREE.Mesh(branchGlowGeo, boltGlowMat);
  boltCore.frustumCulled = boltGlow.frustumCulled = false;
  branchCore.frustumCulled = branchGlow.frustumCulled = false;
  bolt.add(boltGlow, boltCore, branchGlow, branchCore);
  bolt.visible = false;
  scene.add(bolt);

  /* ---- underwater ambience: god-ray shafts, only visible while
     diving. Cylindrically billboarded quads leaning along the
     refracted sun ray; caustic bands sweep down them. ---- */
  const SHAFT_COUNT = 18;
  const shaftGeo = new THREE.InstancedBufferGeometry();
  shaftGeo.setAttribute("position", new THREE.Float32BufferAttribute(
    [-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
  shaftGeo.setIndex([0, 1, 2, 2, 1, 3]);
  {
    const data = new Float32Array(SHAFT_COUNT * 4);
    for (let i = 0; i < SHAFT_COUNT; i++) {
      data[i * 4] = (Math.random() - 0.5) * 44;
      data[i * 4 + 1] = (Math.random() - 0.5) * 44;
      data[i * 4 + 2] = 1.1 + Math.random() * 2.4; // width
      data[i * 4 + 3] = Math.random();             // seed
    }
    shaftGeo.setAttribute("aShaft", new THREE.InstancedBufferAttribute(data, 4));
    shaftGeo.instanceCount = SHAFT_COUNT;
  }
  const shaftUniforms = {
    uTime: { value: 0 },
    uShaftAmt: { value: 0 },
    uShaftTilt: { value: new THREE.Vector2() },
    uShaftColor: { value: new THREE.Color(0.4, 0.75, 0.8) },
  };
  const shaftMaterial = new THREE.ShaderMaterial({
    uniforms: shaftUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aShaft; // x, z, width, seed
      uniform vec2 uShaftTilt;
      varying vec2 vQuad;
      varying float vSeed;
      varying float vDist;
      void main() {
        const float BOX = 44.0;
        const float TOP = -0.22;
        const float BOT = -7.4;
        vec2 rel = mod(aShaft.xy - cameraPosition.xz + BOX * 0.5, BOX) - BOX * 0.5;
        vec2 base = cameraPosition.xz + rel;
        float y = mix(BOT, TOP, position.y);
        vec2 center = base + uShaftTilt * (TOP - y); // lean with the refracted sun
        vec3 toCam = vec3(cameraPosition.x - center.x, 0.0, cameraPosition.z - center.y);
        vDist = length(toCam);
        vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toCam / max(vDist, 1e-3)));
        vec3 world = vec3(center.x, y, center.y) + side * (position.x * aShaft.z);
        vQuad = vec2(position.x * 2.0, position.y);
        vSeed = aShaft.w;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uShaftAmt;
      uniform float uTime;
      uniform vec3 uShaftColor;
      varying vec2 vQuad;
      varying float vSeed;
      varying float vDist;
      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
          mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        float across = 1.0 - vQuad.x * vQuad.x;
        across *= across;
        // caustic bands sweep down the shaft as the surface refocuses light
        float bands = vnoise(vec2(vSeed * 61.0 + vQuad.x * 2.3 + uTime * 0.4, vQuad.y * 5.0 - uTime * 0.7));
        bands = 0.35 + 0.65 * smoothstep(0.3, 0.8, bands);
        // fade out BEFORE the quad's top edge — a hard cutoff there reads
        // as a sharp diagonal seam against the bright surface
        float vert = pow(clamp(vQuad.y, 0.0, 1.0), 1.6) * (1.0 - smoothstep(0.72, 0.98, vQuad.y));
        float distFade = smoothstep(2.0, 5.0, vDist) * smoothstep(26.0, 10.0, vDist);
        float a = across * vert * bands * distFade * uShaftAmt * 0.55;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uShaftColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const shafts = new THREE.Mesh(shaftGeo, shaftMaterial);
  shafts.frustumCulled = false;
  shafts.visible = false;
  scene.add(shafts);

  const boltForward = new THREE.Vector3();
  let boltFade = 1;
  function regenBolt() {
    // a real strike sits kilometres out, inside the camera's view cone
    camera.getWorldDirection(boltForward);
    const az = Math.atan2(boltForward.x, boltForward.z) + (Math.random() - 0.5) * 0.6;
    const distAway = 700 + Math.random() * 600;
    const bx = camera.position.x + Math.sin(az) * distAway;
    const bz = camera.position.z + Math.cos(az) * distAway;
    const topY = 620 + Math.random() * 140;
    boltFade = Math.min(1, 950 / distAway);

    // camera-facing ribbon plane
    const tcx = camera.position.x - bx, tcz = camera.position.z - bz;
    const tcl = Math.hypot(tcx, tcz);
    const px = -tcz / tcl, pz = tcx / tcl;

    // width must grow with distance to stay a few pixels wide on screen
    const wScale = distAway / 1250;

    let x = bx + (Math.random() - 0.5) * 90, z = bz + (Math.random() - 0.5) * 90;
    let wanderX = 0, wanderZ = 0;
    let branchNode = 16 + Math.floor(Math.random() * 14);
    let branchX = 0, branchZ = 0, branchY = 0;
    for (let i = 0; i < BOLT_NODES; i++) {
      const f = i / (BOLT_NODES - 1);       // 0 top -> 1 sea level
      const y = topY * (1 - f);
      // two-scale jag: slow wander re-rolled every few nodes + fine jitter
      if (i % 5 === 0) {
        wanderX = (Math.random() - 0.5) * 24;
        wanderZ = (Math.random() - 0.5) * 24;
      }
      x += wanderX + (Math.random() - 0.5) * 5 + (bx - x) * 0.09;
      z += wanderZ + (Math.random() - 0.5) * 5 + (bz - z) * 0.09;
      if (i === branchNode) { branchX = x; branchZ = z; branchY = y; }
      const wCore = (2.6 - f * 1.2) * wScale;
      const wGlow = wCore * 4.0;
      const k = i * 6;
      boltCorePos[k] = x - px * wCore; boltCorePos[k + 1] = y; boltCorePos[k + 2] = z - pz * wCore;
      boltCorePos[k + 3] = x + px * wCore; boltCorePos[k + 4] = y; boltCorePos[k + 5] = z + pz * wCore;
      boltGlowPos[k] = x - px * wGlow; boltGlowPos[k + 1] = y; boltGlowPos[k + 2] = z - pz * wGlow;
      boltGlowPos[k + 3] = x + px * wGlow; boltGlowPos[k + 4] = y; boltGlowPos[k + 5] = z + pz * wGlow;
    }

    // a thinner branch forks off sideways and peters out mid-air
    let sx = branchX, sz = branchZ;
    const branchDir = Math.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < BOLT_BRANCH; i++) {
      const f = i / (BOLT_BRANCH - 1);
      const y = branchY * (1 - f * 0.8);
      sx += branchDir * (3 + Math.random() * 5) * px * -1 + (Math.random() - 0.5) * 6;
      sz += branchDir * (3 + Math.random() * 5) * pz * -1 + (Math.random() - 0.5) * 6;
      const wCore = (1.2 * (1 - f * 0.85)) * wScale;
      const wGlow = wCore * 6.0;
      const k = i * 6;
      branchCorePos[k] = sx - px * wCore; branchCorePos[k + 1] = y; branchCorePos[k + 2] = sz - pz * wCore;
      branchCorePos[k + 3] = sx + px * wCore; branchCorePos[k + 4] = y; branchCorePos[k + 5] = sz + pz * wCore;
      branchGlowPos[k] = sx - px * wGlow; branchGlowPos[k + 1] = y; branchGlowPos[k + 2] = sz - pz * wGlow;
      branchGlowPos[k + 3] = sx + px * wGlow; branchGlowPos[k + 4] = y; branchGlowPos[k + 5] = sz + pz * wGlow;
    }

    boltCoreGeo.attributes.position.needsUpdate = true;
    boltGlowGeo.attributes.position.needsUpdate = true;
    branchCoreGeo.attributes.position.needsUpdate = true;
    branchGlowGeo.attributes.position.needsUpdate = true;
  }

  const hemi = new THREE.HemisphereLight(0xbfe9ff, 0x0c1a20, 1.2); scene.add(hemi);
  const directional = new THREE.DirectionalLight(0xffe8bd, 3.2);
  directional.castShadow = !mobile;
  directional.shadow.mapSize.set(1024, 1024);
  directional.shadow.camera.near = 0.5;
  directional.shadow.camera.far = 400;
  directional.shadow.camera.left = -85; directional.shadow.camera.right = 85;
  directional.shadow.camera.top = 85; directional.shadow.camera.bottom = -85;
  scene.add(directional, directional.target);

  scene.fog = new THREE.FogExp2(0x9fb4c0, 0.0035);

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(basePixelRatio()); // re-read devicePixelRatio: monitor/zoom may have changed
  });
  renderer.domElement.addEventListener("webglcontextlost", (event) => { event.preventDefault(); error.classList.add("show"); });
  renderer.domElement.addEventListener("webglcontextrestored", () => error.classList.remove("show"));

  /* ---- mirror pass ---- */
  const ORIGIN = new THREE.Vector3(0, 0, 0);
  const mirrorPlane = new THREE.Plane();
  const planeNormal = new THREE.Vector3(0, 1, 0);
  const planeNormalDown = new THREE.Vector3(0, -1, 0);
  const view = new THREE.Vector3();
  const target = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const rotationMatrix = new THREE.Matrix4();
  const clipPlane = new THREE.Vector4();
  const q = new THREE.Vector4();

  function renderMirror() {
    view.copy(camera.position);
    if (view.y <= 0.005) return; // camera at/below surface: reflection invisible
    view.y = Math.min(-0.02, -view.y);

    rotationMatrix.extractRotation(camera.matrixWorld);
    lookAt.set(0, 0, -1).applyMatrix4(rotationMatrix).add(camera.position);
    target.copy(lookAt);
    target.y *= -1;

    mirrorCamera.position.copy(view);
    mirrorCamera.up.set(0, 1, 0).applyMatrix4(rotationMatrix);
    mirrorCamera.up.reflect(planeNormal);
    mirrorCamera.lookAt(target);
    mirrorCamera.far = camera.far;
    mirrorCamera.updateMatrixWorld();
    mirrorCamera.projectionMatrix.copy(camera.projectionMatrix);

    // texture projection matrix (world space)
    mirrorMatrix.set(
      0.5, 0, 0, 0.5,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1
    );
    mirrorMatrix.multiply(mirrorCamera.projectionMatrix);
    mirrorMatrix.multiply(mirrorCamera.matrixWorldInverse);

    // oblique near-plane clipping so nothing below the surface reflects
    mirrorPlane.setFromNormalAndCoplanarPoint(planeNormal, ORIGIN);
    mirrorPlane.applyMatrix4(mirrorCamera.matrixWorldInverse);
    clipPlane.set(mirrorPlane.normal.x, mirrorPlane.normal.y, mirrorPlane.normal.z, mirrorPlane.constant);
    const projectionMatrix = mirrorCamera.projectionMatrix;
    q.x = (Math.sign(clipPlane.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];
    q.y = (Math.sign(clipPlane.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];
    q.z = -1.0;
    q.w = (1.0 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];
    clipPlane.multiplyScalar(2.0 / clipPlane.dot(q));
    projectionMatrix.elements[2] = clipPlane.x;
    projectionMatrix.elements[6] = clipPlane.y;
    projectionMatrix.elements[10] = clipPlane.z + 1.0 - 0.003;
    projectionMatrix.elements[14] = clipPlane.w;

    waterNear.visible = false;
    waterFar.visible = false;
    const rainWasVisible = rain.visible;
    rain.visible = false;
    sky.material = skyMirrorMaterial;
    const oldToneMapping = renderer.toneMapping;
    const oldShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(mirrorRT);
    renderer.clear();
    renderer.render(scene, mirrorCamera);
    renderer.setRenderTarget(null);
    renderer.toneMapping = oldToneMapping;
    renderer.shadowMap.autoUpdate = oldShadowAuto;
    sky.material = mainSkyMaterial;
    rain.visible = rainWasVisible;
    waterNear.visible = true;
    waterFar.visible = true;
  }

  /* ---- under-mirror pass: while submerged, render the underwater
     scene reflected across the surface plane, so total internal
     reflection shows the real seabed / deep water / kelp mirrored ---- */
  function renderMirrorUnder() {
    view.copy(camera.position);
    if (view.y >= -0.02) return; // too close to the plane: reflection invisible
    view.y = -view.y; // virtual camera above the plane, looking down

    rotationMatrix.extractRotation(camera.matrixWorld);
    lookAt.set(0, 0, -1).applyMatrix4(rotationMatrix).add(camera.position);
    target.copy(lookAt);
    target.y *= -1;

    mirrorCamera.position.copy(view);
    mirrorCamera.up.set(0, 1, 0).applyMatrix4(rotationMatrix);
    mirrorCamera.up.reflect(planeNormal);
    mirrorCamera.lookAt(target);
    mirrorCamera.far = camera.far;
    mirrorCamera.updateMatrixWorld();
    mirrorCamera.projectionMatrix.copy(camera.projectionMatrix);

    mirrorMatrix.set(
      0.5, 0, 0, 0.5,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1
    );
    mirrorMatrix.multiply(mirrorCamera.projectionMatrix);
    mirrorMatrix.multiply(mirrorCamera.matrixWorldInverse);

    // oblique near-plane clipping: only what lies BELOW the surface reflects
    mirrorPlane.setFromNormalAndCoplanarPoint(planeNormalDown, ORIGIN);
    mirrorPlane.applyMatrix4(mirrorCamera.matrixWorldInverse);
    clipPlane.set(mirrorPlane.normal.x, mirrorPlane.normal.y, mirrorPlane.normal.z, mirrorPlane.constant);
    const projectionMatrix = mirrorCamera.projectionMatrix;
    q.x = (Math.sign(clipPlane.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];
    q.y = (Math.sign(clipPlane.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];
    q.z = -1.0;
    q.w = (1.0 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];
    clipPlane.multiplyScalar(2.0 / clipPlane.dot(q));
    projectionMatrix.elements[2] = clipPlane.x;
    projectionMatrix.elements[6] = clipPlane.y;
    projectionMatrix.elements[10] = clipPlane.z + 1.0 - 0.003;
    projectionMatrix.elements[14] = clipPlane.w;

    waterNear.visible = false;
    waterFar.visible = false;
    const rainWasVisible = rain.visible;
    const boltWasVisible = bolt.visible;
    const shaftsWere = shafts.visible;
    shafts.visible = false; // camera-relative billboards break in the mirror view
    rain.visible = false;
    bolt.visible = false;
    sky.material = skyMirrorMaterial; // its underwater branch paints the murk backdrop
    const oldToneMapping = renderer.toneMapping;
    const oldShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(mirrorRT);
    renderer.clear();
    renderer.render(scene, mirrorCamera);
    renderer.setRenderTarget(null);
    renderer.toneMapping = oldToneMapping;
    renderer.shadowMap.autoUpdate = oldShadowAuto;
    sky.material = mainSkyMaterial;
    rain.visible = rainWasVisible;
    bolt.visible = boltWasVisible;
    shafts.visible = shaftsWere;
    waterNear.visible = true;
    waterFar.visible = true;
  }

  /* ---- skyward pass: while submerged, capture the world ABOVE the
     surface into the refraction target so Snell's window shows it ---- */
  function renderSkyward() {
    waterNear.visible = false;
    waterFar.visible = false;
    const shaftsWere = shafts.visible;
    shafts.visible = false; // shafts must not leak into the capture of the world above
    const oldToneMapping = renderer.toneMapping;
    const oldShadowAuto = renderer.shadowMap.autoUpdate;
    const oldUnderwater = skyUniforms.uUnderwater.value;
    skyUniforms.uUnderwater.value = 0; // the sky above the surface is an air sky
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(refractionRT);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.toneMapping = oldToneMapping;
    renderer.shadowMap.autoUpdate = oldShadowAuto;
    skyUniforms.uUnderwater.value = oldUnderwater;
    shafts.visible = shaftsWere;
    waterNear.visible = true;
    waterFar.visible = true;
  }

  /* ---- refraction pass: the underwater world through the main camera ---- */
  const savedClearColor = new THREE.Color();
  function renderRefraction() {
    waterNear.visible = false;
    waterFar.visible = false;
    sky.visible = false;
    const rainWasVisible = rain.visible;
    const boltWasVisible = bolt.visible;
    rain.visible = false;
    bolt.visible = false;
    const oldToneMapping = renderer.toneMapping;
    const oldShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(savedClearColor);
    const oldClearAlpha = renderer.getClearAlpha();
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(underFog, 1); // missed rays dissolve into deep water
    renderer.setRenderTarget(refractionRT);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(savedClearColor, oldClearAlpha);
    renderer.toneMapping = oldToneMapping;
    renderer.shadowMap.autoUpdate = oldShadowAuto;
    sky.visible = true;
    rain.visible = rainWasVisible;
    bolt.visible = boltWasVisible;
    waterNear.visible = true;
    waterFar.visible = true;
  }

  /* ---- per-frame state ---- */
  const debugFlags = { freezeSky: false };
  const smooth = {
    wind: state.wind, waveHeight: state.waveHeight, foam: state.foam,
    clouds: state.clouds, time: state.time, rain: state.rain,
  };
  const SMOOTH_KEYS = Object.keys(smooth);
  let subMix = 0;
  const underFog = new THREE.Color();
  let nextStrike = 6, flashEnv = 0, boltLife = 0, lastElapsed = 0;
  const deepColor = waterUniforms.uDeepColor.value;
  const shallowColor = waterUniforms.uShallowColor.value;
  const scatterColor = waterUniforms.uScatterColor.value;
  const hemiSky = new THREE.Color();
  const hemiGround = new THREE.Color();

  const startedAt = performance.now();
  let frames = 0, fpsStarted = startedAt, shown = false, lastFps = 60;
  // hidden tabs run on a throttled timer; never let those frames pollute the fps stats
  document.addEventListener("visibilitychange", () => { frames = 0; fpsStarted = performance.now(); });

  function animate() {
    // rAF pauses in hidden tabs; keep the simulation alive regardless
    if (document.hidden) setTimeout(animate, 40);
    else requestAnimationFrame(animate);
    tick();
  }

  function tick() {
    const elapsed = (performance.now() - startedAt) / 1000;

    // smooth slider values so presets glide
    for (const key of SMOOTH_KEYS) smooth[key] = THREE.MathUtils.lerp(smooth[key], state[key], 0.04);

    directionForHour(smooth.time, sun);
    moon.set(-sun.x, Math.max(0.28, -sun.y * 0.8 + 0.22), -sun.z).normalize();
    const atmo = computeAtmosphere(sun, smooth.clouds);
    atmo.fog.multiplyScalar(1 - smooth.rain * 0.42); // rain-darkened haze everywhere
    const isDay = atmo.day > 0.35;
    lightDir.copy(isDay ? sun : moon);
    // fade the key light to zero across the sun/moon handover so the swap never pops
    const twilightDim = Math.min(1, Math.abs(atmo.day - 0.35) / 0.12);

    /* sky uniforms */
    skyUniforms.uTime.value = elapsed;
    skyUniforms.uCloudCover.value = smooth.clouds;
    skyUniforms.uDay.value = atmo.day;
    if (!debugFlags.freezeSky) {
      skyUniforms.uTurbidity.value = Math.min(2.2 + atmo.overcast * 7.6 + atmo.warm * 1.2, 12);
      skyUniforms.uRayleigh.value = THREE.MathUtils.lerp(3.2, 2.4, atmo.warm);
      skyUniforms.uMieCoefficient.value = 0.003 + atmo.overcast * 0.016 + atmo.warm * 0.021;
      skyUniforms.uSkySat.value = 1.38 - atmo.warm * 0.33 - atmo.overcast * 0.25;
    }
    skyUniforms.uSunTint.value.copy(atmo.sunTint).multiplyScalar(0.55 * atmo.day + 0.01);
    skyUniforms.uCloudAmbient.value.copy(COL.dayAmbient).lerp(COL.duskAmbient, atmo.warm * 0.85)
      .lerp(COL.nightAmbient, 1 - atmo.day).multiplyScalar(THREE.MathUtils.lerp(1, 0.32, atmo.overcast));
    skyUniforms.uFogColor.value.copy(atmo.fog);

    /* water uniforms */
    updateWaveLive(smooth.waveHeight, smooth.wind, elapsed);
    for (let i = 0; i < NW; i++) {
      const w = waveLive[i];
      waterUniforms.uWaveData.value[i].set(w.kx, w.ky, w.amp, w.q);
      waterUniforms.uWavePhase.value[i].set(w.phase, w.gphase, w.omega, w.envDepth);
    }
    // wave phases are wrapped above; this drives only the noise fields
    waterUniforms.uTime.value = elapsed % 3600;
    waterUniforms.uFoamAmount.value = smooth.foam;
    waterUniforms.uDetailAmp.value = THREE.MathUtils.clamp(0.35 + smooth.wind * 0.22, 0.4, 1.5);
    waterUniforms.uLightColor.value.copy(isDay ? atmo.sunTint : COL.moon)
      .multiplyScalar((isDay ? 1 : 0.5) * twilightDim);
    deepColor.copy(COL.deepDay).lerp(COL.deepStorm, atmo.overcast).multiplyScalar(0.12 + 0.88 * atmo.day);
    shallowColor.copy(COL.shallowDay).lerp(COL.shallowStorm, atmo.overcast).multiplyScalar(0.1 + 0.9 * atmo.day);
    scatterColor.copy(COL.scatterDay).multiplyScalar(atmo.day * (1 - atmo.overcast * 0.75) * (1 - atmo.warm * 0.45));

    /* lights + scene fog */
    directional.position.copy(lightDir).multiplyScalar(160);
    directional.target.position.set(-10, 0, -40);
    directional.color.copy(isDay ? atmo.sunTint : COL.moon);
    directional.intensity = (isDay
      ? Math.max(0.1, sun.y) * 3.4 * (1 - atmo.overcast * 0.72)
      : 0.34) * twilightDim;
    hemiSky.copy(COL.dayAmbient).lerp(COL.duskAmbient, atmo.warm * 0.7).lerp(COL.nightAmbient, 1 - atmo.day);
    hemiGround.copy(deepColor).multiplyScalar(2.2);
    hemi.color.copy(hemiSky);
    hemi.groundColor.copy(hemiGround);
    hemi.intensity = THREE.MathUtils.lerp(0.25, 1.35, atmo.day) * (1 - atmo.overcast * 0.4);
    renderer.toneMappingExposure = THREE.MathUtils.lerp(renderer.toneMappingExposure, state.exposure, 0.05);
    controls.autoRotate = state.autopilot && !reducedMotion.matches;

    /* prop bobbing on the real wave field */
    const buoyS = sampleSlope(buoy.position.x, buoy.position.z, elapsed, 0.4);
    buoy.position.y = buoyS.h - 0.05;
    buoy.rotation.z = THREE.MathUtils.lerp(buoy.rotation.z, -buoyS.dx * 1.6, 0.1);
    buoy.rotation.x = THREE.MathUtils.lerp(buoy.rotation.x, buoyS.dz * 1.6, 0.1);
    const shipS = sampleSlope(galleon.position.x, galleon.position.z, elapsed, 3.5);
    galleon.position.y = shipS.h * 0.45 - 0.3;
    galleon.rotation.z = THREE.MathUtils.lerp(galleon.rotation.z, -shipS.dx * 0.12, 0.03);
    galleon.rotation.x = THREE.MathUtils.lerp(galleon.rotation.x, shipS.dz * 0.09, 0.03);
    // lamplight breathes and gutters slightly — lights from inside, not stickers
    const paneMats = galleon.userData.paneMats;
    if (paneMats) {
      paneMats.bright.emissiveIntensity =
        1.2 + Math.sin(elapsed * 8.7) * 0.09 + Math.sin(elapsed * 23.3 + 1.7) * 0.06;
      paneMats.dim.emissiveIntensity =
        0.5 + Math.sin(elapsed * 6.1 + 3.1) * 0.07 + Math.sin(elapsed * 17.9) * 0.04;
    }

    /* ---- above/below surface handover ---- */
    const camSurface = sampleWave(camera.position.x, camera.position.z, elapsed);
    const submerged = camera.position.y < camSurface - 0.04;
    subMix = THREE.MathUtils.lerp(subMix, submerged ? 1 : 0, 0.25);
    // the water column dims as the camera sinks — less light reaches down
    const camDepth = Math.max(0, camSurface - camera.position.y);
    underFog.copy(COL.underFogDay)
      .multiplyScalar((0.1 + 0.9 * atmo.day) * (1 - atmo.overcast * 0.45)
        * (0.55 + 0.45 * Math.exp(-camDepth * 0.07)));
    skyUniforms.uUnderwater.value = subMix;
    skyUniforms.uUnderFog.value.copy(underFog);
    waterUniforms.uUnderFog.value.copy(underFog);
    waterUniforms.uSkyZenith.value
      .setRGB(0.1, 0.28, 0.55)
      .multiplyScalar(atmo.day * (1 - atmo.overcast * 0.55) + 0.015);
    scene.fog.color.copy(submerged ? underFog : atmo.fog);
    scene.fog.density = submerged ? 0.02 : 0.0035 + smooth.rain * 0.0022;
    floorUniforms.uLightColor.value.copy(waterUniforms.uLightColor.value);
    floorUniforms.uAmbient.value.copy(hemiSky).multiplyScalar(0.4 * (0.25 + 0.75 * atmo.day) + 0.03);
    floorUniforms.uFogColor2.value.copy(submerged ? underFog : atmo.fog);
    floorUniforms.uFogDensity2.value = submerged ? 0.02 : 0.0035;
    floorUniforms.uTime.value = waterUniforms.uTime.value;
    kelpUniforms.uTime.value = waterUniforms.uTime.value;

    waterUniforms.uCloudCover2.value = smooth.clouds;
    waterUniforms.uSubmerged.value = subMix;
    renderer.getDrawingBufferSize(waterUniforms.uScreenSize.value);

    /* ---- rain ---- */
    const dtSec = Math.min(Math.max(elapsed - lastElapsed, 0.001), 0.1);
    lastElapsed = elapsed;
    waterUniforms.uRain.value = smooth.rain;
    waterUniforms.uDay.value = atmo.day;
    skyUniforms.uRainSky.value = smooth.rain;
    rain.visible = smooth.rain > 0.03 && subMix < 0.5;
    rainUniforms.uRainAmt.value = smooth.rain;
    rainUniforms.uTime.value = elapsed % 3600;
    rainUniforms.uCenter.value.set(camera.position.x, camera.position.z);
    rainUniforms.uWindVel.value.set(-smooth.wind * 0.55, -smooth.wind * 0.18);
    // rain kills the daylight
    directional.intensity *= 1 - smooth.rain * 0.45;
    hemi.intensity *= 1 - smooth.rain * 0.35;

    /* ---- underwater ambience: god-ray shafts ---- */
    const shaftStrength = subMix * atmo.day * (1 - atmo.overcast * 0.9)
      * THREE.MathUtils.clamp(sun.y * 3.2, 0, 1) * (1 - smooth.rain * 0.6);
    shafts.visible = shaftStrength > 0.015;
    shaftUniforms.uTime.value = elapsed % 3600;
    shaftUniforms.uShaftAmt.value = shaftStrength;
    // refract the sun ray at the surface so the shafts lean the right way
    {
      const eta = 1 / 1.33;
      const cosI = Math.max(sun.y, 0.05);
      const kRefr = Math.max(1 - eta * eta * (1 - cosI * cosI), 1e-3);
      shaftUniforms.uShaftTilt.value.set(
        (-sun.x * eta) / Math.sqrt(kRefr),
        (-sun.z * eta) / Math.sqrt(kRefr));
    }
    shaftUniforms.uShaftColor.value.copy(atmo.sunTint).lerp(COL.shaftTint, 0.45);

    /* ---- lightning: heavy rain builds strikes on a random cadence ---- */
    nextStrike -= dtSec;
    if (smooth.rain > 0.68 && nextStrike <= 0) {
      regenBolt();
      boltLife = 0.34;
      flashEnv = 1;
      nextStrike = 2.5 + Math.random() * 5.5;
    }
    flashEnv = Math.max(0, flashEnv - dtSec * 3.6);
    boltLife = Math.max(0, boltLife - dtSec);
    // return stroke pattern: bright hit, dip, re-strike, fade
    const bp = 1 - boltLife / 0.34;
    const boltOp = boltLife > 0
      ? (bp < 0.3 ? 1 : bp < 0.45 ? 0.25 : bp < 0.75 ? 0.95 : Math.max(0, (1 - bp) / 0.25))
      : 0;
    const flick = flashEnv * (0.55 + 0.45 * Math.sin(elapsed * 120.0 + flashEnv * 40.0));
    skyUniforms.uLightning.value = flick;
    bolt.visible = boltLife > 0;
    boltCoreMat.opacity = boltOp * boltFade;
    boltGlowMat.opacity = boltOp * 0.3 * boltFade;
    if (flick > 0.01) {
      hemi.intensity += flick * 2.4;
      directional.intensity += flick * 1.6;
      waterUniforms.uLightColor.value.addScalar(flick * 0.55);
      floorUniforms.uAmbient.value.addScalar(flick * 0.3);
    }

    controls.update();
    if (!submerged) {
      renderMirror();
      renderRefraction();
    } else {
      renderSkyward();
      renderMirrorUnder();
    }
    renderer.render(scene, camera);

    if (!shown) {
      shown = true;
      document.getElementById("loading").classList.add("done");
    }
    frames++;
    const now = performance.now();
    if (now - fpsStarted > 2500) {
      // abnormally long window (throttled/suspended tab) — discard it
      frames = 0;
      fpsStarted = now;
    } else if (now - fpsStarted > 900) {
      lastFps = Math.round((frames * 1000) / (now - fpsStarted));
      document.getElementById("status").textContent = `WebGL · ${lastFps} fps`;
      document.getElementById("quality").textContent =
        degraded === 0 ? "High" : degraded === 1 ? "Balanced" : degraded === 2 ? "Adaptive" : "Eco";
      // adaptive quality ladder: resolution → render targets → flat clouds
      // (hidden tabs run on a throttled timer loop, so their fps is meaningless)
      if (!document.hidden && lastFps < 38 && degraded < 3 && now - startedAt > 4000) {
        degraded++;
        renderer.setPixelRatio(Math.max(0.85, basePixelRatio()));
        if (degraded === 2) {
          mirrorRT.setSize(384, 384);
          refractionRT.setSize(512, 288);
        }
        if (degraded === 3) {
          mainSkyMaterial = skyLiteMaterial;
          sky.material = mainSkyMaterial;
        }
      }
      frames = 0;
      fpsStarted = now;
    }
  }
  animate();

  // Headless debug/capture hook (no-op for normal viewing)
  window.__tideline = {
    state,
    sky: skyUniforms,
    water: waterUniforms,
    flags: debugFlags,
    scene,
    islandPatch,
    floorHeight,
    set(partial) { Object.assign(state, partial); },
    settle() { for (const key of Object.keys(smooth)) smooth[key] = state[key]; },
    strike() { regenBolt(); boltLife = 0.34; flashEnv = 1; },
    tick, // one manual simulation+render step (throttle-proof capture)
    snapRaw(quality = 0.62) { return renderer.domElement.toDataURL("image/jpeg", quality); },
    look(x, y, z, tx, ty, tz) {
      camera.position.set(x, y, z);
      if (tx !== undefined) controls.target.set(tx, ty, tz);
      controls.update();
    },
    resize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    },
    snap(quality = 0.62) {
      // render a fresh frame in this task so toDataURL is never stale
      // (a visible tab clears the drawing buffer after each composite)
      const elapsed = (performance.now() - startedAt) / 1000;
      const sub = camera.position.y < sampleWave(camera.position.x, camera.position.z, elapsed) - 0.04;
      if (!sub) { renderMirror(); renderRefraction(); } else { renderSkyward(); renderMirrorUnder(); }
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL("image/jpeg", quality);
    },
    bench(frames = 40) {
      const gl = renderer.getContext();
      gl.finish();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        renderMirror();
        renderer.render(scene, camera);
      }
      gl.finish();
      return (performance.now() - t0) / frames;
    },
  };
}

init();
