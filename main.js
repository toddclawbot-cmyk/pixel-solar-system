/* ===================================================================
   PIXEL SOLAR SYSTEM v2
   - J2000 Keplerian elements (real-time ephemeris)
   - Procedural pixel-art textures per body
   - Low-res render target → nearest-neighbor upscale = blocky look
   - CSS2D labels floating over each body
   - Mobile-first touch controls (tap-to-select, pinch zoom, drag orbit)
   =================================================================== */

import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// -------------------------------------------------------------------
// 1. EPHEMERIS  (J2000 elements from NASA — Standish 1992, Williams 1994)
//    Accuracy: ~arc-minutes for inner planets, ~few arc-minutes for
//    outer planets, more than enough at the scales we render.
//    Valid 1800–2050. After that the elements drift but stay close.
// -------------------------------------------------------------------

const DEG = Math.PI / 180;
const J2000 = 2451545.0;
const MS_PER_DAY = 86400000;

const ELEMENTS = {
  mercury: { a:[0.38709927, 0.00000037], e:[0.20563593, 0.00001906], i:[7.00497902,-0.00594749], L:[252.25032350,149472.67411175], wbar:[77.45779628,0.16047689], Omega:[48.33076593,-0.12534081] },
  venus:   { a:[0.72333566, 0.00000390], e:[0.00677672,-0.00004107], i:[3.39467605,-0.00078890], L:[181.97909950, 58517.81538729], wbar:[131.60246718,0.00268329], Omega:[76.67984255,-0.27769418] },
  earth:   { a:[1.00000261, 0.00000562], e:[0.01671123,-0.00004392], i:[-0.00001531,-0.01294668], L:[100.46457166, 35999.37244981], wbar:[102.93768193,0.32327364], Omega:[0.0, 0.0] },
  mars:    { a:[1.52371034, 0.00001847], e:[0.09339410, 0.00007882], i:[1.84969142,-0.00813131], L:[-4.55343205, 19140.30268499], wbar:[-23.94362959,0.44441088], Omega:[49.55953891,-0.29257343] },
  jupiter: { a:[5.20288700,-0.00011607], e:[0.04838624,-0.00013253], i:[1.30439695,-0.00183714], L:[34.39644051, 3034.74612775], wbar:[14.72847983,0.21252668], Omega:[100.47390909, 0.20469106] },
  saturn:  { a:[9.53667594,-0.00125060], e:[0.05386179,-0.00050991], i:[2.48599187, 0.00193609], L:[49.95424423, 1222.49362201], wbar:[92.59887831,-0.41897216], Omega:[113.66242448,-0.28867794] },
  uranus:  { a:[19.18916464,-0.00196176], e:[0.04725744,-0.00004397], i:[0.77263783,-0.00242939], L:[313.23810451, 428.48202785], wbar:[170.95427630, 0.40805281], Omega:[74.01692503, 0.04240589] },
  neptune: { a:[30.06992276, 0.00026291], e:[0.00859048, 0.00005105], i:[1.77004347, 0.00035372], L:[-55.12002969, 218.45945325], wbar:[44.96476227,-0.32241464], Omega:[131.78422574,-0.00508664] },
};

function julianDay(date) { return date.getTime() / MS_PER_DAY + 2440587.5; }
function dateFromJD(jd) { return new Date((jd - 2440587.5) * MS_PER_DAY); }
function centuriesSinceJ2000(jd) { return (jd - J2000) / 36525.0; }

