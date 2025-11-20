// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';
import {
  applyOpacityUpdate,
  stepSpriteImageInterpolations,
} from '../../src/interpolation/interpolationChannels';
import type { InternalSpriteImageState } from '../../src/internalTypes';
import type { SpriteInterpolationOptions } from '../../src/types';

const createMockImageState = (opacity = 0.5): InternalSpriteImageState => ({
  subLayer: 0,
  order: 0,
  imageId: 'image',
  imageHandle: 1,
  mode: 'surface',
  opacity: {
    current: opacity,
    from: undefined,
    to: undefined,
    invalidated: false,
    interpolation: {
      state: null,
      options: null,
      targetValue: opacity,
      baseValue: opacity,
      lastCommandValue: opacity,
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
  rotateDeg: {
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
  rotationCommandDeg: 0,
  displayedRotateDeg: 0,
  autoRotation: false,
  autoRotationMinDistanceMeters: 0,
  resolvedBaseRotateDeg: 0,
  originLocation: undefined,
  originReferenceKey: 0,
  originRenderTargetIndex: 0,
  interpolationDirty: false,
});

describe('applyOpacityUpdate', () => {
  it('applies immediate clamped updates when interpolation is disabled', () => {
    const image = createMockImageState();

    applyOpacityUpdate(image, 5);

    expect(image.opacity.current).toBe(1);
    expect(image.opacity.interpolation.state).toBeNull();
    expect(image.opacity.interpolation.lastCommandValue).toBe(1);
  });

  it('interpolates opacity over time and clamps the final value', () => {
    const image = createMockImageState(0.8);

    applyOpacityUpdate(image, -4, {
      durationMs: 100,
      easing: { type: 'linear' },
    });

    expect(image.opacity.interpolation.state).not.toBeNull();

    const startTimestamp = 0;
    // First tick initializes the interpolation without completing it.
    expect(stepSpriteImageInterpolations(image, startTimestamp)).toBe(true);
    // Second tick advances past the duration, yielding the clamped final value.
    expect(stepSpriteImageInterpolations(image, startTimestamp + 200)).toBe(
      false
    );
    expect(image.opacity.current).toBe(0);
  });

  it('supports feedforward opacity interpolation without exceeding 1.0', () => {
    const image = createMockImageState(0.2);
    const options: SpriteInterpolationOptions = {
      durationMs: 100,
      easing: { type: 'linear' },
      mode: 'feedforward',
    };

    applyOpacityUpdate(image, 0.8, options);
    applyOpacityUpdate(image, 1.2, options);

    stepSpriteImageInterpolations(image, 0);
    stepSpriteImageInterpolations(image, 200);

    expect(image.opacity.current).toBe(1);
  });

  it('applies sprite opacity multiplier to targets', () => {
    const image = createMockImageState(0.4);
    applyOpacityUpdate(image, 0.6, null, 0.5);
    expect(image.opacity.current).toBe(0.3);
    expect(image.opacity.interpolation.baseValue).toBe(0.6);
    expect(image.opacity.interpolation.lastCommandValue).toBe(0.3);
  });
});
