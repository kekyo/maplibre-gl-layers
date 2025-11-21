// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';
import type { InternalSpriteImageState } from '../../src/internalTypes';
import {
  SPRITE_ORIGIN_REFERENCE_KEY_NONE,
  SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
} from '../../src/internalTypes';
import {
  applyOffsetUpdate,
  clearOffsetDegInterpolation,
  clearOffsetMetersInterpolation,
  stepSpriteImageInterpolations,
} from '../../src/interpolation/interpolationChannels';

const createImageState = (): InternalSpriteImageState => ({
  subLayer: 0,
  order: 0,
  imageId: 'test',
  imageHandle: 0,
  mode: 'surface',
  rotateDeg: 0,
  opacity: 1,
  finalOpacity: {
    current: 1,
    from: undefined,
    to: undefined,
    invalidated: false,
    interpolation: {
      state: null,
      options: null,
      targetValue: 1,
      baseValue: 1,
      lastCommandValue: 1,
    },
  },
  lodOpacity: 1,
  scale: 1,
  anchor: { x: 0, y: 0 },
  border: undefined,
  borderPixelWidth: 0,
  leaderLine: undefined,
  leaderLinePixelWidth: 0,
  offset: {
    offsetMeters: {
      current: 0,
      from: undefined,
      to: undefined,
      invalidated: false,
      interpolation: {
        state: null,
        options: null,
        lastCommandValue: 0,
        baseValue: undefined,
        targetValue: undefined,
      },
    },
    offsetDeg: {
      current: 0,
      from: undefined,
      to: undefined,
      invalidated: false,
      interpolation: {
        state: null,
        options: null,
        lastCommandValue: 0,
        baseValue: undefined,
        targetValue: undefined,
      },
    },
  },
  finalRotateDeg: {
    current: 0,
    from: undefined,
    to: undefined,
    invalidated: false,
    interpolation: {
      state: null,
      options: null,
      lastCommandValue: 0,
      baseValue: undefined,
      targetValue: undefined,
    },
  },
  autoRotation: false,
  autoRotationMinDistanceMeters: 0,
  originReferenceKey: SPRITE_ORIGIN_REFERENCE_KEY_NONE,
  originRenderTargetIndex: SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
  originLocation: undefined,
  interpolationDirty: false,
  surfaceShaderInputs: undefined,
  hitTestCorners: undefined,
});

describe('applyOffsetUpdate', () => {
  it('applies offsets immediately when no interpolation requested', () => {
    const state = createImageState();

    applyOffsetUpdate(
      state,
      { offsetDeg: 45, offsetMeters: 12 },
      { deg: null, meters: null }
    );

    expect(state.offset.offsetDeg.current).toBe(45);
    expect(state.offset.offsetMeters.current).toBe(12);
    expect(state.offset.offsetDeg.interpolation.state).toBeNull();
    expect(state.offset.offsetMeters.interpolation.state).toBeNull();
    expect(state.offset.offsetDeg.interpolation.lastCommandValue).toBe(45);
    expect(state.offset.offsetMeters.interpolation.lastCommandValue).toBe(12);
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

    expect(state.offset.offsetDeg.interpolation.state).not.toBeNull();
    expect(state.offset.offsetMeters.interpolation.state).not.toBeNull();
    expect(state.offset.offsetDeg.current).toBe(0);
    expect(state.offset.offsetMeters.current).toBe(0);

    const firstStepActive = stepSpriteImageInterpolations(state, 0);
    expect(firstStepActive).toBe(true);

    const midStepActive = stepSpriteImageInterpolations(state, 500);
    expect(midStepActive).toBe(true);
    expect(state.offset.offsetDeg.current).toBeCloseTo(45, 5);
    expect(state.offset.offsetMeters.current).toBeCloseTo(10, 5);

    const finalStepActive = stepSpriteImageInterpolations(state, 2000);
    expect(finalStepActive).toBe(false);
    expect(state.offset.offsetDeg.current).toBeCloseTo(90, 5);
    expect(state.offset.offsetMeters.current).toBeCloseTo(20, 5);
    expect(state.offset.offsetDeg.interpolation.state).toBeNull();
    expect(state.offset.offsetMeters.interpolation.state).toBeNull();
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

    expect(state.offset.offsetDeg.interpolation.state).not.toBeNull();
    expect(state.offset.offsetMeters.interpolation.state).not.toBeNull();

    clearOffsetDegInterpolation(state);
    clearOffsetMetersInterpolation(state);

    expect(state.offset.offsetDeg.interpolation.state).toBeNull();
    expect(state.offset.offsetMeters.interpolation.state).toBeNull();
  });
});