function solveKepler(M, e) {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 30; i++) {
    const dM = M - (E - e * Math.sin(E));
    const dE = dM / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

function heliocentric(name, jd) {
  const el = ELEMENTS[name];
  const T = centuriesSinceJ2000(jd);
  const a = el.a[0] + el.a[1] * T;
  const e = el.e[0] + el.e[1] * T;
  const i = (el.i[0] + el.i[1] * T) * DEG;
  const L = (el.L[0] + el.L[1] * T) * DEG;
  const wbar = (el.wbar[0] + el.wbar[1] * T) * DEG;
  const Omega = (el.Omega[0] + el.Omega[1] * T) * DEG;
  const w = wbar - Omega;
  const M = ((L - wbar) % (2*Math.PI) + 2*Math.PI) % (2*Math.PI);
  const E = solveKepler(M, e);
  const xPrime = a * (Math.cos(E) - e);
  const yPrime = a * Math.sqrt(1 - e*e) * Math.sin(E);
  const cosw = Math.cos(w), sinw = Math.sin(w);
  const cosO = Math.cos(Omega), sinO = Math.sin(Omega);
  const cosi = Math.cos(i), sini = Math.sin(i);
  const x = (cosw*cosO - sinw*sinO*cosi) * xPrime + (-sinw*cosO - cosw*sinO*cosi) * yPrime;
  const y = (cosw*sinO + sinw*cosO*cosi) * xPrime + (-sinw*sinO + cosw*cosO*cosi) * yPrime;
  const z = (sinw*sini) * xPrime + (cosw*sini) * yPrime;
  return new THREE.Vector3(x, z, -y);
}

// ORBIT-VISIBLE SCALING
// Real AU spans (0.39 to 30) are visually awful — Mercury vanishes,
// Neptune is forever. Compress the outer system with a power scale so
// every orbit is readable. The math is consistent (J2000 elements) and
// the *angles* are still correct — just the radial distance is remapped.
const ORBIT_SCALE = 14;          // AU units → scene units at inner
const ORBIT_POWER = 0.55;        // compression exponent (<1 pulls outer in)
function scaledOrbitRadius(rAU) {
  return ORBIT_SCALE * Math.pow(rAU, ORBIT_POWER);
}

// -------------------------------------------------------------------
// 2. MOON ORBITS  (Keplerian mean-orbit model, scaled for visibility)
// -------------------------------------------------------------------

const MOONS = {
  earth: [
    { name:'Luna', dist:60, period:27.32, size:1.2, color:0xd0c8b8, accent:0x5a5040, label:'MOON' }
  ],
  mars: [
    { name:'Phobos', dist:22, period:0.319, size:0.32, color:0x9a7a5a, accent:0x3a2a1a, label:'PHOBOS' },
    { name:'Deimos', dist:36, period:1.262, size:0.24, color:0xa0886a, accent:0x3a2a1a, label:'DEIMOS' },
  ],
  jupiter: [
    { name:'Io',       dist:50, period:1.769,  size:0.7, color:0xead884, accent:0xa83a1c, label:'IO' },
    { name:'Europa',   dist:70, period:3.551,  size:0.65, color:0xd9c79a, accent:0x6a4020, label:'EUROPA' },
    { name:'Ganymede', dist:95, period:7.155,  size:0.95, color:0xa89684, accent:0x4a3020, label:'GANYMEDE' },
    { name:'Callisto', dist:130,period:16.689, size:0.85, color:0x6a5a48, accent:0x2a2418, label:'CALLISTO' },
  ],
  saturn: [
    { name:'Titan',   dist:110, period:15.945, size:0.9,  color:0xd2a76b, accent:0x6a4020, label:'TITAN' },
    { name:'Rhea',    dist:75,  period:4.518,  size:0.55, color:0xbfb1a0, accent:0x5a4838, label:'RHEA' },
    { name:'Iapetus', dist:170, period:79.330, size:0.55, color:0x9a8a76, accent:0x3a2a20, label:'IAPETUS' },
  ],
  uranus: [
    { name:'Titania', dist:55, period:8.706, size:0.55, color:0x9a9a90, accent:0x3a3a34, label:'TITANIA' },
    { name:'Oberon',  dist:80, period:13.46, size:0.5,  color:0x7a7a72, accent:0x2a2a26, label:'OBERON' },
  ],
  neptune: [
    { name:'Triton',  dist:65, period:5.877, size:0.6, color:0xc8d4e0, accent:0x4c5c70, label:'TRITON' },
  ],
};

// -------------------------------------------------------------------
// 3. PLANET SPECS
// -------------------------------------------------------------------

const PLANETS = {
  mercury: { display:2.0, real:0.38, color:0x8c7a6b, accent:0x3a2f25, palette:'rocky', spin:0.004, name:'MERCURY', desc:'Smallest planet, scarred by impact craters. Closest to the Sun — temperatures swing from -180°C to 430°C.' },
  venus:   { display:3.0, real:0.95, color:0xe8c988, accent:0xa96a2a, palette:'venus',  spin:-0.001, name:'VENUS',   desc:'Hothouse world. Sulfuric acid clouds, surface pressure 92× Earth. Brightest planet in our night sky.' },
  earth:   { display:3.2, real:1.00, color:0x4a8fc8, accent:0x1f5c8a, palette:'earth',  spin:0.02,  name:'EARTH',   desc:'Our pale blue dot. The only known planet with liquid surface water and life. One moon: Luna.' },
  mars:    { display:2.4, real:0.53, color:0xc15a2a, accent:0x6e2b13, palette:'mars',   spin:0.019, name:'MARS',    desc:'The red planet. Home to Olympus Mons — the tallest volcano in the solar system. Two small moons.' },
  jupiter: { display:7.5, real:11.2, color:0xd2a374, accent:0x7a4f24, palette:'jupiter',spin:0.06,  name:'JUPITER', desc:'Largest planet — a gas giant with bands of ammonia clouds and the Great Red Spot storm raging for centuries.' },
  saturn:  { display:6.4, real:9.45, color:0xe0c890, accent:0x8b6f3a, palette:'saturn', spin:0.05,  name:'SATURN',  desc:'Famous for its spectacular ring system — icy chunks from 10 m to 1 km. Low density — would float in water.' },
  uranus:  { display:5.0, real:4.01, color:0x9ad5d4, accent:0x4a7a7a, palette:'uranus', spin:-0.04, name:'URANUS',  desc:'Ice giant tilted on its side (98°). Rolls around the Sun rather than spinning upright.' },
  neptune: { display:4.8, real:3.88, color:0x4a6ac8, accent:0x1f3a7a, palette:'neptune',spin:0.05,  name:'NEPTUNE', desc:'Windiest planet — winds reach 2,100 km/h. Discovered by mathematical prediction before observation.' },
};

const SUN = { display:8.0, real:109.3, name:'SUN', desc:'Our star — a G2V yellow dwarf containing 99.86% of the solar system\'s mass. About 4.6 billion years old.' };

// -------------------------------------------------------------------
// 4. PROCEDURAL PIXEL-ART TEXTURES
// -------------------------------------------------------------------

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = s; t = Math.imul(t ^ (t>>>15), t | 1); t ^= t + Math.imul(t ^ (t>>>7), t | 61); return ((t ^ (t>>>14)) >>> 0) / 4294967296; };
}
function makeNoise2(seed) {
  const rnd = makeRng(seed);
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd()*(i+1)); const t=perm[i]; perm[i]=perm[j]; perm[j]=t; }
  for (let i = 0; i < 256; i++) perm[256+i] = perm[i];
  return (x, y) => {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = xf*xf*(3-2*xf), v = yf*yf*(3-2*yf);
    const aa = perm[perm[xi]+yi], ab = perm[perm[xi]+yi+1], ba = perm[perm[xi+1]+yi], bb = perm[perm[xi+1]+yi+1];
    return aa + (ba-aa)*u + (ab-aa)*v + (aa-ba-ab+bb)*u*v;
  };
}
function fbm(noise2, x, y, oct=5) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * noise2(x*f, y*f); f *= 2; a *= 0.5; }
  return s;
}

