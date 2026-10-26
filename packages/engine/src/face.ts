import * as THREE from 'three';
import type { FaceState } from './rules';

const cache = new Map<string, THREE.CanvasTexture>();

/** 2D ink decals drawn once per (state, glasses) and swapped, never tweened. */
export function faceTexture(state: FaceState, glasses: boolean): THREE.CanvasTexture {
  const key = `${state}|${glasses}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const W = 400, H = 300;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = '#0a0a10';
  g.fillStyle = '#0a0a10';
  g.lineWidth = 12;

  const ex = [W * 0.3, W * 0.7];
  const ey = H * 0.4;
  const eyeR = 30;

  const eye = (x: number, kind: 'open' | 'half' | 'closed' | 'happy' | 'panic') => {
    if (kind === 'closed') {
      g.beginPath(); g.moveTo(x - eyeR, ey); g.lineTo(x + eyeR, ey); g.stroke();
    } else if (kind === 'happy') {
      g.beginPath(); g.arc(x, ey + 12, eyeR, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
    } else {
      const r = kind === 'panic' ? eyeR + 6 : eyeR;
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(x, ey, r, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#0a0a10';
      const py = kind === 'half' ? ey + 12 : ey;
      g.beginPath(); g.arc(x, py, kind === 'panic' ? 7 : 11, 0, Math.PI * 2); g.fill();
      if (kind === 'half') {
        g.fillStyle = '#ffffff';
        g.fillRect(x - r - 8, ey - r - 8, r * 2 + 16, r + 4); // upper lid wipes the eye
        g.beginPath(); g.moveTo(x - r, ey - 4); g.lineTo(x + r, ey - 4); g.stroke();
      }
    }
  };

  const eyeKind = state === 'blink_half' ? 'half' : state === 'blink_full' ? 'closed' : state === 'happy' ? 'happy' : state === 'panic' ? 'panic' : 'open';
  ex.forEach((x) => eye(x, eyeKind));

  if (state === 'panic') {
    g.beginPath(); g.moveTo(ex[0]! - 36, ey - 60); g.lineTo(ex[0]! + 28, ey - 48); g.stroke();
    g.beginPath(); g.moveTo(ex[1]! + 36, ey - 60); g.lineTo(ex[1]! - 28, ey - 48); g.stroke();
  }

  const mx = W / 2, my = H * 0.74;
  g.beginPath();
  if (state === 'happy') g.arc(mx, my - 24, 54, Math.PI * 0.1, Math.PI * 0.9);
  else if (state === 'panic') { g.ellipse(mx, my + 6, 26, 36, 0, 0, Math.PI * 2); g.fillStyle = '#0a0a10'; g.fill(); }
  else if (state === 'blink_half' || state === 'blink_full') { g.moveTo(mx - 34, my); g.lineTo(mx + 34, my); }
  else { g.moveTo(mx - 34, my); g.quadraticCurveTo(mx, my + 18, mx + 34, my); }
  g.stroke();

  if (glasses) {
    g.lineWidth = 10;
    ex.forEach((x) => { g.beginPath(); g.rect(x - 52, ey - 46, 104, 92); g.stroke(); });
    g.beginPath(); g.moveTo(ex[0]! + 52, ey); g.lineTo(ex[1]! - 52, ey); g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}
