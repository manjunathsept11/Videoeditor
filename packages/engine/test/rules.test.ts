import { describe, expect, it } from 'vitest';
import {
  FRAME, cameraCreepScale, dissolveAlpha, faceStateAt, gestureLandTime, gestureWeight,
  headLagWeight, maxDriftPerFrame, springOvershoot, springValue, toFrame,
} from '../src/rules';

describe('rule 2: gestures pre-land before the word', () => {
  const word = 1.24;
  it('lands 4 frames before the word', () => {
    expect(gestureLandTime(word)).toBeCloseTo(word - 4 * FRAME, 9);
  });
  it('is fully extended on the landing frame and at the word', () => {
    expect(gestureWeight(gestureLandTime(word), word)).toBeCloseTo(1, 9);
    expect(gestureWeight(word, word)).toBeCloseTo(1, 9);
  });
  it('is still at rest before the 5-frame rise starts', () => {
    expect(gestureWeight(gestureLandTime(word) - 5 * FRAME, word)).toBe(0);
    expect(gestureWeight(0, word)).toBe(0);
  });
  it('returns to rest after the hold', () => {
    expect(gestureWeight(word + 5, word)).toBe(0);
  });
  it('head trails the hand by 3 frames', () => {
    const land = gestureLandTime(word);
    expect(headLagWeight(land, word)).toBeLessThan(1);
    expect(headLagWeight(land + 3 * FRAME, word)).toBeCloseTo(1, 9);
  });
});

describe('rule 3: two-frame blink then snap', () => {
  const cues = [{ at: 2, expression: 'panic' as const }];
  const f = (frame: number) => faceStateAt(cues, frame * FRAME);
  it('runs neutral -> half -> full -> new expression', () => {
    const e = toFrame(2);
    expect(f(e - 3)).toBe('neutral');
    expect(f(e - 2)).toBe('blink_half');
    expect(f(e - 1)).toBe('blink_full');
    expect(f(e)).toBe('panic');
    expect(f(e + 10)).toBe('panic');
  });
});

describe('rule 4: camera creep', () => {
  it('is 5%/sec, linear, never negative', () => {
    expect(cameraCreepScale(0)).toBe(1);
    expect(cameraCreepScale(2)).toBeCloseTo(1.1, 9);
    expect(cameraCreepScale(-1)).toBe(1);
  });
});

describe('rule 5: dissolves', () => {
  it('last exactly 6 frames centred on the cut', () => {
    const cut = 3;
    expect(dissolveAlpha(cut - 3 * FRAME, cut)).toBeCloseTo(0, 9);
    expect(dissolveAlpha(cut, cut)).toBeCloseTo(0.5, 9);
    expect(dissolveAlpha(cut + 3 * FRAME, cut)).toBeCloseTo(1, 9);
  });
});

describe('rule 6: springs', () => {
  it('overshoots ~10% at zeta 0.59 and settles on target', () => {
    expect(springOvershoot(0.59)).toBeCloseTo(0.1, 1);
    let peak = 0;
    for (let t = 0; t < 2; t += 0.001) peak = Math.max(peak, springValue(t, 0, 0, 1));
    expect(peak).toBeGreaterThan(1.08);
    expect(peak).toBeLessThan(1.12);
    expect(springValue(5, 0, 0, 1)).toBeCloseTo(1, 6);
  });
  it('is a pure function of t', () => {
    expect(springValue(0.37, 0, 3, 9)).toBe(springValue(0.37, 0, 3, 9));
  });
});

describe('rule 1: holds', () => {
  it('reports max per-frame drift', () => {
    expect(maxDriftPerFrame([[0, 0], [0.3, 0.4], [0.3, 0.4]])).toBeCloseTo(0.5, 9);
  });
});
