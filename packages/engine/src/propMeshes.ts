import * as THREE from 'three';
import type { PropDef } from '@shortstudio/schema';
import { calendarFlip, clockAngles, odometerPositions, type PropState } from './propState';
import { createOutlineMaterial, createWhiteLiftMaterial } from './shaders';

const FONT = '"IPAGothic", "Noto Sans CJK JP", "Hiragino Sans", Arial, sans-serif';
const INK = '#0a0a10';

export interface PropMesh {
  group: THREE.Group;
  /** WhiteLift materials that need the shot's light rig pushed in each frame. */
  toonMaterials: THREE.ShaderMaterial[];
  apply(state: PropState): void;
}

const tex = (c: HTMLCanvasElement): THREE.CanvasTexture => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};
const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
};

/** Shared kit: toon + inked solids. */
class Kit {
  readonly toonMaterials: THREE.ShaderMaterial[] = [];
  private ink = createOutlineMaterial(0.025);
  toon(color: string) {
    const m = createWhiteLiftMaterial(color);
    this.toonMaterials.push(m);
    return m;
  }
  /** A mesh with a black inverted-hull outline. */
  solid(geo: THREE.BufferGeometry, color: string, parent: THREE.Object3D): THREE.Mesh {
    const m = new THREE.Mesh(geo, this.toon(color));
    m.add(new THREE.Mesh(geo, this.ink));
    parent.add(m);
    return m;
  }
  flat(geo: THREE.BufferGeometry, map: THREE.Texture, parent: THREE.Object3D): THREE.Mesh {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map, toneMapped: false }));
    parent.add(m);
    return m;
  }
}

function place(group: THREE.Group, def: { position: readonly number[]; rotationY: number; scale: number }): void {
  group.position.set(def.position[0]!, def.position[1]!, def.position[2]!);
  group.rotation.y = def.rotationY;
  group.scale.setScalar(def.scale);
}

// ------------------------------------------------------------------ counter

const DRUM_R = 0.6;
const DRUM_W = 0.46;
const SEG = 128; // texture px per digit

function drumTexture(): THREE.CanvasTexture {
  const { c, g } = canvas(SEG * 10, 256);
  g.fillStyle = '#f7f4ea';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = INK;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // A texel is longer around the drum than along it (circumference 2*pi*R over 1280px vs the drum width over 256px),
  // so stretch the glyph's width by that ratio and it comes out undistorted on the surface.
  const around = (2 * Math.PI * DRUM_R) / (SEG * 10);
  const along = DRUM_W / 256;
  const stretch = around / along;
  g.font = `900 140px ${FONT}`;
  for (let k = 0; k < 10; k++) {
    g.save();
    g.translate((k + 0.5) * SEG, 128);
    g.rotate(Math.PI / 2); // circumference runs along canvas x, so stand each glyph up along it
    g.scale(stretch, 1);
    g.fillText(String(k), 0, 6);
    g.restore();
  }
  return tex(c);
}

