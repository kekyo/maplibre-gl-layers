// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';

import { resolveEasing } from '../../src/interpolation/easing';

describe('resolveEasing', () => {
  it('falls back to linear and clamps progress', () => {
    const resolved = resolveEasing();
    expect(resolved.preset.type).toBe('linear');
    expect(resolved.easing(-1)).toBe(0);
    expect(resolved.easing(2)).toBe(1);
    expect(resolved.easing(0.25)).toBeCloseTo(0.25);
  });

  it('applies custom power for ease-in/out/in-out', () => {
    const easedIn = resolveEasing({ type: 'ease-in', power: 2 }).easing;
    expect(easedIn(0.5)).toBeCloseTo(0.25);

    const easedOut = resolveEasing({ type: 'ease-out', power: 4 }).easing;
    expect(easedOut(0.5)).toBeCloseTo(1 - 0.5 ** 4);

    const easedBoth = resolveEasing({
      type: 'ease-in-out',
      power: 2,
    }).easing;
    expect(easedBoth(0.25)).toBeCloseTo(0.125);
    expect(easedBoth(0.75)).toBeCloseTo(1 - 0.125);
  });

  it('honors exponential exponent and mode', () => {
    const expOut = resolveEasing({
      type: 'exponential',
      exponent: 2,
      mode: 'out',
    }).easing;
    const expIn = resolveEasing({
      type: 'exponential',
      exponent: 2,
      mode: 'in',
    }).easing;

    expect(expOut(0.5)).toBeGreaterThan(0.7);
    expect(expIn(0.5)).toBeLessThan(0.4);
  });

  it('supports quadratic and cubic presets with mode', () => {
    const quad = resolveEasing({ type: 'quadratic', mode: 'out' }).easing;
    const cubic = resolveEasing({ type: 'cubic', mode: 'in' }).easing;

    expect(quad(0.5)).toBeCloseTo(0.75);
    expect(cubic(0.5)).toBeCloseTo(0.125);
  });

  it('applies sine amplitude and mode', () => {
    const sineInOut = resolveEasing({
      type: 'sine',
      mode: 'in-out',
      amplitude: 0.5,
    }).easing;
    expect(sineInOut(0.5)).toBeCloseTo(0.25);
  });

  it('reflects bounce bounces/decay parameters', () => {
    const singleBounce = resolveEasing({
      type: 'bounce',
      bounces: 1,
      decay: 0.5,
    }).easing;
    const multiBounce = resolveEasing({
      type: 'bounce',
      bounces: 4,
      decay: 0.7,
    }).easing;

    const atQuarterSingle = singleBounce(0.25);
    const atQuarterMulti = multiBounce(0.25);
    expect(atQuarterSingle).toBeCloseTo(0.68, 1);
    expect(atQuarterMulti).toBeLessThan(atQuarterSingle);
  });

  it('uses overshoot parameter for back easing', () => {
    const withOvershoot = resolveEasing({
      type: 'back',
      overshoot: 2.5,
    }).easing;
    const mildOvershoot = resolveEasing({
      type: 'back',
      overshoot: 0.5,
    }).easing;

    const t = 0.8;
    const aggressive = withOvershoot(t);
    const mild = mildOvershoot(t);
    expect(aggressive).toBeGreaterThan(mild);
    expect(aggressive).toBeGreaterThan(1);
  });
});
