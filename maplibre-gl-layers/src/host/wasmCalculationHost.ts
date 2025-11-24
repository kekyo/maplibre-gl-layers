// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  ImageHandleBufferController,
  IdHandler,
  InternalSpriteCurrentState,
  InternalSpriteImageState,
  MutableSpriteScreenPoint,
  PreparedDrawSpriteImageParams,
  PrepareDrawSpriteImageParams,
  Releasable,
  RegisteredImage,
  RenderCalculationHost,
  RenderInterpolationParams,
  RenderInterpolationResult,
  ProcessDrawSpriteImagesParams,
  ProcessDrawSpriteImagesResult,
  SurfaceShaderCornerState,
  SurfaceShaderInputs,
  SpriteOriginReference,
  SpriteInterpolationEvaluationResult,
  SpriteInterpolationState,
} from '../internalTypes';
import {
  SURFACE_CORNER_DISPLACEMENT_COUNT,
  calculateMetersPerPixelAtLatitude,
  calculateEffectivePixelsPerMeter,
  calculateDistanceScaleFactor,
  calculateCartesianDistanceMeters,
  multiplyMatrixAndVector,
  type SurfaceCorner,
  normalizeAngleDeg,
} from '../utils/math';
import type {
  SpriteAnchor,
  SpriteLocation,
  SpritePoint,
  SpriteMode,
  SpriteEasingParam,
  SpriteEasingType,
} from '../types';
import { prepareWasmHost, type BufferHolder, type WasmHost } from './wasmHost';
import {
  collectDistanceInterpolationWorkItems,
  applyDistanceInterpolationEvaluations,
  type DistanceInterpolationWorkItem,
} from '../interpolation/distanceInterpolation';
import {
  collectDegreeInterpolationWorkItems,
  applyDegreeInterpolationEvaluations,
  type DegreeInterpolationWorkItem,
} from '../interpolation/degreeInterpolation';
import {
  applyLocationInterpolationEvaluations,
  collectLocationInterpolationWorkItems,
  type LocationInterpolationWorkItem,
} from '../interpolation/locationInterpolation';
import {
  stepSpriteImageInterpolations,
  type ImageInterpolationStepperId,
  hasActiveImageInterpolations,
} from '../interpolation/interpolationChannels';
import {
  createCalculationHost,
  DEFAULT_RENDER_INTERPOLATION_RESULT,
  processOpacityInterpolationsAfterPreparation,
  applyVisibilityDistanceLod,
  syncPreparedOpacities,
  filterVisiblePreparedItems,
  type ProcessInterpolationPresetRequests,
} from './calculationHost';
import {
  prepareProjectionState,
  type PreparedProjectionState,
  type ProjectionHostParams,
} from './projectionHost';
import {
  MIN_CLIP_Z_EPSILON,
  TRIANGLE_INDICES,
  ORDER_BUCKET,
  ORDER_MAX,
  EPS_NDC,
  EARTH_RADIUS_METERS,
  DEG2RAD,
} from '../const';
import {
  ENABLE_NDC_BIAS_SURFACE,
  USE_SHADER_BILLBOARD_GEOMETRY,
  USE_SHADER_SURFACE_GEOMETRY,
} from '../config';
import {
  SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
  SPRITE_ORIGIN_REFERENCE_KEY_NONE,
} from '../internalTypes';
import { QUAD_VERTEX_COUNT, VERTEX_COMPONENT_COUNT } from '../gl/shader';
import { reportWasmRuntimeFailure } from './runtime';

//////////////////////////////////////////////////////////////////////////////////////

const WASM_CalculateSurfaceDepthKey_MATRIX_ELEMENT_COUNT = 16;
const WASM_CalculateSurfaceDepthKey_DISPLACEMENT_ELEMENT_COUNT =
  SURFACE_CORNER_DISPLACEMENT_COUNT * 2;
const WASM_CalculateSurfaceDepthKey_RESULT_ELEMENT_COUNT = 1;

// Must match constants defined in wasm/param_layouts.h.
const WASM_DISTANCE_INTERPOLATION_ITEM_LENGTH = 10;
const WASM_DISTANCE_INTERPOLATION_RESULT_LENGTH = 3;
const WASM_DEGREE_INTERPOLATION_ITEM_LENGTH = 10;
const WASM_DEGREE_INTERPOLATION_RESULT_LENGTH = 3;
const WASM_SPRITE_INTERPOLATION_ITEM_LENGTH = 14;
const WASM_SPRITE_INTERPOLATION_RESULT_LENGTH = 6;
const WASM_PROCESS_INTERPOLATIONS_HEADER_LENGTH = 3;

//////////////////////////////////////////////////////////////////////////////////////

const EASING_PRESET_IDS: Record<SpriteEasingType, number> = {
  linear: 0,
  ease: 1,
  exponential: 4,
  quadratic: 5,
  cubic: 6,
  sine: 7,
  bounce: 8,
  back: 9,
};

type EncodedEasingPreset = {
  readonly id: number;
  readonly param0: number;
  readonly param1: number;
  readonly param2: number;
};

const encodeEasingPreset = (preset: SpriteEasingParam): EncodedEasingPreset => {
  const id = EASING_PRESET_IDS[preset.type] ?? -1;
  switch (preset.type) {
    case 'ease': {
      const mode =
        preset.mode === 'in' ? 1 : preset.mode === 'out' ? 2 : /*in-out*/ 0;
      return { id, param0: preset.power ?? 3, param1: mode, param2: 0 };
    }
    case 'exponential': {
      const mode =
        preset.mode === 'in' ? 1 : preset.mode === 'out' ? 2 : /*in-out*/ 0;
      return {
        id,
        param0: preset.exponent ?? 5,
        param1: mode,
        param2: 0,
      };
    }
    case 'quadratic': {
      const mode =
        preset.mode === 'in' ? 1 : preset.mode === 'out' ? 2 : /*in-out*/ 0;
      return { id, param0: mode, param1: 0, param2: 0 };
    }
    case 'cubic': {
      const mode =
        preset.mode === 'in' ? 1 : preset.mode === 'out' ? 2 : /*in-out*/ 0;
      return { id, param0: mode, param1: 0, param2: 0 };
    }
    case 'sine': {
      const mode =
        preset.mode === 'in' ? 1 : preset.mode === 'out' ? 2 : /*in-out*/ 0;
      return {
        id,
        param0: mode,
        param1: preset.amplitude ?? 1,
        param2: 0,
      };
    }
    case 'bounce':
      return {
        id,
        param0: preset.bounces ?? 3,
        param1: preset.decay ?? 0.5,
        param2: 0,
      };
    case 'back':
      return { id, param0: preset.overshoot ?? 1.70158, param1: 0, param2: 0 };
    case 'linear':
    default:
      return { id, param0: 0, param1: 0, param2: 0 };
  }
};

//////////////////////////////////////////////////////////////////////////////////////

const MAX_MERCATOR_LATITUDE = 85.051129;

type ResolvedOffset = { offsetMeters: number; offsetDeg: number };

const resolveImageOffset = (
  image: Readonly<InternalSpriteImageState>
): ResolvedOffset => {
  const offset = image.offset;
  if (!offset) {
    return { offsetMeters: 0, offsetDeg: 0 };
  }
  return {
    offsetMeters: offset.offsetMeters.current,
    offsetDeg: offset.offsetDeg.current,
  };
};

const resolveAutoRotationDeg = <T>(
  sprite: Readonly<InternalSpriteCurrentState<T>>,
  image: Readonly<InternalSpriteImageState>
): number => {
  return image.autoRotation ? sprite.currentAutoRotateDeg : 0;
};

const encodeDistanceInterpolationRequest = (
  buffer: Float64Array,
  cursor: number,
  state: SpriteInterpolationState<number>,
  timestamp: number
): number => {
  const preset = encodeEasingPreset(state.easingParam);
  if (preset.id < 0) {
    throw new Error(
      'Distance interpolation request missing preset easing function.'
    );
  }
  buffer[cursor++] = state.durationMs;
  buffer[cursor++] = state.from;
  buffer[cursor++] = state.pathTarget ?? state.to;
  buffer[cursor++] = state.to;
  buffer[cursor++] = state.startTimestamp;
  buffer[cursor++] = timestamp;
  buffer[cursor++] = preset.id;
  buffer[cursor++] = preset.param0;
  buffer[cursor++] = preset.param1;
  buffer[cursor++] = preset.param2;
  return cursor;
};

