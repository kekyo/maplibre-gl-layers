// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import {
  prepareProjectionState,
  type PreparedProjectionState,
  type ProjectionHostParams,
} from './projectionHost';
import type { ProjectionHost, SpriteMercatorCoordinate } from './internalTypes';
import type { SpriteLocation, SpritePoint } from './types';
import { prepareWasmHost, type WasmHost } from './wasmHost';

//////////////////////////////////////////////////////////////////////////////////////

interface BufferHolder<TArray extends ArrayBufferView> {
  readonly prepare: () => { ptr: number; buffer: TArray };
  readonly release: () => void;
}

type TypedArrayConstructor<TArray extends ArrayBufferView> = {
  readonly BYTES_PER_ELEMENT: number;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): TArray;
};

const createTypedBuffer = <TArray extends ArrayBufferView>(
  wasm: WasmHost,
  ArrayType: TypedArrayConstructor<TArray>,
  elementCount: number
): BufferHolder<TArray> => {
  const byteLength = elementCount * ArrayType.BYTES_PER_ELEMENT;
  let ptr = wasm.malloc(byteLength);
  let buffer: TArray | null = new ArrayType(
    wasm.memory.buffer,
    ptr,
    elementCount
  );
  const prepare = () => {
    if (ptr === 0) {
      throw new Error('Buffer already freed.');
    }
    if (!buffer) {
      buffer = new ArrayType(wasm.memory.buffer, ptr, elementCount);
    } else if (buffer.buffer !== wasm.memory.buffer) {
      buffer = new ArrayType(wasm.memory.buffer, ptr, elementCount);
    }
    return { ptr, buffer: buffer! };
  };
  const release = () => {
    if (ptr !== 0) {
      wasm.free(ptr);
      ptr = 0;
      buffer = null;
    }
  };
  return {
    prepare,
    release,
  };
};

//////////////////////////////////////////////////////////////////////////////////////

const WASM_FromLngLat_RESULT_ELEMENT_COUNT = 3;

/**
 * Create `fromLngLat` delegator.
 * @param wasm Wasm hosted reference.
 * @returns fromLngLat function object.
 */
const createFromLngLat = (wasm: WasmHost) => {
  // Allocate a result buffer.
  const resultHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_FromLngLat_RESULT_ELEMENT_COUNT
  );

  // `fromLngLat` delegation body
  const fromLngLat = (
    location: Readonly<SpriteLocation>
  ): SpriteMercatorCoordinate => {
    // Prepare the result buffer.
    const { ptr, buffer } = resultHolder.prepare();

    // Call wasm entry point.
    wasm.fromLngLat(location.lng, location.lat, location.z ?? 0, ptr);

    // Extract results from the wasm buffer.
    const x = buffer[0]!;
    const y = buffer[1]!;
    const z = buffer[2]!;

    return { x, y, z };
  };

  // Buffer releaser
  fromLngLat.release = resultHolder.release;

  return fromLngLat;
};

//////////////////////////////////////////////////////////////////////////////////////

const WASM_Project_CONTEXT_ELEMENT_COUNT = 16;
const WASM_Project_RESULT_ELEMENT_COUNT = 2;

/**
 * Create `project` delegator.
 * @param wasm Wasm hosted reference.
 * @returns project function object.
 */
const createProject = (
  wasm: WasmHost,
  preparedState: PreparedProjectionState
) => {
  // Allocate a matrix buffer.
  const matrixHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_Project_CONTEXT_ELEMENT_COUNT
  );

  // Store matrix data into the buffer.
  (() => {
    const { buffer: matrix } = matrixHolder.prepare();
    for (let index = 0; index < 16; index++) {
      matrix[index] = preparedState.pixelMatrix?.[index] ?? 0;
    }
  })();

  // Allocate a result buffer.
  const resultHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_Project_RESULT_ELEMENT_COUNT
  );

  // `project` delegation body
  const project = (location: Readonly<SpriteLocation>): SpritePoint | null => {
    // Prepare the matrix buffer.
    const { ptr: matrixPtr } = matrixHolder.prepare();
    // Prepare the result buffer.
    const { ptr: resultPtr, buffer: result } = resultHolder.prepare();

    // Call wasm entry point.
    if (
      wasm.project(
        location.lng,
        location.lat,
        location.z ?? 0,
        preparedState.worldSize,
        matrixPtr,
        resultPtr
      )
    ) {
      // Extract results from the wasm buffer.
      const x = result[0]!;
      const y = result[1]!;

      return { x, y };
    } else {
      return null;
    }
  };

  project.release = () => {
    matrixHolder.release();
    resultHolder.release();
  };

  return project;
};

//////////////////////////////////////////////////////////////////////////////////////

const WASM_Unproject_CONTEXT_ELEMENT_COUNT = 16;
const WASM_Unproject_RESULT_ELEMENT_COUNT = 2;

/**
 * Create `unproject` delegator.
 * @param wasm Wasm hosted reference.
 * @param preparedState Prepared projection state.
 * @returns unproject function object.
 */
