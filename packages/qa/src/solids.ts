import type { SetDef } from '@shortstudio/schema';
import type { V3 } from './projection';

export interface Solid {
  id: string;
  min: V3;
  max: V3;
}

/** AABB of a box of size w x h x d centred at (cx, cy, cz) and rotated about y. */
function rotated(id: string, c: V3, w: number, h: number, d: number, rotY: number): Solid {
  const co = Math.abs(Math.cos(rotY));
  const si = Math.abs(Math.sin(rotY));
  const hx = (co * w) / 2 + (si * d) / 2;
  const hz = (si * w) / 2 + (co * d) / 2;
  return { id, min: [c[0] - hx, c[1] - h / 2, c[2] - hz], max: [c[0] + hx, c[1] + h / 2, c[2] + hz] };
}

/** Axis-aligned bounds of every opaque prop in a set (floors and lights are not solid). */
export function solidsOf(set: SetDef): Solid[] {
  const out: Solid[] = [];
  for (const o of set.objects) {
    if (o.kind === 'box') {
      const [x, y, z] = o.position;
      const [w, h, d] = o.size;
      out.push({ id: o.id, min: [x - w / 2, y - h / 2, z - d / 2], max: [x + w / 2, y + h / 2, z + d / 2] });
    } else if (o.kind === 'sign') {
      const [x, y, z] = o.position;
      const [w, h] = o.size;
      const c = Math.abs(Math.cos(o.rotationY));
      const s = Math.abs(Math.sin(o.rotationY));
      const hx = (c * w) / 2 + s * 0.05;
      const hz = (s * w) / 2 + c * 0.05;
      out.push({ id: o.id, min: [x - hx, y - h / 2, z - hz], max: [x + hx, y + h / 2, z + hz] });
    } else if (o.kind === 'pachinko') {
      const k = o.scale; // see engine/setKit.ts: 1.1 x 2.35 x 0.8 cabinet plus tray
      out.push(rotated(o.id, [o.position[0], o.position[1] + 1.175 * k, o.position[2]], 1.1 * k, 2.35 * k, 1.0 * k, o.rotationY));
    } else if (o.kind === 'shopcounter') {
      out.push(rotated(o.id, [o.position[0], o.position[1] + 0.565, o.position[2]], o.width + 0.2, 1.13, 0.9, o.rotationY));
    } else if (o.kind === 'exchangewindow') {
      out.push(rotated(o.id, o.position, o.size[0] + 0.8, o.size[1] + 0.8, 0.45, o.rotationY));
    } else if (o.kind === 'shelf') {
      out.push(rotated(o.id, [o.position[0], o.position[1] + o.size[1] / 2, o.position[2]], o.size[0], o.size[1], 0.45, o.rotationY));
    } else if (o.kind === 'lantern') {
      out.push(rotated(o.id, o.position, 0.7 * o.scale, 0.9 * o.scale, 0.7 * o.scale, 0));
    } else if (o.kind === 'vending') {
      out.push(rotated(o.id, [o.position[0], o.position[1] + 0.9 * o.scale, o.position[2]], 0.9 * o.scale, 1.8 * o.scale, 0.75 * o.scale, o.rotationY));
    } else if (o.kind === 'streetlight') {
      out.push(rotated(o.id, [o.position[0], o.position[1] + 2.2 * o.scale, o.position[2]], 0.2 * o.scale, 4.4 * o.scale, 0.2 * o.scale, 0));
    }
  }
  return out;
}

/** Entry parameter t in [0,1] where segment a->b first enters the box, or null if it never does. */
export function segmentEntersBox(a: V3, b: V3, box: Solid): number | null {
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = b[i]! - a[i]!;
    if (Math.abs(d) < 1e-12) {
      if (a[i]! < box.min[i]! || a[i]! > box.max[i]!) return null;
      continue;
    }
    let near = (box.min[i]! - a[i]!) / d;
    let far = (box.max[i]! - a[i]!) / d;
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return null;
  }
  return t0;
}
