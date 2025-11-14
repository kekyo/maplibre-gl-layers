// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';
import {
  applyOpacityUpdate,
  stepSpriteImageInterpolations,
} from '../src/interpolation/interpolationChannels';
import type { InternalSpriteImageState } from '../src/internalTypes';
import type { SpriteInterpolationOptions } from '../src/types';

const createMockImageState = (opacity = 0.5): InternalSpriteImageState => ({
  subLayer: 0,
  order: 0,
  imageId: 'image',
  imageHandle: 1,
  mode: 'surface',
  opacity,
  scale: 1,
  anchor: { x: 0, y: 0 },
  offset: { offsetMeters: 0, offsetDeg: 0 },
  rotateDeg: 0,
  displayedRotateDeg: 0,
  autoRotation: false,
  autoRotationMinDistanceMeters: 0,
  resolvedBaseRotateDeg: 0,
  originLocation: undefined,
  originReferenceKey: 0,
  originRenderTargetIndex: 0,
  rotationInterpolationState: null,
  rotationInterpolationOptions: null,
  offsetDegInterpolationState: null,
  offsetMetersInterpolationState: null,
  opacityInterpolationState: null,
  lastCommandRotateDeg: 0,
  lastCommandOffsetDeg: 0,
  lastCommandOffsetMeters: 0,
  lastCommandOpacity: opacity,
  interpolationDirty: false,
});

describe('applyOpacityUpdate', () => {
  it('applies immediate clamped updates when interpolation is disabled', () => {
    const image = createMockImageState();

    applyOpacityUpdate(image, 5);

    expect(image.opacity).toBe(1);
    expect(image.opacityInterpolationState).toBeNull();
    expect(image.lastCommandOpacity).toBe(1);
  });

  it('interpolates opacity over time and clamps the final value', () => {
    const image = createMockImageState(0.8);

    applyOpacityUpdate(image, -4, { durationMs: 100, easing: (t) => t });

    expect(image.opacityInterpolationState).not.toBeNull();

    const startTimestamp = 0;
    // First tick initializes the interpolation without completing it.
    expect(stepSpriteImageInterpolations(image, startTimestamp)).toBe(true);
    // Second tick advances past the duration, yielding the clamped final value.
    expect(stepSpriteImageInterpolations(image, startTimestamp + 200)).toBe(
      false
    );
    expect(image.opacity).toBe(0);
  });

  it('supports feedforward opacity interpolation without exceeding 1.0', () => {
    const image = createMockImageState(0.2);
    const options: SpriteInterpolationOptions = {
      durationMs: 100,
      easing: (t) => t,
      mode: 'feedforward',
    };

    applyOpacityUpdate(image, 0.8, options);
    applyOpacityUpdate(image, 1.2, options);

    stepSpriteImageInterpolations(image, 0);
    stepSpriteImageInterpolations(image, 200);

    expect(image.opacity).toBe(1);
  });
});
