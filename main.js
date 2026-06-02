/* ===================================================================
   PIXEL SOLAR SYSTEM
   - Real-time accurate positions via Keplerian elements (J2000)
   - Procedural blocky pixel-art textures for each body
   - Touch / mouse orbit + pinch / wheel zoom
   - Time controls: pause, scrub, presets, variable speed
   - Focus camera on any body, inspect info
   =================================================================== */

import * as THREE from 'three';

// -------------------------------------------------------------------
// 1. EPHEMERIS  (J2000 elements from NASA — Standish 1992, Williams 1994)
//    Accuracy: a few arc-minutes for inner planets, a few arc-minutes
//    for outer planets. Plenty for a visualization that scales orbits
//    by 1000x for visibility anyway. Valid 1800–2050.
// -------------------------------------------------------------------

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const J2000 = 2451545.0;                  // Julian Day of J2000.0 epoch
const MS_PER_DAY = 86400000;

// All elements: [a(AU), e, i(deg), L(deg), wbar(deg), Omega(deg)]
// a = semi-major axis, e = eccentricity, i = inclination,
// L = mean longitude, wbar = longitude of perihelion, Omega = long. of asc. node
// Rates per century in same units (in second array)
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

function julianDay(date) {
  // date is JS Date (UTC)
  return date.getTime() / MS_PER_DAY + 2440587.5;
}
function dateFromJD(jd) {
  return new Date((jd - 2440587.5) * MS_PER_DAY);
}
function centuriesSinceJ2000(jd) {
  return (jd - J2000) / 36525.0;
}

// Solve Kepler's equation  M = E - e*sin(E)  for E (eccentric anomaly)
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

// Return heliocentric ecliptic position (x,y,z) in AU for a body
// using a "perifocal" frame transformed by orbital orientation.
function heliocentric(name, jd) {
  const el = ELEMENTS[name];
  if (!el) return new THREE.Vector3();
  const T = centuriesSinceJ2000(jd);
  const a = el.a[0] + el.a[1] * T;
  const e = el.e[0] + el.e[1] * T;
  const i = (el.i[0] + el.i[1] * T) * DEG;
  const L = (el.L[0] + el.L[1] * T) * DEG;
  const wbar = (el.wbar[0] + el.wbar[1] * T) * DEG;
  const Omega = (el.Omega[0] + el.Omega[1] * T) * DEG;
  // argument of perihelion
  const w = wbar - Omega;
  // mean anomaly
  const M = ((L - wbar) % (2*Math.PI) + 2*Math.PI) % (2*Math.PI);
  const E = solveKepler(M, e);
  // position in orbital plane
  const xPrime = a * (Math.cos(E) - e);
  const yPrime = a * Math.sqrt(1 - e*e) * Math.sin(E);
  // rotate to ecliptic frame
  const cosw = Math.cos(w), sinw = Math.sin(w);
  const cosO = Math.cos(Omega), sinO = Math.sin(Omega);
  const cosi = Math.cos(i), sini = Math.sin(i);
  const x = (cosw*cosO - sinw*sinO*cosi) * xPrime + (-sinw*cosO - cosw*sinO*cosi) * yPrime;
  const y = (cosw*sinO + sinw*cosO*cosi) * xPrime + (-sinw*sinO + cosw*cosO*cosi) * yPrime;
  const z = (sinw*sini) * xPrime + (cosw*sini) * yPrime;
  return new THREE.Vector3(x, z, -y); // remap: y-up scene, z toward camera at start
}

// -------------------------------------------------------------------
// 2. MOON ORBITS
//    For inner-system moons we use approximate Keplerian elements
//    relative to the parent planet. For Galilean moons we use a
//    simple mean-orbit model (good enough for visualization, since
//    we're scaling anyway). All values in km / km-s, periods in days.
// -------------------------------------------------------------------

const MOONS = {
  earth: [
    { name:'Luna', dist:384400, period:27.32, size:0.27, color:0xb8b3a8, accent:0x4a4640, label:'MOON' }
  ],
  mars: [
    { name:'Phobos', dist:9376, period:0.319, size:0.015, color:0x6b5a4a, accent:0x3a2f25, label:'PHOBOS' },
    { name:'Deimos', dist:23463, period:1.262, size:0.009, color:0x7a6a5a, accent:0x3a3025, label:'DEIMOS' },
  ],
  jupiter: [
    { name:'Io',       dist:421800, period:1.769,  size:0.20, color:0xead884, accent:0xc24a1c, label:'IO' },
    { name:'Europa',   dist:671100, period:3.551,  size:0.18, color:0xd9c79a, accent:0x8b5a2b, label:'EUROPA' },
    { name:'Ganymede', dist:1070400,period:7.155,  size:0.29, color:0xa89684, accent:0x5b3a2a, label:'GANYMEDE' },
    { name:'Callisto', dist:1882700,period:16.689, size:0.27, color:0x6a5a48, accent:0x2f2a22, label:'CALLISTO' },
  ],
  saturn: [
    { name:'Titan',     dist:1221870, period:15.945, size:0.30, color:0xd2a76b, accent:0x7a4f24, label:'TITAN' },
    { name:'Rhea',      dist:527108,  period:4.518,  size:0.17, color:0xbfb1a0, accent:0x6a5a48, label:'RHEA' },
    { name:'Iapetus',   dist:3560820, period:79.330, size:0.16, color:0x8a7a66, accent:0x3a3024, label:'IAPETUS' },
  ],
  uranus: [
    { name:'Titania',  dist:435910, period:8.706, size:0.17, color:0x9a9a90, accent:0x4a4a44, label:'TITANIA' },
    { name:'Oberon',   dist:583520, period:13.46, size:0.16, color:0x7a7a72, accent:0x3a3a36, label:'OBERON' },
  ],
  neptune: [
    { name:'Triton',   dist:354759, period:5.877, size:0.18, color:0xbcc8d4, accent:0x5c6a78, label:'TRITON' },
  ],
};