const createUnproject = (
  wasm: WasmHost,
  preparedState: PreparedProjectionState
) => {
  // Allocate a matrix buffer.
  const matrixHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_Unproject_CONTEXT_ELEMENT_COUNT
  );

  // Store context data into the buffer.
  (() => {
    const { buffer: matrix } = matrixHolder.prepare();
    for (let index = 0; index < 16; index++) {
      matrix[index] = preparedState.pixelMatrixInverse?.[index] ?? 0;
    }
  })();

  // Allocate a result buffer.
  const resultHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_Unproject_RESULT_ELEMENT_COUNT
  );

  // `unproject` delegation body
  const unproject = (point: Readonly<SpritePoint>): SpriteLocation | null => {
    const { ptr: matrixPtr } = matrixHolder.prepare();
    const { ptr: resultPtr, buffer: result } = resultHolder.prepare();

    if (
      wasm.unproject(
        point.x,
        point.y,
        preparedState.worldSize,
        matrixPtr,
        resultPtr
      )
    ) {
      const lng = result[0]!;
      const lat = result[1]!;

      return { lng, lat };
    } else {
      return null;
    }
  };

  unproject.release = () => {
    matrixHolder.release();
    resultHolder.release();
  };

  return unproject;
};

//////////////////////////////////////////////////////////////////////////////////////

const WASM_CalculatePerspectiveRatio_CONTEXT_ELEMENT_COUNT = 16;
const WASM_CalculatePerspectiveRatio_CACHED_MERCATOR_ELEMENT_COUNT = 3;
const WASM_CalculatePerspectiveRatio_RESULT_ELEMENT_COUNT = 1;

/**
 * Create `calculatePerspectiveRatio` delegator.
 * @param wasm Wasm hosted reference.
 * @param preparedState Prepared projection state.
 * @param fromLngLat Wasm-backed fromLngLat delegator.
 * @returns calculatePerspectiveRatio function object.
 */
const createCalculatePerspectiveRatio = (
  wasm: WasmHost,
  preparedState: PreparedProjectionState
) => {
  const matrixHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_CalculatePerspectiveRatio_CONTEXT_ELEMENT_COUNT
  );

  (() => {
    const { buffer: matrix } = matrixHolder.prepare();
    for (let index = 0; index < 16; index++) {
      matrix[index] = preparedState.mercatorMatrix?.[index] ?? 0;
    }
  })();

  const isInvalidState =
    !preparedState.mercatorMatrix || preparedState.cameraToCenterDistance <= 0;

  const cachedMercatorHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_CalculatePerspectiveRatio_CACHED_MERCATOR_ELEMENT_COUNT
  );

  const resultHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_CalculatePerspectiveRatio_RESULT_ELEMENT_COUNT
  );

  const calculatePerspectiveRatio = (
    location: Readonly<SpriteLocation>,
    cachedMercator?: SpriteMercatorCoordinate
  ): number => {
    if (isInvalidState) {
      return 1;
    }

    if (cachedMercator) {
      const { ptr: matrixPtr } = matrixHolder.prepare();
      const { ptr: cachedMercatorPtr, buffer: cachedMercatorBuffer } =
        cachedMercatorHolder.prepare();
      const { ptr: resultPtr, buffer: result } = resultHolder.prepare();

      cachedMercatorBuffer[0] = cachedMercator.x;
      cachedMercatorBuffer[1] = cachedMercator.y;
      cachedMercatorBuffer[2] = cachedMercator.z;

      if (
        wasm.calculatePerspectiveRatio(
          location.lng,
          location.lat,
          location.z ?? 0,
          cachedMercatorPtr,
          preparedState.cameraToCenterDistance,
          matrixPtr,
          resultPtr
        )
      ) {
        const ratio = result[0]!;
        return ratio;
      } else {
        return 1;
      }
    } else {
      const { ptr: matrixPtr } = matrixHolder.prepare();
      const { ptr: resultPtr, buffer: result } = resultHolder.prepare();

      if (
        wasm.calculatePerspectiveRatio(
          location.lng,
          location.lat,
          location.z ?? 0,
          0,
          preparedState.cameraToCenterDistance,
          matrixPtr,
          resultPtr
        )
      ) {
        const ratio = result[0]!;
        return ratio;
      } else {
        return 1;
      }
    }
  };

  calculatePerspectiveRatio.release = () => {
    matrixHolder.release();
    resultHolder.release();
  };

  return calculatePerspectiveRatio;
};

// TODO: Other ProjectionHost members

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Create wasm-based calculation projection host.
 * @param params Projection parameters
 * @returns Projection host
 * @remarks This needs using before initialization (initializeWasmHost function)
 */
export const createWasmProjectionHost = (
  params: ProjectionHostParams
): ProjectionHost => {
  // Get wasm host.
  const wasm = prepareWasmHost();

  // Prepare parameters.
  const preparedState = prepareProjectionState(params);

  //----------------------------------------------------------

  // Member: fromLngLat
  const fromLngLat = createFromLngLat(wasm);

  // Member: project
  const project = createProject(wasm, preparedState);

  // Member: unproject
  const unproject = createUnproject(wasm, preparedState);

  // Member: calculatePerspectiveRatio
  const calculatePerspectiveRatio = createCalculatePerspectiveRatio(
    wasm,
    preparedState
  );

  //----------------------------------------------------------

  // The projection host disposer
  const release = () => {
    fromLngLat.release();
    project.release();
    unproject.release();
    calculatePerspectiveRatio.release();
  };

  return {
    getZoom: () => {
      return preparedState.zoom;
    },
    getClipContext: () => {
      return preparedState.clipContext;
    },
    fromLngLat, // Overrided
    project, // Overrided
    unproject, // Overrided
    calculatePerspectiveRatio, // Overrided
    release,
  };
};
