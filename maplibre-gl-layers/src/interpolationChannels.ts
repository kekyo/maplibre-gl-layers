// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

/**
 * Utility helpers for managing sprite image interpolation channels.
 * Centralizes rotation and offset channel operations so SpriteLayer stays focused on orchestration.
 */

import type { SpriteInterpolationOptions, SpriteImageOffset } from './types';
import type {
  InternalSpriteImageState,
  DegreeInterpolationState,
  DistanceInterpolationState,
} from './internalTypes';

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

//////////////////////////////////////////////////////////////////////////////////////////

interface DegreeInterpolationStepOptions {
  readonly normalize?: (value: number) => number;
  readonly applyFinalValue?: (value: number) => void;
}

interface DegreeInterpolationStepResult {
  readonly state: DegreeInterpolationState | null;
  readonly active: boolean;
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

const updateImageDisplayedRotation = (
  image: InternalSpriteImageState,
  optionsOverride?: SpriteInterpolationOptions | null
): void => {
  const targetAngle = normalizeAngleDeg(
    image.resolvedBaseRotateDeg + image.rotateDeg
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
      image.offset.offsetDeg = value;
    }
  );

  image.offsetDegInterpolationState = state;
  return active;
};

/**
 * Clears any running offset angle interpolation.
 */
export const clearOffsetDegInterpolation = (
  image: InternalSpriteImageState
): void => {
  image.offsetDegInterpolationState = null;
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
  applyValue: (value: number) => void
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

  applyValue(evaluation.value);

  if (evaluation.completed) {
    applyValue(interpolationState.finalValue);
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
};

const applyOffsetDegUpdate = (
  image: InternalSpriteImageState,
  nextOffset: SpriteImageOffset,
  interpolationOptions?: SpriteInterpolationOptions | null
): void => {
  const options = interpolationOptions;

  if (!options || options.durationMs <= 0) {
    image.offset.offsetDeg = nextOffset.offsetDeg;
    image.offsetDegInterpolationState = null;
    image.lastCommandOffsetDeg = nextOffset.offsetDeg;
    return;
  }

  const { state, requiresInterpolation } = createDegreeInterpolationState({
    currentValue: image.offset.offsetDeg,
    targetValue: nextOffset.offsetDeg,
    previousCommandValue: image.lastCommandOffsetDeg,
    options,
  });

  image.lastCommandOffsetDeg = nextOffset.offsetDeg;

  if (requiresInterpolation) {
    image.offsetDegInterpolationState = state;
  } else {
    image.offset.offsetDeg = nextOffset.offsetDeg;
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
    image.offset.offsetMeters = nextOffset.offsetMeters;
    image.offsetMetersInterpolationState = null;
    image.lastCommandOffsetMeters = nextOffset.offsetMeters;
    return;
  }

  const { state, requiresInterpolation } = createDistanceInterpolationState({
    currentValue: image.offset.offsetMeters,
    targetValue: nextOffset.offsetMeters,
    previousCommandValue: image.lastCommandOffsetMeters,
    options,
  });

  image.lastCommandOffsetMeters = nextOffset.offsetMeters;

  if (requiresInterpolation) {
    image.offsetMetersInterpolationState = state;
  } else {
    image.offset.offsetMeters = nextOffset.offsetMeters;
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
      image.offset.offsetMeters = value;
    }
  );

  image.offsetMetersInterpolationState = state;
  return active;
};

type ImageInterpolationStepper = (
  image: InternalSpriteImageState,
  timestamp: number
) => boolean;

const IMAGE_INTERPOLATION_STEPPERS: readonly ImageInterpolationStepper[] = [
  stepRotationInterpolation,
  stepOffsetDegInterpolation,
  stepOffsetMetersInterpolation,
];

/**
 * Executes all interpolation steppers for an image and reports whether any remain active.
 */
export const stepSpriteImageInterpolations = (
  image: InternalSpriteImageState,
  timestamp: number
): boolean => {
  let active = false;
  for (const stepper of IMAGE_INTERPOLATION_STEPPERS) {
    if (stepper(image, timestamp)) {
      active = true;
    }
  }
  return active;
};

interface ApplyOffsetUpdateOptions {
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