// -------------------------------------------------------------------
// 3. PLANET SPECS  (sizes are *display* sizes in scene units — already
//    inflated for visibility. Real scale is opt-in.)
// -------------------------------------------------------------------

const PLANETS = {
  mercury: { display:0.6, real:0.38, color:0x8c7a6b, accent:0x3a2f25, palette:'rocky', spin:0.004, name:'MERCURY', desc:'Smallest planet, scarred by impact craters. Closest to the Sun — temperatures swing from -180°C to 430°C.' },
  venus:   { display:1.1, real:0.95, color:0xe8c988, accent:0xa96a2a, palette:'venus',  spin:-0.001, name:'VENUS',   desc:'Hothouse world. Sulfuric acid clouds, surface pressure 92× Earth. Brightest planet in our night sky.' },
  earth:   { display:1.15,real:1.00, color:0x4a8fc8, accent:0x1f5c8a, palette:'earth',  spin:0.02,  name:'EARTH',   desc:'Our pale blue dot. The only known planet with liquid surface water and life. One moon: Luna.' },
  mars:    { display:0.75,real:0.53, color:0xc15a2a, accent:0x6e2b13, palette:'mars',   spin:0.019, name:'MARS',    desc:'The red planet. Home to Olympus Mons — the tallest volcano in the solar system. Two small moons.' },
  jupiter: { display:3.8, real:11.2, color:0xd2a374, accent:0x7a4f24, palette:'jupiter',spin:0.06,  name:'JUPITER', desc:'Largest planet — a gas giant with bands of ammonia clouds and the Great Red Spot storm raging for centuries.' },
  saturn:  { display:3.2, real:9.45, color:0xe0c890, accent:0x8b6f3a, palette:'saturn', spin:0.05,  name:'SATURN',  desc:'Famous for its spectacular ring system — icy chunks from 10 m to 1 km. Low density — would float in water.' },
  uranus:  { display:2.4, real:4.01, color:0x9ad5d4, accent:0x4a7a7a, palette:'uranus', spin:-0.04, name:'URANUS',  desc:'Ice giant tilted on its side (98°). Rolls around the Sun rather than spinning upright.' },
  neptune: { display:2.3, real:3.88, color:0x4a6ac8, accent:0x1f3a7a, palette:'neptune',spin:0.05,  name:'NEPTUNE', desc:'Windiest planet — winds reach 2,100 km/h. Discovered by mathematical prediction before observation.' },
};

const SUN = { display:5.0, real:109.3, color:0xffd35a, accent:0xff7a3a, name:'SUN', desc:'Our star — a G2V yellow dwarf containing 99.86% of the solar system\'s mass. About 4.6 billion years old.' };

// -------------------------------------------------------------------
// 4. PROCEDURAL PIXEL-ART TEXTURE GENERATOR
//    Renders each body as a low-res pixel grid (32×16 by default) with
//    a hand-picked palette, so when scaled up with nearest-neighbor it
//    looks like a blocky Terraria/Minecraft sphere.
// -------------------------------------------------------------------

