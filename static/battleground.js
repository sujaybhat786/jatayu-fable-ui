/* ============================================================
   JATAYU OS — battleground.js
   The Shri Yantra Core: wireframe cube + nine-triangle yantra +
   black-hole orb (accretion disk / photon ring / infall
   particles) + feathered wings, one line-material system, one
   live state color, bloom post-processing.

   Voice Independence Principle: this module only ever runs
   inside requestAnimationFrame and exposes flag-setting
   methods. Nothing here awaits, polls, or touches the WS/audio
   pipeline; under load it degrades its own visuals first.
   ============================================================ */

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

/* ---------- palette (mirrors the CSS tokens exactly) ---------- */
const PAL = {
  ice:     { line: new THREE.Color(0xa9d6ff), hi: new THREE.Color(0xeaf4ff), lo: new THREE.Color(0x4c7fa6) },
  gold:    { line: new THREE.Color(0xe8b84b), hi: new THREE.Color(0xffe9b0), lo: new THREE.Color(0x8a652a) },
  pearl:   { line: new THREE.Color(0xede6d6), hi: new THREE.Color(0xffffff), lo: new THREE.Color(0x8f887a) },
  crimson: { line: new THREE.Color(0xe14b4b), hi: new THREE.Color(0xff8080), lo: new THREE.Color(0x6e1e1e) },
  chrome:  { line: new THREE.Color(0x6b7280), hi: new THREE.Color(0x9ca3af), lo: new THREE.Color(0x374151) },
};

const VOID = 0x05060a;

/* ---------- per-state targets ----------
   Gold is the guardian's resting identity. Blue exists only while
   LISTENING, white only while SPEAKING, crimson only on ALERT.
   Motion stays slow everywhere: this thing weighs billions of tons. */
const STATES = {
  IDLE:      { pal: "gold",    activity: 0.2,  bloom: 0.7,  flare: 0.0,   motion: 0.5,  rim: 1.0 },
  LISTENING: { pal: "ice",     activity: 0.45, bloom: 0.85, flare: 1.0,   motion: 0.55, rim: 1.9 },
  THINKING:  { pal: "gold",    activity: 0.9,  bloom: 1.05, flare: 0.35,  motion: 0.85, rim: 1.25 },
  SPEAKING:  { pal: "pearl",   activity: 0.7,  bloom: 0.9,  flare: 0.55,  motion: 0.6,  rim: 1.4 },
  ALERT:     { pal: "crimson", activity: 0.05, bloom: 0.65, flare: -0.55, motion: 0.04, rim: 1.5 },
};

/* ---------- geometry scale ---------- */
const CUBE_HALF = 1.9;
const YANTRA_R = 1.15;
const ORB_R = 0.42;
const DISK_INNER = 0.6;
const DISK_OUTER = 1.62;
const PARTICLE_COUNT = 1400;

/* ============================================================
   SHADERS
   ============================================================ */

const DISK_VERT = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* Accretion disk: fbm streaks in log-spiral coordinates, hottest at
   the inner edge, with a relativistic-beaming brightness asymmetry. */
const DISK_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vPos;
  uniform float uTime;
  uniform float uActivity;
  uniform float uPulse;
  uniform vec3 uColor;
  uniform vec3 uHi;
  uniform float uInner;
  uniform float uOuter;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise(p);
      p = p * 2.13 + vec2(11.7, 5.3);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    float r = length(vPos);
    if (r > uOuter || r < uInner * 0.72) discard;

    float theta = atan(vPos.y, vPos.x);

    // orbital shear: inner material circles faster
    float speed = (0.35 + 1.75 * uActivity) / max(r, 0.35);
    float swirl = theta * 3.0 + r * 6.5 - uTime * speed;

    float streaks = fbm(vec2(swirl, r * 9.0));
    streaks = pow(streaks, 1.55);

    float heat = pow(smoothstep(uOuter, uInner, r), 1.25);
    float edgeIn = smoothstep(uInner * 0.72, uInner, r);
    float edgeOut = smoothstep(uOuter, uOuter - 0.25, r);

    // doppler beaming — the approaching side burns brighter
    float beam = 1.0 + 0.65 * sin(theta + uTime * 0.07);

    float a = streaks * heat * edgeIn * edgeOut * beam;
    a *= (1.5 + 0.9 * uActivity) * (1.0 + 0.7 * uPulse);

    vec3 col = mix(uColor, uHi, clamp(heat * streaks * 1.6, 0.0, 1.0));
    gl_FragColor = vec4(col * a, a);
  }
