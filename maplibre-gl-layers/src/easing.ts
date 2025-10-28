// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { EasingFunction } from './types';

/**
 * Linear interpolation that clamps the value to the [0, 1] range.
 */
export const linearEasing: EasingFunction = (progress: number): number => {
  if (!Number.isFinite(progress)) {
    return 1;
  }
  if (progress <= 0) {
    return 0;
  }
  if (progress >= 1) {
    return 1;
  }
  return progress;
};

/**
 * Returns the provided easing function or falls back to linear interpolation.
 */
export const resolveEasing = (easing?: EasingFunction): EasingFunction =>
  easing ?? linearEasing;
