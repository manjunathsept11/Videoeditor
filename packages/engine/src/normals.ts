import * as THREE from 'three';

const healthy = (x: number, y: number, z: number) => {
  const len = Math.hypot(x, y, z);
  return Number.isFinite(len) && len >= 1e-6;
};

/** Indices of vertices whose normal is missing, non-finite or zero-length. Those render as black smears once lit or bloomed. */
function brokenVertices(geo: THREE.BufferGeometry): number[] {
  const pos = geo.getAttribute('position');
  if (!pos) return [];
  const n = geo.getAttribute('normal');
  const out: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    if (!n || !healthy(n.getX(i), n.getY(i), n.getZ(i))) out.push(i);
  }
  return out;
}

export const brokenNormalCount = (geo: THREE.BufferGeometry): number => brokenVertices(geo).length;

/**
 * Fix only the broken vertices, leaving authored normals (hard edges, smooth shading) alone.
 * Broken vertices take a normal recomputed from their faces; where the faces are degenerate
 * (sphere poles) they fall back to pointing away from the geometry's centre.
 * Returns true when anything was repaired.
 */
export function repairNormals(geo: THREE.BufferGeometry): boolean {
  const broken = brokenVertices(geo);
  if (broken.length === 0) return false;

  const pos = geo.getAttribute('position');
  const old = geo.getAttribute('normal');
  const fresh = geo.clone();
  fresh.deleteAttribute('normal');
  fresh.computeVertexNormals();
  const fn = fresh.getAttribute('normal');

  geo.computeBoundingBox();
  const c = geo.boundingBox!.getCenter(new THREE.Vector3());

  const out = new Float32Array(pos.count * 3);
  const bad = new Set(broken);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    if (!bad.has(i) && old) v.set(old.getX(i), old.getY(i), old.getZ(i));
    else if (healthy(fn.getX(i), fn.getY(i), fn.getZ(i))) v.set(fn.getX(i), fn.getY(i), fn.getZ(i));
    else {
      v.set(pos.getX(i) - c.x, pos.getY(i) - c.y, pos.getZ(i) - c.z);
      if (v.lengthSq() < 1e-12) v.set(0, 1, 0);
    }
    v.normalize();
    out.set([v.x, v.y, v.z], i * 3);
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  fresh.dispose();
  return true;
}

/** Normal-repair pass over a whole scene, before any rendering. Returns the number of geometries repaired. */
export function repairSceneNormals(root: THREE.Object3D): number {
  const seen = new Set<THREE.BufferGeometry>();
  let repaired = 0;
  root.traverse((o) => {
    const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (geo && !seen.has(geo)) {
      seen.add(geo);
      if (repairNormals(geo)) repaired++;
    }
  });
  return repaired;
}