`;

/* Event horizon: opaque black body, thin fresnel rim in state color. */
const HORIZON_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalMatrix * normal;
    vV = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const HORIZON_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vN;
  varying vec3 vV;
  uniform vec3 uColor;
  uniform vec3 uHi;
  uniform float uRim;
  void main() {
    float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 4.5);
    vec3 col = mix(uColor, uHi, 0.5) * fres * uRim;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/* Photon ring: camera-facing lensing halo just outside the horizon. */
const RING_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vPos;
  uniform vec3 uColor;
  uniform vec3 uHi;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uIntensity;
  void main() {
    float d = length(vPos);
    float ring = exp(-pow((d - uRadius) / uWidth, 2.0));
    float halo = 0.1 * exp(-pow((d - uRadius) / (uWidth * 5.0), 2.0));
    float a = (ring + halo) * uIntensity;
    gl_FragColor = vec4(mix(uColor, uHi, 0.65) * a, a);
  }
`;

/* Infall particles: GPU-side spiral, radius decays over each cycle.
   uActivity throttles both drift speed and brightness. */
const PARTICLE_VERT = /* glsl */ `
  attribute float aSeed;
  attribute float aTilt;
  varying float vFade;
  varying float vMix;
  uniform float uTime;
  uniform float uActivity;
  uniform float uRmin;
  uniform float uRmax;
  uniform float uSize;
  void main() {
    float speed = 0.015 + 0.14 * fract(aSeed * 7.31);
    float t = fract(aSeed + uTime * speed * (0.12 + uActivity));
    float r = mix(uRmax, uRmin, t * t);
    float ang = aSeed * 251.327 + uTime * (0.08 + 0.55 * uActivity) / max(r, 0.4) + t * 7.0;
    vec3 p = vec3(cos(ang) * r, aTilt * 0.16 * (r / uRmax), sin(ang) * r);

    vFade = smoothstep(uRmin, uRmin + 0.3, r) * smoothstep(uRmax, uRmax - 0.35, r);
    vMix = t;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * (0.6 + fract(aSeed * 3.7)) * (140.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAG = /* glsl */ `
  precision highp float;
  varying float vFade;
  varying float vMix;
  uniform vec3 uColor;
  uniform vec3 uHi;
  uniform float uActivity;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.0, length(c));
    a = a * a * vFade * (0.12 + 0.55 * uActivity);
    vec3 col = mix(uColor, uHi, vMix * 0.75);
    gl_FragColor = vec4(col * a, a);
  }
