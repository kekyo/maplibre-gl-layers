// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';
import {
  normalizeAngleDeg,
  resolveRotationTarget,
} from '../src/interpolation/rotationInterpolation';

describe('normalizeAngleDeg', () => {
  it('wraps negative angles into [0, 360)', () => {
    expect(normalizeAngleDeg(-30)).toBeCloseTo(330);
    expect(normalizeAngleDeg(-720)).toBe(0);
  });

  it('wraps angles greater than 360 into [0, 360)', () => {
    expect(normalizeAngleDeg(450)).toBeCloseTo(90);
    expect(normalizeAngleDeg(720)).toBe(0);
  });
});

describe('resolveRotationTarget', () => {
  it('returns immediate target when options are absent', () => {
    const result = resolveRotationTarget({
      currentAngleDeg: 10,
      targetAngleDeg: 350,
      options: undefined,
    });

    expect(result.nextAngleDeg).toBeCloseTo(350);
    expect(result.interpolationState).toBeNull();
  });

  it('returns immediate target when interpolation duration is zero', () => {
    const result = resolveRotationTarget({
      currentAngleDeg: 45,
      targetAngleDeg: 90,
      options: { durationMs: 0 },
    });

    expect(result.nextAngleDeg).toBeCloseTo(90);
    expect(result.interpolationState).toBeNull();
  });

  it('creates interpolation state when duration is positive and delta is non-zero', () => {
    const result = resolveRotationTarget({
      currentAngleDeg: 0,
      targetAngleDeg: 270,
      options: { durationMs: 1000 },
    });

    expect(result.nextAngleDeg).toBeCloseTo(0);
    const state = result.interpolationState;
    expect(state).not.toBeNull();
    expect(state?.from).toBeCloseTo(0);
    // Shortest path should be -90 degrees => to == -90 (normalized via numeric interpolation as 270 relative)
    expect(state?.to).toBeCloseTo(-90);
    expect(state?.finalValue).toBeCloseTo(270);
  });

  it('normalizes target angle and reuses shortest path interpolation', () => {
    const result = resolveRotationTarget({
      currentAngleDeg: 350,
      targetAngleDeg: 10,
      options: { durationMs: 500 },
    });

    expect(result.nextAngleDeg).toBeCloseTo(350);
    const state = result.interpolationState;
    expect(state).not.toBeNull();
    expect(state?.from).toBeCloseTo(350);
    expect(state?.to).toBeCloseTo(370);
    expect(state?.finalValue).toBeCloseTo(10);
  });
});
