// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';
import {
  createInterpolationState,
  evaluateInterpolation,
} from '../../src/interpolation/interpolation';
import { linearEasing } from '../../src/interpolation/easing';
import {
  cloneSpriteLocation,
  lerpSpriteLocation,
  spriteLocationsEqual,
} from '../../src/utils/math';

describe('createInterpolationState', () => {
  it('creates feedback interpolation state when locations differ', () => {
    const current = { lng: 0, lat: 0 };
    const next = { lng: 10, lat: 20 };
    const { state, requiresInterpolation } = createInterpolationState({
      currentLocation: current,
      lastCommandLocation: cloneSpriteLocation(current),
      nextCommandLocation: next,
      options: { durationMs: 1000, mode: 'feedback' },
    });

    expect(state.mode).toBe('feedback');
    expect(state.durationMs).toBe(1000);
    expect(requiresInterpolation).toBe(true);
    expect(spriteLocationsEqual(state.from, current)).toBe(true);
    expect(spriteLocationsEqual(state.to, next)).toBe(true);
    expect(state.from).not.toBe(current);
    expect(state.to).not.toBe(next);
    expect(state.easingFunc).toBe(linearEasing);
    expect(state.easingParam.type).toBe('linear');
  });

  it('predicts feedforward target based on velocity', () => {
    const previous = { lng: 1, lat: 1, z: 5 };
    const next = { lng: 2, lat: 3, z: 7 };
    const { state, requiresInterpolation } = createInterpolationState({
      currentLocation: { lng: 1.5, lat: 2 },
      lastCommandLocation: previous,
      nextCommandLocation: next,
      options: { durationMs: 500, mode: 'feedforward' },
    });

    expect(state.mode).toBe('feedforward');
    expect(requiresInterpolation).toBe(true);
    expect(spriteLocationsEqual(state.from, { lng: 1.5, lat: 2 })).toBe(true);
    expect(state.pathTarget?.lng).toBeCloseTo(3);
    expect(state.pathTarget?.lat).toBeCloseTo(5);
    expect(state.pathTarget?.z).toBeCloseTo(9);
    expect(state.to.lng).toBeCloseTo(next.lng);
    expect(state.to.lat).toBeCloseTo(next.lat);
    expect(state.to.z).toBeCloseTo(next.z);
  });

  it('falls back to next location if feedforward lacks history', () => {
    const next = { lng: 4, lat: -2 };
    const { state, requiresInterpolation } = createInterpolationState({
      currentLocation: { lng: 0, lat: 0 },
      lastCommandLocation: undefined,
      nextCommandLocation: next,
      options: { durationMs: 1000, mode: 'feedforward' },
    });

    expect(requiresInterpolation).toBe(true);
    expect(spriteLocationsEqual(state.to, next)).toBe(true);
  });

  it('uses the requested easing preset', () => {
    const { state } = createInterpolationState({
      currentLocation: { lng: 0, lat: 0 },
      nextCommandLocation: { lng: 1, lat: 1 },
      options: { durationMs: 1000, easing: { type: 'linear' } },
    });

    expect(state.easingFunc).toBe(linearEasing);
    expect(state.easingParam.type).toBe('linear');
  });

  it('marks interpolation as unnecessary when duration is zero', () => {
    const { requiresInterpolation, state } = createInterpolationState({
      currentLocation: { lng: 1, lat: 1 },
      nextCommandLocation: { lng: 2, lat: 2 },
      options: { durationMs: 0, mode: 'feedback' },
    });

    expect(requiresInterpolation).toBe(false);
    expect(state.durationMs).toBe(0);
  });

  it('marks interpolation as unnecessary when positions match', () => {
    const location = { lng: 5, lat: -4 };
    const { requiresInterpolation } = createInterpolationState({
      currentLocation: location,
      nextCommandLocation: cloneSpriteLocation(location),
      options: { durationMs: 800, mode: 'feedback' },
    });

    expect(requiresInterpolation).toBe(false);
  });
});

describe('evaluateInterpolation', () => {
  it('returns immediate completion when duration is zero', () => {
    const { state } = createInterpolationState({
      currentLocation: { lng: 0, lat: 0 },
      nextCommandLocation: { lng: 1, lat: 1 },
      options: { durationMs: 0 },
    });

    const result = evaluateInterpolation({
      state,
      timestamp: 1000,
    });

    expect(result.completed).toBe(true);
    expect(spriteLocationsEqual(result.location, state.to)).toBe(true);
  });

  it('interpolates linearly over time', () => {
    const { state } = createInterpolationState({
      currentLocation: { lng: 0, lat: 0 },
      nextCommandLocation: { lng: 10, lat: 20 },
      options: { durationMs: 1000 },
    });

    const startTimestamp = 500;
    const halfway = evaluateInterpolation({
      state,
      timestamp: startTimestamp,
    });
    state.startTimestamp = halfway.effectiveStartTimestamp;

    const midResult = evaluateInterpolation({
      state,
      timestamp: startTimestamp + 500,
    });

    expect(midResult.completed).toBe(false);
    const target = state.pathTarget ?? state.to;
    expect(
      spriteLocationsEqual(
        midResult.location,
        lerpSpriteLocation(state.from, target, 0.5)
      )
    ).toBe(true);

    const finalResult = evaluateInterpolation({
      state,
      timestamp: startTimestamp + 1500,
    });

    expect(finalResult.completed).toBe(true);
    expect(spriteLocationsEqual(finalResult.location, state.to)).toBe(true);
  });

  it('caps easing progress when timestamp goes backwards', () => {
    const { state } = createInterpolationState({
      currentLocation: { lng: 0, lat: 0 },
      nextCommandLocation: { lng: 10, lat: 0 },
      options: { durationMs: 1000 },
    });

    const forward = evaluateInterpolation({
      state,
      timestamp: 1000,
    });

    state.startTimestamp = forward.effectiveStartTimestamp;
    const backwards = evaluateInterpolation({
      state,
      timestamp: state.startTimestamp - 250,
    });

    expect(backwards.completed).toBe(false);
    expect(backwards.location.lng).toBeCloseTo(0);
  });
});
