/**
 * Procedural set dressing: pachinko machines, prize counters, exchange windows, shelves of prizes, lanterns,
 * vending machines, streetlights. Everything is built from primitives plus canvas textures that are seeded
 * from the object id, so a set renders identically every time. Dimensions are mirrored in qa/solids.ts.
 */
import * as THREE from 'three';
import type { SetObject } from '@shortstudio/schema';

type Of<K extends SetObject['kind']> = Extract<SetObject, { kind: K }>;

const FONT = '"IPAGothic", "Noto Sans CJK JP", "Hiragino Sans", Arial, sans-serif';
const CANDY = ['#ff4d6d', '#ffd23d', '#3dd6ff', '#7aff6b', '#ff9a3d', '#c77dff', '#ffffff'];

function rng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
};
const tex = (c: HTMLCanvasElement): THREE.CanvasTexture => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};
const lit = (color: string, rough = 0.6, metal = 0.1) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
const emissive = (map: THREE.Texture, intensity = 1.2) =>
  new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: intensity, roughness: 0.5 });
const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, parent?: THREE.Object3D) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent?.add(m);
  return m;
};
const hex = (c: string) => new THREE.Color(c);
const shade = (c: string, k: number) => `#${hex(c).multiplyScalar(k).getHexString()}`;

let haloTex: THREE.CanvasTexture | undefined;
function halo(): THREE.CanvasTexture {
  if (haloTex) return haloTex;
  const { c, g } = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return (haloTex = tex(c));
}
const glowPlane = (w: number, h: number, color: string, opacity: number) =>
  new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: halo(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );

// ------------------------------------------------------------------- pachinko

function playPanel(id: string, accent: string): THREE.CanvasTexture {
  const W = 344, H = 420;
  const { c, g } = canvas(W, H);
  const r = rng(id + ':panel');
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, shade(accent, 0.35));
  bg.addColorStop(1, '#0a0a1c');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // border lights
  for (let i = 0; i < 26; i++) {
    g.fillStyle = CANDY[Math.floor(r() * CANDY.length)]!;
    const t = i / 26;
    g.beginPath(); g.arc(14 + t * (W - 28), 12, 6, 0, 7); g.fill();
    g.beginPath(); g.arc(14 + t * (W - 28), H - 12, 6, 0, 7); g.fill();
  }
  for (let i = 0; i < 32; i++) {
    g.fillStyle = CANDY[Math.floor(r() * CANDY.length)]!;
    const t = i / 32;
    g.beginPath(); g.arc(12, 24 + t * (H - 48), 6, 0, 7); g.fill();
    g.beginPath(); g.arc(W - 12, 24 + t * (H - 48), 6, 0, 7); g.fill();
  }
  // pins
  g.fillStyle = '#e8e8ff';
  for (let row = 0; row < 15; row++) {
    for (let col = 0; col < 11; col++) {
      g.beginPath();
      g.arc(34 + col * 27 + (row % 2) * 13, 50 + row * 22, 2.6, 0, 7);
      g.fill();
    }
  }
  // centre feature: glowing ring and a flash of colour
  const cx = W / 2, cy = H * 0.52;
  const ring = g.createRadialGradient(cx, cy, 10, cx, cy, 78);
  ring.addColorStop(0, '#fff6a8');
  ring.addColorStop(0.5, accent);
  ring.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = ring;
  g.beginPath(); g.arc(cx, cy, 78, 0, 7); g.fill();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 5;
  g.beginPath(); g.arc(cx, cy, 52, 0, 7); g.stroke();
  g.fillStyle = '#12122a';
  g.font = `900 64px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('7', cx, cy + 3);
  return tex(c);
}

function headerTexture(text: string, accent: string): THREE.CanvasTexture {
  const { c, g } = canvas(440, 180);
  const bg = g.createLinearGradient(0, 0, 440, 0);
  bg.addColorStop(0, shade(accent, 0.6));
  bg.addColorStop(0.5, accent);
  bg.addColorStop(1, shade(accent, 0.6));
  g.fillStyle = bg;
  g.fillRect(0, 0, 440, 180);
  g.strokeStyle = '#ffe14a';
  g.lineWidth = 8;
  g.strokeRect(8, 8, 424, 164);
  g.fillStyle = '#fff3a8';
  g.shadowColor = '#ffd23d';
  g.shadowBlur = 18;
  let size = 130;
  g.font = `900 ${size}px ${FONT}`;
  while (g.measureText(text).width > 380 && size > 20) g.font = `900 ${(size -= 6)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 220, 94);
  return tex(c);
}

