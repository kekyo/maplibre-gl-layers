// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

/**
 * Utility helpers for managing sprite image interpolation channels.
 * Centralizes rotation and offset channel operations so SpriteLayer stays focused on orchestration.
 */

import type { SpriteInterpolationOptions, SpriteImageOffset } from '../types';
import type {
  InternalSpriteImageState,
  DegreeInterpolationState,
  DistanceInterpolationState,
} from '../internalTypes';

import {
  createDegreeInterpolationState,
  evaluateDegreeInterpolation,
} from './degreeInterpolation';
import {
  createDistanceInterpolationState,
  evaluateDistanceInterpolation,
} from './distanceInterpolation';
import {
  normalizeAngleDeg,
  resolveRotationTarget,
} from './rotationInterpolation';
import { clampOpacity } from '../utils/math';

//////////////////////////////////////////////////////////////////////////////////////////

interface DegreeInterpolationStepOptions {
  readonly normalize?: (value: number) => number;
  readonly applyFinalValue?: (value: number) => void;
}

interface DegreeInterpolationStepResult {
  readonly state: DegreeInterpolationState | null;
  readonly active: boolean;
}

interface DistanceInterpolationStepOptions {
  readonly normalize?: (value: number) => number;
  readonly applyFinalValue?: (value: number) => void;
}

const stepDegreeInterpolationState = (
  interpolationState: DegreeInterpolationState | null,
  timestamp: number,
  applyValue: (value: number) => void,
  options?: DegreeInterpolationStepOptions
): DegreeInterpolationStepResult => {
  if (!interpolationState) {
    return { state: null, active: false };
  }

  const evaluation = evaluateDegreeInterpolation({
    state: interpolationState,
    timestamp,
  });

  if (interpolationState.startTimestamp < 0) {
    interpolationState.startTimestamp = evaluation.effectiveStartTimestamp;
  }

  const normalizeValue = options?.normalize ?? ((value: number) => value);
  const applyFinalValue = options?.applyFinalValue ?? applyValue;

  const interpolatedValue = normalizeValue(evaluation.value);
  applyValue(interpolatedValue);

  if (evaluation.completed) {
    const finalValue = normalizeValue(interpolationState.finalValue);
    applyFinalValue(finalValue);
    return { state: null, active: false };
  }

  return { state: interpolationState, active: true };
};

const resolveManualRotationFromDisplayed = (
  image: InternalSpriteImageState
): number => {
  const baseRotation = image.resolvedBaseRotateDeg ?? 0;
  const fallbackRotation = normalizeAngleDeg(
    baseRotation + image.rotationCommandDeg
  );
  const displayedRotation = Number.isFinite(image.displayedRotateDeg)
    ? image.displayedRotateDeg
    : fallbackRotation;
  return normalizeAngleDeg(displayedRotation - baseRotation);
};

const refreshRotateDegInterpolatedValues = (
  image: InternalSpriteImageState
): void => {
  image.rotateDeg.current = resolveManualRotationFromDisplayed(image);
  if (!image.rotationInterpolationState) {
    image.rotateDeg.from = undefined;
    image.rotateDeg.to = undefined;
  }
};

const updateImageDisplayedRotation = (
  image: InternalSpriteImageState,
  optionsOverride?: SpriteInterpolationOptions | null
): void => {
  const targetAngle = normalizeAngleDeg(
    image.resolvedBaseRotateDeg + image.rotationCommandDeg
  );
  const currentAngle = Number.isFinite(image.displayedRotateDeg)
    ? image.displayedRotateDeg
    : targetAngle;
  const previousCommandAngle = image.lastCommandRotateDeg;

  const options =
    optionsOverride === undefined
      ? image.rotationInterpolationOptions
      : optionsOverride;

  const { nextAngleDeg, interpolationState } = resolveRotationTarget({
    currentAngleDeg: currentAngle,
    targetAngleDeg: targetAngle,
    previousCommandAngleDeg: previousCommandAngle,
    options: options ?? undefined,
  });

  image.displayedRotateDeg = nextAngleDeg;
  image.rotationInterpolationState = interpolationState;

  if (!interpolationState) {
    image.displayedRotateDeg = targetAngle;
  }
  image.lastCommandRotateDeg = targetAngle;
};

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Ensures the rotation channel reflects the latest targets, optionally overriding interpolation.
 */
export const syncImageRotationChannel = (
  image: InternalSpriteImageState,
  optionsOverride?: SpriteInterpolationOptions | null
): void => {
  updateImageDisplayedRotation(image, optionsOverride);
  refreshRotateDegInterpolatedValues(image);
};

const stepRotationInterpolation = (
  image: InternalSpriteImageState,
  timestamp: number
): boolean => {
  const { state, active } = stepDegreeInterpolationState(
    image.rotationInterpolationState,
    timestamp,
    (value) => {
      image.displayedRotateDeg = value;
    },
    {
      normalize: normalizeAngleDeg,
    }
  );

  image.rotationInterpolationState = state;
  refreshRotateDegInterpolatedValues(image);
  return active;
};

