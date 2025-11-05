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
import { createTypedBuffer, prepareWasmHost, type WasmHost } from './wasmHost';

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

  // Attach releaser
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
  // Short-circuit.
  if (
    !preparedState.pixelMatrix ||
    preparedState.pixelMatrix.length !== WASM_Project_CONTEXT_ELEMENT_COUNT
  ) {
    const d = (
      _location: Readonly<SpriteLocation>,
      _cachedMercator?: SpriteMercatorCoordinate
    ) => null;
    d.release = () => {};
    return d;
  }

  // Allocate a matrix buffer.
  const matrixHolder = createTypedBuffer(
    wasm,
    Float64Array,
    preparedState.pixelMatrix
  );

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

  // Attach releaser
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
  // Short-circuit.
  if (
    !preparedState.pixelMatrixInverse ||
    preparedState.pixelMatrixInverse.length !==
      WASM_Unproject_CONTEXT_ELEMENT_COUNT
  ) {
    const d = (_point: Readonly<SpritePoint>) => null;
    d.release = () => {};
    return d;
  }

  // Allocate a matrix buffer.
  const matrixHolder = createTypedBuffer(
    wasm,
    Float64Array,
    preparedState.pixelMatrixInverse
  );

  // Allocate a result buffer.
  const resultHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_Unproject_RESULT_ELEMENT_COUNT
  );

  // `unproject` delegation body
  const unproject = (point: Readonly<SpritePoint>): SpriteLocation | null => {
    // Prepare the matrix buffer.
    const { ptr: matrixPtr } = matrixHolder.prepare();
    // Prepare the result buffer.
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

  // Attach releaser
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
  // Short-circuit.
  if (
    !preparedState.mercatorMatrix ||
    preparedState.mercatorMatrix.length !==
      WASM_CalculatePerspectiveRatio_CONTEXT_ELEMENT_COUNT ||
    preparedState.cameraToCenterDistance <= 0
  ) {
    const d = (
      _location: Readonly<SpriteLocation>,
      _cachedMercator?: SpriteMercatorCoordinate
    ) => 1;
    d.release = () => {};
    return d;
  }

  const matrixHolder = createTypedBuffer(
    wasm,
    Float64Array,
    preparedState.mercatorMatrix
  );

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

  // `calculatePerspectiveRatio` delegation body
  const calculatePerspectiveRatio = (
    location: Readonly<SpriteLocation>,
    cachedMercator?: SpriteMercatorCoordinate
  ): number => {
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

  // Attach releaser
  calculatePerspectiveRatio.release = () => {
    matrixHolder.release();
    resultHolder.release();
  };

  return calculatePerspectiveRatio;
};

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