export function buildPachinko(o: Of<'pachinko'>): THREE.Group {
  const g = new THREE.Group();
  box(1.1, 1.9, 0.8, lit('#1d1a3a', 0.5, 0.35), 0, 0.95, 0, g);
  box(1.14, 0.45, 0.68, emissive(headerTexture(o.text, o.color), 1.5), 0, 2.125, 0.0, g);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.88, 1.08), emissive(playPanel(o.id, o.color), 1.6));
  panel.position.set(0, 1.28, 0.405);
  g.add(panel);
  box(1.0, 0.1, 0.34, lit('#c9ccd8', 0.25, 0.9), 0, 0.64, 0.5, g); // ball tray
  box(0.16, 0.16, 0.12, lit('#e6c34a', 0.3, 0.8), 0.32, 0.38, 0.44, g); // dial
  for (const sx of [-1, 1]) box(0.05, 1.8, 0.05, new THREE.MeshStandardMaterial({ color: 0x111111, emissive: hex(o.color), emissiveIntensity: 2.2 }), sx * 0.57, 0.95, 0.38, g);
  const wash = glowPlane(1.8, 2.4, o.color, 0.22); // coloured light spilling forward
  wash.position.set(0, 1.3, 0.62);
  g.add(wash);
  g.position.set(...o.position);
  g.rotation.y = o.rotationY;
  g.scale.setScalar(o.scale);
  return g;
}

// -------------------------------------------------------------- shop counter

function woodTexture(id: string, base: string): THREE.CanvasTexture {
  const { c, g } = canvas(512, 256);
  const r = rng(id + ':wood');
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 70; i++) {
    g.strokeStyle = `rgba(0,0,0,${0.05 + r() * 0.1})`;
    g.lineWidth = 1 + r() * 2;
    const y = r() * 256;
    g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(170, y + (r() - 0.5) * 14, 340, y + (r() - 0.5) * 14, 512, y + (r() - 0.5) * 8); g.stroke();
  }
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 6;
  for (const x of [0, 170, 341, 506]) { g.beginPath(); g.moveTo(x + 3, 0); g.lineTo(x + 3, 256); g.stroke(); }
  g.strokeRect(14, 14, 484, 228);
  return tex(c);
}

export function buildShopCounter(o: Of<'shopcounter'>): THREE.Group {
  const g = new THREE.Group();
  const w = o.width;
  const front = new THREE.MeshStandardMaterial({ map: woodTexture(o.id, o.color), roughness: 0.75 });
  box(w, 1.05, 0.7, front, 0, 0.525, 0, g);
  box(w + 0.2, 0.08, 0.9, lit(shade(o.color, 1.35), 0.4, 0.05), 0, 1.09, 0.08, g);
  box(0.42, 0.3, 0.36, lit('#2b2f45', 0.4, 0.5), w / 2 - 0.55, 1.28, 0.05, g); // cash register
  box(0.36, 0.05, 0.28, emissive(headerTexture('¥', '#2d9cdb'), 1.0), w / 2 - 0.55, 1.45, 0.05, g);
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), lit('#e6c34a', 0.25, 0.9));
  bell.position.set(-w / 2 + 0.5, 1.13, 0.15);
  g.add(bell);
  g.position.set(...o.position);
  g.rotation.y = o.rotationY;
  return g;
}

