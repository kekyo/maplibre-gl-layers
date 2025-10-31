// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { EasingFunction, SpriteInterpolationOptions } from './types';
import { resolveEasing } from './easing';
import type { DistanceInterpolationState } from './internalTypes';

//////////////////////////////////////////////////////////////////////////////////////////

const DISTANCE_EPSILON = 1e-6;

const normaliseDuration = (durationMs: number): number =>
  Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;

const normaliseOptions = (
  options: SpriteInterpolationOptions
): {
  durationMs: number;
  easing: EasingFunction;
  mode: 'feedback' | 'feedforward';
} => ({
  durationMs: normaliseDuration(options.durationMs),
  easing: resolveEasing(options.easing),
  mode: options.mode ?? 'feedback',
});

export interface CreateDistanceInterpolationStateParams {
  currentValue: number;
  targetValue: number;
  previousCommandValue?: number;
  options: SpriteInterpolationOptions;
}

export interface CreateDistanceInterpolationStateResult {
  readonly state: DistanceInterpolationState;
  readonly requiresInterpolation: boolean;
}

export const createDistanceInterpolationState = (
  params: CreateDistanceInterpolationStateParams
): CreateDistanceInterpolationStateResult => {
  const { currentValue, targetValue } = params;
  const options = normaliseOptions(params.options);

  let effectiveTarget = targetValue;
  const previousCommand = params.previousCommandValue;
  if (
    options.mode === 'feedforward' &&
    previousCommand !== undefined &&
    Number.isFinite(previousCommand)
  ) {
    const commandDelta = targetValue - previousCommand;
    effectiveTarget = targetValue + commandDelta;
  }

  const delta = effectiveTarget - currentValue;

  const requiresInterpolation =
    options.durationMs > 0 && Math.abs(delta) > DISTANCE_EPSILON;

  const state: DistanceInterpolationState = {
    durationMs: options.durationMs,
    easing: options.easing,
    from: currentValue,
    to: currentValue + delta,
    finalValue: effectiveTarget,
    startTimestamp: -1,
  };

  return {
    state,
    requiresInterpolation,
  };
};

//////////////////////////////////////////////////////////////////////////////////////////

export interface EvaluateDistanceInterpolationParams {
  state: DistanceInterpolationState;
  timestamp: number;
}

export interface EvaluateDistanceInterpolationResult {
  readonly value: number;
  readonly completed: boolean;
  readonly effectiveStartTimestamp: number;
}

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 1;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
};

export const evaluateDistanceInterpolation = (
  params: EvaluateDistanceInterpolationParams
): EvaluateDistanceInterpolationResult => {
  const { state } = params;
  const timestamp = Number.isFinite(params.timestamp)
    ? params.timestamp
    : Date.now();

  const duration = Math.max(0, state.durationMs);
  const effectiveStart =
    state.startTimestamp >= 0 ? state.startTimestamp : timestamp;

  if (duration === 0 || Math.abs(state.to - state.from) <= DISTANCE_EPSILON) {
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
  const completed = rawProgress >= 1;

  return {
    value: completed ? state.finalValue : interpolated,
    completed,
    effectiveStartTimestamp: effectiveStart,
  };
};