function makePixelTexture(spec, size=48) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size / 2; // 2:1 — for sphere UV mapping
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height);
  const data = img.data;

  // helper: convert hex int to [r,g,b]
  const hex = (h) => [(h>>16)&255, (h>>8)&255, h&255];

  // 2D value-noise (cheap, deterministic via Mulberry32)
  let seed = spec.seed || 0xC0FFEE;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = seed; t = Math.imul(t ^ (t>>>15), t | 1); t ^= t + Math.imul(t ^ (t>>>7), t | 61); return ((t ^ (t>>>14)) >>> 0) / 4294967296; };
  // Permutation table for value noise
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd()*(i+1)); const t=perm[i]; perm[i]=perm[j]; perm[j]=t; }
  for (let i = 0; i < 256; i++) perm[256+i] = perm[i];
  const noise2 = (x, y) => {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = xf*xf*(3-2*xf), v = yf*yf*(3-2*yf);
    const aa = perm[perm[xi]+yi], ab = perm[perm[xi]+yi+1], ba = perm[perm[xi+1]+yi], bb = perm[perm[xi+1]+yi+1];
    const x1 = aa + (ba-aa)*u, x2 = ab + (bb-ab)*u;
    return x1 + (x2-x1)*v;
  };
  const fbm = (x, y, oct=5) => {
    let s = 0, a = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { s += a * noise2(x*f, y*f); f *= 2; a *= 0.5; }
    return s;
  };

  const base = hex(spec.color);
  const accent = hex(spec.accent);

  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      // UV → sphere normal (cheap)
      const u = x / c.width;
      const v = y / c.height;
      const lon = u * Math.PI * 2;
      const lat = (v - 0.5) * Math.PI;
      const nz = Math.cos(lat);
      const ny = Math.sin(lat);
      const nx = Math.cos(lon) * Math.cos(lat);
      // Simple Lambert lighting from a "sun" direction
      const lx = 0.6, ly = 0.4, lz = 0.7;
      const NdotL = Math.max(0, nx*lx + ny*ly + nz*lz);
      // Noise-based pattern varies by palette
      const n = fbm(u*6 + 13.7, v*6 + 91.2, 5);
      const n2 = fbm(u*14 + 41.1, v*14 + 7.3, 4);
      let r, g, b;
      const t = (n*0.6 + n2*0.4);
      // mix base and accent by noise
      const m = Math.min(1, Math.max(0, (t - 0.3) * 1.5));
      r = base[0]*(1-m) + accent[0]*m;
      g = base[1]*(1-m) + accent[1]*m;
      b = base[2]*(1-m) + accent[2]*m;

      // Palette-specific overlays
      if (spec.palette === 'earth') {
        // blue water, green/brown land — thresholded
        const land = fbm(u*8, v*8, 5);
        if (land > 0.55) { r = g = b = 0; r += 80 + n*60; g += 110 + n*70; b += 50 + n*40; } // green
        else if (land > 0.48) { r = 200+n*40; g = 170+n*40; b = 110+n*30; } // tan coast
        else { r = 30 + n*40; g = 70 + n*60; b = 160 + n*50; } // deep blue
        // polar caps
        if (Math.abs(lat) > 1.2) { r=g=b=220+n*30; }
      } else if (spec.palette === 'mars') {
        // reddish with darker patches
        if (n2 > 0.6) { r *= 0.6; g *= 0.55; b *= 0.5; }
        if (Math.abs(lat) > 1.25) { r=200; g=180; b=170; } // polar ice
      } else if (spec.palette === 'jupiter') {
        // horizontal bands
        const band = Math.sin(lat * 7 + n*1.5) * 0.5 + 0.5;
        r = base[0]*(0.6+0.4*band); g = base[1]*(0.6+0.4*band); b = base[2]*(0.4+0.3*band);
        // Great red spot — roughly lat -0.3, lon 0
        if (Math.abs(lat+0.3)<0.15 && Math.abs(lon)<0.4) { r=180; g=60; b=30; }
      } else if (spec.palette === 'saturn') {
        const band = Math.sin(lat * 9 + n*0.8) * 0.5 + 0.5;
        r = base[0]*(0.7+0.3*band); g = base[1]*(0.7+0.3*band); b = base[2]*(0.5+0.3*band);
      } else if (spec.palette === 'venus') {
        // thick yellowish clouds, swirly
        const swirl = fbm(u*4 + n*2, v*4, 4);
        r = 220 + swirl*30; g = 180 + swirl*40; b = 100 + swirl*30;
      } else if (spec.palette === 'uranus') {
        // uniform teal with very subtle banding
        r = 154 + n*20; g = 213 + n*20; b = 212 + n*20;
      } else if (spec.palette === 'neptune') {
        // deep blue, occasional dark storm
        r = 60 + n*30; g = 90 + n*40; b = 200 + n*30;
        if (n2 > 0.72) { r *= 0.5; g *= 0.5; b *= 0.6; }
      } else if (spec.palette === 'rocky') {
        // mercury / generic rocky — cratered gray
        if (n2 > 0.7) { r *= 0.55; g *= 0.55; b *= 0.55; }
        if (n2 > 0.78 && n2 < 0.82) { r = 40; g = 40; b = 40; } // crater rim
      }

      // Apply lighting + ambient
      const light = 0.35 + 0.65 * NdotL;
      r = Math.min(255, r * light);
      g = Math.min(255, g * light);
      b = Math.min(255, b * light);

      // Quantize to ~6 levels per channel for stronger pixel feel
      r = Math.round(r/32)*32; g = Math.round(g/32)*32; b = Math.round(b/32)*32;

      data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function makeSunTexture(size=64) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size/2;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height);
  const data = img.data;
  let seed = 0xFEEDBEEF;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = seed; t = Math.imul(t ^ (t>>>15), t | 1); t ^= t + Math.imul(t ^ (t>>>7), t | 61); return ((t ^ (t>>>14)) >>> 0) / 4294967296; };
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd()*(i+1)); const t=perm[i]; perm[i]=perm[j]; perm[j]=t; }
  for (let i = 0; i < 256; i++) perm[256+i] = perm[i];
  const noise2 = (x, y) => {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = xf*xf*(3-2*xf), v = yf*yf*(3-2*yf);
    const aa = perm[perm[xi]+yi], ab = perm[perm[xi]+yi+1], ba = perm[perm[xi+1]+yi], bb = perm[perm[xi+1]+yi+1];
    return aa + (ba-aa)*u + (ab-aa)*v + (aa-ba-ab+bb)*u*v;
  };
  const fbm = (x, y) => { let s=0,a=0.5,f=1; for (let i=0;i<5;i++){s+=a*noise2(x*f,y*f);f*=2;a*=0.5;} return s; };
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y*c.width + x)*4;
      const u = x/c.width, v = y/c.height;
      const lon = u*Math.PI*2, lat = (v-0.5)*Math.PI;
      const nz = Math.cos(lat), ny = Math.sin(lat), nx = Math.cos(lon)*Math.cos(lat);
      const n = fbm(u*10, v*10);
      const n2 = fbm(u*30+5, v*30+5);
      const flare = (n*0.7 + n2*0.3);
      // hot spots
      const hot = Math.max(0, Math.sin(lon*3 + n*4) * Math.cos(lat*2 + n*3));
      let r = 255, g = 180 + flare*60, b = 40 + hot*80;
      // sunspots
      if (n2 > 0.78) { r = 120; g = 80; b = 30; }
      // limb darkening
      const lz = 0.6*nx + 0.4*ny + 0.5*nz;
      r *= 0.4 + 0.6*Math.max(0, lz);
      g *= 0.4 + 0.6*Math.max(0, lz);
      b *= 0.4 + 0.6*Math.max(0, lz);
      r = Math.round(r/32)*32; g = Math.round(g/32)*32; b = Math.round(b/32)*32;
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
    // x here = radial distance 0..1 in ring
    const r = x / c.width;
    // Ring A: 0.55-0.72, B: 0.42-0.52, C: 0.30-0.40, D: 0.20-0.28, F: 0.78-0.85
    let alpha = 0;
    if (r > 0.18 && r < 0.22) alpha = 0.25;
    else if (r > 0.30 && r < 0.42) alpha = 0.7;
    else if (r > 0.42 && r < 0.52) alpha = 0.1; // Cassini gap
    else if (r > 0.55 && r < 0.74) alpha = 0.9;
    else if (r > 0.78 && r < 0.86) alpha = 0.4;
    if (alpha === 0) { for (let y=0;y<c.height;y++){const i=(y*c.width+x)*4;data[i]=data[i+1]=data[i+2]=0;data[i+3]=0;} continue; }
    // bands
    const band = Math.sin(r * 80) * 0.3 + 0.7;
    const cr = 220 * band * alpha, cg = 200 * band * alpha, cb = 160 * band * alpha;
    for (let y = 0; y < c.height; y++) {
      const i = (y*c.width + x)*4;
      data[i] = cr; data[i+1] = cg; data[i+2] = cb; data[i+3] = 255*alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// -------------------------------------------------------------------
// 5. SCENE SETUP
// -------------------------------------------------------------------

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias:false, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000005);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.001, 1e6);
camera.position.set(0, 30, 60);

