// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';
import {
  createDistanceInterpolationState,
  evaluateDistanceInterpolation,
} from '../../src/interpolation/distanceInterpolation';

describe('createDistanceInterpolationState', () => {
  it('reports interpolation when distance changes', () => {
    const { state, requiresInterpolation } = createDistanceInterpolationState({
      currentValue: 180,
      targetValue: 0,
      options: { durationMs: 1000 },
    });

    expect(requiresInterpolation).toBe(true);
    expect(state.from).toBe(180);
    expect(state.to).toBe(0);
    expect(state.finalValue).toBe(0);
  });

  it('performs feedforward extrapolation without wrapping', () => {
    const { state } = createDistanceInterpolationState({
      currentValue: 100,
      targetValue: 150,
      previousCommandValue: 120,
      options: { durationMs: 1000, mode: 'feedforward' },
    });

    expect(state.to).toBe(180);
    expect(state.finalValue).toBe(180);
  });

  it('disables interpolation when duration is zero', () => {
    const { requiresInterpolation } = createDistanceInterpolationState({
      currentValue: 50,
      targetValue: 20,
      options: { durationMs: 0 },
    });

    expect(requiresInterpolation).toBe(false);
  });
});

describe('evaluateDistanceInterpolation', () => {
  it('interpolates linearly toward the target distance', () => {
    const { state } = createDistanceInterpolationState({
      currentValue: 180,
      targetValue: 0,
      options: { durationMs: 1000 },
    });

    const start = evaluateDistanceInterpolation({
      state,
      timestamp: 500,
    });
    state.startTimestamp = start.effectiveStartTimestamp;

    const halfway = evaluateDistanceInterpolation({
      state,
      timestamp: state.startTimestamp + 500,
    });

    expect(halfway.completed).toBe(false);
    expect(halfway.value).toBeCloseTo(90);

    const end = evaluateDistanceInterpolation({
      state,
      timestamp: state.startTimestamp + 1500,
    });

    expect(end.completed).toBe(true);
    expect(end.value).toBe(0);
  });
});
