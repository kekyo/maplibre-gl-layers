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
  SpriteInterpolationState,
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
  readonly state: SpriteInterpolationState<number> | null;
  readonly active: boolean;
}

interface DistanceInterpolationStepOptions {
  readonly normalize?: (value: number) => number;
  readonly applyFinalValue?: (value: number) => void;
}

const stepDegreeInterpolationState = (
  interpolationState: SpriteInterpolationState<number> | null,
  timestamp: number,
  applyValue: (value: number) => void,
  options?: DegreeInterpolationStepOptions
): DegreeInterpolationStepResult => {
  if (!interpolationState) {
    return { state: null, active: false };
  }

  const evaluation = evaluateDegreeInterpolation(interpolationState, timestamp);

  if (interpolationState.startTimestamp < 0) {
    interpolationState.startTimestamp = evaluation.effectiveStartTimestamp;
  }

  const normalizeValue = options?.normalize ?? ((value: number) => value);
  const applyFinalValue = options?.applyFinalValue ?? applyValue;

  const interpolatedValue = normalizeValue(evaluation.value);
  applyValue(interpolatedValue);

  if (evaluation.completed) {
    const finalValue = normalizeValue(interpolationState.to);
    applyFinalValue(finalValue);
    return { state: null, active: false };
  }

  return { state: interpolationState, active: true };
};

const resolveAutoRotationDeg = (
  image: InternalSpriteImageState,
  spriteAutoRotationDeg: number
): number => {
  return image.autoRotation ? spriteAutoRotationDeg : 0;
};

const resolveCurrentRotation = (
  image: InternalSpriteImageState,
  spriteAutoRotationDeg: number
): number => {
  const targetAngle = normalizeAngleDeg(
    resolveAutoRotationDeg(image, spriteAutoRotationDeg) + image.rotateDeg
  );
  const current = image.finalRotateDeg.current;
  return Number.isFinite(current) ? normalizeAngleDeg(current) : targetAngle;
};

const refreshRotateDegInterpolatedValues = (
  image: InternalSpriteImageState,
  spriteAutoRotationDeg: number
): void => {
  image.finalRotateDeg.current = resolveCurrentRotation(
    image,
    spriteAutoRotationDeg
  );
  if (!image.finalRotateDeg.interpolation.state) {
    image.finalRotateDeg.from = undefined;
    image.finalRotateDeg.to = undefined;
  }
};

const updateImageDisplayedRotation = (
  image: InternalSpriteImageState,
  spriteAutoRotationDeg: number,
  optionsOverride?: SpriteInterpolationOptions | null
): void => {
  const targetAngle = normalizeAngleDeg(
    resolveAutoRotationDeg(image, spriteAutoRotationDeg) + image.rotateDeg
  );
  const currentAngle = resolveCurrentRotation(image, spriteAutoRotationDeg);
  const previousCommandAngle =
    image.finalRotateDeg.interpolation.lastCommandValue;

  const options =
    optionsOverride === undefined
      ? image.finalRotateDeg.interpolation.options
      : optionsOverride;

  const { nextAngleDeg, interpolationState } = resolveRotationTarget({
    currentAngleDeg: currentAngle,
    targetAngleDeg: targetAngle,
    previousCommandAngleDeg: previousCommandAngle,
    options: options ?? undefined,
  });

  image.finalRotateDeg.current = normalizeAngleDeg(
    Number.isFinite(nextAngleDeg) ? nextAngleDeg : targetAngle
  );
  image.finalRotateDeg.interpolation.state = interpolationState;

  if (!interpolationState) {
    image.finalRotateDeg.current = targetAngle;
    image.finalRotateDeg.from = undefined;
    image.finalRotateDeg.to = undefined;
  } else {
    image.finalRotateDeg.from = normalizeAngleDeg(currentAngle);
    image.finalRotateDeg.to = normalizeAngleDeg(targetAngle);
  }
  image.finalRotateDeg.interpolation.lastCommandValue = targetAngle;
};

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Ensures the rotation channel reflects the latest targets, optionally overriding interpolation.
 */
export const syncImageRotationChannel = (
  image: InternalSpriteImageState,
  spriteAutoRotationDeg: number,
  optionsOverride?: SpriteInterpolationOptions | null
): void => {
  updateImageDisplayedRotation(image, spriteAutoRotationDeg, optionsOverride);
  refreshRotateDegInterpolatedValues(image, spriteAutoRotationDeg);
};

const stepRotationInterpolation = (
  image: InternalSpriteImageState,
  spriteAutoRotationDeg: number,
  timestamp: number
): boolean => {
  const { state, active } = stepDegreeInterpolationState(
    image.finalRotateDeg.interpolation.state,
    timestamp,
    (value) => {
      const fallback = normalizeAngleDeg(
        resolveAutoRotationDeg(image, spriteAutoRotationDeg) + image.rotateDeg
      );
      image.finalRotateDeg.current = normalizeAngleDeg(
        Number.isFinite(value) ? value : fallback
      );
    },
    {
      normalize: (value) => {
        const fallback = normalizeAngleDeg(
          resolveAutoRotationDeg(image, spriteAutoRotationDeg) + image.rotateDeg
        );
        return normalizeAngleDeg(Number.isFinite(value) ? value : fallback);
      },
    }
  );

  image.finalRotateDeg.interpolation.state = state;
  refreshRotateDegInterpolatedValues(image, spriteAutoRotationDeg);
  return active;
};

