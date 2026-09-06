/**
 * The statistics in analyze.ts, against values you can check by hand.
 *
 *   bun test verification_bench/analyze.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { mcnemarExact, wilson, pairedBootstrap } from './analyze';

describe('McNemar exact', () => {
  test('no discordant pairs is no evidence', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  test('all discordance in one direction is a coin-flip tail', () => {
    // 2 * P(X = 0 | n = 4, p = 0.5) = 2 * 1/16
    expect(mcnemarExact(0, 4)).toBeCloseTo(0.125, 10);
    // 2 * P(X = 0 | n = 10)
    expect(mcnemarExact(0, 10)).toBeCloseTo(2 * 0.5 ** 10, 10);
    // 2 * P(X <= 1 | n = 10) = 2 * (1 + 10) / 1024
    expect(mcnemarExact(1, 9)).toBeCloseTo((2 * 11) / 1024, 10);
  });

  test('an even split is maximally unsurprising', () => {
    expect(mcnemarExact(5, 5)).toBe(1);
    expect(mcnemarExact(20, 20)).toBe(1);
  });

  test('direction does not change the two-sided p', () => {
    expect(mcnemarExact(3, 12)).toBeCloseTo(mcnemarExact(12, 3), 12);
  });

  test('20 gains and no losses is decisive', () => {
    expect(mcnemarExact(0, 20)).toBeLessThan(1e-5);
  });
});

describe('Wilson interval', () => {
  test('brackets the point estimate', () => {
    const [lo, hi] = wilson(50, 100);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
    expect(lo).toBeCloseTo(0.4038, 3);
    expect(hi).toBeCloseTo(0.5962, 3);
  });

  test('stays inside [0,1] at the extremes — the reason it is not a normal approximation', () => {
    const [lo0, hi0] = wilson(0, 10);
    expect(lo0).toBe(0);
    expect(hi0).toBeGreaterThan(0);
    expect(hi0).toBeLessThan(1);
    const [lo1, hi1] = wilson(10, 10);
    expect(hi1).toBe(1);
    expect(lo1).toBeLessThan(1);
    expect(lo1).toBeGreaterThan(0);
  });

  test('narrows as n grows', () => {
    const w = (n: number) => { const [lo, hi] = wilson(n / 2, n); return hi - lo; };
    expect(w(1000)).toBeLessThan(w(100));
    expect(w(100)).toBeLessThan(w(10));
  });

  test('an empty stratum reports nothing rather than throwing', () => {
    expect(wilson(0, 0)).toEqual([0, 0]);
  });
});

describe('paired bootstrap', () => {
  test('identical arms give an interval containing zero', () => {
    const a = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    const [lo, hi] = pairedBootstrap(a, a);
    expect(lo).toBe(0);
    expect(hi).toBe(0);
  });

  test('a uniform improvement gives an interval at the improvement', () => {
    const a = Array(40).fill(0);
    const b = Array(40).fill(1);
    const [lo, hi] = pairedBootstrap(a, b);
    expect(lo).toBe(1);
    expect(hi).toBe(1);
  });

  test('brackets the observed difference', () => {
    const a = Array.from({ length: 100 }, (_, i) => (i < 70 ? 1 : 0));
    const b = Array.from({ length: 100 }, (_, i) => (i < 85 ? 1 : 0));
    const [lo, hi] = pairedBootstrap(a, b);
    expect(lo).toBeLessThanOrEqual(0.15);
    expect(hi).toBeGreaterThanOrEqual(0.15);
    expect(lo).toBeGreaterThan(0); // 15pp on 100 paired questions is not noise
  });

  test('deterministic — same input, same interval', () => {
    const a = Array.from({ length: 50 }, (_, i) => i % 2);
    const b = Array.from({ length: 50 }, (_, i) => (i % 3 ? 1 : 0));
    expect(pairedBootstrap(a, b)).toEqual(pairedBootstrap(a, b));
  });

  test('no questions is not an error', () => {
    expect(pairedBootstrap([], [])).toEqual([0, 0]);
  });
});
