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
  SpriteInterpolationEvaluationResult,
  EasingFunction,
  InternalSpriteImageState,
  SpriteInterpolationState,
} from '../internalTypes';
import { normalizeAngleDeg } from '../utils/math';
import type { SpriteInterpolationChannelDescriptor } from './interpolationChannels';

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
 * @returns Sanitized options ready for state creation.
 */
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

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Parameters required to construct a {@link DegreeInterpolationState}.
 */
export interface CreateDegreeInterpolationStateParams {
  /** Current numeric value rendered on screen. */
  currentValue: number;
  /** Desired value after interpolation completes. */
  targetValue: number;
  /** Prior commanded value used for feed-forward prediction. */
  previousCommandValue?: number;
  /** Timing and easing configuration. */
  options: SpriteInterpolationOptions;
}

/**
 * Result returned by {@link createDegreeInterpolationState} containing state and a flag for activation.
 */
export interface CreateDegreeInterpolationStateResult {
  /** Resolved state object. */
  readonly state: SpriteInterpolationState<number>;
  /** Indicates whether the caller should animate or snap. */
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
  const normalizedPathTarget =
    Math.abs(pathTarget - targetValue) <= NUMERIC_EPSILON
      ? undefined
      : pathTarget;

  // Duration must be positive and delta must exceed epsilon before we animate.
  const requiresInterpolation =
    options.durationMs > 0 && Math.abs(delta) > NUMERIC_EPSILON;

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

//////////////////////////////////////////////////////////////////////////////////////////

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

export const evaluateDegreeInterpolation = (
  state: SpriteInterpolationState<number>,
  timestamp: number
): SpriteInterpolationEvaluationResult<number> => {
  const targetValue = state.pathTarget ?? state.to;

  const duration = Math.max(0, state.durationMs);
  const effectiveStart =
    state.startTimestamp >= 0 ? state.startTimestamp : timestamp;

  // When duration collapses or no meaningful delta exists, snap to the final value immediately.
  if (duration === 0 || Math.abs(targetValue - state.from) <= NUMERIC_EPSILON) {
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
  // rawProgress >= 1 indicates we've reached or passed the end of the animation window.
  const completed = rawProgress >= 1;

  return {
    value: completed ? state.to : interpolated,
    completed,
    effectiveStartTimestamp: effectiveStart,
  };
};

//////////////////////////////////////////////////////////////////////////////////////////

const DEGREE_INTERPOLATION_CHANNELS: Record<
  'rotation' | 'offsetDeg',
  SpriteInterpolationChannelDescriptor
> = {
  rotation: {
    resolveInterpolation: (image) => image.finalRotateDeg.interpolation,
    normalize: normalizeAngleDeg,
    applyValue: (image, value) => {
      image.finalRotateDeg.current = normalizeAngleDeg(value);
    },
    applyFinalValue: (image, value) => {
      image.finalRotateDeg.current = normalizeAngleDeg(value);
      image.finalRotateDeg.from = undefined;
      image.finalRotateDeg.to = undefined;
    },
  },
  offsetDeg: {
    resolveInterpolation: (image) => image.offset.offsetDeg.interpolation,
    applyValue: (image, value) => {
      image.offset.offsetDeg.current = value;
    },
    applyFinalValue: (image, value) => {
      image.offset.offsetDeg.current = value;
      image.offset.offsetDeg.from = undefined;
      image.offset.offsetDeg.to = undefined;
    },
  },
};

const updateDegreeInterpolationState = (
  image: InternalSpriteImageState,
  descriptor: SpriteInterpolationChannelDescriptor,
  nextState: SpriteInterpolationState<number> | null
): void => {
  descriptor.resolveInterpolation(image).state = nextState;
};

export interface DegreeInterpolationWorkItem
  extends SpriteInterpolationState<number> {
  readonly descriptor: SpriteInterpolationChannelDescriptor;
  readonly image: InternalSpriteImageState;
  readonly channel: 'rotation' | 'offsetDeg';
}

export const collectDegreeInterpolationWorkItems = (
  image: InternalSpriteImageState,
  workItems: DegreeInterpolationWorkItem[]
): void => {
  const rotationState =
    DEGREE_INTERPOLATION_CHANNELS.rotation.resolveInterpolation(image).state;
  if (rotationState) {
    workItems.push({
      ...rotationState,
      descriptor: DEGREE_INTERPOLATION_CHANNELS.rotation,
      image,
      channel: 'rotation',
    });
  }

  const offsetState =
    DEGREE_INTERPOLATION_CHANNELS.offsetDeg.resolveInterpolation(image).state;
  if (offsetState) {
    workItems.push({
      ...offsetState,
      descriptor: DEGREE_INTERPOLATION_CHANNELS.offsetDeg,
      image,
      channel: 'offsetDeg',
    });
  }
};

export const applyDegreeInterpolationEvaluations = (
  workItems: readonly DegreeInterpolationWorkItem[],
  evaluations: readonly SpriteInterpolationEvaluationResult<number>[],
  timestamp: number
): boolean => {
  let active = false;
  for (let index = 0; index < workItems.length; index += 1) {
    const item = workItems[index]!;
    const evaluation =
      evaluations[index] ?? evaluateDegreeInterpolation(item, timestamp);

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
      updateDegreeInterpolationState(item.image, item.descriptor, null);
    } else {
      updateDegreeInterpolationState(item.image, item.descriptor, item);
      active = true;
    }
  }
  return active;
};