const encodeDegreeInterpolationRequest = (
  buffer: Float64Array,
  cursor: number,
  state: SpriteInterpolationState<number>,
  timestamp: number
): number => {
  const preset = encodeEasingPreset(state.easingParam);
  if (preset.id < 0) {
    throw new Error(
      'Degree interpolation request missing preset easing function.'
    );
  }
  buffer[cursor++] = state.durationMs;
  buffer[cursor++] = state.from;
  buffer[cursor++] = state.pathTarget ?? state.to;
  buffer[cursor++] = state.to;
  buffer[cursor++] = state.startTimestamp;
  buffer[cursor++] = timestamp;
  buffer[cursor++] = preset.id;
  buffer[cursor++] = preset.param0;
  buffer[cursor++] = preset.param1;
  buffer[cursor++] = preset.param2;
  return cursor;
};

const encodeSpriteInterpolationRequest = (
  buffer: Float64Array,
  cursor: number,
  state: SpriteInterpolationState<SpriteLocation>,
  timestamp: number
): number => {
  const preset = encodeEasingPreset(state.easingParam);
  if (preset.id < 0) {
    throw new Error(
      'Sprite interpolation request missing preset easing function.'
    );
  }
  const hasZ = state.from.z !== undefined || state.to.z !== undefined ? 1 : 0;
  buffer[cursor++] = state.durationMs;
  buffer[cursor++] = state.from.lng;
  buffer[cursor++] = state.from.lat;
  buffer[cursor++] = state.from.z ?? 0;
  buffer[cursor++] = state.to.lng;
  buffer[cursor++] = state.to.lat;
  buffer[cursor++] = state.to.z ?? 0;
  buffer[cursor++] = hasZ;
  buffer[cursor++] = state.startTimestamp;
  buffer[cursor++] = timestamp;
  buffer[cursor++] = preset.id;
  buffer[cursor++] = preset.param0;
  buffer[cursor++] = preset.param1;
  buffer[cursor++] = preset.param2;
  return cursor;
};

const decodeSpriteInterpolationResult = (
  buffer: Float64Array,
  cursor: number
): {
  readonly nextCursor: number;
  readonly result: SpriteInterpolationEvaluationResult<SpriteLocation>;
} => {
  const lng = buffer[cursor++]!;
  const lat = buffer[cursor++]!;
  const z = buffer[cursor++]!;
  const hasZ = buffer[cursor++]! !== 0;
  const completed = buffer[cursor++]! !== 0;
  const effectiveStartTimestamp = buffer[cursor++]!;
  const value: SpriteLocation = hasZ ? { lng, lat, z } : { lng, lat };
  return {
    nextCursor: cursor,
    result: {
      value,
      completed,
      effectiveStartTimestamp,
    },
  };
};

interface WasmProcessInterpolationResults {
  readonly distance: SpriteInterpolationEvaluationResult<number>[];
  readonly degree: SpriteInterpolationEvaluationResult<number>[];
  readonly sprite: SpriteInterpolationEvaluationResult<SpriteLocation>[];
}

const processInterpolationsViaWasm = (
  wasm: WasmHost,
  requests: ProcessInterpolationPresetRequests,
  timestamp: number
): WasmProcessInterpolationResults => {
  const distanceCount = requests.distance.length;
  const degreeCount = requests.degree.length;
  const spriteCount = requests.sprite.length;

  if (distanceCount === 0 && degreeCount === 0 && spriteCount === 0) {
    return {
      distance: [],
      degree: [],
      sprite: [],
    };
  }

  const inputLength =
    WASM_PROCESS_INTERPOLATIONS_HEADER_LENGTH +
    distanceCount * WASM_DISTANCE_INTERPOLATION_ITEM_LENGTH +
    degreeCount * WASM_DEGREE_INTERPOLATION_ITEM_LENGTH +
    spriteCount * WASM_SPRITE_INTERPOLATION_ITEM_LENGTH;
  const resultLengthTotal =
    WASM_PROCESS_INTERPOLATIONS_HEADER_LENGTH +
    distanceCount * WASM_DISTANCE_INTERPOLATION_RESULT_LENGTH +
    degreeCount * WASM_DEGREE_INTERPOLATION_RESULT_LENGTH +
    spriteCount * WASM_SPRITE_INTERPOLATION_RESULT_LENGTH;

  const paramsHolder = wasm.allocateTypedBuffer(Float64Array, inputLength);
  const resultHolder = wasm.allocateTypedBuffer(
    Float64Array,
    resultLengthTotal
  );

  try {
    const paramsPrepared = paramsHolder.prepare();
    const paramsBuffer = paramsPrepared.buffer;
    paramsBuffer[0] = distanceCount;
    paramsBuffer[1] = degreeCount;
    paramsBuffer[2] = spriteCount;
    let cursor = WASM_PROCESS_INTERPOLATIONS_HEADER_LENGTH;
    for (const request of requests.distance) {
      cursor = encodeDistanceInterpolationRequest(
        paramsBuffer,
        cursor,
        request,
        timestamp
      );
    }
    for (const request of requests.degree) {
      cursor = encodeDegreeInterpolationRequest(
        paramsBuffer,
        cursor,
        request,
        timestamp
      );
    }
    for (const request of requests.sprite) {
      cursor = encodeSpriteInterpolationRequest(
        paramsBuffer,
        cursor,
        request,
        timestamp
      );
    }

    const resultPrepared = resultHolder.prepare();
    const success = wasm.processInterpolations(
      paramsPrepared.ptr,
      resultPrepared.ptr
    );
    if (!success) {
      throw new Error('Wasm processing of interpolations failed.');
    }

    const resultBuffer = resultPrepared.buffer;
    let read = WASM_PROCESS_INTERPOLATIONS_HEADER_LENGTH;

    const distanceResults: SpriteInterpolationEvaluationResult<number>[] =
      new Array(distanceCount);
    for (let i = 0; i < distanceCount; i += 1) {
      const value = resultBuffer[read++]!;
      const completed = resultBuffer[read++]! !== 0;
      const effectiveStartTimestamp = resultBuffer[read++]!;
      distanceResults[i] = {
        value,
        completed,
        effectiveStartTimestamp,
      };
    }

    const degreeResults: SpriteInterpolationEvaluationResult<number>[] =
      new Array(degreeCount);
    for (let i = 0; i < degreeCount; i += 1) {
      const value = resultBuffer[read++]!;
      const completed = resultBuffer[read++]! !== 0;
      const effectiveStartTimestamp = resultBuffer[read++]!;
      degreeResults[i] = {
        value,
        completed,
        effectiveStartTimestamp,
      };
    }

    const spriteResults: SpriteInterpolationEvaluationResult<SpriteLocation>[] =
      new Array(spriteCount);
    for (let i = 0; i < spriteCount; i += 1) {
      const decoded = decodeSpriteInterpolationResult(resultBuffer, read);
      spriteResults[i] = decoded.result;
      read = decoded.nextCursor;
    }

    return {
      distance: distanceResults,
      degree: degreeResults,
      sprite: spriteResults,
    };
  } finally {
    resultHolder.release();
    paramsHolder.release();
  }
};