`;

/* Horizontal dust streams flowing outward from the core — the
   golden waves at the left and right of the reference frame. */
const DUST_VERT = /* glsl */ `
  attribute float aSeed;
  varying float vA;
  uniform float uTime;
  uniform float uSize;
  void main() {
    float s1 = fract(aSeed * 13.73);
    float s2 = fract(aSeed * 57.31);
    float side = s1 < 0.5 ? -1.0 : 1.0;
    float t = fract(aSeed + uTime * (0.006 + 0.012 * s2));
    float x = side * (2.3 + t * 5.6);
    float y = (s2 - 0.5) * 2.4 * (0.35 + t) + sin(t * 11.0 + aSeed * 43.0) * 0.14;
    float z = (fract(aSeed * 7.91) - 0.5) * 3.2;
    vA = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.7, 1.0, t));
    vec4 mv = modelViewMatrix * vec4(x, y, z, 1.0);
    gl_PointSize = uSize * (0.5 + s2) * (140.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const DUST_FRAG = /* glsl */ `
  precision highp float;
  varying float vA;
  uniform vec3 uColor;
  uniform vec3 uHi;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.0, length(c));
    a = a * a * vA * 0.45;
    gl_FragColor = vec4(mix(uColor, uHi, 0.3) * a, a);
  }
`;

/* Volumetric back-glow: a broad radial haze behind the core so the
   singularity sits in an atmosphere, not on flat black. */
const GLOW_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vPos;
  uniform vec3 uColor;
  uniform float uIntensity;
  void main() {
    float d = length(vPos) / 4.0;
    float a = exp(-d * d * 3.2) * uIntensity;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

/* ============================================================
   MODULE STATE
   ============================================================ */

const S = {
  inited: false,
  webgl: true,
  reducedMotion: false,
  running: false,
  rafId: 0,

  container: null,
  getAudioLevel: null,

  renderer: null,
  composer: null,
  bloomPass: null,
  scene: null,
  camera: null,
  resizeObserver: null,

  coreGroup: null,
  cubeGroup: null,
  yantra: null, // { group, frame, down, up }
  orbGroup: null,
  diskGroup: null,
  ringMesh: null,
  wingL: null,
  wingR: null,
  particles: null,
  dais: null,
  dust: null,
  glowMesh: null,

  stateLineMats: [],           // [{ m, k }] — tinted by live state color
  wingMats: { google: [], comms: [], knowledge: [], voice: [] },
  clusterHealth: { google: "healthy", comms: "healthy", knowledge: "healthy", voice: "healthy" },

  diskUniforms: null,
  horizonUniforms: null,
  ringUniforms: null,
  particleUniforms: null,
  dustUniforms: null,
  glowUniforms: null,

  stateName: "IDLE",
  target: { ...STATES.IDLE },
  cur: {
    line: PAL.ice.line.clone(),
    hi: PAL.ice.hi.clone(),
    activity: 0.22,
    bloom: 0.95,
    flare: 0,
    motion: 1,
    rim: 1,
  },
  pulse: 0,
  shaderTime: 0,
  lastTime: 0,
  baseScale: 1,

  // perf degradation ladder: 0 = full, 1 = pixelRatio 1, 2 = no particles/bloom
  perfLevel: 0,
  frameAcc: 0,
  frameCount: 0,

  fallbackEl: null,
};

const _tmpColor = new THREE.Color();

/* ============================================================
   GEOMETRY BUILDERS — pure line-work, one construction logic
   ============================================================ */

function makeLineMat(k) {
  const m = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  S.stateLineMats.push({ m, k });
  return m;
}

function makeWingMat(clusterId, k) {
  const m = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  S.wingMats[clusterId].push({ m, k });
  return m;
}

function loopFromPoints(pts, mat) {
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.LineLoop(g, mat);
}

function segmentsFromPoints(pts, mat) {
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.LineSegments(g, mat);
}

function circlePoints(r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
  }
  return pts;
}

function squarePoints(half) {
  return [
    new THREE.Vector3(-half, -half, 0),
    new THREE.Vector3(half, -half, 0),
    new THREE.Vector3(half, half, 0),
    new THREE.Vector3(-half, half, 0),
  ];
}

function trianglePoints(r, pointsUp) {
  const start = pointsUp ? Math.PI / 2 : -Math.PI / 2;
  const pts = [];
  for (let i = 0; i < 3; i++) {
    const a = start + (i / 3) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
  }
  return pts;
}

/* Lotus-petal ring: petals as polar arcs bulging outward. */
function petalPoints(rIn, rOut, count) {
  const pts = [];
  const steps = 8;
  for (let i = 0; i < count; i++) {
    const a0 = (i / count) * Math.PI * 2;
    const a1 = ((i + 1) / count) * Math.PI * 2;
    let prev = null;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const ang = a0 + (a1 - a0) * t;
      const r = rIn + (rOut - rIn) * Math.sin(Math.PI * t);
      const p = new THREE.Vector3(Math.cos(ang) * r, Math.sin(ang) * r, 0);
      if (prev) pts.push(prev, p);
      prev = p;
    }
  }
  return pts;
}

/* The nine-triangle yantra in three independently rotating layers,
   with slight z-separation for parallax depth. */
