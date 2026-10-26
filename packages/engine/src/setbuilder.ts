import * as THREE from 'three';
import type { SetObject } from '@shortstudio/schema';

/** Small deterministic PRNG so lit-window patterns never change between renders. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const canvasTex = (c: HTMLCanvasElement): THREE.CanvasTexture => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};

function windowTexture(id: string, base: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = base; g.fillRect(0, 0, 256, 512);
  const r = rng(id);
  const palette = ['#ffd27a', '#ffb347', '#9fd8ff', '#ff7ad9'];
  for (let y = 16; y < 496; y += 32) {
    for (let x = 16; x < 240; x += 32) {
      if (r() < 0.55) { g.fillStyle = palette[Math.floor(r() * palette.length)]!; g.fillRect(x, y, 18, 20); }
      else { g.fillStyle = '#15151f'; g.fillRect(x, y, 18, 20); }
    }
  }
  return canvasTex(c);
}

function signTexture(text: string, color: string, bg: string, w: number, h: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  const px = 256;
  c.width = Math.round(px * w); c.height = Math.round(px * h);
  const g = c.getContext('2d')!;
  g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = color; g.lineWidth = 8; g.strokeRect(10, 10, c.width - 20, c.height - 20);
  let size = c.height * 0.55;
  g.font = `bold ${size}px "IPAGothic", "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", sans-serif`;
  while (g.measureText(text).width > c.width * 0.86 && size > 12) {
    size -= 4;
    g.font = `bold ${size}px "IPAGothic", "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", sans-serif`;
  }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = color; g.shadowBlur = 28; g.fillStyle = color;
  g.fillText(text, c.width / 2, c.height / 2 + size * 0.04);
  g.shadowBlur = 0; g.fillText(text, c.width / 2, c.height / 2 + size * 0.04);
  return canvasTex(c);
}

let glowTex: THREE.CanvasTexture | undefined;
function glowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return (glowTex = canvasTex(c));
}

export function buildSetObject(o: SetObject): THREE.Object3D {
  switch (o.kind) {
    case 'floor': {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(o.size[0], o.size[1]),
        new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.55, metalness: 0.15 }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(...o.position);
      return m;
    }
    case 'box': {
      const mats: THREE.Material[] = [];
      const plain = new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.85 });
      if (o.windows) {
        const wm = new THREE.MeshStandardMaterial({
          color: 0xffffff, map: windowTexture(o.id, o.color), emissiveMap: windowTexture(o.id, '#000000'),
          emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.9,
        });
        mats.push(plain, plain, plain, plain, wm, plain); // +x -x +y -y +z -z
      } else {
        if (o.emissive) { plain.emissive = new THREE.Color(o.emissive); plain.emissiveIntensity = o.emissiveIntensity; }
        mats.push(plain);
      }
      const m = new THREE.Mesh(new THREE.BoxGeometry(...o.size), o.windows ? mats : plain);
      m.position.set(...o.position);
      return m;
    }
    case 'sign': {
      const g = new THREE.Group();
      g.position.set(...o.position);
      g.rotation.y = o.rotationY;
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(o.size[0], o.size[1]),
        new THREE.MeshBasicMaterial({ map: signTexture(o.text, o.color, o.background, o.size[0], o.size[1]), toneMapped: false }),
      );
      g.add(plane);
      if (o.glow) {
        const halo = new THREE.Mesh(
          new THREE.PlaneGeometry(o.size[0] * 1.9, o.size[1] * 2.4),
          new THREE.MeshBasicMaterial({ map: glowTexture(), color: o.color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
        );
        halo.position.z = -0.02;
        g.add(halo);
      }
      return g;
    }
    case 'light': {
      const l = new THREE.PointLight(o.color, o.intensity, o.distance, 1.6);
      l.position.set(...o.position);
      return l;
    }
  }
}
