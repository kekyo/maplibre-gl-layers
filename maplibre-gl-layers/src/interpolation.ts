// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  SpriteInterpolationMode,
  SpriteInterpolationOptions,
  SpriteLocation,
} from './types';
import type {
  SpriteInterpolationState,
  SpriteInterpolationEvaluationParams,
  SpriteInterpolationEvaluationResult,
} from './internalTypes';

import { resolveEasing } from './easing';
import {
  cloneSpriteLocation,
  lerpSpriteLocation,
  spriteLocationsEqual,
} from './math';

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Computes a feed-forward target by extrapolating the delta between the two most recent locations.
 * When the previous location is missing the function falls back to cloning the current command,
 * ensuring the caller never receives an undefined reference.
 *
 * @param previous - The last command location that precedes `next`, or undefined when unavailable.
 * @param next - The upcoming command location to extrapolate from.
 * @returns A new sprite location positioned ahead of `next` using doubled deltas.
 */
const computeFeedforwardTarget = (
  previous: SpriteLocation | undefined,
  next: SpriteLocation
): SpriteLocation => {
  // If there is no previous command, trust the next command verbatim to avoid speculative extrapolation.
  if (!previous) {
    return cloneSpriteLocation(next);
  }
  const prevZ = previous.z ?? 0;
  const nextZ = next.z ?? 0;
  const hasZ = previous.z !== undefined || next.z !== undefined;

  const target: SpriteLocation = {
    lng: next.lng + (next.lng - previous.lng),
    lat: next.lat + (next.lat - previous.lat),
    // Only extrapolate altitude when either point includes z; otherwise we maintain the 2D assumption.
    z: hasZ ? nextZ + (nextZ - prevZ) : undefined,
  };
  return target;
};

/**
 * Normalized representation of interpolation options with defaults applied.
 *
 * @property durationMs - Clamped non-negative duration in milliseconds.
 * @property mode - Strategy that guides how the destination is computed.
 * @property easing - Optional easing function carried through for later resolution.
 */
interface NormalizedInterpolationOptions {
  durationMs: number;
  mode: SpriteInterpolationMode;
  easing?: SpriteInterpolationOptions['easing'];
}

/**
 * Normalizes raw interpolation options by clamping duration and applying defaults.
 *
 * @param options - Caller-provided interpolation options.
 * @returns Options safe for downstream consumption.
 */
const normalizeOptions = (
  options: SpriteInterpolationOptions
): NormalizedInterpolationOptions => {
  return {
    durationMs: Math.max(0, options.durationMs),
    mode: options.mode ?? 'feedback',
    easing: options.easing,
  };
};

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Parameters required to create a fresh interpolation state for the next animation segment.
 *
 * @property currentLocation - Sprite location currently rendered on screen.
 * @property lastCommandLocation - Previously commanded target, used for feedforward extrapolation.
 * @property nextCommandLocation - Upcoming commanded target that the sprite should reach.
 * @property options - Raw interpolation options supplied by the caller.
 */
export interface CreateInterpolationStateParams {
  currentLocation: SpriteLocation;
  lastCommandLocation?: SpriteLocation;
  nextCommandLocation: SpriteLocation;
  options: SpriteInterpolationOptions;
}

/**
 * Result of preparing interpolation state, including a flag denoting whether any lerp is needed.
 *
 * @property state - Prepared interpolation state ready for evaluation.
 * @property requiresInterpolation - Indicates whether lerping is needed or an immediate snap is sufficient.
 */
export interface CreateInterpolationStateResult {
  readonly state: SpriteInterpolationState;
  readonly requiresInterpolation: boolean;
}

/**
 * Creates interpolation state for the next sprite movement and signals if interpolation is necessary.
 *
 * @param params - The context needed to build interpolation state, including locations and configuration.
 * @returns The prepared state alongside a boolean indicating whether animation should run.
 */
export const createInterpolationState = (
  params: CreateInterpolationStateParams
): CreateInterpolationStateResult => {
  const { currentLocation, lastCommandLocation, nextCommandLocation } = params;
  const options = normalizeOptions(params.options);
  const from = cloneSpriteLocation(currentLocation);
  const resolvedEasing = resolveEasing(options.easing);

  let to: SpriteLocation;
  // When feedforward is requested we extrapolate beyond the next command to smooth remote updates.
  if (options.mode === 'feedforward') {
    to = computeFeedforwardTarget(lastCommandLocation, nextCommandLocation);
  } else {
    // Otherwise we perform feedback interpolation by targeting the commanded location exactly.
    to = cloneSpriteLocation(nextCommandLocation);
  }

  const requiresInterpolation =
    options.durationMs > 0 && !spriteLocationsEqual(from, to);

  const state: SpriteInterpolationState = {
    mode: options.mode,
    durationMs: options.durationMs,
    easing: resolvedEasing.easing,
    easingPreset: resolvedEasing.preset,
    startTimestamp: -1,
    from,
    to,
  };

  return { state, requiresInterpolation };
};

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Evaluates an interpolation state at a specific point in time and returns the intermediate location.
 *
 * @param params - The interpolation state and the reference timestamp for evaluation.
 * @returns The lerped location, whether the interpolation has finished, and the effective start time.
 */
export const evaluateInterpolation = (
  params: SpriteInterpolationEvaluationParams
): SpriteInterpolationEvaluationResult => {
  const { state } = params;
  const easingFn = state.easing;
  // Use the provided timestamp when valid; otherwise fall back to real time to keep animation advancing.
  const timestamp = Number.isFinite(params.timestamp)
    ? params.timestamp
    : Date.now();

  const duration = Math.max(0, state.durationMs);
  // Reuse an existing start timestamp when set; if unset we kick off the interpolation at the current tick.
  const effectiveStart =
    state.startTimestamp >= 0 ? state.startTimestamp : timestamp;

  // Zero-duration animations snap to the target immediately, avoiding unnecessary easing work.
  if (duration === 0) {
    return {
      location: cloneSpriteLocation(state.to),
      completed: true,
      effectiveStartTimestamp: effectiveStart,
    };
  }

  const elapsed = timestamp - effectiveStart;
  // Guard against non-positive durations to prevent division by zero, treating them as instantly complete.
  const rawProgress = duration <= 0 ? 1 : elapsed / duration;
  const eased = easingFn(rawProgress);
  const location = lerpSpriteLocation(state.from, state.to, eased);
  const completed = rawProgress >= 1;

  return {
    location,
    completed,
    effectiveStartTimestamp: effectiveStart,
  };
};