function labelTexture(text: string, w: number, h: number, color = '#ffe14a'): THREE.CanvasTexture {
  const { c, g } = canvas(Math.round(w * 256), Math.round(h * 256));
  g.fillStyle = '#12121c';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = color;
  let size = c.height * 0.8;
  g.font = `900 ${size}px ${FONT}`;
  while (g.measureText(text).width > c.width * 0.9 && size > 10) g.font = `900 ${(size -= 4)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + size * 0.04);
  return tex(c);
}

function buildCounter(def: Extract<PropDef, { kind: 'counter' }>): PropMesh {
  const kit = new Kit();
  const group = new THREE.Group();
  const pre = def.prefix ? 0.55 : 0;
  const suf = def.suffix ? 0.55 : 0;
  const drumsW = def.digits * (DRUM_W + 0.04);
  const W = drumsW + 0.5 + pre + suf;
  const H = 1.3;

  kit.solid(new THREE.BoxGeometry(W, H, 0.5), '#2b2f55', group);
  const drumTex = drumTexture();
  const drums: THREE.Mesh[] = [];
  const x0 = -drumsW / 2 + (pre - suf) / 2;
  for (let i = 0; i < def.digits; i++) {
    const geo = new THREE.CylinderGeometry(DRUM_R, DRUM_R, DRUM_W, 40, 1, true).rotateZ(Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: drumTex, toneMapped: false }));
    m.position.set(x0 + (i + 0.5) * (DRUM_W + 0.04), 0, 0.4 - DRUM_R);
    group.add(m);
    drums.push(m);
  }
  // bezel: four bars frame a window onto the front of the drums
  const zb = 0.44;
  const winH = 0.62;
  const bar = (w: number, h: number, x: number, y: number) => kit.solid(new THREE.BoxGeometry(w, h, 0.1), '#161a33', group).position.set(x, y, zb);
  bar(W, (H - winH) / 2, 0, winH / 2 + (H - winH) / 4); // covers y 0.31..0.65, which hides the drum (radius 0.6) above and below the window
  bar(W, (H - winH) / 2, 0, -winH / 2 - (H - winH) / 4);
  const left = x0 - 0.04;
  const right = x0 + drumsW;
  const side = (x: number) => kit.solid(new THREE.BoxGeometry(0.1, winH, 0.1), '#161a33', group).position.set(x, 0, zb);
  side(left);
  side(right);
  // affixes sit on the housing beside the drums
  if (def.prefix) kit.flat(new THREE.PlaneGeometry(0.5, 0.6), labelTexture(def.prefix, 0.5, 0.6), group).position.set(-W / 2 + 0.35, 0, 0.26);
  if (def.suffix) kit.flat(new THREE.PlaneGeometry(0.5, 0.6), labelTexture(def.suffix, 0.5, 0.6), group).position.set(W / 2 - 0.1 - 0.25, 0, 0.26);

  place(group, def);
  return {
    group,
    toonMaterials: kit.toonMaterials,
    apply(s) {
      if (s.kind !== 'counter') return;
      const pos = odometerPositions(s.value, def.digits);
      drums.forEach((d, i) => (d.rotation.x = (2 * Math.PI * (pos[i]! + 0.5)) / 10));
    },
  };
}

// --------------------------------------------------------------------- dial

function dialFace(def: Extract<PropDef, { kind: 'dial' }>): THREE.CanvasTexture {
  const S = 512;
  const { c, g } = canvas(S, S);
  g.fillStyle = '#f7f4ea';
  g.fillRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  const a0 = (Math.PI * 3) / 4 + Math.PI / 2, aSweep = (Math.PI * 3) / 2; // canvas angles: min at lower-left, max at lower-right
  // coloured arc
  for (const [from, to, col] of [[0, 0.6, '#3ddc84'], [0.6, 0.85, '#ffd23d'], [0.85, 1, '#ff4d4d']] as const) {
    g.beginPath();
    g.strokeStyle = col;
    g.lineWidth = 34;
    g.arc(cx, cy, 190, a0 + aSweep * from, a0 + aSweep * to);
    g.stroke();
  }
  g.strokeStyle = INK;
  g.fillStyle = INK;
  g.font = `900 40px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i <= 10; i++) {
    const a = a0 + (aSweep * i) / 10;
    const long = i % 5 === 0;
    g.lineWidth = long ? 8 : 4;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * 160, cy + Math.sin(a) * 160);
    g.lineTo(cx + Math.cos(a) * (long ? 130 : 142), cy + Math.sin(a) * (long ? 130 : 142));
    g.stroke();
  }
  g.fillText(String(def.min), cx + Math.cos(a0) * 100, cy + Math.sin(a0) * 100);
  g.fillText(String(def.max), cx + Math.cos(a0 + aSweep) * 100, cy + Math.sin(a0 + aSweep) * 100);
  if (def.label) {
    g.font = `900 46px ${FONT}`;
    g.fillText(def.label, cx, cy + 118);
  }
  return tex(c);
}

function buildDial(def: Extract<PropDef, { kind: 'dial' }>): PropMesh {
  const kit = new Kit();
  const group = new THREE.Group();
  kit.solid(new THREE.CylinderGeometry(0.85, 0.85, 0.2, 48).rotateX(Math.PI / 2), '#1c1f3a', group);
  kit.flat(new THREE.CircleGeometry(0.74, 48), dialFace(def), group).position.z = 0.11;
  const needle = new THREE.Group();
  needle.position.z = 0.16;
  const blade = kit.solid(new THREE.BoxGeometry(0.07, 0.62, 0.03), '#e63946', needle);
  blade.position.y = 0.24;
  kit.solid(new THREE.BoxGeometry(0.07, 0.18, 0.03), '#e63946', needle).position.y = -0.08;
  group.add(needle);
  kit.solid(new THREE.SphereGeometry(0.1, 20, 14), '#1c1f3a', group).position.z = 0.19;

  place(group, def);
  return {
    group,
    toonMaterials: kit.toonMaterials,
    apply(s) {
      if (s.kind !== 'dial') return;
      const f = Math.max(-0.12, Math.min(1.12, (s.value - def.min) / (def.max - def.min)));
      needle.rotation.z = (Math.PI * 3) / 4 - f * ((Math.PI * 3) / 2); // min lower-left, max lower-right, through the top
    },
  };
}

