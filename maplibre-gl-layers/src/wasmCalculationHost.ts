// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  ClipContext,
  PreparedDrawSpriteImageParams,
  PrepareDrawSpriteImageParams,
  RenderCalculationHost,
} from './internalTypes';
import { SURFACE_CORNER_DISPLACEMENT_COUNT, type SurfaceCorner } from './math';
import type { SpriteLocation, SpriteScreenPoint } from './types';
import { createTypedBuffer, prepareWasmHost, type WasmHost } from './wasmHost';
import {
  prepareProjectionState,
  type PreparedProjectionState,
  type ProjectionHostParams,
} from './projectionHost';
import { __createWasmProjectionCalculationHost } from './calculationHost';
import { MIN_CLIP_Z_EPSILON, TRIANGLE_INDICES } from './const';

//////////////////////////////////////////////////////////////////////////////////////

const WASM_ProjectLngLatToClipSpace_MATRIX_ELEMENT_COUNT = 16;
const WASM_ProjectLngLatToClipSpace_RESULT_ELEMENT_COUNT = 4;

/**
 * Create `projectLngLatToClipSpace` delegator.
 * @param wasm Wasm hosted reference.
 * @returns projectLngLatToClipSpace function object.
 */
const createProjectLngLatToClipSpace = (wasm: WasmHost) => {
  // Allocate a matrix buffer.
  const matrixHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_ProjectLngLatToClipSpace_MATRIX_ELEMENT_COUNT
  );

  // Allocate a result buffer.
  const resultHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_ProjectLngLatToClipSpace_RESULT_ELEMENT_COUNT
  );

  // `projectLngLatToClipSpace` delegation body
  const projectLngLatToClipSpace = (
    clipContext: Readonly<ClipContext> | null,
    location: Readonly<SpriteLocation>
  ) => {
    if (!clipContext) {
      return null;
    }

    // Prepare the matrix buffer.
    const { ptr: matrixPtr, buffer: matrix } = matrixHolder.prepare();
    // Store matrix data into the buffer.
    matrix.set(clipContext.mercatorMatrix);

    // Prepare the result buffer.
    const { ptr: resultPtr, buffer: result } = resultHolder.prepare();

    if (
      wasm.projectLngLatToClipSpace(
        location.lng,
        location.lat,
        location.z ?? 0,
        matrixPtr,
        resultPtr
      )
    ) {
      return [result[0]!, result[1]!, result[2]!, result[3]!];
    } else {
      return null;
    }
  };

  // Attach releaser
  projectLngLatToClipSpace.release = () => {
    matrixHolder.release();
    resultHolder.release();
  };

  return projectLngLatToClipSpace;
};

// TODO: Remove this when wasm implementation is done.
export const createWasmProjectLngLatToClipSpace = () => {
  const wasm = prepareWasmHost();
  return createProjectLngLatToClipSpace(wasm);
};

//////////////////////////////////////////////////////////////////////////////////////

const WASM_CalculateBillboardDepthKey_MATRIX_ELEMENT_COUNT = 16;
const WASM_CalculateBillboardDepthKey_RESULT_ELEMENT_COUNT = 1;

/**
 * Create `calculateBillboardDepthKey` delegator.
 * @param wasm Wasm hosted reference.
 * @param preparedState Prepared state.
 * @returns calculateBillboardDepthKey function object.
 */
