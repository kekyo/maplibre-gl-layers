// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';
import {
  createNumericInterpolationState,
  evaluateNumericInterpolation,
} from '../src/numericInterpolation';

describe('createNumericInterpolationState', () => {
  it('requires interpolation for non-zero angular delta', () => {
    const { state, requiresInterpolation } = createNumericInterpolationState({
      currentValue: 0,
      targetValue: 90,
      options: { durationMs: 1000 },
    });

    expect(requiresInterpolation).toBe(true);
    expect(state.from).toBe(0);
    expect(state.to).toBe(90);
    expect(state.finalValue).toBe(90);
  });

  it('uses shortest path for large positive delta', () => {
    const { state, requiresInterpolation } = createNumericInterpolationState({
      currentValue: 0,
      targetValue: 270,
      options: { durationMs: 1000 },
    });

    expect(requiresInterpolation).toBe(true);
    expect(state.to).toBeCloseTo(-90);
    expect(state.finalValue).toBe(270);
  });

  it('keeps forward rotation when delta is small positive even if exceeding 360', () => {
    const { state, requiresInterpolation } = createNumericInterpolationState({
      currentValue: 359,
      targetValue: 375,
      options: { durationMs: 1000 },
    });

    expect(requiresInterpolation).toBe(true);
    expect(state.from).toBe(359);
    expect(state.to).toBeCloseTo(375);
    expect(state.finalValue).toBe(375);
  });
});

describe('evaluateNumericInterpolation', () => {
  it('interpolates along the shortest path and snaps to final value at completion', () => {
    const { state } = createNumericInterpolationState({
      currentValue: 0,
      targetValue: 270,
      options: { durationMs: 1000 },
    });

    const start = evaluateNumericInterpolation({
      state,
      timestamp: 500,
    });
    state.startTimestamp = start.effectiveStartTimestamp;

    const midway = evaluateNumericInterpolation({
      state,
      timestamp: state.startTimestamp + 500,
    });

    expect(midway.completed).toBe(false);
    expect(midway.value).toBeCloseTo(-45);

    const end = evaluateNumericInterpolation({
      state,
      timestamp: state.startTimestamp + 1500,
    });

    expect(end.completed).toBe(true);
    expect(end.value).toBe(270);
  });

  it('returns final value immediately when duration is zero or delta is negligible', () => {
    const { state } = createNumericInterpolationState({
      currentValue: 0,
      targetValue: 360,
      options: { durationMs: 0 },
    });

    const result = evaluateNumericInterpolation({
      state,
      timestamp: 0,
    });

    expect(result.completed).toBe(true);
    expect(result.value).toBe(360);
  });
});
