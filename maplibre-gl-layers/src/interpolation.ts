// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  EasingFunction,
  SpriteInterpolationMode,
  SpriteLocationInterpolationOptions,
  SpriteLocation,
} from './types';
import { cloneSpriteLocation, lerpSpriteLocation } from './location';
import { resolveEasing } from './easing';
import { spriteLocationsEqual } from './location';

/**
 * Runtime state describing the active interpolation between two sprite locations.
 * Consumers reuse the same state across ticks to avoid re-allocations while animation is running.
 *
 * @property mode - Strategy used to resolve the target location (feedback or feedforward).
 * @property durationMs - Total time allocated for the interpolation in milliseconds.
 * @property easing - Resolved easing function applied to raw progress values.
 * @property startTimestamp - Epoch millisecond when the interpolation started, or -1 when uninitialised.
 * @property from - Origin sprite location cloned from the current render state.
 * @property to - Destination sprite location being interpolated towards.
 */
export interface SpriteInterpolationState {
  readonly mode: SpriteInterpolationMode;
  readonly durationMs: number;
  readonly easing: EasingFunction;
  startTimestamp: number;
  readonly from: SpriteLocation;
  readonly to: SpriteLocation;
}

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
  options: SpriteLocationInterpolationOptions;
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
  };
  // Only extrapolate altitude when either point includes z; otherwise we maintain the 2D assumption.
  if (hasZ) {
    target.z = nextZ + (nextZ - prevZ);
  }
  return target;
};

/**
 * Normalised representation of interpolation options with defaults applied.
 *
 * @property durationMs - Clamped non-negative duration in milliseconds.
 * @property mode - Strategy that guides how the destination is computed.
 * @property easing - Optional easing function carried through for later resolution.
 */
interface NormalisedInterpolationOptions {
  durationMs: number;
  mode: SpriteInterpolationMode;
  easing?: EasingFunction;
}

/**
 * Normalises raw interpolation options by clamping duration and applying defaults.
 *
 * @param options - Caller-provided interpolation options.
 * @returns Options safe for downstream consumption.
 */
const normaliseOptions = (
  options: SpriteLocationInterpolationOptions
): NormalisedInterpolationOptions => {
  return {
    durationMs: Math.max(0, options.durationMs),
    mode: options.mode ?? 'feedback',
    easing: options.easing,
  };
};

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
  const options = normaliseOptions(params.options);
  const from = cloneSpriteLocation(currentLocation);
  const easing = resolveEasing(options.easing);

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
    easing,
    startTimestamp: -1,
    from,
    to,
  };

  return { state, requiresInterpolation };
};

/**
 * Parameters required to evaluate an interpolation tick at a given moment.
 *
 * @property state - Active interpolation state previously created.
 * @property timestamp - Epoch millisecond at which interpolation should be evaluated.
 */
export interface EvaluateInterpolationParams {
  state: SpriteInterpolationState;
  timestamp: number;
}

/**
 * Result of evaluating interpolation progress at a specific timestamp.
 *
 * @property location - Interpolated sprite location corresponding to the evaluated time.
 * @property completed - Indicates whether the interpolation has reached or exceeded its duration.
 * @property effectiveStartTimestamp - Timestamp detected or assigned as the interpolation starting point.
 */
export interface EvaluateInterpolationResult {
  readonly location: SpriteLocation;
  readonly completed: boolean;
  readonly effectiveStartTimestamp: number;
}

/**
 * Evaluates an interpolation state at a specific point in time and returns the intermediate location.
 *
 * @param params - The interpolation state and the reference timestamp for evaluation.
 * @returns The lerped location, whether the interpolation has finished, and the effective start time.
 */
export const evaluateInterpolation = (
  params: EvaluateInterpolationParams
): EvaluateInterpolationResult => {
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
