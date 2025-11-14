// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  EasingFunction,
  SpriteEasingPresetName,
  SpriteInterpolationOptions,
} from '../types';
import { resolveEasing } from './easing';
import type {
  DistanceInterpolationEvaluationParams,
  DistanceInterpolationEvaluationResult,
  DistanceInterpolationState,
  InternalSpriteImageState,
} from '../internalTypes';
import { clampOpacity } from '../utils/math';

//////////////////////////////////////////////////////////////////////////////////////////

const DISTANCE_EPSILON = 1e-6;

const normalizeDuration = (durationMs: number): number =>
  Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;

const normalizeOptions = (
  options: SpriteInterpolationOptions
): {
  durationMs: number;
  easing: EasingFunction;
  easingPreset: SpriteEasingPresetName | null;
  mode: 'feedback' | 'feedforward';
} => {
  const resolved = resolveEasing(options.easing);
  return {
    durationMs: normalizeDuration(options.durationMs),
    easing: resolved.easing,
    easingPreset: resolved.preset,
    mode: options.mode ?? 'feedback',
  };
};

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
  const options = normalizeOptions(params.options);

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
    easingPreset: options.easingPreset,
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
  params: DistanceInterpolationEvaluationParams
): DistanceInterpolationEvaluationResult => {
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

//////////////////////////////////////////////////////////////////////////////////////////

type DistanceInterpolationStateKey =
  | 'offsetMetersInterpolationState'
  | 'opacityInterpolationState';

interface DistanceInterpolationChannelDescriptor {
  readonly stateKey: DistanceInterpolationStateKey;
  readonly normalize?: (value: number) => number;
  readonly applyValue: (image: InternalSpriteImageState, value: number) => void;
  readonly applyFinalValue?: (
    image: InternalSpriteImageState,
    value: number
  ) => void;
}

const DISTANCE_INTERPOLATION_CHANNELS: Record<
  'offsetMeters' | 'opacity',
  DistanceInterpolationChannelDescriptor
> = {
  offsetMeters: {
    stateKey: 'offsetMetersInterpolationState',
    applyValue: (image: InternalSpriteImageState, value: number) => {
      image.offset.offsetMeters = value;
    },
  },
  opacity: {
    stateKey: 'opacityInterpolationState',
    normalize: clampOpacity,
    applyValue: (image: InternalSpriteImageState, value: number) => {
      image.opacity = value;
    },
  },
};

export type DistanceInterpolationChannelDescriptorMap =
  typeof DISTANCE_INTERPOLATION_CHANNELS;

export type DistanceInterpolationChannelName =
  keyof DistanceInterpolationChannelDescriptorMap;

export interface DistanceInterpolationWorkItem {
  readonly descriptor: DistanceInterpolationChannelDescriptorMap[DistanceInterpolationChannelName];
  readonly image: InternalSpriteImageState;
  readonly state: DistanceInterpolationState;
}

export interface CollectDistanceInterpolationWorkItemOptions {
  readonly includeOffsetMeters?: boolean;
  readonly includeOpacity?: boolean;
}

export const collectDistanceInterpolationWorkItems = (
  image: InternalSpriteImageState,
  workItems: DistanceInterpolationWorkItem[],
  options?: CollectDistanceInterpolationWorkItemOptions
): void => {
  const includeOffsetMeters = options?.includeOffsetMeters ?? true;
  const includeOpacity = options?.includeOpacity ?? true;

  const offsetMetersState = image.offsetMetersInterpolationState;
  if (includeOffsetMeters && offsetMetersState) {
    workItems.push({
      descriptor: DISTANCE_INTERPOLATION_CHANNELS.offsetMeters,
      image,
      state: offsetMetersState,
    });
  }

  const opacityState = image.opacityInterpolationState;
  if (includeOpacity && opacityState) {
    workItems.push({
      descriptor: DISTANCE_INTERPOLATION_CHANNELS.opacity,
      image,
      state: opacityState,
    });
  }
};

const updateDistanceInterpolationState = (
  image: InternalSpriteImageState,
  descriptor: DistanceInterpolationChannelDescriptor,
  nextState: DistanceInterpolationState | null
): void => {
  if (descriptor.stateKey === 'offsetMetersInterpolationState') {
    image.offsetMetersInterpolationState = nextState;
  } else {
    image.opacityInterpolationState = nextState;
  }
};

export const applyDistanceInterpolationEvaluations = (
  workItems: readonly DistanceInterpolationWorkItem[],
  evaluations: readonly DistanceInterpolationEvaluationResult[],
  timestamp: number
): boolean => {
  let active = false;
  for (let index = 0; index < workItems.length; index += 1) {
    const item = workItems[index]!;
    const evaluation =
      evaluations[index] ??
      evaluateDistanceInterpolation({
        state: item.state,
        timestamp,
      });

    if (item.state.startTimestamp < 0) {
      item.state.startTimestamp = evaluation.effectiveStartTimestamp;
    }

    const normalize = item.descriptor.normalize ?? ((value: number) => value);
    const applyFinalValue =
      item.descriptor.applyFinalValue ?? item.descriptor.applyValue;

    const interpolatedValue = normalize(evaluation.value);
    item.descriptor.applyValue(item.image, interpolatedValue);

    if (evaluation.completed) {
      const finalValue = normalize(item.state.finalValue);
      applyFinalValue(item.image, finalValue);
      updateDistanceInterpolationState(item.image, item.descriptor, null);
    } else {
      updateDistanceInterpolationState(item.image, item.descriptor, item.state);
      active = true;
    }
  }
  return active;
};