const stepOffsetDegInterpolation = (
  image: InternalSpriteImageState,
  timestamp: number
): boolean => {
  const { state, active } = stepDegreeInterpolationState(
    image.offsetDegInterpolationState,
    timestamp,
    (value) => {
      image.offset.offsetDeg.current = value;
    }
  );

  image.offsetDegInterpolationState = state;
  if (!state) {
    image.offset.offsetDeg.from = undefined;
    image.offset.offsetDeg.to = undefined;
  }
  return active;
};

/**
 * Clears any running offset angle interpolation.
 */
export const clearOffsetDegInterpolation = (
  image: InternalSpriteImageState
): void => {
  image.offsetDegInterpolationState = null;
  image.offset.offsetDeg.from = undefined;
  image.offset.offsetDeg.to = undefined;
};

/**
 * Container used by the distance interpolation helper.
 */
interface DistanceInterpolationStepResult {
  readonly state: DistanceInterpolationState | null;
  readonly active: boolean;
}

const stepDistanceInterpolationState = (
  interpolationState: DistanceInterpolationState | null,
  timestamp: number,
  applyValue: (value: number) => void,
  options?: DistanceInterpolationStepOptions
): DistanceInterpolationStepResult => {
  if (!interpolationState) {
    return { state: null, active: false };
  }

  const evaluation = evaluateDistanceInterpolation({
    state: interpolationState,
    timestamp,
  });

  if (interpolationState.startTimestamp < 0) {
    interpolationState.startTimestamp = evaluation.effectiveStartTimestamp;
  }

  const normalizeValue = options?.normalize ?? ((value: number) => value);
  const applyFinalValue = options?.applyFinalValue ?? applyValue;

  const interpolatedValue = normalizeValue(evaluation.value);
  applyValue(interpolatedValue);

  if (evaluation.completed) {
    const finalValue = normalizeValue(interpolationState.finalValue);
    applyFinalValue(finalValue);
    return { state: null, active: false };
  }

  return { state: interpolationState, active: true };
};

/**
 * Clears any running offset distance interpolation in meters.
 */
export const clearOffsetMetersInterpolation = (
  image: InternalSpriteImageState
): void => {
  image.offsetMetersInterpolationState = null;
  image.offset.offsetMeters.from = undefined;
  image.offset.offsetMeters.to = undefined;
};

/**
 * Clears any running opacity interpolation.
 */
export const clearOpacityInterpolation = (
  image: InternalSpriteImageState
): void => {
  image.opacityInterpolationState = null;
};

const applyOffsetDegUpdate = (
  image: InternalSpriteImageState,
  nextOffset: SpriteImageOffset,
  interpolationOptions?: SpriteInterpolationOptions | null
): void => {
  const options = interpolationOptions;

  if (!options || options.durationMs <= 0) {
    image.offset.offsetDeg.current = nextOffset.offsetDeg;
    image.offset.offsetDeg.from = undefined;
    image.offset.offsetDeg.to = undefined;
    image.offsetDegInterpolationState = null;
    image.lastCommandOffsetDeg = nextOffset.offsetDeg;
    return;
  }

  const { state, requiresInterpolation } = createDegreeInterpolationState({
    currentValue: image.offset.offsetDeg.current,
    targetValue: nextOffset.offsetDeg,
    previousCommandValue: image.lastCommandOffsetDeg,
    options,
  });

  image.lastCommandOffsetDeg = nextOffset.offsetDeg;

  if (requiresInterpolation) {
    image.offsetDegInterpolationState = state;
    image.offset.offsetDeg.from = image.offset.offsetDeg.current;
    image.offset.offsetDeg.to = nextOffset.offsetDeg;
  } else {
    image.offset.offsetDeg.current = nextOffset.offsetDeg;
    image.offset.offsetDeg.from = undefined;
    image.offset.offsetDeg.to = undefined;
    image.offsetDegInterpolationState = null;
  }
};

const applyOffsetMetersUpdate = (
  image: InternalSpriteImageState,
  nextOffset: SpriteImageOffset,
  interpolationOptions?: SpriteInterpolationOptions | null
): void => {
  const options = interpolationOptions;

  if (!options || options.durationMs <= 0) {
    image.offset.offsetMeters.current = nextOffset.offsetMeters;
    image.offset.offsetMeters.from = undefined;
    image.offset.offsetMeters.to = undefined;
    image.offsetMetersInterpolationState = null;
    image.lastCommandOffsetMeters = nextOffset.offsetMeters;
    return;
  }

  const { state, requiresInterpolation } = createDistanceInterpolationState({
    currentValue: image.offset.offsetMeters.current,
    targetValue: nextOffset.offsetMeters,
    previousCommandValue: image.lastCommandOffsetMeters,
    options,
  });

  image.lastCommandOffsetMeters = nextOffset.offsetMeters;

  if (requiresInterpolation) {
    image.offsetMetersInterpolationState = state;
    image.offset.offsetMeters.from = image.offset.offsetMeters.current;
    image.offset.offsetMeters.to = nextOffset.offsetMeters;
  } else {
    image.offset.offsetMeters.current = nextOffset.offsetMeters;
    image.offset.offsetMeters.from = undefined;
    image.offset.offsetMeters.to = undefined;
    image.offsetMetersInterpolationState = null;
  }
};