function buildYantra() {
  const group = new THREE.Group();
  const mat = makeLineMat(0.72);

  const frame = new THREE.Group();
  frame.add(loopFromPoints(squarePoints(YANTRA_R * 1.28), makeLineMat(0.4)));
  frame.add(loopFromPoints(squarePoints(YANTRA_R * 1.2), makeLineMat(0.3)));
  for (const r of [1.0, 0.94, 0.88]) {
    frame.add(loopFromPoints(circlePoints(YANTRA_R * r, 96), mat));
  }
  frame.add(segmentsFromPoints(petalPoints(YANTRA_R * 1.0, YANTRA_R * 1.14, 16), makeLineMat(0.45)));
  frame.position.z = -0.14;

  // five descending (shakti) triangles
  const down = new THREE.Group();
  for (const r of [0.86, 0.72, 0.57, 0.42, 0.27]) {
    down.add(loopFromPoints(trianglePoints(YANTRA_R * r, false), mat));
  }
  down.position.z = 0;

  // four ascending (shiva) triangles
  const up = new THREE.Group();
  for (const r of [0.79, 0.64, 0.49, 0.34]) {
    up.add(loopFromPoints(trianglePoints(YANTRA_R * r, true), mat));
  }
  up.position.z = 0.14;

  group.add(frame, down, up);
  return { group, frame, down, up };
}

/* One feather: bezier spine + swept-back barbs, all raw segments.
   The fan sweeps from short down-angled coverts at the bottom to
   long primaries rising well above the cube — the raptor silhouette
   of the reference, not a symmetric fan. */
function buildFeather(out, side, t) {
  const ang = THREE.MathUtils.lerp(-0.3, 1.3, Math.pow(t, 0.9));
  let len = 2.1 + 2.3 * Math.pow(Math.sin(Math.PI * Math.min(t * 0.85 + 0.1, 1.0)), 1.1);
  len *= 0.92 + 0.16 * ((t * 7.13) % 1); // organic stagger, not a perfect arc
  const root = new THREE.Vector3(
    side * 0.18 * Math.sin(t * Math.PI),
    THREE.MathUtils.lerp(-0.75, 0.95, t),
    THREE.MathUtils.lerp(0.14, -0.18, t)
  );
  const dir = new THREE.Vector3(Math.cos(ang) * side, Math.sin(ang), 0);

  const tip = root.clone().addScaledVector(dir, len);
  tip.y += len * (0.12 + 0.34 * t); // curl climbs toward the top primaries
  const ctrl = root.clone().addScaledVector(dir, len * 0.5);
  ctrl.y -= len * 0.11; // sag through the middle gives the curve life

  const curve = new THREE.QuadraticBezierCurve3(root, ctrl, tip);
  const SAMPLES = 10;
  const pts = curve.getPoints(SAMPLES);

  for (let i = 0; i < SAMPLES; i++) out.push(pts[i], pts[i + 1]);

  for (let j = 2; j < SAMPLES; j += 2) {
    const p = pts[j];
    const tangent = pts[j + 1].clone().sub(pts[j]).normalize();
    const barbLen = 0.3 * Math.sin((j / SAMPLES) * Math.PI) * (len / 4.4 + 0.4);
    const n1 = new THREE.Vector3(-tangent.y, tangent.x, 0);
    const n2 = new THREE.Vector3(tangent.y, -tangent.x, 0);
    for (const n of [n1, n2]) {
      const bdir = n.multiplyScalar(0.85).addScaledVector(tangent, -0.55).normalize();
      out.push(p.clone(), p.clone().addScaledVector(bdir, barbLen));
    }
  }
}

const WING_BASE_SCALE = 0.85;

/* Wings §4: four feather clusters per wing = the agent registry.
   Bottom-to-top: google primaries → comms → knowledge → voice coverts. */
function buildWing(side) {
  const wing = new THREE.Group();
  wing.position.set(side * (CUBE_HALF + 0.15), 0.25, 0);
  wing.scale.setScalar(WING_BASE_SCALE);

  const clusterDefs = [
    { id: "google", count: 8 },
    { id: "comms", count: 8 },
    { id: "knowledge", count: 7 },
    { id: "voice", count: 7 },
  ];
  const total = clusterDefs.reduce((n, c) => n + c.count, 0);

  let fi = 0;
  for (const def of clusterDefs) {
    const pts = [];
    for (let k = 0; k < def.count; k++) {
      const t = fi / (total - 1);
      fi++;
      buildFeather(pts, side, t);
    }
    wing.add(segmentsFromPoints(pts, makeWingMat(def.id, 0.34)));
  }
  return wing;
}

/* The dais: concentric rings and radial ticks grounding the core,
   as in the reference's circular platform. */
