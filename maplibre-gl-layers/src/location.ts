// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { SpriteLocation } from './types';

/**
 * Produces a deep copy so later updates do not mutate the original object.
 */
export const cloneSpriteLocation = (
  location: SpriteLocation
): SpriteLocation => {
  if (location.z === undefined) {
    return { lng: location.lng, lat: location.lat };
  }
  return { lng: location.lng, lat: location.lat, z: location.z };
};

/**
 * Linearly interpolates longitude, latitude, and optionally altitude.
 * The `ratio` may fall outside [0, 1]; callers are responsible for clamping if needed.
 */
export const lerpSpriteLocation = (
  from: SpriteLocation,
  to: SpriteLocation,
  ratio: number
): SpriteLocation => {
  const zFrom = from.z ?? 0;
  const zTo = to.z ?? 0;
  const hasZ = from.z !== undefined || to.z !== undefined;

  const result: SpriteLocation = {
    lng: from.lng + (to.lng - from.lng) * ratio,
    lat: from.lat + (to.lat - from.lat) * ratio,
  };

  if (hasZ) {
    result.z = zFrom + (zTo - zFrom) * ratio;
  }

  return result;
};

/**
 * Compares two locations. Treats altitude as equal when either side is undefined.
 */
export const spriteLocationsEqual = (
  a: SpriteLocation,
  b: SpriteLocation
): boolean => {
  const zA = a.z ?? null;
  const zB = b.z ?? null;
  return a.lng === b.lng && a.lat === b.lat && zA === zB;
};