const processInterpolationsWithWasm = <TTag>(
  wasm: WasmHost,
  params: RenderInterpolationParams<TTag>
): RenderInterpolationResult => {
  const { sprites, timestamp } = params;
  if (!sprites.length) {
    return {
      handled: true,
      hasActiveInterpolation: false,
    };
  }

  const distanceInterpolationWorkItems: DistanceInterpolationWorkItem[] = [];
  const degreeInterpolationWorkItems: DegreeInterpolationWorkItem[] = [];
  const locationInterpolationWorkItems: LocationInterpolationWorkItem<TTag>[] =
    [];
  const processedSprites: Array<{
    sprite: InternalSpriteCurrentState<TTag>;
    touchedImages: InternalSpriteImageState[];
  }> = [];
  let hasActiveInterpolation = false;

  for (const sprite of sprites) {
    const locationInterpolation = sprite.location.interpolation;
    const state = locationInterpolation.state;
    const hasSpriteInterpolation = state !== null;
    if (!hasSpriteInterpolation && !sprite.interpolationDirty) {
      continue;
    }

    collectLocationInterpolationWorkItems(
      sprite,
      locationInterpolationWorkItems
    );

    const touchedImages: InternalSpriteImageState[] = [];

    sprite.images.forEach((orderMap) => {
      orderMap.forEach((image) => {
        const imageHasInterpolations = hasActiveImageInterpolations(image);
        if (!imageHasInterpolations && !image.interpolationDirty) {
          return;
        }

        touchedImages.push(image);

        if (!imageHasInterpolations) {
          return;
        }

        const hasOffsetMetersInterpolation =
          image.offset.offsetMeters.interpolation.state !== null;
        const hasOpacityInterpolation =
          image.finalOpacity.interpolation.state !== null;
        const hasDegreeInterpolation =
          image.finalRotateDeg.interpolation.state !== null ||
          image.offset.offsetDeg.interpolation.state !== null;

        if (hasOffsetMetersInterpolation) {
          collectDistanceInterpolationWorkItems(
            image,
            distanceInterpolationWorkItems,
            true, // includeOffsetMeters
            false
          );
        }

        if (hasDegreeInterpolation) {
          collectDegreeInterpolationWorkItems(
            image,
            degreeInterpolationWorkItems
          );
        }

        const skipChannels: Partial<
          Record<ImageInterpolationStepperId, boolean>
        > = {};
        let shouldSkipChannels = false;
        if (hasOffsetMetersInterpolation) {
          skipChannels.offsetMeters = true;
          shouldSkipChannels = true;
        }
        if (hasOpacityInterpolation) {
          skipChannels.opacity = true;
          shouldSkipChannels = true;
        }
        if (hasDegreeInterpolation) {
          skipChannels.rotation = true;
          skipChannels.offsetDeg = true;
          shouldSkipChannels = true;
        }

        const interpolationOptions = shouldSkipChannels
          ? {
              skipChannels,
              autoRotationDeg: resolveAutoRotationDeg(sprite, image),
            }
          : { autoRotationDeg: resolveAutoRotationDeg(sprite, image) };

        const activeInterpolation = stepSpriteImageInterpolations(
          image,
          timestamp,
          interpolationOptions
        );
        hasActiveInterpolation ||= activeInterpolation;
      });
    });

    if (!hasSpriteInterpolation && touchedImages.length === 0) {
      sprite.interpolationDirty = false;
      continue;
    }

    processedSprites.push({ sprite, touchedImages });
  }

  const wasmResults = processInterpolationsViaWasm(
    wasm,
    {
      distance: distanceInterpolationWorkItems,
      degree: degreeInterpolationWorkItems,
      sprite: locationInterpolationWorkItems,
    },
    timestamp
  );

  const activeDistanceInterpolation = applyDistanceInterpolationEvaluations(
    distanceInterpolationWorkItems,
    wasmResults.distance,
    timestamp
  );
  hasActiveInterpolation ||= activeDistanceInterpolation;

  const activeDegreeInterpolation = applyDegreeInterpolationEvaluations(
    degreeInterpolationWorkItems,
    wasmResults.degree,
    timestamp
  );
  hasActiveInterpolation ||= activeDegreeInterpolation;

  const activeLocationInterpolation = applyLocationInterpolationEvaluations(
    locationInterpolationWorkItems,
    wasmResults.sprite,
    timestamp
  );
  hasActiveInterpolation ||= activeLocationInterpolation;

  for (const entry of processedSprites) {
    for (const image of entry.touchedImages) {
      const dirty = hasActiveImageInterpolations(image);
      image.interpolationDirty ||= dirty;
      entry.sprite.interpolationDirty ||= dirty;
    }
  }

  return {
    handled: true,
    hasActiveInterpolation,
  };
};

type CalculateSurfaceDepthKeyOptions = {
  readonly indices?: readonly number[];
  readonly bias?: {
    readonly ndc: number;
    readonly minClipZEpsilon?: number;
  };
};

/**
 * Create `calculateSurfaceDepthKey` delegator.
 * @param wasm Wasm hosted reference.
 * @param preparedState Prepared state.
 * @returns calculateSurfaceDepthKey function object.
 */
const createCalculateSurfaceDepthKey = (
  wasm: WasmHost,
  preparedState: PreparedProjectionState
) => {
  // Short-circuit.
  if (
    !preparedState.clipContext?.mercatorMatrix ||
    preparedState.clipContext.mercatorMatrix.length !==
      WASM_CalculateSurfaceDepthKey_MATRIX_ELEMENT_COUNT
  ) {
    const fallback = (
      _base: Readonly<SpriteLocation>,
      _displacements: readonly SurfaceCorner[]
    ): number | null => null;
    fallback.release = () => {};
    return fallback;
  }

  // Allocate buffers for immutable matrices.
  const mercatorHolder = wasm.allocateTypedBuffer(
    Float64Array,
    preparedState.clipContext.mercatorMatrix
  );

  const displacementHolder = wasm.allocateTypedBuffer(
    Float64Array,
    WASM_CalculateSurfaceDepthKey_DISPLACEMENT_ELEMENT_COUNT
  );

  const indexHolder = wasm.allocateTypedBuffer(Int32Array, TRIANGLE_INDICES);

  const resultHolder = wasm.allocateTypedBuffer(
    Float64Array,
    WASM_CalculateSurfaceDepthKey_RESULT_ELEMENT_COUNT
  );

  const calculateSurfaceDepthKey = (
    baseLngLat: Readonly<SpriteLocation>,
    displacements: readonly SurfaceCorner[],
    options?: CalculateSurfaceDepthKeyOptions
  ): number | null => {
    if (displacements.length !== SURFACE_CORNER_DISPLACEMENT_COUNT) {
      return null;
    }

    const displacementView = displacementHolder.prepare();
    const displacementBuffer = displacementView.buffer;

    let displacementOffset = 0;
    for (const corner of displacements) {
      displacementBuffer[displacementOffset++] = corner.east;
      displacementBuffer[displacementOffset++] = corner.north;
    }

    const indexView = indexHolder.prepare();
    const indexBuffer = indexView.buffer;
    let indexCount: number = TRIANGLE_INDICES.length;
    if (options?.indices && options.indices.length > 0) {
      if (options.indices.length > indexBuffer.length) {
        return null;
      }
      indexCount = options.indices.length;
      indexBuffer.set(options.indices);
      let writeIndex = indexCount;
      while (writeIndex < indexBuffer.length) {
        indexBuffer[writeIndex++] = 0;
      }
    } else {
      indexBuffer.set(TRIANGLE_INDICES);
    }

    const { ptr: mercatorPtr } = mercatorHolder.prepare();
    const { ptr: resultPtr, buffer: resultBuffer } = resultHolder.prepare();

    const bias = options?.bias;
    const applyBias = bias ? 1 : 0;
    const biasNdc = bias?.ndc ?? 0;
    const minClipZEpsilon = bias?.minClipZEpsilon ?? MIN_CLIP_Z_EPSILON;

    const success = wasm.calculateSurfaceDepthKey(
      baseLngLat.lng,
      baseLngLat.lat,
      baseLngLat.z ?? 0,
      displacementView.ptr,
      displacements.length,
      indexView.ptr,
      indexCount,
      mercatorPtr,
      applyBias,
      biasNdc,
      minClipZEpsilon,
      resultPtr
    );

    if (!success) {
      return null;
    }

    return resultBuffer[0] ?? null;
  };

  // Attach releaser
  calculateSurfaceDepthKey.release = () => {
    mercatorHolder.release();
    displacementHolder.release();
    indexHolder.release();
    resultHolder.release();
  };

  return calculateSurfaceDepthKey;
};

