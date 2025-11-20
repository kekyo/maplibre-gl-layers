// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { SpriteInterpolationOptions } from '../types';
import type { SpriteInterpolationState } from '../internalTypes';
import { createDegreeInterpolationState } from './degreeInterpolation';
import { normalizeAngleDeg } from '../utils/math';

export { normalizeAngleDeg } from '../utils/math';

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Parameters describing the rotation update request.
 */
export interface ResolveRotationTargetParams {
  /** Current angle already applied to the sprite in degrees. */
  currentAngleDeg: number;
  /** Desired angle in degrees that should be reached. */
  targetAngleDeg: number;
  /** Previous commanded angle for feed-forward prediction. */
  previousCommandAngleDeg?: number;
  /** Optional interpolation configuration. */
  options?: SpriteInterpolationOptions | null;
}

/**
 * Result produced by {@link resolveRotationTarget} when determining the next rotation step.
 */
export interface ResolveRotationTargetResult {
  /** Angle that should be applied immediately. */
  readonly nextAngleDeg: number;
  /** Optional state for animating toward the target. */
  readonly interpolationState: SpriteInterpolationState<number> | null;
}

/**
 * Determines whether a rotation change requires interpolation and, if so, produces the state to drive it.
 * @param {ResolveRotationTargetParams} params - Inputs including current angle, target angle, and options.
 * @returns {ResolveRotationTargetResult} Immediate angle plus optional interpolation state.
 */
export const resolveRotationTarget = (
  params: ResolveRotationTargetParams
): ResolveRotationTargetResult => {
  const options = params.options;
  const targetAngle = normalizeAngleDeg(params.targetAngleDeg);
  const currentAngle = normalizeAngleDeg(params.currentAngleDeg);
  const previousCommandAngleDeg =
    params.previousCommandAngleDeg !== undefined
      ? normalizeAngleDeg(params.previousCommandAngleDeg)
      : undefined;

  // Without options or with a zero/negative duration we snap to the target directly.
  if (!options || options.durationMs <= 0) {
    return {
      nextAngleDeg: targetAngle,
      interpolationState: null,
    };
  }

  const { state, requiresInterpolation } = createDegreeInterpolationState({
    currentValue: currentAngle,
    targetValue: targetAngle,
    previousCommandValue: previousCommandAngleDeg,
    options,
  });

  // No interpolation required when delta is negligible or clamped duration aborted the animation.
  if (!requiresInterpolation) {
    return {
      nextAngleDeg: targetAngle,
      interpolationState: null,
    };
  }

  return {
    nextAngleDeg: currentAngle,
    interpolationState: state,
  };
};
