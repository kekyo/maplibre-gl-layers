// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { EasingFunction, SpriteInterpolationOptions } from './types';
import { resolveEasing } from './easing';
import type { DegreeInterpolationState } from './internalTypes';

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Small tolerance used to decide when numeric differences are effectively zero.
 * Prevents oscillation caused by floating-point noise during interpolation.
 * @constant
 */
const NUMERIC_EPSILON = 1e-6;

/**
 * Normalizes animation duration values so downstream calculations avoid negative or invalid numbers.
 * @param {number} durationMs - Duration in milliseconds supplied by the caller.
 * @returns {number} Non-negative, finite duration safe for interpolation math.
 */
const normalizeDuration = (durationMs: number): number =>
  Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;

/**
 * Normalizes angular deltas to the range [-180, 180] to enforce the shortest rotation path.
 * @param {number} delta - Difference between target and current angles in degrees.
 * @returns {number} Shortest equivalent delta within [-180, 180].
 */
const normalizeDelta = (delta: number): number => {
  if (!Number.isFinite(delta)) {
    return 0;
  }
  let adjusted = delta % 360;
  // If the delta exceeds 180 degrees, rotate backwards instead to minimise travel.
  if (adjusted > 180) {
    adjusted -= 360;
    // When delta drops below or equal to -180, rotate forwards by adding a full turn.
  } else if (adjusted <= -180) {
    adjusted += 360;
  }
  return adjusted;
};

/**
 * Resolves interpolation options by applying defaults to duration and easing configuration.
 * @param {SpriteInterpolationOptions} options - Caller-supplied interpolation configuration.
 * @returns {{ durationMs: number; easing: EasingFunction }} Sanitized options ready for state creation.
 */
const normalizeOptions = (
  options: SpriteInterpolationOptions
): {
  durationMs: number;
  easing: EasingFunction;
  mode: 'feedback' | 'feedforward';
} => {
  return {
    durationMs: normalizeDuration(options.durationMs),
    easing: resolveEasing(options.easing),
    mode: options.mode ?? 'feedback',
  };
};

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Parameters required to construct a {@link DegreeInterpolationState}.
 * @property {number} currentValue - Current numeric value rendered on screen.
 * @property {number} targetValue - Desired value after interpolation completes.
 * @property {number | undefined} previousCommandValue - Prior commanded value used for feed-forward prediction.
 * @property {SpriteInterpolationOptions} options - Timing and easing configuration.
 */
export interface CreateDegreeInterpolationStateParams {
  currentValue: number;
  targetValue: number;
  previousCommandValue?: number;
  options: SpriteInterpolationOptions;
}

/**
 * Result returned by {@link createDegreeInterpolationState} containing state and a flag for activation.
 * @property {DegreeInterpolationState} state - Resolved state object.
 * @property {boolean} requiresInterpolation - Indicates whether the caller should animate or snap.
 */
export interface CreateDegreeInterpolationStateResult {
  readonly state: DegreeInterpolationState;
  readonly requiresInterpolation: boolean;
}

/**
 * Creates interpolation state describing how to move from the current value to the target value.
 * @param {CreateDegreeInterpolationStateParams} params - Inputs describing the current, target, and options.
 * @returns {CreateDegreeInterpolationStateResult} State data plus a flag indicating if animation is needed.
 */
export const createDegreeInterpolationState = (
  params: CreateDegreeInterpolationStateParams
): CreateDegreeInterpolationStateResult => {
  const { currentValue, targetValue } = params;
  const options = normalizeOptions(params.options);

  let effectiveTarget = targetValue;
  const previousCommand = params.previousCommandValue;
  if (
    options.mode === 'feedforward' &&
    previousCommand !== undefined &&
    Number.isFinite(previousCommand)
  ) {
    const commandDelta = normalizeDelta(targetValue - previousCommand);
    effectiveTarget = targetValue + commandDelta;
  }

  const delta = normalizeDelta(effectiveTarget - currentValue);
  const pathTarget = currentValue + delta;

  // Duration must be positive and delta must exceed epsilon before we animate.
  const requiresInterpolation =
    options.durationMs > 0 && Math.abs(delta) > NUMERIC_EPSILON;

  const state: DegreeInterpolationState = {
    durationMs: options.durationMs,
    easing: options.easing,
    from: currentValue,
    to: pathTarget,
    finalValue: effectiveTarget,
    startTimestamp: -1,
  };

  return {
    state,
    requiresInterpolation,
  };
};

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Parameters describing interpolation evaluation state.
 * @property {DegreeInterpolationState} state - State generated via {@link createDegreeInterpolationState}.
 * @property {number} timestamp - Timestamp in milliseconds used to sample the interpolation curve.
 */
export interface EvaluateDegreeInterpolationParams {
  state: DegreeInterpolationState;
  timestamp: number;
}

/**
 * Result of evaluating a numeric interpolation at a specific timestamp.
 * @property {number} value - Current interpolated value (or final value after completion).
 * @property {boolean} completed - Indicates whether interpolation reached the end.
 * @property {number} effectiveStartTimestamp - Start timestamp applied during evaluation.
 */
export interface EvaluateDegreeInterpolationResult {
  readonly value: number;
  readonly completed: boolean;
  readonly effectiveStartTimestamp: number;
}

/**
 * Clamps a numeric value to the inclusive range [0, 1], handling infinities gracefully.
 * @param {number} value - Raw easing output to normalize.
 * @returns {number} Value clamped between 0 and 1.
 */
const clamp01 = (value: number): number => {
  // Non-finite easing outputs should be treated as completion to avoid the animation stalling.
  if (!Number.isFinite(value)) {
    return 1;
  }
  // Values below zero round up to zero so callers do not rewind past the start.
  if (value <= 0) {
    return 0;
  }
  // Values above one indicate completion and should saturate at one.
  if (value >= 1) {
    return 1;
  }
  return value;
};

/**
 * Evaluates a numeric interpolation against the provided timestamp.
 * @param {EvaluateDegreeInterpolationParams} params - Inputs containing interpolation state and sample timestamp.
 * @returns {EvaluateDegreeInterpolationResult} Current value, completion flag, and effective start time.
 */
export const evaluateDegreeInterpolation = (
  params: EvaluateDegreeInterpolationParams
): EvaluateDegreeInterpolationResult => {
  const { state } = params;
  const timestamp = Number.isFinite(params.timestamp)
    ? params.timestamp
    : Date.now();

  const duration = Math.max(0, state.durationMs);
  const effectiveStart =
    state.startTimestamp >= 0 ? state.startTimestamp : timestamp;

  // When duration collapses or no meaningful delta exists, snap to the final value immediately.
  if (duration === 0 || Math.abs(state.to - state.from) <= NUMERIC_EPSILON) {
    return {
      value: state.finalValue,
      completed: true,
      effectiveStartTimestamp: effectiveStart,
    };
  }

  const elapsed = timestamp - effectiveStart;
  const rawProgress = duration <= 0 ? 1 : elapsed / duration;
  const eased = clamp01(state.easing(rawProgress));
  const interpolated = state.from + (state.to - state.from) * eased;
  // rawProgress >= 1 indicates we've reached or passed the end of the animation window.
  const completed = rawProgress >= 1;

  return {
    value: completed ? state.finalValue : interpolated,
    completed,
    effectiveStartTimestamp: effectiveStart,
  };
};
