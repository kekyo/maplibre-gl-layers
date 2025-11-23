// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  SpriteEasingParam,
  SpriteInterpolationMode,
  SpriteInterpolationOptions,
  SpriteLocation,
} from '../types';
import type {
  EasingFunction,
  InternalSpriteCurrentState,
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

const computeFeedforwardTarget = (
  previous: SpriteLocation | undefined,
  next: SpriteLocation
): SpriteLocation => {
  if (!previous) {
    return cloneSpriteLocation(next);
  }
  const prevZ = previous.z ?? 0;
  const nextZ = next.z ?? 0;
  const hasZ = previous.z !== undefined || next.z !== undefined;

  return {
    lng: next.lng + (next.lng - previous.lng),
    lat: next.lat + (next.lat - previous.lat),
    z: hasZ ? nextZ + (nextZ - prevZ) : undefined,
  };
};

//////////////////////////////////////////////////////////////////////////////////////////

export interface CreateLocationInterpolationStateParams {
  currentLocation: SpriteLocation;
  lastCommandLocation?: SpriteLocation;
  nextCommandLocation: SpriteLocation;
  options: SpriteInterpolationOptions;
}

export interface CreateLocationInterpolationStateResult {
  readonly state: SpriteInterpolationState<SpriteLocation>;
  readonly requiresInterpolation: boolean;
}

export const createLocationInterpolationState = (
  params: CreateLocationInterpolationStateParams
): CreateLocationInterpolationStateResult => {
  const { currentLocation, lastCommandLocation, nextCommandLocation } = params;
  const options = normalizeOptions(params.options);
  const from = cloneSpriteLocation(currentLocation);
  const commandTarget = cloneSpriteLocation(nextCommandLocation);

  let pathTarget: SpriteLocation | undefined;
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
    easingFunc: options.easingFunc,
    easingParam: options.easingParam,
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

export const evaluateLocationInterpolation = (
  state: SpriteInterpolationState<SpriteLocation>,
  timestamp: number
): SpriteInterpolationEvaluationResult<SpriteLocation> => {
  const easingFn = state.easingFunc;

  const duration = Math.max(0, state.durationMs);
  const effectiveStart =
    state.startTimestamp >= 0 ? state.startTimestamp : timestamp;

  const target = state.pathTarget ?? state.to;

  if (duration === 0 || spriteLocationsEqual(state.from, target)) {
    return {
      value: cloneSpriteLocation(state.to),
      completed: true,
      effectiveStartTimestamp: effectiveStart,
    };
  }

  const elapsed = timestamp - effectiveStart;
  const rawProgress = duration <= 0 ? 1 : elapsed / duration;
  const eased = easingFn(rawProgress);
  const value = lerpSpriteLocation(state.from, target, eased);
  const completed = rawProgress >= 1;

  return {
    value,
    completed,
    effectiveStartTimestamp: effectiveStart,
  };
};

export const evaluateLocationInterpolationsBatch = (
  states: readonly SpriteInterpolationState<SpriteLocation>[],
  timestamp: number
): SpriteInterpolationEvaluationResult<SpriteLocation>[] => {
  if (!states.length) {
    return [];
  }
  return states.map((state) => evaluateLocationInterpolation(state, timestamp));
};

//////////////////////////////////////////////////////////////////////////////////////////

export interface LocationInterpolationWorkItem<TTag>
  extends SpriteInterpolationState<SpriteLocation> {
  readonly sprite: InternalSpriteCurrentState<TTag>;
}

export const collectLocationInterpolationWorkItems = <TTag>(
  sprite: InternalSpriteCurrentState<TTag>,
  workItems: LocationInterpolationWorkItem<TTag>[]
): void => {
  const state = sprite.location.interpolation.state;
  if (state) {
    workItems.push({ ...state, sprite });
  }
};

export const applyLocationInterpolationEvaluations = <TTag>(
  workItems: readonly LocationInterpolationWorkItem<TTag>[],
  evaluations: readonly SpriteInterpolationEvaluationResult<SpriteLocation>[],
  timestamp: number
): boolean => {
  let active = false;
  for (let index = 0; index < workItems.length; index += 1) {
    const item = workItems[index]!;
    const { sprite } = item;
    const evaluation =
      evaluations[index] ?? evaluateLocationInterpolation(item, timestamp);

    if (item.startTimestamp < 0) {
      const effectiveStart = evaluation.effectiveStartTimestamp;
      item.startTimestamp = effectiveStart;
      const interpolationState = sprite.location.interpolation.state;
      if (interpolationState && interpolationState.startTimestamp < 0) {
        interpolationState.startTimestamp = effectiveStart;
      }
    }

    sprite.location.current = evaluation.value;

    if (evaluation.completed) {
      sprite.location.current = cloneSpriteLocation(item.to);
      sprite.location.from = undefined;
      sprite.location.to = undefined;
      sprite.location.interpolation.state = null;
    } else {
      active = true;
    }
  }
  return active;
};