function buildDais() {
  const g = new THREE.Group();
  g.position.y = -2.75;
  g.rotation.x = -Math.PI / 2;

  const faint = makeLineMat(0.2);
  const soft = makeLineMat(0.32);

  for (const r of [2.1, 2.5, 3.0]) g.add(loopFromPoints(circlePoints(r, 128), faint));
  g.add(loopFromPoints(circlePoints(3.45, 160), soft));

  const ticks = [];
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const r0 = 3.55;
    const r1 = i % 6 === 0 ? 3.85 : 3.68;
    ticks.push(
      new THREE.Vector3(Math.cos(a) * r0, Math.sin(a) * r0, 0),
      new THREE.Vector3(Math.cos(a) * r1, Math.sin(a) * r1, 0)
    );
  }
  g.add(segmentsFromPoints(ticks, faint));

  const dashes = [];
  for (let i = 0; i < 48; i += 2) {
    const a0 = (i / 48) * Math.PI * 2;
    const a1 = ((i + 0.7) / 48) * Math.PI * 2;
    dashes.push(
      new THREE.Vector3(Math.cos(a0) * 1.7, Math.sin(a0) * 1.7, 0),
      new THREE.Vector3(Math.cos(a1) * 1.7, Math.sin(a1) * 1.7, 0)
    );
  }
  g.add(segmentsFromPoints(dashes, faint));

  return g;
}

function buildDust() {
  const N = 900;
  const seeds = new Float32Array(N);
  for (let i = 0; i < N; i++) seeds[i] = Math.random();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);

  S.dustUniforms = {
    uTime: { value: 0 },
    uSize: { value: 0.5 },
    uColor: { value: PAL.gold.line.clone() },
    uHi: { value: PAL.gold.hi.clone() },
  };
  return new THREE.Points(
    geo,
    new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: S.dustUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
}