// Pixel-art is achieved by rendering the whole scene to a low-resolution
// render target, then drawing that target to the screen with nearest
// neighbor filtering. This gives the "blocky" Minecraft look.
const PIXEL_PRESETS = { low: 0.25, mid: 0.45, high: 0.7 };
let pixelScale = PIXEL_PRESETS.mid;
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
      // Snap UV to pixel grid for hard pixel edges + faint scanline tint
      vec2 px = floor(vUv * uRes) / uRes + 0.5/uRes;
      vec3 c = texture2D(tDiff, px).rgb;
      // soft scanline
      float s = 0.94 + 0.06 * sin(gl_FragCoord.y * 3.14159);
      gl_FragColor = vec4(c * s, 1.0);
    }
  `,
});
const fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2,2), fsMat);
fsScene.add(fsQuad);

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  const w = Math.max(64, Math.floor(window.innerWidth * pixelScale));
  const h = Math.max(48, Math.floor(window.innerHeight * pixelScale));
  rt.setSize(w, h);
  fsMat.uniforms.uRes.value.set(w, h);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// -------------------------------------------------------------------
// 6. BUILD SOLAR SYSTEM
// -------------------------------------------------------------------

// Starfield
function makeStars() {
  const g = new THREE.BufferGeometry();
  const n = 2000;
  const pos = new Float32Array(n*3);
  const col = new Float32Array(n*3);
  for (let i = 0; i < n; i++) {
    const r = 4000 + Math.random()*1000;
    const t = Math.random()*Math.PI*2;
    const p = Math.acos(2*Math.random()-1);
    pos[i*3] = r*Math.sin(p)*Math.cos(t);
    pos[i*3+1] = r*Math.cos(p);
    pos[i*3+2] = r*Math.sin(p)*Math.sin(t);
    // slight color variation
    const hue = 0.55 + Math.random()*0.15;
    col[i*3] = 0.8 + Math.random()*0.2;
    col[i*3+1] = 0.8 + Math.random()*0.2;
    col[i*3+2] = 0.9 + Math.random()*0.1;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({ size:4, vertexColors:true, sizeAttenuation:false, transparent:true, opacity:0.9, depthWrite:false });
  return new THREE.Points(g, m);
}
scene.add(makeStars());

// Sun
const sunTex = new THREE.CanvasTexture(makeSunTexture());
sunTex.magFilter = THREE.NearestFilter;
sunTex.minFilter = THREE.NearestFilter;
sunTex.colorSpace = THREE.SRGBColorSpace;
const sunMesh = new THREE.Mesh(
  new THREE.IcosahedronGeometry(SUN.display, 3),
  new THREE.MeshBasicMaterial({ map: sunTex })
);
scene.add(sunMesh);

// Sun glow (additive sprite-like billboard)
const glowGeo = new THREE.PlaneGeometry(SUN.display*4, SUN.display*4);
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
      float pulse = 0.9 + 0.1 * sin(uTime*2.0);
      float a = smoothstep(0.5, 0.0, d) * 0.7 * pulse;
      vec3 col = mix(vec3(1.0,0.6,0.2), vec3(1.0,0.95,0.6), 1.0 - d*2.0);
      gl_FragColor = vec4(col, a);
    }
  `,
});
const sunGlow = new THREE.Mesh(glowGeo, glowMat);
sunGlow.renderOrder = -1;
scene.add(sunGlow);

