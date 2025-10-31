// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';
import type { InternalSpriteImageState } from '../src/internalTypes';
import {
  applyOffsetUpdate,
  clearOffsetDegInterpolation,
  clearOffsetMetersInterpolation,
  stepSpriteImageInterpolations,
} from '../src/interpolationChannels';

const createImageState = (): InternalSpriteImageState => ({
  subLayer: 0,
  order: 0,
  imageId: 'test',
  mode: 'surface',
  opacity: 1,
  scale: 1,
  anchor: { x: 0, y: 0 },
  offset: { offsetMeters: 0, offsetDeg: 0 },
  rotateDeg: 0,
  displayedRotateDeg: 0,
  autoRotation: false,
  autoRotationMinDistanceMeters: 0,
  resolvedBaseRotateDeg: 0,
  rotationInterpolationState: null,
  rotationInterpolationOptions: null,
  offsetDegInterpolationState: null,
  offsetMetersInterpolationState: null,
  originLocation: undefined,
  lastCommandRotateDeg: 0,
  lastCommandOffsetDeg: 0,
  lastCommandOffsetMeters: 0,
});

describe('applyOffsetUpdate', () => {
  it('applies offsets immediately when no interpolation requested', () => {
    const state = createImageState();

    applyOffsetUpdate(
      state,
      { offsetDeg: 45, offsetMeters: 12 },
      { deg: null, meters: null }
    );

    expect(state.offset.offsetDeg).toBe(45);
    expect(state.offset.offsetMeters).toBe(12);
    expect(state.offsetDegInterpolationState).toBeNull();
    expect(state.offsetMetersInterpolationState).toBeNull();
    expect(state.lastCommandOffsetDeg).toBe(45);
    expect(state.lastCommandOffsetMeters).toBe(12);
  });

  it('creates interpolation state for both angle and distance channels', () => {
    const state = createImageState();

    applyOffsetUpdate(
      state,
      { offsetDeg: 90, offsetMeters: 20 },
      {
        deg: { durationMs: 1000 },
        meters: { durationMs: 1000 },
      }
    );

    expect(state.offsetDegInterpolationState).not.toBeNull();
    expect(state.offsetMetersInterpolationState).not.toBeNull();
    expect(state.offset.offsetDeg).toBe(0);
    expect(state.offset.offsetMeters).toBe(0);

    const firstStepActive = stepSpriteImageInterpolations(state, 0);
    expect(firstStepActive).toBe(true);

    const midStepActive = stepSpriteImageInterpolations(state, 500);
    expect(midStepActive).toBe(true);
    expect(state.offset.offsetDeg).toBeCloseTo(45, 5);
    expect(state.offset.offsetMeters).toBeCloseTo(10, 5);

    const finalStepActive = stepSpriteImageInterpolations(state, 2000);
    expect(finalStepActive).toBe(false);
    expect(state.offset.offsetDeg).toBeCloseTo(90, 5);
    expect(state.offset.offsetMeters).toBeCloseTo(20, 5);
    expect(state.offsetDegInterpolationState).toBeNull();
    expect(state.offsetMetersInterpolationState).toBeNull();
  });

  it('clears interpolation state explicitly', () => {
    const state = createImageState();

    applyOffsetUpdate(
      state,
      { offsetDeg: 30, offsetMeters: 5 },
      {
        deg: { durationMs: 1000 },
        meters: { durationMs: 1000 },
      }
    );

    expect(state.offsetDegInterpolationState).not.toBeNull();
    expect(state.offsetMetersInterpolationState).not.toBeNull();

    clearOffsetDegInterpolation(state);
    clearOffsetMetersInterpolation(state);

    expect(state.offsetDegInterpolationState).toBeNull();
    expect(state.offsetMetersInterpolationState).toBeNull();
  });
});