// ----------------------------------------------------------------- calendar

const halfCache = new Map<string, THREE.CanvasTexture>();
function numberHalf(n: number, half: 'top' | 'bottom', flipped: boolean): THREE.CanvasTexture {
  const key = `${n}|${half}|${flipped}`;
  const hit = halfCache.get(key);
  if (hit) return hit;
  const W = 256, H = 128;
  const { c, g } = canvas(W, H);
  if (flipped) {
    g.translate(W, H);
    g.rotate(Math.PI); // the flap's back face arrives upside-down; pre-rotate so it reads upright
  }
  g.fillStyle = '#f7f4ea';
  g.fillRect(0, 0, W, H);
  g.fillStyle = INK;
  g.font = `900 230px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const centreY = half === 'top' ? H : 0; // the card centre is the hinge line
  g.fillText(String(n), W / 2, centreY + 14);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, half === 'top' ? H - 3 : 0, W, 3);
  const t = tex(c);
  halfCache.set(key, t);
  return t;
}

function buildCalendar(def: Extract<PropDef, { kind: 'calendar' }>): PropMesh {
  const kit = new Kit();
  const group = new THREE.Group();
  kit.solid(new THREE.BoxGeometry(1.3, 1.75, 0.3), '#e63946', group);
  if (def.month) {
    kit.flat(new THREE.PlaneGeometry(1.1, 0.38), labelTexture(def.month.toUpperCase(), 1.1, 0.38, '#ffffff'), group).position.set(0, 0.68, 0.16);
  }
  const hingeY = -0.18, w = 1.0, hh = 0.5;
  const hinge = new THREE.Vector3(0, hingeY, 0.17);
  const mk = (t: THREE.Texture, y: number, z: number, parent: THREE.Object3D = group) => {
    const m = kit.flat(new THREE.PlaneGeometry(w, hh), t, parent);
    m.position.set(0, y, z);
    return m;
  };
  const staticTop = mk(numberHalf(def.initial + 1, 'top', false), hingeY + hh / 2, 0.16);
  const staticBottom = mk(numberHalf(def.initial, 'bottom', false), hingeY - hh / 2, 0.16);
  const flap = new THREE.Group();
  flap.position.copy(hinge);
  group.add(flap);
  const front = mk(numberHalf(def.initial, 'top', false), hh / 2, 0.005, flap);
  const back = mk(numberHalf(def.initial + 1, 'bottom', true), hh / 2, -0.005, flap);
  back.rotation.y = Math.PI; // faces -z until the flap swings over
  const set = (m: THREE.Mesh, t: THREE.Texture) => {
    const mat = m.material as THREE.MeshBasicMaterial;
    if (mat.map !== t) { mat.map = t; mat.needsUpdate = true; }
  };

  place(group, def);
  return {
    group,
    toonMaterials: kit.toonMaterials,
    apply(s) {
      if (s.kind !== 'calendar') return;
      const f = calendarFlip(s.value);
      set(staticTop, numberHalf(f.next, 'top', false));
      set(staticBottom, numberHalf(f.current, 'bottom', false));
      set(front, numberHalf(f.current, 'top', false));
      set(back, numberHalf(f.next, 'bottom', true));
      flap.rotation.x = Math.PI * f.fold; // top edge swings toward the viewer, over, and down onto the lower half
    },
  };
}

// -------------------------------------------------------------------- clock

function clockFace(): THREE.CanvasTexture {
  const S = 512;
  const { c, g } = canvas(S, S);
  g.fillStyle = '#f7f4ea';
  g.fillRect(0, 0, S, S);
  const cx = S / 2;
  g.fillStyle = INK;
  g.strokeStyle = INK;
  g.font = `900 58px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 1; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    g.fillText(String(i), cx + Math.cos(a) * 190, cx + Math.sin(a) * 190 + 3);
  }
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    g.lineWidth = i % 5 === 0 ? 7 : 3;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * 238, cx + Math.sin(a) * 238);
    g.lineTo(cx + Math.cos(a) * (i % 5 === 0 ? 222 : 230), cx + Math.sin(a) * (i % 5 === 0 ? 222 : 230));
    g.stroke();
  }
  return tex(c);
}