function buildStars() {
  const N = 320;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 17;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 9;
    pos[i * 3 + 2] = -2 - Math.random() * 5;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({
    size: 0.028,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  S.stateLineMats.push({ m, k: 0.5 }); // stars breathe with the state color
  return new THREE.Points(geo, m);
}

function buildOrb() {
  const orbGroup = new THREE.Group();

  // event horizon — true black body, occludes everything behind it
  S.horizonUniforms = {
    uColor: { value: PAL.ice.line.clone() },
    uHi: { value: PAL.ice.hi.clone() },
    uRim: { value: 1.0 },
  };
  const horizon = new THREE.Mesh(
    new THREE.SphereGeometry(ORB_R, 48, 48),
    new THREE.ShaderMaterial({
      vertexShader: HORIZON_VERT,
      fragmentShader: HORIZON_FRAG,
      uniforms: S.horizonUniforms,
    })
  );
  horizon.renderOrder = 0;
  orbGroup.add(horizon);

  // tilted disk group: accretion disk + infall particles
  const diskGroup = new THREE.Group();
  diskGroup.rotation.x = 1.28; // near-edge-on, Interstellar-style
  diskGroup.rotation.z = -0.12;

  S.diskUniforms = {
    uTime: { value: 0 },
    uActivity: { value: 0.22 },
    uPulse: { value: 0 },
    uColor: { value: PAL.ice.line.clone() },
    uHi: { value: PAL.ice.hi.clone() },
    uInner: { value: DISK_INNER },
    uOuter: { value: DISK_OUTER },
  };
  const disk = new THREE.Mesh(
    new THREE.PlaneGeometry(DISK_OUTER * 2.05, DISK_OUTER * 2.05),
    new THREE.ShaderMaterial({
      vertexShader: DISK_VERT,
      fragmentShader: DISK_FRAG,
      uniforms: S.diskUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  disk.renderOrder = 1;
  diskGroup.add(disk);

  // particles
  const seeds = new Float32Array(PARTICLE_COUNT);
  const tilts = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    seeds[i] = Math.random();
    tilts[i] = (Math.random() - 0.5) * 2;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(PARTICLE_COUNT * 3), 3));
  pGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  pGeo.setAttribute("aTilt", new THREE.BufferAttribute(tilts, 1));
  pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), DISK_OUTER * 2);

  S.particleUniforms = {
    uTime: { value: 0 },
    uActivity: { value: 0.22 },
    uRmin: { value: DISK_INNER * 0.9 },
    uRmax: { value: DISK_OUTER * 1.35 },
    uSize: { value: 0.38 },
    uColor: { value: PAL.ice.line.clone() },
    uHi: { value: PAL.ice.hi.clone() },
  };
  S.particles = new THREE.Points(
    pGeo,
    new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: S.particleUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  S.particles.renderOrder = 1;
  diskGroup.add(S.particles);
  orbGroup.add(diskGroup);
  S.diskGroup = diskGroup;

  // photon ring — billboarded lensing halo
  S.ringUniforms = {
    uColor: { value: PAL.ice.line.clone() },
    uHi: { value: PAL.ice.hi.clone() },
    uRadius: { value: ORB_R * 1.18 },
    uWidth: { value: 0.022 },
    uIntensity: { value: 0.45 },
  };
  S.ringMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(ORB_R * 4, ORB_R * 4),
    new THREE.ShaderMaterial({
      vertexShader: DISK_VERT,
      fragmentShader: RING_FRAG,
      uniforms: S.ringUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
  );
  S.ringMesh.renderOrder = 3;
  orbGroup.add(S.ringMesh);

  return orbGroup;
}

function buildScene() {
  S.scene = new THREE.Scene();
  S.scene.background = new THREE.Color(VOID);

  S.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  S.camera.position.set(0, 0.3, 10.2);

  S.coreGroup = new THREE.Group();
  S.scene.add(S.coreGroup);

  // volumetric back-glow behind everything
  S.glowUniforms = {
    uColor: { value: PAL.gold.line.clone() },
    uIntensity: { value: 0.12 },
  };
  S.glowMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 9),
    new THREE.ShaderMaterial({
      vertexShader: DISK_VERT,
      fragmentShader: GLOW_FRAG,
      uniforms: S.glowUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
  );
  S.glowMesh.position.z = -1.7;
  S.glowMesh.renderOrder = -1;
  S.coreGroup.add(S.glowMesh);

  // containment cube, corner-on as in the reference, with an inner shell
  S.cubeGroup = new THREE.Group();
  const cubeGeo = new THREE.BoxGeometry(CUBE_HALF * 2, CUBE_HALF * 2, CUBE_HALF * 2);
  S.cubeGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(cubeGeo), makeLineMat(0.34)));
  const innerShell = new THREE.LineSegments(new THREE.EdgesGeometry(cubeGeo), makeLineMat(0.12));
  innerShell.scale.setScalar(0.9);
  S.cubeGroup.add(innerShell);
  S.cubeGroup.rotation.x = 0.14;
  S.cubeGroup.rotation.y = Math.PI / 4;
  S.coreGroup.add(S.cubeGroup);

  // dais, dust streams, starfield
  S.dais = buildDais();
  S.scene.add(S.dais);
  S.dust = buildDust();
  S.scene.add(S.dust);
  S.scene.add(buildStars());

  // yantra — faces the viewer, layers counter-rotate in-plane
  S.yantra = buildYantra();
  S.coreGroup.add(S.yantra.group);

  // orb — the bindu at the exact center
  S.orbGroup = buildOrb();
  S.coreGroup.add(S.orbGroup);

  // wings — grown from the same material, mapped to the agent registry
  S.wingL = buildWing(-1);
  S.wingR = buildWing(1);
  S.coreGroup.add(S.wingL, S.wingR);
}

/* ============================================================
   RENDER LOOP
   ============================================================ */

function frame(now) {
  if (!S.running) return;
  S.rafId = requestAnimationFrame(frame);

  const dt = Math.min(0.05, (now - S.lastTime) / 1000 || 0.016);
  S.lastTime = now;

  step(dt);
  render();
  monitorPerf(dt);
}

function step(dt) {
  const t = STATES[S.stateName];
  const pal = PAL[t.pal];
  const f = 1 - Math.exp(-dt * 3.5); // smoothing toward targets

  const c = S.cur;
  c.line.lerp(pal.line, f);
  c.hi.lerp(pal.hi, f);
  c.activity += (t.activity - c.activity) * f;
  c.bloom += (t.bloom - c.bloom) * f;
  c.flare += (t.flare - c.flare) * f;
  c.motion += (t.motion - c.motion) * f;
  c.rim += (t.rim - c.rim) * f;

  // SPEAKING pulse: real TTS amplitude when available, else a gentle synthetic breath
  let pulseTarget = 0;
  if (S.stateName === "SPEAKING") {
    const level = S.getAudioLevel ? S.getAudioLevel() : null;
    pulseTarget = level != null ? level : 0.25 + 0.2 * Math.sin(S.shaderTime * 6.0);
  }
  S.pulse += (pulseTarget - S.pulse) * Math.min(1, dt * 12);

  // ALERT stillness: shader time and rotations all ride motion scale
  S.shaderTime += dt * (0.1 + 0.9 * c.motion);
  const rot = dt * c.motion;

  // the cube never spins — it sways, corner-on, like a moored monolith
  S.cubeGroup.rotation.y = Math.PI / 4 + Math.sin(S.shaderTime * 0.11) * 0.05;
  S.yantra.frame.rotation.z += rot * 0.008;
  S.yantra.down.rotation.z -= rot * (0.02 + 0.07 * c.activity);
  S.yantra.up.rotation.z += rot * (0.02 + 0.07 * c.activity);
  S.dais.rotation.z += rot * 0.01;

  // wing pose: flare on listening/speaking, droop on alert
  const flareAngle = c.flare * 0.13;
  S.wingR.rotation.z = -flareAngle;
  S.wingL.rotation.z = flareAngle;
  const wScale = WING_BASE_SCALE * (1 + c.flare * 0.035);
  S.wingL.scale.setScalar(wScale);
  S.wingR.scale.setScalar(wScale);

  // breathing + audio pulse on the orb — slow, tidal
  const breath = 1 + 0.009 * Math.sin(S.shaderTime * 0.55) * c.motion;
  S.coreGroup.scale.setScalar(S.baseScale * breath);
  S.orbGroup.scale.setScalar(1 + S.pulse * 0.08);

  // billboard the photon ring
  S.ringMesh.quaternion.copy(S.camera.quaternion);

  applyColors();

  if (S.bloomPass) S.bloomPass.strength = c.bloom * (1 + S.pulse * 0.45);
}

function applyColors() {
  const c = S.cur;

  for (const { m, k } of S.stateLineMats) {
    m.color.copy(c.line).multiplyScalar(k);
  }

  // wing clusters: healthy follows the live state color; degraded goes
  // chrome; failed goes crimson — the diagnostic job of the wings (§4)
  for (const [id, mats] of Object.entries(S.wingMats)) {
    const health = S.clusterHealth[id] || "healthy";
    for (const { m, k } of mats) {
      if (health === "failed") m.color.copy(PAL.crimson.line).multiplyScalar(k);
      else if (health === "degraded") m.color.copy(PAL.chrome.line).multiplyScalar(k * 0.65);
      else m.color.copy(c.line).multiplyScalar(k);
    }
  }

  S.diskUniforms.uTime.value = S.shaderTime;
  S.diskUniforms.uActivity.value = c.activity;
  S.diskUniforms.uPulse.value = S.pulse;
  S.diskUniforms.uColor.value.copy(c.line);
  S.diskUniforms.uHi.value.copy(c.hi);

  S.horizonUniforms.uColor.value.copy(c.line);
  S.horizonUniforms.uHi.value.copy(c.hi);
  S.horizonUniforms.uRim.value = c.rim * (1 + S.pulse * 0.5);

  S.ringUniforms.uColor.value.copy(c.line);
  S.ringUniforms.uHi.value.copy(c.hi);
  S.ringUniforms.uIntensity.value = 0.35 + 0.3 * c.activity + S.pulse * 0.5;

  S.particleUniforms.uTime.value = S.shaderTime;
  S.particleUniforms.uActivity.value = c.activity;
  S.particleUniforms.uColor.value.copy(c.line);
  S.particleUniforms.uHi.value.copy(c.hi);

  S.dustUniforms.uTime.value = S.shaderTime;
  S.dustUniforms.uColor.value.copy(c.line);
  S.dustUniforms.uHi.value.copy(c.hi);

  S.glowUniforms.uColor.value.copy(c.line);
  S.glowUniforms.uIntensity.value = 0.1 + 0.08 * c.activity + S.pulse * 0.12;
}

function render() {
  if (S.composer && S.perfLevel < 2) S.composer.render();
  else S.renderer.render(S.scene, S.camera);
}

/* Degrade visuals before ever costing the rest of the app anything
   (Guidelines §7): drop pixel ratio first, then particles + bloom. */
function monitorPerf(dt) {
  S.frameAcc += dt;
  S.frameCount++;
  if (S.frameCount < 120) return;
  const avg = S.frameAcc / S.frameCount;
  S.frameAcc = 0;
  S.frameCount = 0;

  if (avg > 0.034 && S.perfLevel === 0) {
    S.perfLevel = 1;
    S.renderer.setPixelRatio(1);
    onResize();
  } else if (avg > 0.034 && S.perfLevel === 1) {
    S.perfLevel = 2;
    S.particles.visible = false;
  }
}

function onResize() {
  if (!S.container || !S.renderer) return;
  const w = S.container.clientWidth || 1;
  const h = S.container.clientHeight || 1;
  S.camera.aspect = w / h;
  S.camera.updateProjectionMatrix();
  S.renderer.setSize(w, h);
  if (S.composer) S.composer.setSize(w, h);
  // keep the wingspan inside narrow viewports
  S.baseScale = THREE.MathUtils.clamp((w / h) / 1.45, 0.55, 1);
  if (S.reducedMotion) renderStill();
}

/* Reduced motion: snap to the state's look and render one still frame —
   the glow stays because color is still carrying state information. */
function renderStill() {
  const t = STATES[S.stateName];
  const pal = PAL[t.pal];
  const c = S.cur;
  c.line.copy(pal.line);
  c.hi.copy(pal.hi);
  c.activity = t.activity;
  c.bloom = t.bloom;
  c.flare = t.flare;
  c.motion = 0;
  c.rim = t.rim;
  S.pulse = 0;
  step(0);
  render();
}

/* ============================================================
   PUBLIC API
   ============================================================ */

const Battleground = {
  get state() {
    return S.stateName;
  },

  async init({ container, getAudioLevel }) {
    if (S.inited) return;
    S.inited = true;
    S.container = container;
    S.getAudioLevel = getAudioLevel || null;
    S.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // WebGL feature gate → static emblem fallback (Guidelines §8)
    let gl = null;
    try {
      const probe = document.createElement("canvas");
      gl = probe.getContext("webgl2") || probe.getContext("webgl");
    } catch { /* fall through */ }
    if (!gl) {
      S.webgl = false;
      container.classList.add("bg-fallback");
      S.fallbackEl = document.createElement("div");
      S.fallbackEl.className = "orb-fallback";
      container.appendChild(S.fallbackEl);
      return;
    }

    S.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    // Filmic rolloff keeps stacked additive lines gold instead of
    // clipping them to white — the material IS the color.
    S.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    S.renderer.toneMappingExposure = 1.1;
    S.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    S.renderer.setClearColor(VOID);
    container.appendChild(S.renderer.domElement);

    buildScene();

    const size = new THREE.Vector2(container.clientWidth, container.clientHeight);
    S.composer = new EffectComposer(S.renderer);
    S.composer.addPass(new RenderPass(S.scene, S.camera));
    S.bloomPass = new UnrealBloomPass(size, 0.65, 0.55, 0.2);
    S.composer.addPass(S.bloomPass);
    S.composer.addPass(new OutputPass());

    S.resizeObserver = new ResizeObserver(onResize);
    S.resizeObserver.observe(container);
    onResize();

    if (S.reducedMotion) renderStill();
  },

  /* Non-blocking by design: just flag writes. The loop picks them up. */
  setState(name) {
    if (!STATES[name]) return;
    S.stateName = name;
    if (!S.webgl) return;
    if (S.reducedMotion && S.inited && S.renderer) renderStill();
  },

  setClusterHealth(map) {
    Object.assign(S.clusterHealth, map);
    if (S.reducedMotion && S.renderer) renderStill();
  },

  resume() {
    if (!S.webgl || S.running || S.reducedMotion) {
      if (S.reducedMotion && S.renderer) renderStill();
      return;
    }
    S.running = true;
    S.lastTime = performance.now();
    S.rafId = requestAnimationFrame(frame);
  },

  pause() {
    S.running = false;
    cancelAnimationFrame(S.rafId);
  },

  dispose() {
    this.pause();
    if (S.resizeObserver) S.resizeObserver.disconnect();
    if (S.renderer) {
      S.renderer.dispose();
      S.renderer.domElement.remove();
    }
    S.inited = false;
  },
};

export default Battleground;