export const createWasmCalculateSurfaceDepthKey = (
  preparedState: PreparedProjectionState
) => {
  const wasm = prepareWasmHost();
  return createCalculateSurfaceDepthKey(wasm, preparedState);
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * ## Input buffer layout (Float64Array)
 *
 * - Header (`INPUT_HEADER_LENGTH`): counts, offsets, feature flags.
 * - Frame constants (`INPUT_FRAME_CONSTANT_LENGTH`): A constant scalar between frames, such as zoom, meters-per-pixel, and screen-to-clip conversion.
 * - Matrices (`INPUT_MATRIX_LENGTH`): mercator/pixel/pixelInverse (16 items ×3).
 * - Resource table (`RESOURCE_STRIDE`× count): Size and texture state of each image handles
 * - Sprite table (`SPRITE_STRIDE`× count): `handle`, `location`, `cachedMercator`.
 * - Item table (`ITEM_STRIDE`× bucket length): Drawing attributes of each sprite images
 *
 * ## Result buffer layout (Float64Array)
 *
 * - Header (`RESULT_HEADER_LENGTH`): prepared count, stride, feature flags。
 * - Item result (`RESULT_ITEM_STRIDE`): `spriteHandle`, `imageIndex`, `resourceIndex`,
 *   Screen-to-Clip, vertex attributes, hit-test corners, surface/billboard uniforms。
 *
 * Since these struct definitions assume the same order in the Wasm side as well,
 * if you change any constants, you must simultaneously update the Wasm implementation.
 */

const INPUT_HEADER_LENGTH = 15;
const INPUT_FRAME_CONSTANT_LENGTH = 27;
const INPUT_MATRIX_LENGTH = 48;
const RESOURCE_STRIDE = 9;
const SPRITE_STRIDE = 6;
const ITEM_STRIDE = 27;
const INPUT_BASE_LENGTH =
  INPUT_HEADER_LENGTH + INPUT_FRAME_CONSTANT_LENGTH + INPUT_MATRIX_LENGTH;

const RESULT_HEADER_LENGTH = 7;
const RESULT_VERTEX_COMPONENT_LENGTH =
  QUAD_VERTEX_COUNT * VERTEX_COMPONENT_COUNT;
const RESULT_HIT_TEST_COMPONENT_LENGTH = 8; // 4 corners * 2 components
const RESULT_SURFACE_CORNER_COMPONENT_LENGTH = 4 /* corners */ * 4; /* xyzw */
const RESULT_SURFACE_CORNER_MODEL_COMPONENT_LENGTH = 4 /* corners */ * 4; // east,north,lng,lat
const RESULT_SURFACE_BLOCK_LENGTH =
  3 + // mercatorCenter
  2 + // worldToMercatorScale
  2 + // halfSizeMeters
  2 + // anchor
  2 + // offsetMeters
  2 + // sin/cos
  1 + // totalRotateDeg
  1 + // depthBiasNdc
  2 + // centerDisplacement
  4 + // clipCenter xyzw
  4 + // clipBasisEast
  4 + // clipBasisNorth
  RESULT_SURFACE_CORNER_COMPONENT_LENGTH + // clipCorners
  3 + // baseLngLat
  3 + // displacedCenter
  1 + // scaleAdjustment
  RESULT_SURFACE_CORNER_MODEL_COMPONENT_LENGTH; // corner model (east/north/lng/lat)
const RESULT_BILLBOARD_UNIFORM_LENGTH = 8; // center(2)+halfSize(2)+anchor(2)+sin+cos
const RESULT_COMMON_ITEM_LENGTH =
  4 + // spriteIndex,imageIndex,resourceIndex,opacity
  4 + // screenToClip scale/offset
  3 + // useShaderSurface, surfaceClipEnabled, useShaderBillboard
  RESULT_BILLBOARD_UNIFORM_LENGTH +
  1; // cameraDistanceMeters
const RESULT_ITEM_STRIDE =
  RESULT_COMMON_ITEM_LENGTH +
  RESULT_VERTEX_COMPONENT_LENGTH +
  RESULT_HIT_TEST_COMPONENT_LENGTH +
  RESULT_SURFACE_BLOCK_LENGTH;

const enum InputHeaderFlags {
  USE_SHADER_SURFACE_GEOMETRY = 1 << 0,
  USE_SHADER_BILLBOARD_GEOMETRY = 1 << 1,
  ENABLE_NDC_BIAS_SURFACE = 1 << 2,
}

const enum InputHeaderIndex {
  TOTAL_LENGTH = 0,
  FRAME_CONST_COUNT = 1,
  MATRIX_OFFSET = 2,
  RESOURCE_COUNT = 3,
  RESOURCE_OFFSET = 4,
  SPRITE_COUNT = 5,
  SPRITE_OFFSET = 6,
  ITEM_COUNT = 7,
  ITEM_OFFSET = 8,
  FLAGS = 9,
  RESERVED0 = 10,
  RESERVED1 = 11,
  RESERVED2 = 12,
  RESERVED3 = 13,
  RESERVED4 = 14,
}

const enum ResultHeaderIndex {
  PREPARED_COUNT = 0,
  ITEM_STRIDE = 1,
  VERTEX_COMPONENT_COUNT = 2,
  SURFACE_CORNER_COUNT = 3,
  FLAGS = 4,
  RESERVED0 = 5,
  RESERVED1 = 6,
}

const enum ResultHeaderFlags {
  HAS_HIT_TEST = 1 << 0,
  HAS_SURFACE_INPUTS = 1 << 1,
}

const toFiniteOr = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) ? (value as number) : fallback;

const boolToNumber = (value: boolean): number => (value ? 1 : 0);

const modeToNumber = (mode: SpriteMode): number => (mode === 'surface' ? 0 : 1);

const computeInputElementCount = (
  resourceCount: number,
  spriteCount: number,
  resultItemCount: number
): number => {
  const resourceLength = resourceCount * RESOURCE_STRIDE;
  const spriteLength = spriteCount * SPRITE_STRIDE;
  const itemLength = resultItemCount * ITEM_STRIDE;
  return INPUT_BASE_LENGTH + resourceLength + spriteLength + itemLength;
};

const computeResultElementCount = (itemCount: number): number =>
  RESULT_HEADER_LENGTH + itemCount * RESULT_ITEM_STRIDE;

const ensureHitTestCorners = (
  imageEntry: InternalSpriteImageState
): [
  MutableSpriteScreenPoint,
  MutableSpriteScreenPoint,
  MutableSpriteScreenPoint,
  MutableSpriteScreenPoint,
] => {
  if (!imageEntry.hitTestCorners) {
    imageEntry.hitTestCorners = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
  }
  return imageEntry.hitTestCorners;
};

interface PreparedInputBuffer extends Releasable {
  readonly parameterHolder: BufferHolder<Float64Array>;
  readonly resultItemCount: number;
}

interface WritableWasmProjectionState<TTag> {
  readonly preparedProjection: PreparedProjectionState;
  lastFrameParams?: {
    baseMetersPerPixel: number;
    zoomScaleFactor: number;
  };
  readonly prepareInputBuffer: (
    params: PrepareDrawSpriteImageParams<TTag>
  ) => PreparedInputBuffer;
  readonly getImageRefs: () => readonly InternalSpriteImageState[];
  readonly getResourceRefs: () => readonly (RegisteredImage | undefined)[];
}

/**
 * Wasm interoperability dependencies.
 * @remarks These are a group of helpers that perform marshaling to generate input/output data for wasm calculation.
 */
export interface WasmCalculationInteropDependencies<TTag> {
  readonly imageIdHandler: IdHandler<RegisteredImage>;
  readonly imageHandleBuffersController: ImageHandleBufferController;
  readonly originReference: SpriteOriginReference;
  readonly spriteIdHandler: IdHandler<InternalSpriteCurrentState<TTag>>;
}

/**
 * Create prepared image parameters from wasm calculation.
 * @param inputBuffer Input buffer
 * @param deps Host dependencies
 * @param resultBuffer Received wasm calculation data
 * @returns Prepared parameters for WebGL rendering
 */
