import type { SetDef } from '@shortstudio/schema';
import type { V3 } from './projection';

export interface Solid {
  id: string;
  min: V3;
  max: V3;
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