// ------------------------------------------------------------ exchange window

export function buildExchangeWindow(o: Of<'exchangewindow'>): THREE.Group {
  const g = new THREE.Group();
  const [w, h] = o.size;
  const wall = lit(o.color, 0.8);
  const t = 0.4; // wall thickness around the opening
  box(w + 2 * t, t, 0.4, wall, 0, h / 2 + t / 2, 0, g);
  box(w + 2 * t, t, 0.4, wall, 0, -h / 2 - t / 2, 0, g);
  box(t, h, 0.4, wall, -w / 2 - t / 2, 0, 0, g);
  box(t, h, 0.4, wall, w / 2 + t / 2, 0, 0, g);
  // glass with a warm light behind and a slight vertical reflection
  const { c, g: cg } = canvas(256, 192);
  const grad = cg.createLinearGradient(0, 0, 0, 192);
  grad.addColorStop(0, shade(o.glow, 0.85));
  grad.addColorStop(1, shade(o.glow, 0.6));
  cg.fillStyle = grad;
  cg.fillRect(0, 0, 256, 192);
  cg.fillStyle = 'rgba(255,255,255,0.35)';
  cg.beginPath(); cg.moveTo(30, 0); cg.lineTo(90, 0); cg.lineTo(40, 192); cg.lineTo(0, 192); cg.fill();
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), emissive(tex(c), 1.2));
  glass.position.z = 0.02;
  g.add(glass);
  box(w + 0.3, 0.08, 0.5, lit('#c9ccd8', 0.25, 0.9), 0, -h / 2 + 0.04, 0.28, g); // ledge / tray
  box(0.05, h, 0.1, lit('#161420', 0.5), 0, 0, 0.05, g); // glass divider
  const wash = glowPlane(w * 2.2, h * 2.2, o.glow, 0.2);
  wash.position.z = 0.3;
  g.add(wash);
  g.position.set(...o.position);
  g.rotation.y = o.rotationY;
  return g;
}

// ---------------------------------------------------------------------- shelf

export function buildShelf(o: Of<'shelf'>): THREE.Group {
  const g = new THREE.Group();
  const [w, h] = o.size;
  const r = rng(o.id + ':items');
  const wood = lit(o.color, 0.8);
  box(w, h, 0.05, lit(shade(o.color, 0.55), 0.9), 0, h / 2, -0.2, g); // back
  for (const sx of [-1, 1]) box(0.06, h, 0.45, wood, sx * (w / 2 - 0.03), h / 2, 0, g);
  const rows = Math.max(2, Math.round(h / 0.55));
  for (let i = 0; i <= rows; i++) {
    const y = 0.04 + (i * (h - 0.08)) / rows;
    box(w, 0.05, 0.45, wood, 0, y, 0, g);
    if (i === rows) continue;
    // prizes: boxes and tins in candy colours, packed along the shelf
    let x = -w / 2 + 0.12;
    while (x < w / 2 - 0.2) {
      const iw = 0.14 + r() * 0.2;
      const ih = 0.16 + r() * 0.25;
      const col = CANDY[Math.floor(r() * CANDY.length)]!;
      const item = box(iw, ih, 0.2 + r() * 0.12, new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, emissive: hex(col), emissiveIntensity: 0.12 }), x + iw / 2, y + 0.025 + ih / 2, 0.02, g);
      if (r() < 0.3) item.rotation.z = (r() - 0.5) * 0.2;
      x += iw + 0.03 + r() * 0.05;
    }
  }
  g.position.set(...o.position);
  g.rotation.y = o.rotationY;
  return g;
}

// -------------------------------------------------------------------- lantern