const stepOffsetDegInterpolation = (
  image: InternalSpriteImageState,
  timestamp: number
): boolean => {
  const { state, active } = stepDegreeInterpolationState(
    image.offset.offsetDeg.interpolation.state,
    timestamp,
    (value) => {
      image.offset.offsetDeg.current = value;
    }
  );

  image.offset.offsetDeg.interpolation.state = state;
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
  image.offset.offsetDeg.interpolation.state = null;
  image.offset.offsetDeg.from = undefined;
  image.offset.offsetDeg.to = undefined;
};

/**
 * Container used by the distance interpolation helper.
 */
interface DistanceInterpolationStepResult {
  readonly state: SpriteInterpolationState<number> | null;
  readonly active: boolean;
}

const stepDistanceInterpolationState = (
  interpolationState: SpriteInterpolationState<number> | null,
  timestamp: number,
  applyValue: (value: number) => void,
  options?: DistanceInterpolationStepOptions
): DistanceInterpolationStepResult => {
  if (!interpolationState) {
    return { state: null, active: false };
  }

  const evaluation = evaluateDistanceInterpolation(
    interpolationState,
    timestamp
  );

  if (interpolationState.startTimestamp < 0) {
    interpolationState.startTimestamp = evaluation.effectiveStartTimestamp;
  }

  const normalizeValue = options?.normalize ?? ((value: number) => value);
  const applyFinalValue = options?.applyFinalValue ?? applyValue;

  const interpolatedValue = normalizeValue(evaluation.value);
  applyValue(interpolatedValue);

  if (evaluation.completed) {
    const finalValue = normalizeValue(interpolationState.to);
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
  image.offset.offsetMeters.interpolation.state = null;
  image.offset.offsetMeters.from = undefined;
  image.offset.offsetMeters.to = undefined;
};

/**
 * Clears any running opacity interpolation.
 */
export const clearOpacityInterpolation = (
  image: InternalSpriteImageState
): void => {
  image.finalOpacity.interpolation.state = null;
  image.finalOpacity.from = undefined;
  image.finalOpacity.to = undefined;
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
    image.offset.offsetDeg.interpolation.state = null;
    image.offset.offsetDeg.interpolation.lastCommandValue =
      nextOffset.offsetDeg;
    return;
  }

  const { state, requiresInterpolation } = createDegreeInterpolationState({
    currentValue: image.offset.offsetDeg.current,
    targetValue: nextOffset.offsetDeg,
    previousCommandValue: image.offset.offsetDeg.interpolation.lastCommandValue,
    options,
  });

  image.offset.offsetDeg.interpolation.lastCommandValue = nextOffset.offsetDeg;

  if (requiresInterpolation) {
    image.offset.offsetDeg.interpolation.state = state;
    image.offset.offsetDeg.from = image.offset.offsetDeg.current;
    image.offset.offsetDeg.to = nextOffset.offsetDeg;
  } else {
    image.offset.offsetDeg.current = nextOffset.offsetDeg;
    image.offset.offsetDeg.from = undefined;
    image.offset.offsetDeg.to = undefined;
    image.offset.offsetDeg.interpolation.state = null;
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
    image.offset.offsetMeters.interpolation.state = null;
    image.offset.offsetMeters.interpolation.lastCommandValue =
      nextOffset.offsetMeters;
    return;
  }

  const { state, requiresInterpolation } = createDistanceInterpolationState({
    currentValue: image.offset.offsetMeters.current,
    targetValue: nextOffset.offsetMeters,
    previousCommandValue:
      image.offset.offsetMeters.interpolation.lastCommandValue,
    options,
  });

  image.offset.offsetMeters.interpolation.lastCommandValue =
    nextOffset.offsetMeters;

  if (requiresInterpolation) {
    image.offset.offsetMeters.interpolation.state = state;
    image.offset.offsetMeters.from = image.offset.offsetMeters.current;
    image.offset.offsetMeters.to = nextOffset.offsetMeters;
  } else {
    image.offset.offsetMeters.current = nextOffset.offsetMeters;
    image.offset.offsetMeters.from = undefined;
    image.offset.offsetMeters.to = undefined;
    image.offset.offsetMeters.interpolation.state = null;
  }
};

