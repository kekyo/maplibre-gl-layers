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
    expect(resolved.param.type).toBe('linear');
    expect(resolved.func(-1)).toBe(0);
    expect(resolved.func(2)).toBe(1);
    expect(resolved.func(0.25)).toBeCloseTo(0.25);
  });

  it('applies custom power and mode for ease', () => {
    const easedIn = resolveEasing({
      type: 'ease',
      mode: 'in',
      power: 2,
    }).func;
    expect(easedIn(0.5)).toBeCloseTo(0.25);

    const easedOut = resolveEasing({
      type: 'ease',
      mode: 'out',
      power: 4,
    }).func;
    expect(easedOut(0.5)).toBeCloseTo(1 - 0.5 ** 4);

    const easedBoth = resolveEasing({
      type: 'ease',
      power: 2,
    }).func;
    expect(easedBoth(0.25)).toBeCloseTo(0.125);
    expect(easedBoth(0.75)).toBeCloseTo(1 - 0.125);
  });

  it('honors exponential exponent and mode', () => {
    const expOut = resolveEasing({
      type: 'exponential',
      exponent: 2,
      mode: 'out',
    }).func;
    const expIn = resolveEasing({
      type: 'exponential',
      exponent: 2,
      mode: 'in',
    }).func;

    expect(expOut(0.5)).toBeGreaterThan(0.7);
    expect(expIn(0.5)).toBeLessThan(0.4);
  });

  it('supports quadratic and cubic presets with mode', () => {
    const quad = resolveEasing({ type: 'quadratic', mode: 'out' }).func;
    const cubic = resolveEasing({ type: 'cubic', mode: 'in' }).func;

    expect(quad(0.5)).toBeCloseTo(0.75);
    expect(cubic(0.5)).toBeCloseTo(0.125);
  });

  it('applies sine amplitude and mode', () => {
    const sineInOut = resolveEasing({
      type: 'sine',
      mode: 'in-out',
      amplitude: 0.5,
    }).func;
    expect(sineInOut(0.5)).toBeCloseTo(0.25);
  });

  it('reflects bounce bounces/decay parameters', () => {
    const singleBounce = resolveEasing({
      type: 'bounce',
      bounces: 1,
      decay: 0.5,
    }).func;
    const multiBounce = resolveEasing({
      type: 'bounce',
      bounces: 4,
      decay: 0.7,
    }).func;

    const atQuarterSingle = singleBounce(0.25);
    const atQuarterMulti = multiBounce(0.25);
    expect(atQuarterSingle).toBeCloseTo(0.68, 1);
    expect(atQuarterMulti).toBeLessThan(atQuarterSingle);
  });

  it('uses overshoot parameter for back func', () => {
    const withOvershoot = resolveEasing({
      type: 'back',
      overshoot: 2.5,
    }).func;
    const mildOvershoot = resolveEasing({
      type: 'back',
      overshoot: 0.5,
    }).func;

    const t = 0.8;
    const aggressive = withOvershoot(t);
    const mild = mildOvershoot(t);
    expect(aggressive).toBeGreaterThan(mild);
    expect(aggressive).toBeGreaterThan(1);
  });
});