const converToPreparedDrawImageParams = <TTag>(
  state: WritableWasmProjectionState<TTag>,
  deps: WasmCalculationInteropDependencies<TTag>,
  resultBuffer: BufferHolder<Float64Array>
): PreparedDrawSpriteImageParams<TTag>[] => {
  const { buffer } = resultBuffer.prepare();
  if (buffer.length < RESULT_HEADER_LENGTH) {
    return [];
  }

  const preparedCount = Math.max(
    0,
    Math.trunc(buffer[ResultHeaderIndex.PREPARED_COUNT] ?? 0)
  );
  const itemStride = Math.trunc(buffer[ResultHeaderIndex.ITEM_STRIDE] ?? 0);
  const flags = Math.trunc(buffer[ResultHeaderIndex.FLAGS] ?? 0);
  const hasHitTest = (flags & ResultHeaderFlags.HAS_HIT_TEST) !== 0;
  const hasSurfaceInputs = (flags & ResultHeaderFlags.HAS_SURFACE_INPUTS) !== 0;

  if (
    itemStride <= 0 ||
    buffer.length < RESULT_HEADER_LENGTH + preparedCount * itemStride
  ) {
    return [];
  }

  const { spriteIdHandler } = deps;
  const imageRefs = state.getImageRefs();
  const resourceRefs = state.getResourceRefs();

  const items: PreparedDrawSpriteImageParams<TTag>[] = [];

  const baseMetersPerPixel = state.lastFrameParams?.baseMetersPerPixel ?? 1;
  const zoomScaleFactor = state.lastFrameParams?.zoomScaleFactor ?? 1;

  const clampLatitude = (lat: number): number =>
    Math.min(Math.max(lat, -MAX_MERCATOR_LATITUDE), MAX_MERCATOR_LATITUDE);

  const mercatorZfromAltitude = (
    altitude: number,
    latitude: number
  ): number => {
    const circumferenceAtLatitude =
      2 * Math.PI * EARTH_RADIUS_METERS * Math.cos(latitude * DEG2RAD);
    if (
      !Number.isFinite(circumferenceAtLatitude) ||
      circumferenceAtLatitude === 0
    ) {
      return 0;
    }
    return altitude / circumferenceAtLatitude;
  };

  const calculatePerspectiveRatio = (
    location: Readonly<SpriteLocation>
  ): number => {
    const { mercatorMatrix, cameraToCenterDistance } = state.preparedProjection;
    if (!mercatorMatrix || !Number.isFinite(cameraToCenterDistance)) {
      return 1;
    }
    const lng = location.lng ?? 0;
    const lat = clampLatitude(location.lat ?? 0);
    const altitude = location.z ?? 0;
    const mercatorX = (180 + lng) / 360;
    const mercatorY =
      (180 -
        (180 / Math.PI) *
          Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) /
      360;
    const mercatorZ = mercatorZfromAltitude(altitude, lat);
    try {
      const [, , , w] = multiplyMatrixAndVector(
        mercatorMatrix,
        mercatorX,
        mercatorY,
        mercatorZ,
        1
      );
      if (!Number.isFinite(w) || w <= 0) {
        return 1;
      }
      const ratio = cameraToCenterDistance / w;
      return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    } catch {
      return 1;
    }
  };

  const resolveEffectivePixelsPerMeter = (
    location: Readonly<SpriteLocation>
  ): number => {
    const metersPerPixelAtLat = calculateMetersPerPixelAtLatitude(
      state.preparedProjection.zoom,
      location.lat ?? 0
    );
    const perspectiveRatio = calculatePerspectiveRatio(location);
    const effective = calculateEffectivePixelsPerMeter(
      metersPerPixelAtLat,
      perspectiveRatio
    );
    return Number.isFinite(effective) && effective > 0 ? effective : 0;
  };

  const calculateBorderWidthPixels = (
    widthMeters: number | undefined,
    imageScale: number,
    sizeScaleAdjustment: number,
    effectivePixelsPerMeter: number
  ): number => {
    if (
      widthMeters === undefined ||
      !Number.isFinite(widthMeters) ||
      widthMeters <= 0 ||
      !Number.isFinite(effectivePixelsPerMeter) ||
      effectivePixelsPerMeter <= 0 ||
      !Number.isFinite(imageScale) ||
      imageScale <= 0 ||
      !Number.isFinite(sizeScaleAdjustment) ||
      sizeScaleAdjustment <= 0
    ) {
      return 0;
    }
    return (
      widthMeters *
      imageScale *
      zoomScaleFactor *
      effectivePixelsPerMeter *
      sizeScaleAdjustment
    );
  };

  for (let itemIndex = 0; itemIndex < preparedCount; itemIndex++) {
    const base = RESULT_HEADER_LENGTH + itemIndex * itemStride;
    let cursor = base;

    const spriteHandle = Math.trunc(buffer[cursor++] ?? -1);
    const imageIndex = Math.trunc(buffer[cursor++] ?? -1);
    const resourceIndex = Math.trunc(buffer[cursor++] ?? -1);

    const spriteEntry =
      spriteHandle >= 0 ? spriteIdHandler.get(spriteHandle) : undefined;
    const imageEntry = imageRefs[imageIndex];
    const imageResource = resourceRefs[resourceIndex];
    if (!spriteEntry || !imageEntry || !imageResource) {
      continue;
    }

    const opacity = buffer[cursor++] ?? 0;
    const screenToClip = {
      scaleX: buffer[cursor++] ?? 0,
      scaleY: buffer[cursor++] ?? 0,
      offsetX: buffer[cursor++] ?? 0,
      offsetY: buffer[cursor++] ?? 0,
    };
    const useShaderSurface = (buffer[cursor++] ?? 0) !== 0;
    const surfaceClipEnabled = (buffer[cursor++] ?? 0) !== 0;
    const useShaderBillboard = (buffer[cursor++] ?? 0) !== 0;

    const billboardCenter: SpritePoint = {
      x: buffer[cursor++] ?? 0,
      y: buffer[cursor++] ?? 0,
    };
    const halfWidth = buffer[cursor++] ?? 0;
    const halfHeight = buffer[cursor++] ?? 0;
    const billboardAnchor: SpriteAnchor = {
      x: buffer[cursor++] ?? 0,
      y: buffer[cursor++] ?? 0,
    };
    const billboardSin = buffer[cursor++] ?? 0;
    const billboardCos = buffer[cursor++] ?? 0;
    const cameraDistance = buffer[cursor++] ?? Number.POSITIVE_INFINITY;

    const vertexStart = base + RESULT_COMMON_ITEM_LENGTH;
    const vertexEnd = vertexStart + RESULT_VERTEX_COMPONENT_LENGTH;
    const hitTestStart = vertexEnd;
    const hitTestEnd = hitTestStart + RESULT_HIT_TEST_COMPONENT_LENGTH;
    const surfaceStart = hitTestEnd;

    if (vertexEnd > buffer.length) {
      break;
    }

    const vertexSlice = buffer.subarray(vertexStart, vertexEnd);
    const vertexData = new Float32Array(RESULT_VERTEX_COMPONENT_LENGTH);
    for (let i = 0; i < vertexSlice.length; i++) {
      vertexData[i] = vertexSlice[i] ?? 0;
    }

    let hitTestCorners: PreparedDrawSpriteImageParams<TTag>['hitTestCorners'] =
      null;
    if (hasHitTest) {
      if (hitTestEnd > buffer.length) {
        break;
      }
      const corners = ensureHitTestCorners(imageEntry);
      for (let i = 0; i < 4; i++) {
        const x = buffer[hitTestStart + i * 2] ?? 0;
        const y = buffer[hitTestStart + i * 2 + 1] ?? 0;
        corners[i]!.x = x;
        corners[i]!.y = y;
      }
      hitTestCorners = corners;
    }

    let surfaceShaderInputs: SurfaceShaderInputs | undefined;
    if (useShaderSurface && hasSurfaceInputs) {
      if (surfaceStart + RESULT_SURFACE_BLOCK_LENGTH > buffer.length) {
        break;
      }
      let surfaceCursor = surfaceStart;
      const mercatorCenter = {
        x: buffer[surfaceCursor++] ?? 0,
        y: buffer[surfaceCursor++] ?? 0,
        z: buffer[surfaceCursor++] ?? 0,
      };
      const worldToMercatorScale: SurfaceCorner = {
        east: buffer[surfaceCursor++] ?? 0,
        north: buffer[surfaceCursor++] ?? 0,
      };
      const halfSizeMeters: SurfaceCorner = {
        east: buffer[surfaceCursor++] ?? 0,
        north: buffer[surfaceCursor++] ?? 0,
      };
      const surfaceAnchor: SpriteAnchor = {
        x: buffer[surfaceCursor++] ?? 0,
        y: buffer[surfaceCursor++] ?? 0,
      };
      const offsetMeters: SurfaceCorner = {
        east: buffer[surfaceCursor++] ?? 0,
        north: buffer[surfaceCursor++] ?? 0,
      };
      const sin = buffer[surfaceCursor++] ?? 0;
      const cos = buffer[surfaceCursor++] ?? 0;
      const totalRotateDeg = buffer[surfaceCursor++] ?? 0;
      const depthBiasNdc = buffer[surfaceCursor++] ?? 0;
      const centerDisplacement: SurfaceCorner = {
        east: buffer[surfaceCursor++] ?? 0,
        north: buffer[surfaceCursor++] ?? 0,
      };
      const clipCenter = {
        x: buffer[surfaceCursor++] ?? 0,
        y: buffer[surfaceCursor++] ?? 0,
        z: buffer[surfaceCursor++] ?? 0,
        w: buffer[surfaceCursor++] ?? 0,
      };
      const clipBasisEast = {
        x: buffer[surfaceCursor++] ?? 0,
        y: buffer[surfaceCursor++] ?? 0,
        z: buffer[surfaceCursor++] ?? 0,
        w: buffer[surfaceCursor++] ?? 0,
      };
      const clipBasisNorth = {
        x: buffer[surfaceCursor++] ?? 0,
        y: buffer[surfaceCursor++] ?? 0,
        z: buffer[surfaceCursor++] ?? 0,
        w: buffer[surfaceCursor++] ?? 0,
      };
      const clipCorners: Array<{
        readonly x: number;
        readonly y: number;
        readonly z: number;
        readonly w: number;
      }> = [];
      for (let i = 0; i < 4; i++) {
        clipCorners.push({
          x: buffer[surfaceCursor++] ?? 0,
          y: buffer[surfaceCursor++] ?? 0,
          z: buffer[surfaceCursor++] ?? 0,
          w: buffer[surfaceCursor++] ?? 0,
        });
      }
      const baseLngLat: SpriteLocation = {
        lng: buffer[surfaceCursor++] ?? 0,
        lat: buffer[surfaceCursor++] ?? 0,
        z: buffer[surfaceCursor++] ?? 0,
      };
      const displacedCenter: SpriteLocation = {
        lng: buffer[surfaceCursor++] ?? 0,
        lat: buffer[surfaceCursor++] ?? 0,
        z: buffer[surfaceCursor++] ?? 0,
      };
      const scaleAdjustment = buffer[surfaceCursor++] ?? 0;

      const corners: SurfaceShaderCornerState[] = [];
      for (let i = 0; i < 4; i++) {
        corners.push({
          east: buffer[surfaceCursor++] ?? 0,
          north: buffer[surfaceCursor++] ?? 0,
          lng: buffer[surfaceCursor++] ?? 0,
          lat: buffer[surfaceCursor++] ?? 0,
        });
      }

      surfaceShaderInputs = {
        mercatorCenter,
        worldToMercatorScale,
        halfSizeMeters,
        anchor: surfaceAnchor,
        offsetMeters,
        sinCos: { sin, cos },
        totalRotateDeg,
        depthBiasNdc,
        centerDisplacement,
        baseLngLat,
        displacedCenter,
        scaleAdjustment,
        corners,
        clipCenter,
        clipBasisEast,
        clipBasisNorth,
        clipCorners,
      };
      imageEntry.surfaceShaderInputs = surfaceShaderInputs;
    } else {
      imageEntry.surfaceShaderInputs = undefined;
    }

    const billboardUniforms = useShaderBillboard
      ? {
          center: billboardCenter,
          halfWidth,
          halfHeight,
          anchor: billboardAnchor,
          sin: billboardSin,
          cos: billboardCos,
        }
      : null;

    // Calculate border pixel width on the JS side (wasm does not currently emit it).
    const widthMeters = imageEntry.border?.widthMeters;
    const imageScale = imageEntry.scale ?? 1;
    const effectivePixelsPerMeter = resolveEffectivePixelsPerMeter(
      spriteEntry.location.current
    );

    // Apply surface/billboard size clamp scaling when available.
    let sizeScaleAdjustment = 1;
    if (useShaderSurface && surfaceShaderInputs) {
      sizeScaleAdjustment = surfaceShaderInputs.scaleAdjustment;
    } else if (useShaderBillboard && imageResource) {
      const actualWidth = (halfWidth ?? 0) * 2;
      const actualHeight = (halfHeight ?? 0) * 2;
      const rawWidth =
        imageResource.width *
        baseMetersPerPixel *
        imageScale *
        zoomScaleFactor *
        effectivePixelsPerMeter;
      const rawHeight =
        imageResource.height *
        baseMetersPerPixel *
        imageScale *
        zoomScaleFactor *
        effectivePixelsPerMeter;
      const largestActual = Math.max(actualWidth, actualHeight);
      const largestRaw = Math.max(rawWidth, rawHeight);
      if (
        Number.isFinite(largestActual) &&
        largestActual > 0 &&
        Number.isFinite(largestRaw) &&
        largestRaw > 0
      ) {
        const ratio = largestActual / largestRaw;
        if (Number.isFinite(ratio) && ratio > 0) {
          sizeScaleAdjustment = ratio;
        }
      }
    }

    imageEntry.borderPixelWidth = calculateBorderWidthPixels(
      widthMeters,
      imageScale,
      sizeScaleAdjustment,
      effectivePixelsPerMeter
    );
    const leaderLineWidthMeters = imageEntry.leaderLine?.widthMeters;
    imageEntry.leaderLinePixelWidth = calculateBorderWidthPixels(
      leaderLineWidthMeters,
      imageScale,
      sizeScaleAdjustment,
      effectivePixelsPerMeter
    );

    items.push({
      spriteEntry,
      imageEntry,
      imageResource,
      vertexData,
      opacity,
      cameraDistanceMeters: cameraDistance,
      hitTestCorners,
      screenToClip,
      useShaderSurface,
      surfaceShaderInputs,
      surfaceClipEnabled,
      useShaderBillboard,
      billboardUniforms,
    });
  }

  return items;
};