function makePixelTexture(spec, size=64) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size / 2;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height);
  const data = img.data;
  const hex = (h) => [(h>>16)&255, (h>>8)&255, h&255];
  const noise2 = makeNoise2(spec.seed || 0xC0FFEE);
  const base = hex(spec.color);
  const accent = hex(spec.accent);
  const quant = spec.quant || 32;

  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      const u = x / c.width, v = y / c.height;
      const lon = u * Math.PI * 2;
      const lat = (v - 0.5) * Math.PI;
      const nz = Math.cos(lat), ny = Math.sin(lat), nx = Math.cos(lon) * Math.cos(lat);
      const lx = 0.6, ly = 0.4, lz = 0.7;
      const NdotL = Math.max(0, nx*lx + ny*ly + nz*lz);
      const n = fbm(noise2, u*6 + 13.7, v*6 + 91.2, 5);
      const n2 = fbm(noise2, u*14 + 41.1, v*14 + 7.3, 4);
      let r, g, b;
      const t = (n*0.6 + n2*0.4);
      const m = Math.min(1, Math.max(0, (t - 0.3) * 1.5));
      r = base[0]*(1-m) + accent[0]*m;
      g = base[1]*(1-m) + accent[1]*m;
      b = base[2]*(1-m) + accent[2]*m;

      if (spec.palette === 'earth') {
        const land = fbm(noise2, u*8, v*8, 5);
        if (land > 0.56) { r = 80 + n*60; g = 130 + n*60; b = 50 + n*30; }
        else if (land > 0.48) { r = 200+n*40; g = 170+n*40; b = 110+n*30; }
        else { r = 25 + n*40; g = 70 + n*60; b = 170 + n*50; }
        if (Math.abs(lat) > 1.15) { r=g=b=220+n*30; }
      } else if (spec.palette === 'mars') {
        if (n2 > 0.6) { r *= 0.55; g *= 0.5; b *= 0.5; }
        if (Math.abs(lat) > 1.25) { r=210; g=190; b=180; }
      } else if (spec.palette === 'jupiter') {
        const band = Math.sin(lat * 7 + n*1.5) * 0.5 + 0.5;
        r = base[0]*(0.55+0.45*band); g = base[1]*(0.55+0.45*band); b = base[2]*(0.4+0.3*band);
        if (Math.abs(lat+0.3)<0.15 && Math.abs(lon)<0.4) { r=200; g=70; b=35; }
      } else if (spec.palette === 'saturn') {
        const band = Math.sin(lat * 9 + n*0.8) * 0.5 + 0.5;
        r = base[0]*(0.65+0.35*band); g = base[1]*(0.65+0.35*band); b = base[2]*(0.5+0.3*band);
      } else if (spec.palette === 'venus') {
        const swirl = fbm(noise2, u*4 + n*2, v*4, 4);
        r = 230 + swirl*25; g = 190 + swirl*30; b = 110 + swirl*25;
      } else if (spec.palette === 'uranus') {
        r = 160 + n*20; g = 220 + n*20; b = 220 + n*20;
      } else if (spec.palette === 'neptune') {
        r = 70 + n*30; g = 100 + n*40; b = 220 + n*30;
        if (n2 > 0.72) { r *= 0.5; g *= 0.5; b *= 0.6; }
      } else if (spec.palette === 'rocky') {
        if (n2 > 0.7) { r *= 0.55; g *= 0.55; b *= 0.55; }
        if (n2 > 0.78 && n2 < 0.82) { r = 40; g = 40; b = 40; }
      }

      const light = 0.42 + 0.58 * NdotL;
      r = Math.min(255, r * light);
      g = Math.min(255, g * light);
      b = Math.min(255, b * light);
      r = Math.round(r/quant)*quant; g = Math.round(g/quant)*quant; b = Math.round(b/quant)*quant;
      data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function makeSunTexture(size=96) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size/2;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height);
  const data = img.data;
  const noise2 = makeNoise2(0xFEEDBEEF);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y*c.width + x)*4;
      const u = x/c.width, v = y/c.height;
      const lon = u*Math.PI*2, lat = (v-0.5)*Math.PI;
      const nz = Math.cos(lat), ny = Math.sin(lat), nx = Math.cos(lon)*Math.cos(lat);
      const n = fbm(noise2, u*10, v*10);
      const n2 = fbm(noise2, u*30+5, v*30+5);
      const flare = (n*0.7 + n2*0.3);
      const hot = Math.max(0, Math.sin(lon*3 + n*4) * Math.cos(lat*2 + n*3));
      // HOT yellow-white sun
      let r = 255, g = 220 + flare*35, b = 90 + hot*100;
      if (n2 > 0.78) { r = 200; g = 120; b = 50; } // sunspots
      // bright limb
      const lz = 0.5*nx + 0.3*ny + 0.8*nz;
      const lit = 0.7 + 0.3*Math.max(0, lz);
      r *= lit; g *= lit; b *= lit;
      r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
      r = Math.round(r/24)*24; g = Math.round(g/24)*24; b = Math.round(b/24)*24;
      data[i]=r; data[i+1]=g; data[i+2]=b; data[i+3]=255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function makeRingTexture(size=128) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size/2;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height);
  const data = img.data;
  for (let x = 0; x < c.width; x++) {
    const r = x / c.width;
    let alpha = 0;
    if (r > 0.18 && r < 0.22) alpha = 0.25;
    else if (r > 0.30 && r < 0.42) alpha = 0.7;
    else if (r > 0.42 && r < 0.52) alpha = 0.08;
    else if (r > 0.55 && r < 0.74) alpha = 0.9;
    else if (r > 0.78 && r < 0.86) alpha = 0.4;
    if (alpha === 0) { for (let y=0;y<c.height;y++){const i=(y*c.width+x)*4;data[i]=data[i+1]=data[i+2]=0;data[i+3]=0;} continue; }
    const band = Math.sin(r * 80) * 0.3 + 0.7;
    const cr = 230 * band * alpha, cg = 210 * band * alpha, cb = 170 * band * alpha;
    for (let y = 0; y < c.height; y++) {
      const i = (y*c.width + x)*4;
      data[i] = cr; data[i+1] = cg; data[i+2] = cb; data[i+3] = 255*alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// -------------------------------------------------------------------
// 5. RENDERER + SCENE
// -------------------------------------------------------------------

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias:false, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
// background is a dark gradient — set on the BODY so the canvas can be transparent
// (otherwise pixel-art edges look hard). Or just keep a solid bg.
scene.background = new THREE.Color(0x02020a);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth/window.innerHeight, 0.05, 20000);
camera.position.set(0, 60, 120);

// CSS2D label renderer (DOM-based, crisp text, floats over 3D)
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.id = 'labels';
document.body.appendChild(labelRenderer.domElement);

// Pixel-art via low-res render target
const PIXEL_PRESETS = { low: 0.18, mid: 0.35, high: 0.55 };
let pixelScale = PIXEL_PRESETS.high;
const rt = new THREE.WebGLRenderTarget(1, 1, {
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  wrapS: THREE.ClampToEdgeWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
  depthBuffer: true,
  stencilBuffer: false,
});
const fsScene = new THREE.Scene();
const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fsMat = new THREE.ShaderMaterial({
  uniforms: { tDiff: { value: rt.texture }, uRes: { value: new THREE.Vector2(1,1) } },
  vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position,1.0);}',
  fragmentShader: `
    uniform sampler2D tDiff;
    uniform vec2 uRes;
    varying vec2 vUv;
    void main(){
      vec2 px = floor(vUv * uRes) / uRes + 0.5/uRes;
      vec3 c = texture2D(tDiff, px).rgb;
      // soft scanline
      float s = 0.95 + 0.05 * sin(gl_FragCoord.y * 3.14159);
      gl_FragColor = vec4(c * s, 1.0);
    }
  `,
});
const fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2,2), fsMat);
fsScene.add(fsQuad);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  const rtW = Math.max(80, Math.floor(w * pixelScale));
  const rtH = Math.max(60, Math.floor(h * pixelScale));
  rt.setSize(rtW, rtH);
  fsMat.uniforms.uRes.value.set(rtW, rtH);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// -------------------------------------------------------------------