// Build planets
const planetMeshes = {};
const orbitLines = {};
const planetGroup = new THREE.Group();
scene.add(planetGroup);

const TEX_RES = 64; // low-res texture = chunkier pixels

for (const [name, p] of Object.entries(PLANETS)) {
  const tex = new THREE.CanvasTexture(makePixelTexture({ ...p, seed: name.charCodeAt(0)*1337 + name.length }, TEX_RES));
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const geom = new THREE.IcosahedronGeometry(p.display, 4);
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  const mesh = new THREE.Mesh(geom, mat);
  planetMeshes[name] = mesh;
  planetGroup.add(mesh);

  // Orbit line (a few hundred points around the orbit)
  const a = ELEMENTS[name].a[0];
  const e = ELEMENTS[name].e[0];
  const i = ELEMENTS[name].i[0] * DEG;
  const Omega = ELEMENTS[name].Omega[0] * DEG;
  // sample 256 points
  const N = 256;
  const pts = new Float32Array(N*3);
  for (let k = 0; k < N; k++) {
    const E = (k/N) * Math.PI * 2;
    const xPrime = a * (Math.cos(E) - e);
    const yPrime = a * Math.sqrt(1-e*e) * Math.sin(E);
    // to ecliptic using mean (not current) elements — close enough for visual orbit ring
    const wbar = ELEMENTS[name].wbar[0] * DEG;
    const w = wbar - Omega;
    const cosw = Math.cos(w), sinw = Math.sin(w);
    const cosO = Math.cos(Omega), sinO = Math.sin(Omega);
    const cosi = Math.cos(i), sini = Math.sin(i);
    const x = (cosw*cosO - sinw*sinO*cosi) * xPrime + (-sinw*cosO - cosw*sinO*cosi) * yPrime;
    const y = (cosw*sinO + sinw*cosO*cosi) * xPrime + (-sinw*sinO + cosw*cosO*cosi) * yPrime;
    const z = (sinw*sini) * xPrime + (cosw*sini) * yPrime;
    pts[k*3] = x; pts[k*3+1] = z; pts[k*3+2] = -y;
  }
  const orbitGeo = new THREE.BufferGeometry();
  orbitGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const orbitMat = new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent:true, opacity:0.18 });
  const orbit = new THREE.Line(orbitGeo, orbitMat);
  scene.add(orbit);
  orbitLines[name] = orbit;
}

// Saturn's rings
const ringTex = new THREE.CanvasTexture(makeRingTexture(128));
ringTex.magFilter = THREE.NearestFilter;
ringTex.minFilter = THREE.NearestFilter;
ringTex.colorSpace = THREE.SRGBColorSpace;
const saturn = planetMeshes.saturn;
const ringMesh = new THREE.Mesh(
  new THREE.RingGeometry(PLANETS.saturn.display*1.3, PLANETS.saturn.display*2.1, 64),
  new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, side: THREE.DoubleSide, depthWrite: false })
);
ringMesh.rotation.x = -Math.PI/2 + 0.4;
saturn.add(ringMesh);

// Lights — Sun as point light at origin
const sunLight = new THREE.PointLight(0xfff4d4, 4, 0, 0);
sunLight.position.set(0,0,0);
scene.add(sunLight);
// small ambient so dark side isn't pure black
scene.add(new THREE.AmbientLight(0x404060, 0.5));

