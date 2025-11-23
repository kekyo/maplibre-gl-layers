// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { Map as MapLibreMap } from 'maplibre-gl';

import { normalizeAngleDeg } from '../utils/math';
import type { Releasable } from '../internalTypes';
import type { SpriteCurrentState } from '../types';

/**
 * Sprite tracking controller.
 * @template TTag Tag type.
 */
export interface SpriteTrackingController<TTag> extends Releasable {
  /**
   * Track the sprite
   * @param sprite - Target sprite
   * @param trackRotation - Track with rotation when true
   */
  readonly trackSprite: (
    sprite: SpriteCurrentState<TTag>,
    trackRotation: boolean
  ) => void;
  /**
   * Untrack sprite.
   */
  readonly untrackSprite: () => void;
}

/**
 * Drives sprite tracking (centering and optional rotation) with a requestAnimationFrame loop.
 * Pauses tracking while the user is manipulating the camera to avoid fighting user input.
 * @template TTag Tag type.
 * @param mapInstance - MapLibre instance.
 */
export const createSpriteTrackingController = <TTag>(
  mapInstance: MapLibreMap
): SpriteTrackingController<TTag> => {
  let trackedSpriteTrackRotation = true;
  let trackedSprite: SpriteCurrentState<TTag> | undefined;
  let trackedSpriteFrameId: number | null = null;

  const cancelTrackedSpriteFrame = (): void => {
    if (trackedSpriteFrameId === null) {
      return;
    }
    if (typeof window !== 'undefined') {
      window.cancelAnimationFrame(trackedSpriteFrameId);
    }
    trackedSpriteFrameId = null;
  };

  const untrackSpriteInternal = (): void => {
    cancelTrackedSpriteFrame();
  };

  const applyTrackedSpriteRotation = (
    sprite: SpriteCurrentState<TTag>
  ): boolean => {
    let targetBearing: number | null = null;
    for (const orderMap of sprite.images.values()) {
      const iterator = orderMap.values().next();
      if (!iterator.done) {
        targetBearing = normalizeAngleDeg(
          iterator.value.finalRotateDeg.current
        );
        break;
      }
    }
    if (targetBearing === null) {
      return false;
    }
    const currentBearing = normalizeAngleDeg(mapInstance.getBearing());
    if (currentBearing === targetBearing) {
      return false;
    }
    mapInstance.setBearing(targetBearing);
    return true;
  };

  const stepTrackedSprite = (): void => {
    trackedSpriteFrameId = null;
    if (!mapInstance || !trackedSprite || typeof window === 'undefined') {
      return;
    }

    mapInstance.setCenter(trackedSprite.location.current);

    if (trackedSpriteTrackRotation) {
      applyTrackedSpriteRotation(trackedSprite);
    }

    trackedSpriteFrameId = window.requestAnimationFrame(stepTrackedSprite);
  };

  const trackSprite = (
    sprite: SpriteCurrentState<TTag>,
    trackRotation: boolean
  ): void => {
    if (typeof window === 'undefined') {
      return;
    }
    trackedSpriteTrackRotation = trackRotation !== false;
    trackedSprite = sprite;
    cancelTrackedSpriteFrame();
    trackedSpriteFrameId = window.requestAnimationFrame(stepTrackedSprite);
  };

  const untrackSprite = (): void => {
    trackedSpriteTrackRotation = true;
    trackedSprite = undefined;
    untrackSpriteInternal();
  };

  return {
    trackSprite,
    untrackSprite,
    release: () => {
      untrackSpriteInternal();
      trackedSprite = undefined;
    },
  };
};