// 6. BUILD SOLAR SYSTEM
// -------------------------------------------------------------------

// Starfield (twinkles)
function makeStars() {
  const g = new THREE.BufferGeometry();
  const n = 2400;
  const pos = new Float32Array(n*3);
  const col = new Float32Array(n*3);
  const sz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = 5000 + Math.random()*2000;
    const t = Math.random()*Math.PI*2;
    const p = Math.acos(2*Math.random()-1);
    pos[i*3] = r*Math.sin(p)*Math.cos(t);
    pos[i*3+1] = r*Math.cos(p);
    pos[i*3+2] = r*Math.sin(p)*Math.sin(t);
    const hue = 0.55 + Math.random()*0.15;
    col[i*3] = 0.85 + Math.random()*0.15;
    col[i*3+1] = 0.85 + Math.random()*0.15;
    col[i*3+2] = 0.95 + Math.random()*0.1;
    sz[i] = 1.5 + Math.random()*3.5;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('size', new THREE.BufferAttribute(sz, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      uniform float uTime;
      void main(){
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // twinkle: per-star sin offset based on position
        float seed = position.x*0.01 + position.y*0.013 + position.z*0.017;
        float tw = 0.7 + 0.3 * sin(uTime*1.5 + seed);
        gl_PointSize = size * tw * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        float a = 1.0 - smoothstep(0.0, 0.5, d);
        gl_FragColor = vec4(vColor, a);
      }
    `,
  });
  return new THREE.Points(g, m);
}
const stars = makeStars();
scene.add(stars);

// Sun
const sunTex = new THREE.CanvasTexture(makeSunTexture());
sunTex.magFilter = THREE.NearestFilter;
sunTex.minFilter = THREE.NearestFilter;
sunTex.colorSpace = THREE.SRGBColorSpace;
const sunMesh = new THREE.Mesh(
  new THREE.IcosahedronGeometry(SUN.display, 4),
  new THREE.MeshBasicMaterial({ map: sunTex })
);
scene.add(sunMesh);

// Sun label
const sunLabelDiv = document.createElement('div');
sunLabelDiv.className = 'body-label sun';
sunLabelDiv.textContent = '☉ SUN';
const sunLabel = new CSS2DObject(sunLabelDiv);
sunLabel.position.set(0, SUN.display * 1.4, 0);
sunMesh.add(sunLabel);

// Sun glow (additive, billboard)
const glowMat = new THREE.ShaderMaterial({
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  uniforms: { uTime: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
  fragmentShader: `
    varying vec2 vUv;
    uniform float uTime;
    void main(){
      vec2 c = vUv - 0.5;
      float d = length(c);
      float pulse = 0.92 + 0.08 * sin(uTime*1.5);
      float a = smoothstep(0.5, 0.0, d);
      a = pow(a, 1.6) * 1.0 * pulse;
      // outer corona soft yellow, inner hot white
      vec3 col = mix(vec3(1.0,0.45,0.1), vec3(1.0,0.95,0.6), pow(1.0 - d*2.0, 1.5));
      gl_FragColor = vec4(col, a);
    }
  `,
});
const sunGlow = new THREE.Mesh(new THREE.PlaneGeometry(SUN.display*5, SUN.display*5), glowMat);
sunGlow.renderOrder = -1;
scene.add(sunGlow);

// Build planets
const planetMeshes = {};
const orbitLines = {};
const planetLabels = {};

for (const [name, p] of Object.entries(PLANETS)) {
  const tex = new THREE.CanvasTexture(makePixelTexture({ ...p, seed: name.charCodeAt(0)*1337 + name.length }, 96));
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const geom = new THREE.IcosahedronGeometry(p.display, 4);
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  const mesh = new THREE.Mesh(geom, mat);
  planetMeshes[name] = mesh;
  scene.add(mesh);

  // Label
  const div = document.createElement('div');
  div.className = 'body-label planet';
  div.textContent = p.name;
  const lbl = new CSS2DObject(div);
  lbl.position.set(0, p.display * 1.6 + 1.2, 0);
  mesh.add(lbl);
  planetLabels[name] = div;

  // Orbit line
  const a = ELEMENTS[name].a[0];
  const e = ELEMENTS[name].e[0];
  const i = ELEMENTS[name].i[0] * DEG;
  const Omega = ELEMENTS[name].Omega[0] * DEG;
  const N = 256;
  const pts = new Float32Array(N*3);
  for (let k = 0; k < N; k++) {
    const E = (k/N) * Math.PI * 2;
    const xPrime = a * (Math.cos(E) - e);
    const yPrime = a * Math.sqrt(1-e*e) * Math.sin(E);
    const wbar = ELEMENTS[name].wbar[0] * DEG;
    const w = wbar - Omega;
    const cosw = Math.cos(w), sinw = Math.sin(w);
    const cosO = Math.cos(Omega), sinO = Math.sin(Omega);
    const cosi = Math.cos(i), sini = Math.sin(i);
    const x = (cosw*cosO - sinw*sinO*cosi) * xPrime + (-sinw*cosO - cosw*sinO*cosi) * yPrime;
    const y = (cosw*sinO + sinw*cosO*cosi) * xPrime + (-sinw*sinO + cosw*cosO*cosi) * yPrime;
    const z = (sinw*sini) * xPrime + (cosw*sini) * yPrime;
    const r3 = scaledOrbitRadius(Math.sqrt(x*x + y*y + z*z));
    const norm = r3 / Math.sqrt(x*x + y*y + z*z);
    pts[k*3] = x * norm;
    pts[k*3+1] = y * norm;
    pts[k*3+2] = z * norm;
  }
  const orbitGeo = new THREE.BufferGeometry();
  orbitGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const orbitMat = new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent:true, opacity:0.22 });
  const orbit = new THREE.Line(orbitGeo, orbitMat);
  scene.add(orbit);
  orbitLines[name] = orbit;
}

// Saturn's rings
const ringTex = new THREE.CanvasTexture(makeRingTexture(256));
ringTex.magFilter = THREE.NearestFilter;
ringTex.minFilter = THREE.NearestFilter;
ringTex.colorSpace = THREE.SRGBColorSpace;
const ringInner = PLANETS.saturn.display * 1.45;
const ringOuter = PLANETS.saturn.display * 2.5;
const saturn = planetMeshes.saturn;
const ringMesh = new THREE.Mesh(
  new THREE.RingGeometry(ringInner, ringOuter, 96),
  new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, side: THREE.DoubleSide, depthWrite: false })
);
ringMesh.rotation.x = -Math.PI/2 + 0.35;
saturn.add(ringMesh);

// Lights
const sunLight = new THREE.PointLight(0xfff4d4, 5, 0, 0);
scene.add(sunLight);
scene.add(new THREE.AmbientLight(0x404060, 0.6));

// Moons
const moonMeshes = {};
const moonOrbits = {};
for (const [planet, moons] of Object.entries(MOONS)) {
  moonMeshes[planet] = [];
  moonOrbits[planet] = [];
  for (const m of moons) {
    const tex = new THREE.CanvasTexture(makePixelTexture({ color:m.color, accent:m.accent, seed:m.name.length*1009, palette:'rocky' }, 32));
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(m.size, 2),
      new THREE.MeshLambertMaterial({ map: tex })
    );
    scene.add(mesh);
    const div = document.createElement('div');
    div.className = 'body-label moon';
    div.textContent = m.label;
    const lbl = new CSS2DObject(div);
    lbl.position.set(0, m.size * 2.2, 0);
    mesh.add(lbl);
    moonMeshes[planet].push({ mesh, data: m, labelDiv: div });
    // orbit ring (around parent)
    const N = 64;
    const pts = new Float32Array(N*3);
    for (let k = 0; k < N; k++) {
      const a = (k/N) * Math.PI*2;
      pts[k*3] = Math.cos(a)*m.dist;
      pts[k*3+1] = 0;
      pts[k*3+2] = Math.sin(a)*m.dist;
    }
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', new THREE.BufferAttribute(pts,3));
    const om = new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent:true, opacity:0.18 });
    const line = new THREE.Line(og, om);
    planetMeshes[planet].add(line);
    moonOrbits[planet].push(line);
  }
}

// -------------------------------------------------------------------
// 7. CAMERA CONTROLS — custom orbit (no OrbitControls dependency)
// -------------------------------------------------------------------

const controls = {
  target: new THREE.Vector3(0, 0, 0),
  distance: 80,
  azimuth: Math.PI * 0.3,
  elevation: 0.35,
  minDist: 0.5,
  maxDist: 8000,
  minEl: -Math.PI/2 + 0.05,
  maxEl:  Math.PI/2 - 0.05,
  // inertia
  vAz: 0, vEl: 0,
  vDist: 0,
  // tap detection
  isDown: false,
  downX: 0, downY: 0,
  downT: 0,
  moved: 0,
  lastX: 0, lastY: 0,
  // animation
  anim: null,
};

function applyCamera() {
  const cx = controls.distance * Math.cos(controls.elevation) * Math.sin(controls.azimuth);
  const cy = controls.distance * Math.sin(controls.elevation);
  const cz = controls.distance * Math.cos(controls.elevation) * Math.cos(controls.azimuth);
  camera.position.set(controls.target.x + cx, controls.target.y + cy, controls.target.z + cz);
  camera.lookAt(controls.target);
}

// Pointer events
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  controls.isDown = true;
  controls.downX = controls.lastX = e.clientX;
  controls.downY = controls.lastY = e.clientY;
  controls.downT = performance.now();
  controls.moved = 0;
  controls.vAz = controls.vEl = 0;
  hideHint();
});
canvas.addEventListener('pointermove', e => {
  if (!controls.isDown) return;
  const dx = e.clientX - controls.lastX;
  const dy = e.clientY - controls.lastY;
  controls.lastX = e.clientX;
  controls.lastY = e.clientY;
  controls.moved += Math.abs(dx) + Math.abs(dy);
  const sens = 0.005;
  controls.azimuth -= dx * sens;
  controls.elevation = Math.max(controls.minEl, Math.min(controls.maxEl, controls.elevation + dy * sens));
  controls.vAz = -dx * sens;
  controls.vEl = dy * sens;
  applyCamera();
});
function endPointer(e) {
  if (!controls.isDown) return;
  controls.isDown = false;
  const dt = performance.now() - controls.downT;
  if (controls.moved < 6 && dt < 350) {
    // tap — pick a body
    handleTap(e.clientX, e.clientY);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', () => { controls.isDown = false; });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = Math.exp(e.deltaY * 0.001);
  controls.distance = Math.max(controls.minDist, Math.min(controls.maxDist, controls.distance * factor));
  applyCamera();
  hideHint();
}, { passive: false });

// Pinch
let pinchStart = 0, pinchStartDist = 0;
canvas.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    pinchStartDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    pinchStart = controls.distance;
  }
}, { passive: true });
canvas.addEventListener('touchmove', e => {
  if (e.touches.length === 2) {
    e.preventDefault();
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    if (pinchStartDist > 0) controls.distance = Math.max(controls.minDist, Math.min(controls.maxDist, pinchStart * (pinchStartDist / d)));
    applyCamera();
  }
}, { passive: false });

function handleTap(x, y) {
  const rect = canvas.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((x - rect.left) / rect.width) * 2 - 1,
    -((y - rect.top) / rect.height) * 2 + 1
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(mouse, camera);
  const targets = [sunMesh, ...Object.values(planetMeshes)];
  for (const moons of Object.values(moonMeshes)) for (const m of moons) targets.push(m.mesh);
  const hits = ray.intersectObjects(targets, false);
  if (hits.length) {
    const h = hits[0].object;
    if (h === sunMesh) { focusOn('sun', null); return; }
    for (const [name, mesh] of Object.entries(planetMeshes)) if (mesh === h) { focusOn(name, null); return; }
    for (const [planet, moons] of Object.entries(moonMeshes)) {
      for (const m of moons) if (m.mesh === h) { focusOn(planet, m.data); return; }
    }
  }
}

// -------------------------------------------------------------------
// 8. FOCUS + UI
// -------------------------------------------------------------------

const focusList = document.getElementById('focusList');
const focusItems = [
  { id:'overview', label:'⊕ OVERVIEW', type:'star' },
  { id:'sun',      label:'☉ SUN',      type:'star' },
  ...Object.entries(PLANETS).map(([k,v]) => ({ id:k, label:v.name, type:'planet' })),
];
for (const fi of focusItems) {
  const b = document.createElement('button');
  b.className = 'btn'; b.dataset.type = fi.type; b.dataset.id = fi.id;
  b.textContent = fi.label;
  b.onclick = () => focusOn(fi.id, null);
  focusList.appendChild(b);
}

let focusedPlanet = 'overview';
let focusedMoon = null;

function focusOn(name, moon) {
  focusedPlanet = name;
  focusedMoon = moon;
  let target, dist, elev;
  if (name === 'overview') {
    target = new THREE.Vector3(0, 0, 0);
    dist = 320;
    elev = 0.55; // tilt up to see the whole plane
  } else if (name === 'sun') {
    target = new THREE.Vector3(0, 0, 0);
    dist = SUN.display * 5;
    elev = 0.3;
  } else {
    target = planetMeshes[name].position.clone();
    const r = moon ? Math.max(moon.size * 6, 12) : PLANETS[name].display * 4;
    dist = r;
    elev = 0.3;
  }
  controls.anim = {
    fromTarget: controls.target.clone(),
    toTarget: target,
    fromDist: controls.distance,
    toDist: Math.max(8, dist),
    fromElev: controls.elevation,
    toElev: elev,
    t0: performance.now(),
    dur: 1100,
  };
  if (name !== 'overview') updateInfo(name, moon);
  else updateInfoOverview();
  document.querySelectorAll('.focus-list .btn').forEach(b => b.classList.toggle('active', b.dataset.id === name));
  if (window.innerWidth <= 768) closeSidebar();
}

function updateInfo(name, moon) {
  const nameEl = document.getElementById('infoName');
  const bodyEl = document.getElementById('infoBody');
  if (name === 'sun') {
    nameEl.textContent = '☉ SUN';
    bodyEl.innerHTML = `<div class="stat"><span>TYPE</span><b>Yellow dwarf (G2V)</b></div>
      <div class="stat"><span>DIAMETER</span><b>1,392,700 km</b></div>
      <div class="stat"><span>MASS</span><b>1.989×10³⁰ kg</b></div>
      <div class="stat"><span>AGE</span><b>~4.6 Gyr</b></div>
      <p>${SUN.desc}</p>`;
    return;
  }
  const p = PLANETS[name];
  if (!p) return;
  if (moon) {
    nameEl.textContent = moon.label;
    bodyEl.innerHTML = `<div class="stat"><span>ORBITS</span><b>${p.name}</b></div>
      <div class="stat"><span>PERIOD</span><b>${moon.period.toFixed(3)} d</b></div>
      <p>A moon of ${p.name}.</p>`;
  } else {
    const el = ELEMENTS[name];
    const periodDays = Math.sqrt(el.a[0]**3) * 365.25;
    nameEl.textContent = p.name;
    bodyEl.innerHTML = `<div class="stat"><span>SEMI-MAJOR</span><b>${el.a[0].toFixed(3)} AU</b></div>
      <div class="stat"><span>ECCENTRICITY</span><b>${el.e[0].toFixed(4)}</b></div>
      <div class="stat"><span>INCLINATION</span><b>${el.i[0].toFixed(2)}°</b></div>
      <div class="stat"><span>ORBITAL PERIOD</span><b>${periodDays < 365 ? periodDays.toFixed(1)+' d' : (periodDays/365.25).toFixed(2)+' yr'}</b></div>
      <p>${p.desc}</p>`;
  }
}

function updateInfoOverview() {
  const nameEl = document.getElementById('infoName');
  const bodyEl = document.getElementById('infoBody');
  nameEl.textContent = '⊕ SOLAR SYSTEM';
  bodyEl.innerHTML = `<p style="margin:0">Drag to look around. Pinch or scroll to zoom. Tap any body to focus on it. Use the TIME panel to scrub dates or speed up time.</p>
    <div class="stat" style="margin-top:8px"><span>BODIES</span><b>1 star · 8 planets · 16 moons</b></div>
    <div class="stat"><span>EPOCH</span><b id="ov-jd">--</b></div>`;
}

// TIME controls
let timeSpeed = 1;
let timeOffset = 0;

const clockDate = document.getElementById('clock-date');
const clockTime = document.getElementById('clock-time');
const clockSpeed = document.getElementById('clock-speed');
const rDate = document.getElementById('r-date');
const rTime = document.getElementById('r-time');
const rJD = document.getElementById('r-jd');
const scrub = document.getElementById('scrub');
const scrubVal = document.getElementById('scrubVal');

function fmtSpeed(s) {
  if (s === 0) return '⏸';
  if (s === 1) return '×1';
  if (s === 60) return '×60';
  if (s === 3600) return '×1h/s';
  if (s === 86400) return '×1d/s';
  if (s === 604800) return '×1w/s';
  return '×' + s;
}
function fmtOffset(d) {
  if (d === 0) return 'now';
  const sign = d > 0 ? '+' : '−';
  const ad = Math.abs(d);
  if (ad < 1) return sign + (ad*24).toFixed(1) + 'h';
  if (ad < 365) return sign + ad.toFixed(1) + 'd';
  return sign + (ad/365.25).toFixed(2) + 'y';
}

document.querySelectorAll('[data-speed]').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('[data-speed]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    timeSpeed = parseFloat(btn.dataset.speed);
    clockSpeed.textContent = fmtSpeed(timeSpeed);
  };
});
scrub.addEventListener('input', () => {
  timeOffset = parseFloat(scrub.value);
  scrubVal.textContent = fmtOffset(timeOffset);
});
document.getElementById('btnNow').onclick = () => { timeOffset = 0; scrub.value = 0; scrubVal.textContent = 'now'; };
document.getElementById('btnJ2000').onclick = () => {
  timeOffset = J2000 - julianDay(new Date());
  scrub.value = Math.max(-365, Math.min(365, timeOffset));
  scrubVal.textContent = fmtOffset(timeOffset);
};
document.getElementById('btn2080').onclick = () => {
  timeOffset = julianDay(new Date('2080-01-01T00:00:00Z')) - julianDay(new Date());
  scrub.value = Math.max(-365, Math.min(365, timeOffset));
  scrubVal.textContent = fmtOffset(timeOffset);
};
document.getElementById('btnReset').onclick = () => { focusOn('overview', null); };

// View toggles
let showOrbits = true, showLabels = true, showMoons = true, realScale = false;
function setBtn(id, state) { document.getElementById(id).classList.toggle('active', state); }
document.getElementById('btnOrbits').onclick = (e) => {
  showOrbits = !showOrbits; setBtn('btnOrbits', showOrbits);
  for (const l of Object.values(orbitLines)) l.visible = showOrbits;
  for (const arr of Object.values(moonOrbits)) for (const l of arr) l.visible = showOrbits;
};
document.getElementById('btnLabels').onclick = (e) => {
  showLabels = !showLabels; setBtn('btnLabels', showLabels);
  sunLabelDiv.style.display = showLabels ? '' : 'none';
  for (const div of Object.values(planetLabels)) div.style.display = showLabels ? '' : 'none';
  for (const arr of Object.values(moonMeshes)) for (const m of arr) m.labelDiv.style.display = showLabels ? '' : 'none';
};
document.getElementById('btnMoons').onclick = (e) => {
  showMoons = !showMoons; setBtn('btnMoons', showMoons);
  for (const arr of Object.values(moonMeshes)) for (const m of arr) m.mesh.visible = showMoons;
};
document.getElementById('btnRealistic').onclick = (e) => {
  realScale = !realScale; setBtn('btnRealistic', realScale);
  for (const [name, p] of Object.entries(PLANETS)) {
    const s = realScale ? Math.max(0.15, p.real * 0.5) : p.display;
    planetMeshes[name].scale.setScalar(s / p.display);
  }
  ringMesh.visible = !realScale;
  sunMesh.scale.setScalar(realScale ? 2.5 : 1);
};
['PixelLow','PixelMid','PixelHigh'].forEach((id, i) => {
  document.getElementById('btn' + id).onclick = (e) => {
    document.querySelectorAll('[id^="btnPixel"]').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    pixelScale = PIXEL_PRESETS[['low','mid','high'][i]];
    resize();
  };
});

// Sidebar
const sidebar = document.getElementById('sidebar');
const backdrop = document.getElementById('sidebarBackdrop');
function openSidebar() { sidebar.classList.add('open'); sidebar.setAttribute('aria-hidden','false'); backdrop.classList.add('visible'); }
function closeSidebar() { sidebar.classList.remove('open'); sidebar.setAttribute('aria-hidden','true'); backdrop.classList.remove('visible'); }
function toggleSidebar() { sidebar.classList.contains('open') ? closeSidebar() : openSidebar(); }
document.getElementById('sidebarTab').onclick = toggleSidebar;
backdrop.onclick = closeSidebar;
// ESC closes
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSidebar();
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    timeSpeed = timeSpeed === 0 ? 1 : 0;
    document.querySelectorAll('[data-speed]').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.speed) === timeSpeed));
    clockSpeed.textContent = fmtSpeed(timeSpeed);
  }
});

// Default open on desktop, closed on mobile
if (window.innerWidth > 768) openSidebar();

// Hint
let hintHidden = false;
function hideHint() { if (!hintHidden) { document.getElementById('hint').classList.add('hidden'); hintHidden = true; } }
setTimeout(hideHint, 10000);

// -------------------------------------------------------------------
// 9. MAIN LOOP
// -------------------------------------------------------------------

let lastT = performance.now();

function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  // inertia
  if (!controls.isDown) {
    controls.azimuth -= controls.vAz * 1.0;
    controls.elevation = Math.max(controls.minEl, Math.min(controls.maxEl, controls.elevation + controls.vEl * 1.0));
    controls.vAz *= 0.9;
    controls.vEl *= 0.9;
    if (Math.abs(controls.vAz) > 0.0001 || Math.abs(controls.vEl) > 0.0001) applyCamera();
  }

  // Advance simulation time
  const jd = julianDay(new Date()) + timeOffset;
  // we also track simulated time for timeSpeed-driven motion (when timeOffset is static but speed is on)
  timeOffset += (timeSpeed * dt) / 86400.0; // convert sim-seconds per real-second to days per real-second
  // keep scrub in sync (clamped)
  if (timeSpeed !== 0 && Math.abs(scrub.value - timeOffset) > 0.01) {
    const clamped = Math.max(-365, Math.min(365, timeOffset));
    scrub.value = clamped;
    scrubVal.textContent = fmtOffset(timeOffset);
  }

  const d = dateFromJD(jd);

  // Update planet positions (scaled)
  for (const [name, mesh] of Object.entries(planetMeshes)) {
    const p = heliocentric(name, jd);
    const r = scaledOrbitRadius(p.length());
    if (r > 0.001) p.multiplyScalar(r / p.length());
    mesh.position.copy(p);
    mesh.rotation.y += PLANETS[name].spin * dt;
  }

  // Moons
  for (const [planet, moons] of Object.entries(moonMeshes)) {
    const parent = planetMeshes[planet];
    for (let i = 0; i < moons.length; i++) {
      const m = moons[i];
      const phase = (jd * 2 * Math.PI) / m.data.period + i * 0.7;
      const r = m.data.dist;
      const tilt = 0.08 * (i % 2 ? 1 : -1);
      const ly = Math.sin(phase * 0.5) * r * tilt;
      m.mesh.position.set(parent.position.x + Math.cos(phase) * r, parent.position.y + ly, parent.position.z + Math.sin(phase) * r);
      m.mesh.rotation.y += 0.4 * dt;
      m.mesh.visible = showMoons;
    }
  }

  // Camera animation
  if (controls.anim) {
    const a = controls.anim;
    const t = Math.min(1, (now - a.t0) / a.dur);
    const e = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
    controls.target.lerpVectors(a.fromTarget, a.toTarget, e);
    controls.distance = a.fromDist + (a.toDist - a.fromDist) * e;
    if (a.toElev !== undefined) {
      controls.elevation = a.fromElev + (a.toElev - a.fromElev) * e;
    }
    if (t >= 1) controls.anim = null;
    applyCamera();
  }

  // Sun glow always faces camera
  sunGlow.position.copy(sunMesh.position);
  sunGlow.lookAt(camera.position);
  glowMat.uniforms.uTime.value = now * 0.001;
  stars.material.uniforms.uTime.value = now * 0.001;

  // HUD time
  const ds = d.toISOString();
  clockDate.textContent = ds.slice(0,10).replace(/-/g,'/');
  clockTime.textContent = ds.slice(11,19);
  rDate.textContent = ds.slice(0,10);
  rTime.textContent = ds.slice(11,19);
  rJD.textContent = jd.toFixed(4);
  const ov = document.getElementById('ov-jd'); if (ov) ov.textContent = jd.toFixed(4);

  // Render: scene to low-res RT, then to screen via fullscreen quad. CSS2D labels go on top.
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(fsScene, fsCam);
  labelRenderer.render(scene, camera);

  requestAnimationFrame(tick);
}

resize();
applyCamera();
focusOn('overview', null);
clockSpeed.textContent = fmtSpeed(timeSpeed);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const ld = document.getElementById('loader');
    ld.classList.add('gone');
    setTimeout(() => ld.remove(), 600);
  });
});

tick();
