// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  SpriteEasingParam,
  SpriteInterpolationMode,
  SpriteInterpolationOptions,
} from '../types';
import { resolveEasing } from './easing';
import type {
  EasingFunction,
  InternalSpriteImageState,
  MutableSpriteInterpolation,
  SpriteInterpolationEvaluationResult,
  SpriteInterpolationState,
} from '../internalTypes';
import { clampOpacity } from '../utils/math';

//////////////////////////////////////////////////////////////////////////////////////////

const DISTANCE_EPSILON = 1e-6;

const normalizeDuration = (durationMs: number): number =>
  Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;

const normalizeOptions = (
  options: SpriteInterpolationOptions
): {
  readonly durationMs: number;
  readonly easingFunc: EasingFunction;
  readonly easingParam: SpriteEasingParam;
  readonly mode: SpriteInterpolationMode;
} => {
  const resolved = resolveEasing(options.easing);
  return {
    durationMs: normalizeDuration(options.durationMs),
    easingFunc: resolved.func,
    easingParam: resolved.param,
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
  readonly state: SpriteInterpolationState<number>;
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

  const pathTarget = currentValue + delta;
  const normalizedPathTarget =
    Math.abs(pathTarget - targetValue) <= DISTANCE_EPSILON
      ? undefined
      : pathTarget;

  const state: SpriteInterpolationState<number> = {
    mode: options.mode,
    durationMs: options.durationMs,
    easingFunc: options.easingFunc,
    easingParam: options.easingParam,
    from: currentValue,
    to: targetValue,
    pathTarget: normalizedPathTarget,
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
  state: SpriteInterpolationState<number>,
  timestamp: number
): SpriteInterpolationEvaluationResult<number> => {
  const targetValue = state.pathTarget ?? state.to;

  const duration = Math.max(0, state.durationMs);
  const effectiveStart =
    state.startTimestamp >= 0 ? state.startTimestamp : timestamp;

  if (
    duration === 0 ||
    Math.abs(targetValue - state.from) <= DISTANCE_EPSILON
  ) {
    return {
      value: state.to,
      completed: true,
      effectiveStartTimestamp: effectiveStart,
    };
  }

  const elapsed = timestamp - effectiveStart;
  const rawProgress = duration <= 0 ? 1 : elapsed / duration;
  const eased = clamp01(state.easingFunc(rawProgress));
  const interpolated = state.from + (targetValue - state.from) * eased;
  const completed = rawProgress >= 1;

  return {
    value: completed ? state.to : interpolated,
    completed,
    effectiveStartTimestamp: effectiveStart,
  };
};

//////////////////////////////////////////////////////////////////////////////////////////

interface DistanceInterpolationChannelDescriptor {
  readonly resolveInterpolation: (
    image: InternalSpriteImageState
  ) => MutableSpriteInterpolation<number>;
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
    resolveInterpolation: (image) => image.offset.offsetMeters.interpolation,
    applyValue: (image: InternalSpriteImageState, value: number) => {
      image.offset.offsetMeters.current = value;
    },
    applyFinalValue: (image: InternalSpriteImageState, value: number) => {
      image.offset.offsetMeters.current = value;
      image.offset.offsetMeters.from = undefined;
      image.offset.offsetMeters.to = undefined;
    },
  },
  opacity: {
    resolveInterpolation: (image) => image.finalOpacity.interpolation,
    normalize: clampOpacity,
    applyValue: (image: InternalSpriteImageState, value: number) => {
      image.finalOpacity.current = value;
    },
    applyFinalValue: (image, value) => {
      image.finalOpacity.current = value;
      image.finalOpacity.from = undefined;
      image.finalOpacity.to = undefined;
    },
  },
};

export type DistanceInterpolationChannelDescriptorMap =
  typeof DISTANCE_INTERPOLATION_CHANNELS;

export type DistanceInterpolationChannelName =
  keyof DistanceInterpolationChannelDescriptorMap;

export interface DistanceInterpolationWorkItem
  extends SpriteInterpolationState<number> {
  readonly descriptor: DistanceInterpolationChannelDescriptorMap[DistanceInterpolationChannelName];
  readonly image: InternalSpriteImageState;
}

export const collectDistanceInterpolationWorkItems = (
  image: InternalSpriteImageState,
  workItems: DistanceInterpolationWorkItem[],
  includeOffsetMeters: boolean,
  includeOpacity: boolean
): void => {
  const offsetMetersState =
    DISTANCE_INTERPOLATION_CHANNELS.offsetMeters.resolveInterpolation(
      image
    ).state;
  if (includeOffsetMeters && offsetMetersState) {
    workItems.push({
      ...offsetMetersState,
      descriptor: DISTANCE_INTERPOLATION_CHANNELS.offsetMeters,
      image,
    });
  }

  const opacityState =
    DISTANCE_INTERPOLATION_CHANNELS.opacity.resolveInterpolation(image).state;
  if (includeOpacity && opacityState) {
    workItems.push({
      ...opacityState,
      descriptor: DISTANCE_INTERPOLATION_CHANNELS.opacity,
      image,
    });
  }
};

const updateDistanceInterpolationState = (
  image: InternalSpriteImageState,
  descriptor: DistanceInterpolationChannelDescriptor,
  nextState: SpriteInterpolationState<number> | null
): void => {
  descriptor.resolveInterpolation(image).state = nextState;
};

export const applyDistanceInterpolationEvaluations = (
  workItems: readonly DistanceInterpolationWorkItem[],
  evaluations: readonly SpriteInterpolationEvaluationResult<number>[],
  timestamp: number
): boolean => {
  let active = false;
  for (let index = 0; index < workItems.length; index += 1) {
    const item = workItems[index]!;
    const evaluation =
      evaluations[index] ?? evaluateDistanceInterpolation(item, timestamp);

    const interpolationState = item.descriptor.resolveInterpolation(
      item.image
    ).state;
    if (interpolationState && interpolationState.startTimestamp < 0) {
      interpolationState.startTimestamp = evaluation.effectiveStartTimestamp;
    }
    if (item.startTimestamp < 0) {
      item.startTimestamp = evaluation.effectiveStartTimestamp;
    }

    const normalize = item.descriptor.normalize ?? ((value: number) => value);
    const applyFinalValue =
      item.descriptor.applyFinalValue ?? item.descriptor.applyValue;

    const interpolatedValue = normalize(evaluation.value);
    item.descriptor.applyValue(item.image, interpolatedValue);

    if (evaluation.completed) {
      const finalValue = normalize(item.to);
      applyFinalValue(item.image, finalValue);
      updateDistanceInterpolationState(item.image, item.descriptor, null);
    } else {
      updateDistanceInterpolationState(item.image, item.descriptor, item);
      active = true;
    }
  }
  return active;
};