// Moons
const moonMeshes = {};   // { 'earth': [mesh, mesh], ... }
const moonOrbits = {};
const moonDisplayScale = 0.02; // scene-units per km
for (const [planet, moons] of Object.entries(MOONS)) {
  moonMeshes[planet] = [];
  moonOrbits[planet] = [];
  const parent = planetMeshes[planet];
  for (const m of moons) {
    const tex = new THREE.CanvasTexture(makePixelTexture({ color:m.color, accent:m.accent, seed:m.name.length*1009, palette:'rocky' }, 24));
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(m.size, 2),
      new THREE.MeshLambertMaterial({ map: tex })
    );
    scene.add(mesh);
    moonMeshes[planet].push({ mesh, data: m });
    // orbit ring
    const N = 128;
    const pts = new Float32Array(N*3);
    const r = m.dist * moonDisplayScale;
    for (let k = 0; k < N; k++) {
      const a = (k/N) * Math.PI*2;
      pts[k*3] = Math.cos(a)*r;
      pts[k*3+1] = 0;
      pts[k*3+2] = Math.sin(a)*r;
    }
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', new THREE.BufferAttribute(pts,3));
    const om = new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent:true, opacity:0.12 });
    const line = new THREE.Line(og, om);
    parent.add(line);
    moonOrbits[planet].push(line);
  }
}

// -------------------------------------------------------------------
// 7. CAMERA CONTROLS  (touch + mouse, OrbitControls-equivalent)
// -------------------------------------------------------------------

const controls = {
  target: new THREE.Vector3(0, 0, 0),
  distance: 80,
  azimuth: Math.PI * 0.25,    // around y
  elevation: 0.3,             // up/down
  minDist: 0.5,
  maxDist: 4000,
  minEl: -Math.PI/2 + 0.05,
  maxEl:  Math.PI/2 - 0.05,
  isDragging: false,
  lastX: 0, lastY: 0,
  touchDist: 0,
  // smooth focus animation
  anim: null, // { start, end, t0, dur }
};

function applyCamera() {
  const cx = controls.distance * Math.cos(controls.elevation) * Math.sin(controls.azimuth);
  const cy = controls.distance * Math.sin(controls.elevation);
  const cz = controls.distance * Math.cos(controls.elevation) * Math.cos(controls.azimuth);
  camera.position.set(controls.target.x + cx, controls.target.y + cy, controls.target.z + cz);
  camera.lookAt(controls.target);
}

// --- pointer events (works for both mouse and touch) ---
const pointerDown = (x, y) => { controls.isDragging = true; controls.lastX = x; controls.lastY = y; };
const pointerMove = (x, y) => {
  if (!controls.isDragging) return;
  const dx = x - controls.lastX;
  const dy = y - controls.lastY;
  controls.lastX = x; controls.lastY = y;
  controls.azimuth -= dx * 0.005;
  controls.elevation = Math.max(controls.minEl, Math.min(controls.maxEl, controls.elevation + dy * 0.005));
  applyCamera();
};
const pointerUp = () => { controls.isDragging = false; };
const wheel = (delta) => {
  controls.distance *= (1 + delta * 0.001);
  controls.distance = Math.max(controls.minDist, Math.min(controls.maxDist, controls.distance));
  applyCamera();
};

canvas.addEventListener('mousedown', e => { e.preventDefault(); pointerDown(e.clientX, e.clientY); hideHint(); });
window.addEventListener('mousemove', e => pointerMove(e.clientX, e.clientY));
window.addEventListener('mouseup', pointerUp);
canvas.addEventListener('wheel', e => { e.preventDefault(); wheel(e.deltaY); hideHint(); }, { passive:false });

// Touch
let touches = [];
canvas.addEventListener('touchstart', e => {
  e.preventDefault(); hideHint();
  touches = Array.from(e.touches);
  if (touches.length === 1) pointerDown(touches[0].clientX, touches[0].clientY);
  else if (touches.length === 2) {
    controls.touchDist = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    controls.isDragging = false;
  }
}, { passive:false });
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  touches = Array.from(e.touches);
  if (touches.length === 1 && controls.isDragging) {
    pointerMove(touches[0].clientX, touches[0].clientY);
  } else if (touches.length === 2) {
    const d = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    if (controls.touchDist) wheel((controls.touchDist - d) * 4);
    controls.touchDist = d;
    // also drag midpoint to rotate
    const cx = (touches[0].clientX + touches[1].clientX)/2;
    const cy = (touches[0].clientY + touches[1].clientY)/2;
    pointerMove(cx, cy);
    controls.lastX = cx; controls.lastY = cy;
  }
}, { passive:false });
canvas.addEventListener('touchend', e => { if (e.touches.length === 0) { pointerUp(); controls.touchDist = 0; } });

// Tap to select
canvas.addEventListener('click', (e) => {
  // Cast a ray, find what we hit
  const rect = canvas.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(mouse, camera);
  // collect all selectable meshes
  const targets = [sunMesh, ...Object.values(planetMeshes)];
  for (const moons of Object.values(moonMeshes)) for (const m of moons) targets.push(m.mesh);
  const hits = ray.intersectObjects(targets, false);
  if (hits.length) {
    const h = hits[0].object;
    if (h === sunMesh) focusOn('sun', null);
    else {
      for (const [name, mesh] of Object.entries(planetMeshes)) if (mesh === h) { focusOn(name, null); return; }
      for (const [planet, moons] of Object.entries(moonMeshes)) for (const m of moons) if (m.mesh === h) { focusOn(planet, m.data); return; }
    }
  }
});