function buildClock(def: Extract<PropDef, { kind: 'clock' }>): PropMesh {
  const kit = new Kit();
  const group = new THREE.Group();
  kit.solid(new THREE.CylinderGeometry(0.85, 0.85, 0.2, 48).rotateX(Math.PI / 2), '#e63946', group);
  kit.flat(new THREE.CircleGeometry(0.74, 48), clockFace(), group).position.z = 0.11;
  const hand = (len: number, thick: number, z: number) => {
    const pivot = new THREE.Group();
    pivot.position.z = z;
    kit.solid(new THREE.BoxGeometry(thick, len, 0.03), '#0a0a10', pivot).position.y = len / 2 - 0.06;
    group.add(pivot);
    return pivot;
  };
  const hour = hand(0.38, 0.09, 0.15);
  const minute = hand(0.58, 0.06, 0.18);
  kit.solid(new THREE.SphereGeometry(0.075, 16, 12), '#0a0a10', group).position.z = 0.2;

  place(group, def);
  return {
    group,
    toonMaterials: kit.toonMaterials,
    apply(s) {
      if (s.kind !== 'clock') return;
      const a = clockAngles(s.minutes);
      hour.rotation.z = -a.hour; // clockwise from 12
      minute.rotation.z = -a.minute;
    },
  };
}

// --------------------------------------------------------------- magnifier

const DOC_W = 1.4, DOC_H = 1.8;
function documentTexture(text: string): THREE.CanvasTexture {
  const { c, g } = canvas(512, 658);
  g.fillStyle = '#f7f4ea';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = INK;
  g.font = `700 34px ${FONT}`;
  g.textBaseline = 'middle';
  const lines = (text || 'terms and conditions apply\nsee section 9(b) for details\nthe fine print goes here').split('\n');
  for (let y = 60, i = 0; y < c.height - 30; y += 52, i++) {
    const t = lines[i % lines.length]!;
    if (i % 2 === 0 || !text) g.fillText(t, 36, y);
    else { g.fillRect(36, y - 3, 60 + ((i * 97) % 300), 6); }
  }
  return tex(c);
}

function buildMagnifier(def: Extract<PropDef, { kind: 'magnifier' }>): PropMesh {
  const kit = new Kit();
  const group = new THREE.Group();
  const doc = documentTexture(def.text);
  kit.solid(new THREE.BoxGeometry(DOC_W + 0.06, DOC_H + 0.06, 0.05), '#ffffff', group);
  kit.flat(new THREE.PlaneGeometry(DOC_W, DOC_H), doc, group).position.z = 0.03;

  const lens = new THREE.Group();
  lens.position.z = 0.12;
  const R = 0.36;
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uDoc: { value: doc }, uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uMag: { value: 2.2 }, uR: { value: new THREE.Vector2(R / DOC_W, R / DOC_H) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D uDoc; uniform vec2 uCenter; uniform vec2 uR; uniform float uMag; varying vec2 vUv;
      void main(){ vec2 p = vUv * 2.0 - 1.0; vec3 c = texture2D(uDoc, uCenter + p * uR / uMag).rgb; c = mix(c, vec3(0.80, 0.92, 1.0), 0.18);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  lens.add(new THREE.Mesh(new THREE.CircleGeometry(R, 40), mat));
  const ring = kit.solid(new THREE.TorusGeometry(R + 0.02, 0.06, 12, 40), '#3b2a1a', lens);
  ring.position.z = 0.01;
  const handle = kit.solid(new THREE.CylinderGeometry(0.06, 0.07, 0.62, 12), '#3b2a1a', lens);
  handle.position.set(0.31 + R * 0.7, -(0.31 + R * 0.7), 0.01);
  handle.rotation.z = Math.PI / 4;
  group.add(lens);

  place(group, def);
  return {
    group,
    toonMaterials: kit.toonMaterials,
    apply(s) {
      if (s.kind !== 'magnifier') return;
      const x = Math.max(-1, Math.min(1, s.x)), y = Math.max(-1, Math.min(1, s.y));
      lens.position.x = x * (DOC_W / 2 - 0.2);
      lens.position.y = y * (DOC_H / 2 - 0.2);
      (mat.uniforms.uCenter!.value as THREE.Vector2).set(0.5 + lens.position.x / DOC_W, 0.5 + lens.position.y / DOC_H);
    },
  };
}

export function buildProp(def: PropDef): PropMesh {
  switch (def.kind) {
    case 'counter': return buildCounter(def);
    case 'dial': return buildDial(def);
    case 'calendar': return buildCalendar(def);
    case 'clock': return buildClock(def);
    case 'magnifier': return buildMagnifier(def);
  }
}
