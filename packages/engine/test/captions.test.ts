import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Alignment } from '@shortstudio/schema';
import { buildCaptionLines, captionAt } from '../src/captions';
import { brokenNormalCount, repairNormals, repairSceneNormals } from '../src/normals';

const al = (words: [string, number, number][]) => Alignment.parse({ words: words.map(([text, start, end]) => ({ text, start, end })) });

describe('buildCaptionLines', () => {
  const a = al([
    ['Japan', 0.1, 0.5], ['bans', 0.5, 0.9], ['gambling.', 0.9, 1.5],
    ['But', 1.7, 1.9], ['the', 1.9, 2.0], ['prize', 2.0, 2.4], ['counter', 2.4, 2.9], ['makes', 3.0, 3.3],
    ['it', 3.3, 3.4], ['legal', 5.0, 5.4],
  ]);
  const lines = buildCaptionLines(a);
  it('breaks on sentence ends, word count and long pauses', () => {
    expect(lines.map((l) => l.text)).toEqual(['Japan bans gambling.', 'But the prize', 'counter makes it', 'legal']);
  });
  it('never overlaps lines and holds briefly after the last word', () => {
    for (let i = 0; i + 1 < lines.length; i++) expect(lines[i]!.end).toBeLessThanOrEqual(lines[i + 1]!.start);
    expect(lines[0]!.end).toBeCloseTo(1.5 + 0.15, 9);
    expect(lines.at(-1)!.end).toBeCloseTo(5.4 + 0.15, 9);
  });
  it('respects maxChars and maxWords options', () => {
    expect(buildCaptionLines(a, { maxWords: 2 })[0]!.text).toBe('Japan bans');
    expect(buildCaptionLines(al([['internationalization', 0, 1], ['standardization', 1, 2]]), { maxChars: 22 }).map((l) => l.text)).toEqual(['internationalization', 'standardization']);
  });
});

describe('captionAt', () => {
  const lines = buildCaptionLines(al([['one', 0, 0.4], ['two', 0.4, 0.8], ['three', 0.8, 1.2]]));
  it('returns the active line and the word being spoken', () => {
    expect(captionAt(lines, 0.1)).toMatchObject({ word: 0 });
    expect(captionAt(lines, 0.5)).toMatchObject({ word: 1 });
    expect(captionAt(lines, 1.0)).toMatchObject({ word: 2 });
  });
  it('is null before the first word and after the last line', () => {
    expect(captionAt(lines, -1)).toBeNull();
    expect(captionAt(lines, 2.0)).toBeNull();
  });
});

describe('normal repair (black-smear guard)', () => {
  const corrupt = () => {
    const g = new THREE.SphereGeometry(1, 8, 6);
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    n.setXYZ(3, NaN, 0, 0);
    n.setXYZ(5, 0, 0, 0);
    return g;
  };
  it('detects and repairs NaN and zero normals', () => {
    const g = corrupt();
    expect(brokenNormalCount(g)).toBe(2);
    expect(repairNormals(g)).toBe(true);
    expect(brokenNormalCount(g)).toBe(0);
  });
  it('keeps healthy authored normals exactly as they were', () => {
    const g = corrupt();
    const n = g.getAttribute('normal');
    const before = [n.getX(10), n.getY(10), n.getZ(10)];
    repairNormals(g);
    const after = g.getAttribute('normal');
    expect([after.getX(10), after.getY(10), after.getZ(10)]).toEqual(before);
  });
  it('gives repaired vertices unit-length normals pointing outward', () => {
    const g = corrupt();
    repairNormals(g);
    const n = g.getAttribute('normal');
    const p = g.getAttribute('position');
    for (const i of [3, 5]) {
      expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 6);
      expect(n.getX(i) * p.getX(i) + n.getY(i) * p.getY(i) + n.getZ(i) * p.getZ(i)).toBeGreaterThan(0.5);
    }
  });
  it('leaves healthy geometry alone', () => {
    expect(repairNormals(new THREE.BoxGeometry(1, 1, 1))).toBe(false);
  });
  it('repairs a geometry once even when shared by many meshes', () => {
    const g = corrupt();
    const root = new THREE.Group();
    for (let i = 0; i < 3; i++) root.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
    expect(repairSceneNormals(root)).toBe(1);
    expect(repairSceneNormals(root)).toBe(0);
  });
});