const createCalculateBillboardDepthKey = (
  wasm: WasmHost,
  preparedState: PreparedProjectionState
) => {
  // Short-circuit.
  if (
    !preparedState.pixelMatrixInverse ||
    preparedState.pixelMatrixInverse.length !==
      WASM_CalculateBillboardDepthKey_MATRIX_ELEMENT_COUNT ||
    !preparedState.clipContext ||
    !preparedState.clipContext.mercatorMatrix ||
    preparedState.clipContext.mercatorMatrix.length !==
      WASM_CalculateBillboardDepthKey_MATRIX_ELEMENT_COUNT ||
    !Number.isFinite(preparedState.worldSize) ||
    preparedState.worldSize <= 0
  ) {
    const fallback = (_center: Readonly<SpriteScreenPoint>): number | null => {
      return null;
    };
    fallback.release = () => {};
    return fallback;
  }

  // Allocate an inverse matrix buffer.
  const inverseHolder = createTypedBuffer(
    wasm,
    Float64Array,
    preparedState.pixelMatrixInverse
  );

  // Allocate a mercator matrix buffer.
  const mercatorHolder = createTypedBuffer(
    wasm,
    Float64Array,
    preparedState.clipContext.mercatorMatrix
  );

  // Allocate a result buffer.
  const resultHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_CalculateBillboardDepthKey_RESULT_ELEMENT_COUNT
  );

  // `calculateBillboardDepthKey` delegation body
  const calculateBillboardDepthKey = (
    center: Readonly<SpriteScreenPoint>
  ): number | null => {
    const { ptr: inversePtr } = inverseHolder.prepare();
    const { ptr: mercatorPtr } = mercatorHolder.prepare();
    const { ptr: resultPtr, buffer: resultBuffer } = resultHolder.prepare();

    if (
      wasm.calculateBillboardDepthKey(
        center.x,
        center.y,
        preparedState.worldSize,
        inversePtr,
        mercatorPtr,
        resultPtr
      )
    ) {
      return resultBuffer[0] ?? null;
    } else {
      return null;
    }
  };

  // Attach releaser
  calculateBillboardDepthKey.release = () => {
    inverseHolder.release();
    mercatorHolder.release();
    resultHolder.release();
  };

  return calculateBillboardDepthKey;
};

// TODO: Remove this when wasm implementation is done.
export const createWasmCalculateBillboardDepthKey = (
  preparedState: PreparedProjectionState
) => {
  const wasm = prepareWasmHost();
  return createCalculateBillboardDepthKey(wasm, preparedState);
};

//////////////////////////////////////////////////////////////////////////////////////

const WASM_CalculateSurfaceDepthKey_MATRIX_ELEMENT_COUNT = 16;
const WASM_CalculateSurfaceDepthKey_DISPLACEMENT_ELEMENT_COUNT =
  SURFACE_CORNER_DISPLACEMENT_COUNT * 2;
const WASM_CalculateSurfaceDepthKey_RESULT_ELEMENT_COUNT = 1;

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
  const mercatorHolder = createTypedBuffer(
    wasm,
    Float64Array,
    preparedState.clipContext.mercatorMatrix
  );

  const displacementHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_CalculateSurfaceDepthKey_DISPLACEMENT_ELEMENT_COUNT
  );

  const indexHolder = createTypedBuffer(wasm, Int32Array, TRIANGLE_INDICES);

  const resultHolder = createTypedBuffer(
    wasm,
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

// TODO: To be implementing in wasm side.
const prepareDrawSpriteImagesInternal = <TTag>(
  _wasm: WasmHost,
  _preparedState: PreparedProjectionState,
  _params: PrepareDrawSpriteImageParams<TTag>
): PreparedDrawSpriteImageParams<TTag>[] => {
  const { bucket, bucketBuffers } = _params;
  if (
    bucketBuffers &&
    (bucketBuffers.originReferenceKeys.length !== bucket.length ||
      bucketBuffers.originTargetIndices.length !== bucket.length)
  ) {
    throw new Error('bucketBuffers length mismatch');
  }
  // TODO: To be implementing in wasm side.
  return undefined!;
};
void prepareDrawSpriteImagesInternal;

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Create calculation host that wasm implementation.
 * @param TTag Tag type.
 * @param params Projection host params.
 * @returns Calculation host.
 */
export const createWasmCalculationHost = <TTag>(
  params: ProjectionHostParams
): RenderCalculationHost<TTag> => {
  // Get wasm host.
  const wasm = prepareWasmHost();
  void wasm; // (ignored warning)

  // Prepare parameters.
  const preparedState = prepareProjectionState(params);
  void preparedState; // (ignored warning)

  // TODO: Remove this when wasm implementation is done.
  const baseHost = __createWasmProjectionCalculationHost<TTag>(params);

  return {
    prepareDrawSpriteImages: (params) =>
      baseHost.prepareDrawSpriteImages(params),
    //prepareDrawSpriteImagesInternal(wasm, preparedState, params),
    release: () => {},
  };
};