export function buildLantern(o: Of<'lantern'>): THREE.Group {
  const g = new THREE.Group();
  const { c, g: cg } = canvas(256, 256);
  cg.fillStyle = o.color;
  cg.fillRect(0, 0, 256, 256);
  cg.fillStyle = 'rgba(255,230,160,0.35)';
  cg.fillRect(0, 100, 256, 56);
  cg.strokeStyle = 'rgba(0,0,0,0.65)';
  cg.lineWidth = 4;
  for (let y = 22; y < 256; y += 22) { cg.beginPath(); cg.moveTo(0, y); cg.lineTo(256, y); cg.stroke(); }
  if (o.text) {
    cg.fillStyle = '#12121c';
    cg.font = `900 90px ${FONT}`;
    cg.textAlign = 'center';
    cg.textBaseline = 'middle';
    cg.fillText(o.text, 128, 130);
  }
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 28, 20).scale(0.92, 1.1, 0.92),
    new THREE.MeshStandardMaterial({ map: tex(c), emissiveMap: tex(c), emissive: 0xffffff, emissiveIntensity: 1.9, roughness: 0.6 }),
  );
  g.add(body);
  for (const sy of [-1, 1]) box(0.34, 0.06, 0.34, lit('#15151c', 0.6), 0, sy * 0.4, 0, g);
  const wash = glowPlane(1.5, 1.7, o.color, 0.32);
  wash.position.z = 0.1;
  g.add(wash);
  g.position.set(...o.position);
  g.scale.setScalar(o.scale);
  return g;
}

// -------------------------------------------------------------------- vending

export function buildVending(o: Of<'vending'>): THREE.Group {
  const g = new THREE.Group();
  const r = rng(o.id + ':cans');
  box(0.9, 1.8, 0.75, lit(o.color, 0.4, 0.4), 0, 0.9, 0, g);
  const { c, g: cg } = canvas(280, 380);
  cg.fillStyle = '#f4f6ff';
  cg.fillRect(0, 0, 280, 380);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      cg.fillStyle = CANDY[Math.floor(r() * CANDY.length)]!;
      cg.fillRect(12 + col * 53, 14 + row * 76, 40, 62);
      cg.fillStyle = 'rgba(255,255,255,0.45)';
      cg.fillRect(16 + col * 53, 18 + row * 76, 7, 54);
    }
    cg.fillStyle = 'rgba(0,0,0,0.25)';
    cg.fillRect(0, 80 + row * 76, 280, 3);
  }
  const display = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.95), emissive(tex(c), 1.35));
  display.position.set(-0.04, 1.15, 0.38);
  g.add(display);
  box(0.76, 0.24, 0.05, lit('#0b0b12', 0.4, 0.5), 0, 0.3, 0.39, g); // pickup flap
  box(0.1, 0.34, 0.04, lit('#d9d9e4', 0.3, 0.8), 0.33, 1.15, 0.385, g); // coin panel
  const wash = glowPlane(1.8, 2.6, '#cfe6ff', 0.2);
  wash.position.set(0, 1.0, 0.6);
  g.add(wash);
  g.position.set(...o.position);
  g.rotation.y = o.rotationY;
  g.scale.setScalar(o.scale);
  return g;
}

// ---------------------------------------------------------------- streetlight

export function buildStreetlight(o: Of<'streetlight'>): THREE.Group {
  const g = new THREE.Group();
  const metal = lit('#2a2d3a', 0.5, 0.7);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 4.2, 12), metal);
  pole.position.y = 2.1;
  g.add(pole);
  box(0.7, 0.07, 0.07, metal, 0.3, 4.15, 0, g);
  const headMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: hex(o.color), emissiveIntensity: 3.0 });
  box(0.34, 0.12, 0.22, headMat, 0.62, 4.08, 0, g);
  const wash = glowPlane(3.4, 3.4, o.color, 0.4);
  wash.position.set(0.62, 3.95, 0.05);
  g.add(wash);
  if (o.light) {
    const l = new THREE.PointLight(o.color, 25, 12, 1.6);
    l.position.set(0.62, 3.9, 0.2);
    g.add(l);
  }
  g.position.set(...o.position);
  g.scale.setScalar(o.scale);
  return g;
}
