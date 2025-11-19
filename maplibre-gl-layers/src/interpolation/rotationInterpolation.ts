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
 * @property {number} currentAngleDeg - Current angle already applied to the sprite in degrees.
 * @property {number} targetAngleDeg - Desired angle in degrees that should be reached.
 * @property {number | undefined} previousCommandAngleDeg - Previous commanded angle for feed-forward prediction.
 * @property {SpriteInterpolationOptions | null} [options] - Optional interpolation configuration.
 */
export interface ResolveRotationTargetParams {
  currentAngleDeg: number;
  targetAngleDeg: number;
  previousCommandAngleDeg?: number;
  options?: SpriteInterpolationOptions | null;
}

/**
 * Result produced by {@link resolveRotationTarget} when determining the next rotation step.
 * @property {number} nextAngleDeg - Angle that should be applied immediately.
 * @property {DegreeInterpolationState | null} interpolationState - Optional state for animating toward the target.
 */
export interface ResolveRotationTargetResult {
  readonly nextAngleDeg: number;
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
