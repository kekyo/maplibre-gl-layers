// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  EasingFunction,
  SpriteEasingPresetName,
  SpriteInterpolationEasing,
} from '../types';

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

const EASING_PRESETS: Record<SpriteEasingPresetName, EasingFunction> = {
  linear: linearEasing,
};

export interface ResolvedEasing {
  readonly easing: EasingFunction;
  readonly preset: SpriteEasingPresetName | null;
}

/**
 * Returns the provided easing function or falls back to linear interpolation.
 * When a preset name is supplied the resolved preset identifier is preserved for downstream consumers.
 */
export const resolveEasing = (
  easing?: SpriteInterpolationEasing
): ResolvedEasing => {
  if (!easing) {
    return { easing: linearEasing, preset: 'linear' };
  }
  if (typeof easing === 'string') {
    const presetName = easing as SpriteEasingPresetName;
    const preset = EASING_PRESETS[presetName];
    if (preset) {
      return { easing: preset, preset: presetName };
    }
  }
  return { easing: easing as EasingFunction, preset: null };
};