const stepOffsetMetersInterpolation = (
  image: InternalSpriteImageState,
  timestamp: number
): boolean => {
  const { state, active } = stepDistanceInterpolationState(
    image.offsetMetersInterpolationState,
    timestamp,
    (value) => {
      image.offset.offsetMeters.current = value;
    }
  );

  image.offsetMetersInterpolationState = state;
  if (!state) {
    image.offset.offsetMeters.from = undefined;
    image.offset.offsetMeters.to = undefined;
  }
  return active;
};

export const applyOpacityUpdate = (
  image: InternalSpriteImageState,
  nextOpacity: number,
  interpolationOptions?: SpriteInterpolationOptions | null
): void => {
  const clampedTarget = clampOpacity(nextOpacity);
  const options = interpolationOptions;

  if (!options || options.durationMs <= 0) {
    image.opacity.current = clampedTarget;
    image.opacity.from = undefined;
    image.opacity.to = undefined;
    image.opacityInterpolationState = null;
    image.lastCommandOpacity = clampedTarget;
    image.opacityTargetValue = clampedTarget;
    image.lodLastCommandOpacity = clampedTarget;
    return;
  }

  const { state, requiresInterpolation } = createDistanceInterpolationState({
    currentValue: clampOpacity(image.opacity.current),
    targetValue: clampedTarget,
    previousCommandValue: image.lastCommandOpacity,
    options,
  });

  image.lastCommandOpacity = clampedTarget;
  image.opacityTargetValue = clampedTarget;
  image.lodLastCommandOpacity = clampedTarget;

  if (requiresInterpolation) {
    image.opacityInterpolationState = state;
    image.opacity.from = image.opacity.current;
    image.opacity.to = clampedTarget;
  } else {
    image.opacity.current = clampedTarget;
    image.opacity.from = undefined;
    image.opacity.to = undefined;
    image.opacityInterpolationState = null;
  }
};

const stepOpacityInterpolation = (
  image: InternalSpriteImageState,
  timestamp: number
): boolean => {
  const { state, active } = stepDistanceInterpolationState(
    image.opacityInterpolationState,
    timestamp,
    (value) => {
      image.opacity.current = value;
    },
    {
      normalize: clampOpacity,
    }
  );

  image.opacityInterpolationState = state;
  if (!state) {
    image.opacity.from = undefined;
    image.opacity.to = undefined;
  }
  return active;
};

type ImageInterpolationStepper = (
  image: InternalSpriteImageState,
  timestamp: number
) => boolean;

export type ImageInterpolationStepperId =
  | 'rotation'
  | 'offsetDeg'
  | 'offsetMeters'
  | 'opacity';

interface ImageInterpolationStepperEntry {
  readonly id: ImageInterpolationStepperId;
  readonly step: ImageInterpolationStepper;
}

const IMAGE_INTERPOLATION_STEPPERS: readonly ImageInterpolationStepperEntry[] =
  [
    { id: 'rotation', step: stepRotationInterpolation },
    { id: 'offsetDeg', step: stepOffsetDegInterpolation },
    { id: 'offsetMeters', step: stepOffsetMetersInterpolation },
    { id: 'opacity', step: stepOpacityInterpolation },
  ];

/**
 * Executes all interpolation steppers for an image and reports whether any remain active.
 */
export interface StepSpriteImageInterpolationOptions {
  readonly skipChannels?: Partial<Record<ImageInterpolationStepperId, boolean>>;
}

export const stepSpriteImageInterpolations = (
  image: InternalSpriteImageState,
  timestamp: number,
  options?: StepSpriteImageInterpolationOptions
): boolean => {
  let active = false;
  const skipChannels = options?.skipChannels ?? null;
  for (const { id, step } of IMAGE_INTERPOLATION_STEPPERS) {
    if (skipChannels && skipChannels[id]) {
      continue;
    }
    if (step(image, timestamp)) {
      active = true;
    }
  }
  return active;
};

export const hasActiveImageInterpolations = (
  image: InternalSpriteImageState
): boolean => {
  return (
    image.rotationInterpolationState !== null ||
    image.offsetDegInterpolationState !== null ||
    image.offsetMetersInterpolationState !== null ||
    image.opacityInterpolationState !== null
  );
};

export interface ApplyOffsetUpdateOptions {
  readonly deg?: SpriteInterpolationOptions | null;
  readonly meters?: SpriteInterpolationOptions | null;
}

/**
 * Applies offset updates across both angular and radial channels.
 */
export const applyOffsetUpdate = (
  image: InternalSpriteImageState,
  nextOffset: SpriteImageOffset,
  options: ApplyOffsetUpdateOptions = {}
): void => {
  applyOffsetDegUpdate(image, nextOffset, options.deg);
  applyOffsetMetersUpdate(image, nextOffset, options.meters);
};