const stepOffsetMetersInterpolation = (
  image: InternalSpriteImageState,
  timestamp: number
): boolean => {
  const { state, active } = stepDistanceInterpolationState(
    image.offset.offsetMeters.interpolation.state,
    timestamp,
    (value) => {
      image.offset.offsetMeters.current = value;
    }
  );

  image.offset.offsetMeters.interpolation.state = state;
  if (!state) {
    image.offset.offsetMeters.from = undefined;
    image.offset.offsetMeters.to = undefined;
  }
  return active;
};

const runOpacityTargetTransition = (
  image: InternalSpriteImageState,
  targetOpacity: number,
  interpolationOptions: SpriteInterpolationOptions | null
): void => {
  const clampedTarget = clampOpacity(targetOpacity);
  const options = interpolationOptions;

  if (!options || options.durationMs <= 0) {
    image.finalOpacity.current = clampedTarget;
    image.finalOpacity.from = undefined;
    image.finalOpacity.to = undefined;
    image.finalOpacity.interpolation.state = null;
  } else {
    const { state, requiresInterpolation } = createDistanceInterpolationState({
      currentValue: clampOpacity(image.finalOpacity.current),
      targetValue: clampedTarget,
      previousCommandValue: image.finalOpacity.interpolation.lastCommandValue,
      options,
    });

    if (requiresInterpolation) {
      image.finalOpacity.interpolation.state = state;
      image.finalOpacity.from = image.finalOpacity.current;
      image.finalOpacity.to = clampedTarget;
    } else {
      image.finalOpacity.current = clampedTarget;
      image.finalOpacity.from = undefined;
      image.finalOpacity.to = undefined;
      image.finalOpacity.interpolation.state = null;
    }
  }

  image.finalOpacity.interpolation.lastCommandValue = clampedTarget;
  image.finalOpacity.interpolation.targetValue = clampedTarget;
};

export const applyOpacityUpdate = (
  image: InternalSpriteImageState,
  nextOpacity: number,
  interpolationOptions?: SpriteInterpolationOptions | null,
  spriteOpacityMultiplier = 1
): void => {
  const clampedBase = clampOpacity(nextOpacity);
  const lodMultiplier =
    typeof image.lodOpacity === 'number' ? image.lodOpacity : 1;
  image.finalOpacity.interpolation.baseValue = clampedBase;
  image.opacity = clampedBase;
  runOpacityTargetTransition(
    image,
    clampedBase * spriteOpacityMultiplier * lodMultiplier,
    interpolationOptions ?? null
  );
};

export const applyResolvedOpacityTarget = (
  image: InternalSpriteImageState,
  resolvedTarget: number,
  interpolationOptions?: SpriteInterpolationOptions | null
): void => {
  runOpacityTargetTransition(
    image,
    resolvedTarget,
    interpolationOptions ?? null
  );
};

const stepOpacityInterpolation = (
  image: InternalSpriteImageState,
  timestamp: number
): boolean => {
  const { state, active } = stepDistanceInterpolationState(
    image.finalOpacity.interpolation.state,
    timestamp,
    (value) => {
      image.finalOpacity.current = value;
    },
    {
      normalize: clampOpacity,
    }
  );

  image.finalOpacity.interpolation.state = state;
  if (!state) {
    image.finalOpacity.from = undefined;
    image.finalOpacity.to = undefined;
  }
  return active;
};

type ImageInterpolationStepper = (
  image: InternalSpriteImageState,
  timestamp: number,
  autoRotationDeg: number
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
    {
      id: 'offsetDeg',
      step: (image, timestamp, _autoRotationDeg) =>
        stepOffsetDegInterpolation(image, timestamp),
    },
    {
      id: 'offsetMeters',
      step: (image, timestamp, _autoRotationDeg) =>
        stepOffsetMetersInterpolation(image, timestamp),
    },
    {
      id: 'opacity',
      step: (image, timestamp, _autoRotationDeg) =>
        stepOpacityInterpolation(image, timestamp),
    },
  ] as const;

/**
 * Executes all interpolation steppers for an image and reports whether any remain active.
 */
export interface StepSpriteImageInterpolationOptions {
  readonly skipChannels?: Partial<Record<ImageInterpolationStepperId, boolean>>;
  readonly autoRotationDeg?: number;
}

export const stepSpriteImageInterpolations = (
  image: InternalSpriteImageState,
  timestamp: number,
  options?: StepSpriteImageInterpolationOptions
): boolean => {
  let active = false;
  const skipChannels = options?.skipChannels ?? null;
  const autoRotationDeg = options?.autoRotationDeg ?? 0;
  for (const { id, step } of IMAGE_INTERPOLATION_STEPPERS) {
    if (skipChannels && skipChannels[id]) {
      continue;
    }
    if (step(image, timestamp, autoRotationDeg)) {
      active = true;
    }
  }
  return active;
};

export const hasActiveImageInterpolations = (
  image: InternalSpriteImageState
): boolean => {
  return (
    image.finalRotateDeg.interpolation.state !== null ||
    image.offset.offsetDeg.interpolation.state !== null ||
    image.offset.offsetMeters.interpolation.state !== null ||
    image.finalOpacity.interpolation.state !== null
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
