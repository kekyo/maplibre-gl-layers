// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  SpriteInterpolationMode,
  SpriteInterpolationOptions,
  SpriteLocation,
} from '../types';
import type {
  SpriteInterpolationEvaluationParams,
  SpriteInterpolationEvaluationResult,
  SpriteInterpolationState,
} from '../internalTypes';

import { resolveEasing } from './easing';
import {
  cloneSpriteLocation,
  lerpSpriteLocation,
  spriteLocationsEqual,
} from '../utils/math';

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
 */
interface NormalizedInterpolationOptions {
  /** Clamped non-negative duration in milliseconds. */
  durationMs: number;
  /** Strategy that guides how the destination is computed. */
  mode: SpriteInterpolationMode;
  /** Optional easing preset carried through for later resolution. */
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
 */
export interface CreateInterpolationStateParams {
  /** Sprite location currently rendered on screen. */
  currentLocation: SpriteLocation;
  /** Previously commanded target, used for feedforward extrapolation. */
  lastCommandLocation?: SpriteLocation;
  /** Upcoming commanded target that the sprite should reach. */
  nextCommandLocation: SpriteLocation;
  /** Raw interpolation options supplied by the caller. */
  options: SpriteInterpolationOptions;
}

/**
 * Result of preparing interpolation state, including a flag denoting whether any lerp is needed.
 */
export interface CreateInterpolationStateResult {
  /** Prepared interpolation state ready for evaluation. */
  readonly state: SpriteInterpolationState<SpriteLocation>;
  /** Indicates whether lerping is needed or an immediate snap is sufficient. */
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

  const commandTarget = cloneSpriteLocation(nextCommandLocation);
  let pathTarget: SpriteLocation | undefined;
  // When feedforward is requested we extrapolate beyond the next command to smooth remote updates.
  if (options.mode === 'feedforward') {
    pathTarget = computeFeedforwardTarget(
      lastCommandLocation,
      nextCommandLocation
    );
  }

  const requiresInterpolation =
    options.durationMs > 0 &&
    !spriteLocationsEqual(from, pathTarget ?? commandTarget);

  const state: SpriteInterpolationState<SpriteLocation> = {
    mode: options.mode,
    durationMs: options.durationMs,
    easingFunc: resolvedEasing.func,
    easingParam: resolvedEasing.param,
    startTimestamp: -1,
    from,
    to: commandTarget,
    pathTarget:
      pathTarget && !spriteLocationsEqual(pathTarget, commandTarget)
        ? pathTarget
        : undefined,
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
  const easingFn = state.easingFunc;
  // Use the provided timestamp when valid; otherwise fall back to real time to keep animation advancing.
  const timestamp = Number.isFinite(params.timestamp)
    ? params.timestamp
    : Date.now();

  const duration = Math.max(0, state.durationMs);
  // Reuse an existing start timestamp when set; if unset we kick off the interpolation at the current tick.
  const effectiveStart =
    state.startTimestamp >= 0 ? state.startTimestamp : timestamp;

  // Zero-duration animations snap to the target immediately, avoiding unnecessary easing work.
  const target = state.pathTarget ?? state.to;

  if (duration === 0 || spriteLocationsEqual(state.from, target)) {
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
  const location = lerpSpriteLocation(state.from, target, eased);
  const completed = rawProgress >= 1;

  return {
    location,
    completed,
    effectiveStartTimestamp: effectiveStart,
  };
};
