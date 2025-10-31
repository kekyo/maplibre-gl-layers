// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { SpriteNumericInterpolationOptions } from './types';
import {
  createNumericInterpolationState,
  type NumericInterpolationState,
} from './numericInterpolation';

/**
 * Normalizes an absolute angle in degrees to the range [0, 360).
 * @param {number} angle - Angle provided by the caller which may fall outside a single revolution.
 * @returns {number} Angle wrapped to [0, 360) with negative zero converted to zero.
 */
export const normaliseAngleDeg = (angle: number): number => {
  if (!Number.isFinite(angle)) {
    return 0;
  }
  const wrapped = angle % 360;
  const normalized = wrapped < 0 ? wrapped + 360 : wrapped;
  return Object.is(normalized, -0) ? 0 : normalized;
};

/**
 * Parameters describing the rotation update request.
 * @property {number} currentAngleDeg - Current angle already applied to the sprite in degrees.
 * @property {number} targetAngleDeg - Desired angle in degrees that should be reached.
 * @property {number | undefined} previousCommandAngleDeg - Previous commanded angle for feed-forward prediction.
 * @property {SpriteNumericInterpolationOptions | null} [options] - Optional interpolation configuration.
 */
export interface ResolveRotationTargetParams {
  currentAngleDeg: number;
  targetAngleDeg: number;
  previousCommandAngleDeg?: number;
  options?: SpriteNumericInterpolationOptions | null;
}

/**
 * Result produced by {@link resolveRotationTarget} when determining the next rotation step.
 * @property {number} nextAngleDeg - Angle that should be applied immediately.
 * @property {NumericInterpolationState | null} interpolationState - Optional state for animating toward the target.
 */
export interface ResolveRotationTargetResult {
  readonly nextAngleDeg: number;
  readonly interpolationState: NumericInterpolationState | null;
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
  const targetAngle = normaliseAngleDeg(params.targetAngleDeg);
  const currentAngle = normaliseAngleDeg(params.currentAngleDeg);
  const previousCommandAngleDeg =
    params.previousCommandAngleDeg !== undefined
      ? normaliseAngleDeg(params.previousCommandAngleDeg)
      : undefined;

  // Without options or with a zero/negative duration we snap to the target directly.
  if (!options || options.durationMs <= 0) {
    return {
      nextAngleDeg: targetAngle,
      interpolationState: null,
    };
  }

  const { state, requiresInterpolation } = createNumericInterpolationState({
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