/**
 * Invoke `prepareDrawSpriteImages` wasm entry point. Marshals both input parameters and output results.
 * @param wasm Wasm host.
 * @param wasmState Wasm projection states.
 * @param deps Wasm interoperability dependencies.
 * @param params Input parameters.
 * @returns Prepared draw image parameters, uses to WebGL render.
 */
const prepareDrawSpriteImagesInternal = <TTag>(
  wasm: WasmHost,
  wasmState: WritableWasmProjectionState<TTag>,
  deps: WasmCalculationInteropDependencies<TTag>,
  params: PrepareDrawSpriteImageParams<TTag>
): PreparedDrawSpriteImageParams<TTag>[] => {
  // Construct wasm input parameters
  const inputBuffer = wasmState.prepareInputBuffer(params);
  try {
    // Construct wasm result buffer
    const resultElementCount = computeResultElementCount(
      inputBuffer.resultItemCount
    );
    const resultBuffer = wasm.allocateTypedBuffer(
      Float64Array,
      resultElementCount
    );

    try {
      // Get the pointers of parameters.
      const { ptr: paramsPtr } = inputBuffer.parameterHolder.prepare();
      const { ptr: resultPtr } = resultBuffer.prepare();

      // Invoke wasm entry point.
      const success = wasm.prepareDrawSpriteImages(paramsPtr, resultPtr);
      if (!success) {
        return [];
      }

      // Convert result using the latest state snapshot (image/resource refs).
      return converToPreparedDrawImageParams(wasmState, deps, resultBuffer);
    } finally {
      resultBuffer.release();
    }
  } finally {
    inputBuffer.release();
  }
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Construct wasm projection states.
 * @param wasm Wasm host.
 * @param params Projection host parameters.
 * @param deps Wasm interoperability dependencies.
 * @returns
 */
const convertToWasmProjectionState = <TTag>(
  wasm: WasmHost,
  params: ProjectionHostParams,
  deps: WasmCalculationInteropDependencies<TTag>
): WritableWasmProjectionState<TTag> => {
  const { imageHandleBuffersController, originReference, imageIdHandler } =
    deps;
  void imageIdHandler;
  const preparedProjection = prepareProjectionState(params);
  let spriteHandles: number[] = [];
  let imageRefs: InternalSpriteImageState[] = [];
  let resourceRefs: ReadonlyArray<RegisteredImage | undefined> = [];

  let state: WritableWasmProjectionState<TTag>;

  const writeMatrix = (
    buffer: Float64Array,
    start: number,
    matrix: ArrayLike<number> | null | undefined
  ) => {
    for (let i = 0; i < 16; i++) {
      buffer[start + i] = matrix ? (matrix[i] ?? 0) : 0;
    }
  };

  const prepareInputBuffer = (
    callParams: PrepareDrawSpriteImageParams<TTag>
  ): PreparedInputBuffer => {
    const { bucket } = callParams;
    const resultItemCount = bucket.length;

    const spriteHandleSet = new Set<number>();
    const spriteByHandle = new Map<number, InternalSpriteCurrentState<TTag>>();
    spriteHandles = [];
    const registerSprite = (
      sprite: InternalSpriteCurrentState<TTag>
    ): number => {
      const spriteHandle = sprite.handle;
      if (!spriteHandleSet.has(spriteHandle)) {
        spriteHandleSet.add(spriteHandle);
        spriteHandles.push(spriteHandle);
        spriteByHandle.set(spriteHandle, sprite);
      }
      return spriteHandle;
    };

    imageRefs = [];
    bucket.forEach(([sprite, image]) => {
      registerSprite(sprite);
      imageRefs.push(image);
    });

    resourceRefs = imageHandleBuffersController.getResourcesByHandle();
    const resourceCount = resourceRefs.length;
    const spriteCount = spriteHandles.length;
    const requiredElements = computeInputElementCount(
      resourceCount,
      spriteCount,
      resultItemCount
    );

    const parameterHolder = wasm.allocateTypedBuffer(
      Float64Array,
      requiredElements
    );

    const { buffer: parameterBuffer } = parameterHolder.prepare();
    parameterBuffer.fill(0, 0, requiredElements);

    const frameConstOffset = INPUT_HEADER_LENGTH;
    const matrixOffset = frameConstOffset + INPUT_FRAME_CONSTANT_LENGTH;
    const resourceOffset = matrixOffset + INPUT_MATRIX_LENGTH;
    const spriteOffset = resourceOffset + resourceCount * RESOURCE_STRIDE;
    const itemOffset = spriteOffset + spriteCount * SPRITE_STRIDE;

    let inputFlags = 0;
    if (USE_SHADER_SURFACE_GEOMETRY) {
      inputFlags |= InputHeaderFlags.USE_SHADER_SURFACE_GEOMETRY;
    }
    if (USE_SHADER_BILLBOARD_GEOMETRY) {
      inputFlags |= InputHeaderFlags.USE_SHADER_BILLBOARD_GEOMETRY;
    }
    if (ENABLE_NDC_BIAS_SURFACE) {
      inputFlags |= InputHeaderFlags.ENABLE_NDC_BIAS_SURFACE;
    }

    parameterBuffer[InputHeaderIndex.TOTAL_LENGTH] = requiredElements;
    parameterBuffer[InputHeaderIndex.FRAME_CONST_COUNT] =
      INPUT_FRAME_CONSTANT_LENGTH;
    parameterBuffer[InputHeaderIndex.MATRIX_OFFSET] = matrixOffset;
    parameterBuffer[InputHeaderIndex.RESOURCE_COUNT] = resourceCount;
    parameterBuffer[InputHeaderIndex.RESOURCE_OFFSET] = resourceOffset;
    parameterBuffer[InputHeaderIndex.SPRITE_COUNT] = spriteCount;
    parameterBuffer[InputHeaderIndex.SPRITE_OFFSET] = spriteOffset;
    parameterBuffer[InputHeaderIndex.ITEM_COUNT] = resultItemCount;
    parameterBuffer[InputHeaderIndex.ITEM_OFFSET] = itemOffset;
    parameterBuffer[InputHeaderIndex.FLAGS] = inputFlags;

    const zoomScaleFactor = 1;
    const spriteMinPixel = 0;
    const spriteMaxPixel = 0;

    const frameConstView = parameterBuffer.subarray(
      frameConstOffset,
      frameConstOffset + INPUT_FRAME_CONSTANT_LENGTH
    );
    let fcCursor = 0;
    frameConstView[fcCursor++] = toFiniteOr(preparedProjection.zoom, 0);
    frameConstView[fcCursor++] = toFiniteOr(preparedProjection.worldSize, 0);
    frameConstView[fcCursor++] = toFiniteOr(
      preparedProjection.pixelPerMeter,
      0
    );
    frameConstView[fcCursor++] = toFiniteOr(
      preparedProjection.cameraToCenterDistance,
      0
    );
    frameConstView[fcCursor++] = callParams.baseMetersPerPixel;
    frameConstView[fcCursor++] = spriteMinPixel;
    frameConstView[fcCursor++] = spriteMaxPixel;
    frameConstView[fcCursor++] = callParams.drawingBufferWidth;
    frameConstView[fcCursor++] = callParams.drawingBufferHeight;
    frameConstView[fcCursor++] = callParams.pixelRatio;
    frameConstView[fcCursor++] = zoomScaleFactor;
    frameConstView[fcCursor++] = callParams.identityScaleX;
    frameConstView[fcCursor++] = callParams.identityScaleY;
    frameConstView[fcCursor++] = callParams.identityOffsetX;
    frameConstView[fcCursor++] = callParams.identityOffsetY;
    frameConstView[fcCursor++] = callParams.screenToClipScaleX;
    frameConstView[fcCursor++] = callParams.screenToClipScaleY;
    frameConstView[fcCursor++] = callParams.screenToClipOffsetX;
    frameConstView[fcCursor++] = callParams.screenToClipOffsetY;
    frameConstView[fcCursor++] = MIN_CLIP_Z_EPSILON;
    frameConstView[fcCursor++] = ORDER_BUCKET;
    frameConstView[fcCursor++] = ORDER_MAX;
    frameConstView[fcCursor++] = EPS_NDC;
    frameConstView[fcCursor++] = boolToNumber(ENABLE_NDC_BIAS_SURFACE);
    const cameraLocation = preparedProjection.cameraLocation;
    frameConstView[fcCursor++] = cameraLocation?.lng ?? 0;
    frameConstView[fcCursor++] = cameraLocation?.lat ?? 0;
    frameConstView[fcCursor++] = cameraLocation?.z ?? 0;

    state.lastFrameParams = {
      baseMetersPerPixel: callParams.baseMetersPerPixel,
      zoomScaleFactor,
    };

    writeMatrix(
      parameterBuffer,
      matrixOffset,
      preparedProjection.mercatorMatrix
    );
    writeMatrix(
      parameterBuffer,
      matrixOffset + 16,
      preparedProjection.pixelMatrix
    );
    writeMatrix(
      parameterBuffer,
      matrixOffset + 32,
      preparedProjection.pixelMatrixInverse
    );

    let cursor = resourceOffset;
    for (let handle = 0; handle < resourceCount; handle++) {
      const resource = resourceRefs[handle];
      parameterBuffer[cursor++] = handle;
      if (resource) {
        parameterBuffer[cursor++] = resource.width;
        parameterBuffer[cursor++] = resource.height;
        parameterBuffer[cursor++] = resource.texture ? 1 : 0;
        parameterBuffer[cursor++] =
          typeof resource.atlasPageIndex === 'number'
            ? resource.atlasPageIndex
            : -1;
        parameterBuffer[cursor++] =
          typeof resource.atlasU0 === 'number' ? resource.atlasU0 : 0;
        parameterBuffer[cursor++] =
          typeof resource.atlasV0 === 'number' ? resource.atlasV0 : 0;
        parameterBuffer[cursor++] =
          typeof resource.atlasU1 === 'number' ? resource.atlasU1 : 1;
        parameterBuffer[cursor++] =
          typeof resource.atlasV1 === 'number' ? resource.atlasV1 : 1;
      } else {
        parameterBuffer[cursor++] = 0;
        parameterBuffer[cursor++] = 0;
        parameterBuffer[cursor++] = 0;
        parameterBuffer[cursor++] = -1;
        parameterBuffer[cursor++] = 0;
        parameterBuffer[cursor++] = 0;
        parameterBuffer[cursor++] = 1;
        parameterBuffer[cursor++] = 1;
      }
    }

    cursor = spriteOffset;
    spriteHandles.forEach((handle) => {
      const sprite = spriteByHandle.get(handle);
      if (!sprite) {
        return;
      }
      const location = sprite.location.current;
      const mercator = sprite.cachedMercator;
      parameterBuffer[cursor++] = location.lng;
      parameterBuffer[cursor++] = location.lat;
      parameterBuffer[cursor++] = location.z ?? 0;
      parameterBuffer[cursor++] = mercator.x;
      parameterBuffer[cursor++] = mercator.y;
      parameterBuffer[cursor++] = mercator.z ?? 0;
    });

    const originReferenceKeys =
      callParams.bucketBuffers?.originReferenceKeys ?? null;
    const originTargetIndices =
      callParams.bucketBuffers?.originTargetIndices ?? null;

    cursor = itemOffset;
    bucket.forEach(([sprite, image], index) => {
      const imageHandle = image.imageHandle;
      const spriteHandle = sprite.handle;
      const originKeyCandidate =
        originReferenceKeys?.[index] ?? image.originReferenceKey;
      const originKey =
        originKeyCandidate !== undefined &&
        originKeyCandidate !== SPRITE_ORIGIN_REFERENCE_KEY_NONE
          ? originKeyCandidate
          : originReference.encodeKey(image.subLayer, image.order);
      const originIndex =
        originTargetIndices?.[index] ?? image.originRenderTargetIndex;
      const originLocation = image.originLocation;
      const currentLocation = sprite.location.current;
      const cameraLocation = preparedProjection.cameraLocation;
      const cameraDistanceMeters =
        cameraLocation !== undefined
          ? calculateCartesianDistanceMeters(cameraLocation, {
              lng: currentLocation.lng,
              lat: currentLocation.lat,
              z: currentLocation.z ?? 0,
            })
          : Number.POSITIVE_INFINITY;
      const distanceScaleFactor = calculateDistanceScaleFactor(
        cameraDistanceMeters,
        callParams.resolvedScaling
      );
      const scaledImageScale = (image.scale ?? 1) * distanceScaleFactor;
      parameterBuffer[cursor++] = spriteHandle;
      parameterBuffer[cursor++] = imageHandle;
      parameterBuffer[cursor++] =
        originIndex ?? SPRITE_ORIGIN_REFERENCE_INDEX_NONE;
      parameterBuffer[cursor++] = boolToNumber(
        originLocation?.useResolvedAnchor ?? false
      );
      parameterBuffer[cursor++] = modeToNumber(image.mode);
      parameterBuffer[cursor++] = scaledImageScale;
      parameterBuffer[cursor++] = image.finalOpacity.current;
      const anchor = image.anchor ?? { x: 0, y: 0 };
      parameterBuffer[cursor++] = anchor.x;
      parameterBuffer[cursor++] = anchor.y;
      const offset = resolveImageOffset(image);
      parameterBuffer[cursor++] = offset.offsetMeters;
      parameterBuffer[cursor++] = offset.offsetDeg;
      const autoRotationDeg = resolveAutoRotationDeg(sprite, image);
      const resolvedRotation = normalizeAngleDeg(
        toFiniteOr(image.finalRotateDeg.current, 0)
      );
      parameterBuffer[cursor++] = resolvedRotation;
      parameterBuffer[cursor++] = toFiniteOr(autoRotationDeg, 0);
      parameterBuffer[cursor++] = toFiniteOr(image.rotateDeg, 0);
      parameterBuffer[cursor++] = image.order;
      parameterBuffer[cursor++] = image.subLayer;
      parameterBuffer[cursor++] = originKey ?? SPRITE_ORIGIN_REFERENCE_KEY_NONE;
      parameterBuffer[cursor++] =
        originReferenceKeys?.[index] ?? SPRITE_ORIGIN_REFERENCE_KEY_NONE;
      parameterBuffer[cursor++] =
        originTargetIndices?.[index] ?? SPRITE_ORIGIN_REFERENCE_INDEX_NONE;
      parameterBuffer[cursor++] = image.imageHandle;
      parameterBuffer[cursor++] = currentLocation.lng;
      parameterBuffer[cursor++] = currentLocation.lat;
      parameterBuffer[cursor++] = currentLocation.z ?? 0;
      parameterBuffer[cursor++] = originLocation?.subLayer ?? -1;
      parameterBuffer[cursor++] = originLocation?.order ?? -1;
      parameterBuffer[cursor++] = boolToNumber(
        originLocation?.useResolvedAnchor ?? false
      );
      parameterBuffer[cursor++] = index;
    });

    return {
      parameterHolder,
      resultItemCount,
      release: () => parameterHolder.release(),
    };
  };

  state = {
    preparedProjection,
    lastFrameParams: undefined,
    prepareInputBuffer,
    getImageRefs: () => imageRefs,
    getResourceRefs: () => resourceRefs,
  };

  return state;
};

/**
 * Create calculation host that wasm implementation.
 * @param TTag Tag type.
 * @param params Projection host params.
 * @param deps Wasm interoperability dependencies.
 * @returns Calculation host.
 */
export const createWasmCalculationHost = <TTag>(
  params: ProjectionHostParams,
  deps: WasmCalculationInteropDependencies<TTag>
): RenderCalculationHost<TTag> => {
  // Get wasm host.
  const wasm = prepareWasmHost();

  // Prepare parameters.
  const wasmState = convertToWasmProjectionState<TTag>(wasm, params, deps);
  let wasmFailed = false;
  let fallbackHost: RenderCalculationHost<TTag> | null = null;

  const ensureFallbackHost = (): RenderCalculationHost<TTag> => {
    if (!fallbackHost) {
      fallbackHost = createCalculationHost<TTag>(params);
    }
    return fallbackHost;
  };

  const releaseFallbackHost = () => {
    if (!fallbackHost) {
      return;
    }
    fallbackHost.release();
    fallbackHost = null;
  };

  const runWithFallback = <TReturn>(
    invokeWasm: () => TReturn,
    invokeJs: () => TReturn
  ): TReturn => {
    if (wasmFailed) {
      return invokeJs();
    }
    try {
      return invokeWasm();
    } catch (error) {
      wasmFailed = true;
      reportWasmRuntimeFailure(error);
      return invokeJs();
    }
  };

  return {
    processDrawSpriteImages: (
      params: ProcessDrawSpriteImagesParams<TTag>
    ): ProcessDrawSpriteImagesResult<TTag> =>
      runWithFallback(
        () => {
          let interpolationResult = params.interpolationParams
            ? processInterpolationsWithWasm(wasm, params.interpolationParams)
            : DEFAULT_RENDER_INTERPOLATION_RESULT;
          const preparedItems = params.prepareParams
            ? prepareDrawSpriteImagesInternal<TTag>(
                wasm,
                wasmState,
                deps,
                params.prepareParams
              )
            : [];
          if (preparedItems.length > 0) {
            applyVisibilityDistanceLod(preparedItems);
          }
          if (params.interpolationParams) {
            const opacityResult = processOpacityInterpolationsAfterPreparation(
              params.interpolationParams,
              preparedItems
            );
            interpolationResult = {
              handled: interpolationResult.handled || opacityResult.handled,
              hasActiveInterpolation:
                interpolationResult.hasActiveInterpolation ||
                opacityResult.hasActiveInterpolation,
            };
          }
          syncPreparedOpacities(preparedItems);
          const visiblePreparedItems =
            filterVisiblePreparedItems(preparedItems);
          return {
            interpolationResult,
            preparedItems: visiblePreparedItems,
          };
        },
        () => ensureFallbackHost().processDrawSpriteImages(params)
      ),
    release: () => {
      releaseFallbackHost();
    },
  };
};

//////////////////////////////////////////////////////////////////////////////////////

// Only testing purpose, DO NOT USE in production code.
export const __wasmCalculationTestInternals = {
  convertToWasmProjectionState,
  converToPreparedDrawImageParams,
  prepareDrawSpriteImagesInternal,
  processInterpolationsViaWasm,
  processInterpolationsWithWasm,
};