// -------------------------------------------------------------------
// 8. FOCUS + UI
// -------------------------------------------------------------------

const focusList = document.getElementById('focusList');
const focusItems = [
  { id:'sun',     label:'☉ SUN',         type:'star'   },
  ...Object.entries(PLANETS).map(([k,v]) => ({ id:k, label:v.name, type:'planet' })),
];
for (const fi of focusItems) {
  const b = document.createElement('button');
  b.className = 'btn'; b.dataset.type = fi.type;
  b.dataset.id = fi.id;
  b.textContent = fi.label;
  b.onclick = () => focusOn(fi.id, null);
  focusList.appendChild(b);
}

let focusedPlanet = null;
let focusedMoon = null;

function focusOn(name, moon) {
  focusedPlanet = name;
  focusedMoon = moon;
  let target, dist;
  if (name === 'sun') { target = new THREE.Vector3(0,0,0); dist = SUN.display * 4; }
  else {
    target = planetMeshes[name].position.clone();
    const r = moon ? moon.size * 4 : PLANETS[name].display * 3.5;
    dist = r;
  }
  // animate
  controls.anim = {
    fromTarget: controls.target.clone(),
    toTarget: target,
    fromDist: controls.distance,
    toDist: Math.max(2, dist),
    t0: performance.now(),
    dur: 900,
  };
  // update info panel
  updateInfo(name, moon);
  // mark active
  document.querySelectorAll('.focus-list .btn').forEach(b => b.classList.toggle('active', b.dataset.id === name));
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
      <p style="margin-top:8px;font-size:16px;color:var(--ink-dim)">${SUN.desc}</p>`;
    return;
  }
  const p = PLANETS[name];
  if (!p) return;
  if (moon) {
    nameEl.textContent = moon.label;
    bodyEl.innerHTML = `<div class="stat"><span>ORBITS</span><b>${p.name}</b></div>
      <div class="stat"><span>SEMI-MAJOR</span><b>${moon.dist.toLocaleString()} km</b></div>
      <div class="stat"><span>PERIOD</span><b>${moon.period.toFixed(3)} d</b></div>
      <p style="margin-top:8px;font-size:16px;color:var(--ink-dim)">A moon of ${p.name}.</p>`;
  } else {
    const el = ELEMENTS[name];
    nameEl.textContent = p.name;
    bodyEl.innerHTML = `<div class="stat"><span>SEMI-MAJOR</span><b>${el.a[0].toFixed(3)} AU</b></div>
      <div class="stat"><span>ECCENTRICITY</span><b>${el.e[0].toFixed(4)}</b></div>
      <div class="stat"><span>INCLINATION</span><b>${el.i[0].toFixed(2)}°</b></div>
      <div class="stat"><span>PERIOD</span><b>${(Math.sqrt(el.a[0]**3)*365.25).toFixed(1)} d</b></div>
      <p style="margin-top:8px;font-size:16px;color:var(--ink-dim)">${p.desc}</p>`;
  }
}

// Time controls
let timeSpeed = 1;        // sim seconds per real second
let timeOffset = 0;       // sim days from now

const clockDate = document.getElementById('clock-date');
const clockTime = document.getElementById('clock-time');
const rDate = document.getElementById('r-date');
const rTime = document.getElementById('r-time');
const rJD = document.getElementById('r-jd');
const scrub = document.getElementById('scrub');
const scrubVal = document.getElementById('scrubVal');

document.querySelectorAll('[data-speed]').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('[data-speed]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    timeSpeed = parseFloat(btn.dataset.speed);
  };
});
scrub.oninput = () => {
  timeOffset = parseFloat(scrub.value);
  scrubVal.textContent = `${timeOffset.toFixed(1)}d`;
};
document.getElementById('btnNow').onclick = () => { timeOffset = 0; scrub.value = 0; scrubVal.textContent = '0d'; };
document.getElementById('btnJ2000').onclick = () => {
  const jd = J2000;
  timeOffset = jd - julianDay(new Date());
  scrub.value = Math.max(-30, Math.min(30, timeOffset));
  scrubVal.textContent = `${timeOffset.toFixed(0)}d`;
};
document.getElementById('btn2080').onclick = () => {
  const jd = julianDay(new Date('2080-01-01T00:00:00Z'));
  timeOffset = jd - julianDay(new Date());
  scrub.value = Math.max(-30, Math.min(30, timeOffset));
  scrubVal.textContent = `${timeOffset.toFixed(0)}d`;
};

// View toggles
let showOrbits = true, showLabels = true, showMoons = true, realScale = false;
document.getElementById('btnOrbits').onclick = (e) => {
  showOrbits = !showOrbits;
  e.target.classList.toggle('active', showOrbits);
  for (const l of Object.values(orbitLines)) l.visible = showOrbits;
  for (const arr of Object.values(moonOrbits)) for (const l of arr) l.visible = showOrbits;
};
document.getElementById('btnLabels').onclick = (e) => { showLabels = !showLabels; e.target.classList.toggle('active', showLabels); };
document.getElementById('btnMoons').onclick = (e) => { showMoons = !showMoons; e.target.classList.toggle('active', showMoons); };
document.getElementById('btnRealistic').onclick = (e) => {
  realScale = !realScale;
  e.target.classList.toggle('active', realScale);
  // Recompute display sizes for planet meshes
  for (const [name, p] of Object.entries(PLANETS)) {
    const s = realScale ? Math.max(0.1, p.real * 0.3) : p.display;
    planetMeshes[name].scale.setScalar(s / p.display);
  }
  ringMesh.visible = !realScale; // skip rings in real-scale view
  sunMesh.scale.setScalar(realScale ? 2.5 : 1);
};
['PixelLow','PixelMid','PixelHigh'].forEach((id, i) => {
  document.getElementById('btn' + id).onclick = (e) => {
    document.querySelectorAll('[id^="btnPixel"]').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    const k = ['low','mid','high'][i];
    pixelScale = PIXEL_PRESETS[k];
    resize();
  };
});

// Sidebar toggle
const sidebar = document.getElementById('sidebar');
document.getElementById('sidebarTab').onclick = () => sidebar.classList.toggle('open');
sidebar.classList.add('open'); // open by default on desktop

// Hide hint after first interaction
let hintHidden = false;
function hideHint() { if (!hintHidden) { document.getElementById('hint').classList.add('hidden'); hintHidden = true; } }
setTimeout(hideHint, 8000);

// Auto-collapse sidebar on small screens at start
if (window.innerWidth < 600) sidebar.classList.remove('open');

// -------------------------------------------------------------------
// 9. MAIN LOOP
// -------------------------------------------------------------------

const clock = new THREE.Clock();
let lastT = performance.now();
let simNow = new Date();

function tick() {
  const now = performance.now();
  const dt = (now - lastT) / 1000;
  lastT = now;
  // advance simulation time
  simNow = new Date(simNow.getTime() + timeSpeed * dt * 1000);
  // current JD = real now + offset
  const jd = julianDay(new Date()) + timeOffset;
  const d = dateFromJD(jd);

  // Update planet positions
  for (const [name, mesh] of Object.entries(planetMeshes)) {
    const p = heliocentric(name, jd);
    mesh.position.copy(p);
    // also rotate the planet
    mesh.rotation.y += PLANETS[name].spin * dt;
  }
  // Sun stays at origin (well, solar system barycenter is offset a bit,
  // but visually keeping it at 0 is cleaner for the pixel-art aesthetic)

  // Update moons — position relative to parent
  for (const [planet, moons] of Object.entries(moonMeshes)) {
    const parent = planetMeshes[planet];
    const jdAtParent = jd;
    for (let i = 0; i < moons.length; i++) {
      const m = moons[i];
      // mean anomaly scaled by simulation time
      const phase = (jdAtParent * 2 * Math.PI) / m.data.period;
      const r = m.data.dist * moonDisplayScale;
      const lx = Math.cos(phase) * r;
      const lz = Math.sin(phase) * r;
      // tilt orbit slightly
      const tilt = 0.1 * (i % 2 ? 1 : -1);
      const ly = Math.sin(phase * 0.7 + i) * r * tilt;
      m.mesh.position.set(parent.position.x + lx, parent.position.y + ly, parent.position.z + lz);
      m.mesh.rotation.y += 0.5 * dt;
      m.mesh.visible = showMoons;
    }
  }

  // Camera animation
  if (controls.anim) {
    const a = controls.anim;
    const t = Math.min(1, (now - a.t0) / a.dur);
    const e = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t; // easeInOut
    controls.target.lerpVectors(a.fromTarget, a.toTarget, e);
    controls.distance = a.fromDist + (a.toDist - a.fromDist) * e;
    if (t >= 1) controls.anim = null;
    applyCamera();
  }

  // Sun glow always faces camera
  sunGlow.lookAt(camera.position);
  glowMat.uniforms.uTime.value = now * 0.001;

  // Update HUD time
  const ds = d.toISOString();
  clockDate.textContent = ds.slice(0,10).replace(/-/g,'/');
  clockTime.textContent = ds.slice(11,19);
  rDate.textContent = ds.slice(0,10);
  rTime.textContent = ds.slice(11,19);
  rJD.textContent = jd.toFixed(4);

  // Render to low-res RT, then to screen
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(fsScene, fsCam);

  requestAnimationFrame(tick);
}

// First-time setup
resize();
applyCamera();
focusOn('sun', null);
// hide loader after first frame
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    document.getElementById('loader').classList.add('gone');
    setTimeout(() => document.getElementById('loader').remove(), 600);
  });
});

tick();
