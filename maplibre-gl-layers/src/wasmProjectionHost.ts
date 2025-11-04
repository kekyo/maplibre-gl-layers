// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import {
  createProjectionHost,
  prepareProjectionState,
  type PreparedProjectionState,
  type ProjectionHostParams,
} from './projectionHost';
import type { ProjectionHost, SpriteMercatorCoordinate } from './internalTypes';
import type { SpriteLocation, SpritePoint } from './types';

//////////////////////////////////////////////////////////////////////////////////////

type WasmFromLngLat = (
  lng: number,
  lat: number,
  altitude: number,
  outPtr: number
) => void;

type WasmProject = (
  lng: number,
  lat: number,
  altitude: number,
  contextPtr: number,
  outPtr: number
) => void;

type WasmUnproject = (
  x: number,
  y: number,
  contextPtr: number,
  outPtr: number
) => void;

type WasmCalculatePerspectiveRatio = (
  lng: number,
  lat: number,
  altitude: number,
  cachedMercatorPtr: number,
  contextPtr: number,
  outPtr: number
) => void;

interface RawProjectionWasmExports {
  readonly memory?: WebAssembly.Memory;
  readonly _fromLngLat?: WasmFromLngLat;
  readonly fromLngLat?: WasmFromLngLat;
  readonly _project?: WasmProject;
  readonly project?: WasmProject;
  readonly _calculatePerspectiveRatio?: WasmCalculatePerspectiveRatio;
  readonly calculatePerspectiveRatio?: WasmCalculatePerspectiveRatio;
  readonly _unproject?: WasmUnproject;
  readonly unproject?: WasmUnproject;
  readonly _malloc?: (size: number) => number;
  readonly malloc?: (size: number) => number;
  readonly _free?: (ptr: number) => void;
  readonly free?: (ptr: number) => void;
  readonly __wasm_call_ctors?: () => void;
}

interface ResolvedProjectionWasm {
  readonly memory: WebAssembly.Memory;
  readonly fromLngLat: WasmFromLngLat;
  readonly project: WasmProject;
  readonly calculatePerspectiveRatio: WasmCalculatePerspectiveRatio;
  readonly unproject: WasmUnproject;
  readonly malloc: (size: number) => number;
  readonly free: (ptr: number) => void;
}

//////////////////////////////////////////////////////////////////////////////////////

type NodeFsPromisesModule = typeof import('fs/promises');
type NodeUrlModule = typeof import('url');

const isNodeEnvironment = (() => {
  const globalProcess = (
    globalThis as {
      process?: { versions?: { node?: string } };
    }
  ).process;
  return !!globalProcess?.versions?.node;
})();

const importNodeModule = async <T>(specifier: string): Promise<T> =>
  (await import(/* @vite-ignore */ specifier)) as T;

const createImportFunctionStub = (): Record<
  string,
  (...args: unknown[]) => number
> => {
  const noop = () => 0;
  return new Proxy(
    {},
    {
      get: () => noop,
    }
  ) as Record<string, (...args: unknown[]) => number>;
};

const loadWasmBinary = async (): Promise<ArrayBuffer> => {
  const wasmUrl = new URL('./wasm/projection_host.wasm', import.meta.url);

  if (typeof fetch === 'function') {
    try {
      const response = await fetch(wasmUrl);
      if (response.ok) {
        return await response.arrayBuffer();
      }
    } catch {
      // Ignore and fall back to Node resolution.
    }
  }

  if (isNodeEnvironment && wasmUrl.protocol === 'file:') {
    const [{ readFile }, { fileURLToPath }] = await Promise.all([
      importNodeModule<NodeFsPromisesModule>('node:fs/promises'),
      importNodeModule<NodeUrlModule>('node:url'),
    ]);
    const filePath = fileURLToPath(wasmUrl);
    const fileBuffer = await readFile(filePath);
    const arrayBuffer = fileBuffer.buffer as ArrayBuffer;
    return arrayBuffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength
    );
  }

  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(`Failed to load projection host WASM: ${wasmUrl.href}`);
  }
  return await response.arrayBuffer();
};

const instantiateProjectionWasm = async (): Promise<ResolvedProjectionWasm> => {
  const binary = await loadWasmBinary();
  const imports: WebAssembly.Imports = {};
  const functionStub = createImportFunctionStub();
  const importTargets = imports as Record<string, unknown>;
  importTargets.wasi_snapshot_preview1 = functionStub;
  importTargets.env = functionStub;
  const { instance } = await WebAssembly.instantiate(binary, imports);
  const exports = instance.exports as RawProjectionWasmExports;

  if (typeof exports.__wasm_call_ctors === 'function') {
    exports.__wasm_call_ctors();
  }

  const memory = exports.memory;
  const fromLngLat =
    (exports._fromLngLat as WasmFromLngLat | undefined) ??
    (exports.fromLngLat as WasmFromLngLat | undefined);
  const project =
    (exports._project as WasmProject | undefined) ??
    (exports.project as WasmProject | undefined);
  const calculatePerspectiveRatio =
    (exports._calculatePerspectiveRatio as
      | WasmCalculatePerspectiveRatio
      | undefined) ??
    (exports.calculatePerspectiveRatio as
      | WasmCalculatePerspectiveRatio
      | undefined);
  const unproject =
    (exports._unproject as WasmUnproject | undefined) ??
    (exports.unproject as WasmUnproject | undefined);
  const malloc =
    (exports._malloc as ((size: number) => number) | undefined) ??
    (exports.malloc as ((size: number) => number) | undefined);
  const free =
    (exports._free as ((ptr: number) => void) | undefined) ??
    (exports.free as ((ptr: number) => void) | undefined);

  if (
    !memory ||
    !fromLngLat ||
    !project ||
    !calculatePerspectiveRatio ||
    !unproject ||
    !malloc ||
    !free
  ) {
    throw new Error('Projection host WASM exports are incomplete.');
  }

  return {
    memory,
    fromLngLat,
    project,
    calculatePerspectiveRatio,
    unproject,
    malloc,
    free,
  };
};

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
  wasm: ResolvedProjectionWasm,
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
const createFromLngLat = (wasm: ResolvedProjectionWasm) => {
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

const WASM_Project_CONTEXT_ELEMENT_COUNT = 1 + 16;
const WASM_Project_RESULT_ELEMENT_COUNT = 3;

/**
 * Create `project` delegator.
 * @param wasm Wasm hosted reference.
 * @returns project function object.
 */
const createProject = (
  wasm: ResolvedProjectionWasm,
  preparedState: PreparedProjectionState
) => {
  // Allocate a context buffer.
  const contextHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_Project_CONTEXT_ELEMENT_COUNT
  );

  // Store context data into the buffer.
  (() => {
    const { buffer: context } = contextHolder.prepare();
    context[0] = preparedState.worldSize;
    for (let index = 0; index < 16; index++) {
      context[index + 1] = preparedState.pixelMatrix?.[index] ?? 0;
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
    // Prepare the context buffer.
    const { ptr: contextPtr } = contextHolder.prepare();
    // Prepare the result buffer.
    const { ptr: resultPtr, buffer: result } = resultHolder.prepare();

    // Call wasm entry point.
    wasm.project(
      location.lng,
      location.lat,
      location.z ?? 0,
      contextPtr,
      resultPtr
    );

    // Extract results from the wasm buffer.
    const w = result[2]!;

    if (!Number.isFinite(w) || w <= 0) {
      return null;
    }

    const x = result[0]!;
    const y = result[1]!;

    return { x, y };
  };

  project.release = () => {
    contextHolder.release();
    resultHolder.release();
  };

  return project;
};

//////////////////////////////////////////////////////////////////////////////////////

const WASM_Unproject_CONTEXT_ELEMENT_COUNT = 1 + 16;
const WASM_Unproject_RESULT_ELEMENT_COUNT = 2;

/**
 * Create `unproject` delegator.
 * @param wasm Wasm hosted reference.
 * @param preparedState Prepared projection state.
 * @returns unproject function object.
 */
const createUnproject = (
  wasm: ResolvedProjectionWasm,
  preparedState: PreparedProjectionState
) => {
  // Allocate a context buffer.
  const contextHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_Unproject_CONTEXT_ELEMENT_COUNT
  );

  // Store context data into the buffer.
  (() => {
    const { buffer: context } = contextHolder.prepare();
    context[0] = preparedState.worldSize;
    for (let index = 0; index < 16; index++) {
      context[index + 1] = preparedState.pixelMatrixInverse?.[index] ?? 0;
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
    const { ptr: contextPtr } = contextHolder.prepare();
    const { ptr: resultPtr, buffer: result } = resultHolder.prepare();

    wasm.unproject(point.x, point.y, contextPtr, resultPtr);

    const lng = result[0]!;
    const lat = result[1]!;

    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return null;
    }

    return { lng, lat };
  };

  unproject.release = () => {
    contextHolder.release();
    resultHolder.release();
  };

  return unproject;
};

//////////////////////////////////////////////////////////////////////////////////////

const WASM_CalculatePerspectiveRatio_CONTEXT_ELEMENT_COUNT = 1 + 16;
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
  wasm: ResolvedProjectionWasm,
  preparedState: PreparedProjectionState
) => {
  const contextHolder = createTypedBuffer(
    wasm,
    Float64Array,
    WASM_CalculatePerspectiveRatio_CONTEXT_ELEMENT_COUNT
  );

  (() => {
    const { buffer: context } = contextHolder.prepare();
    context[0] = preparedState.cameraToCenterDistance;
    for (let index = 0; index < 16; index++) {
      context[index + 1] = preparedState.mercatorMatrix?.[index] ?? 0;
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
      const { ptr: contextPtr } = contextHolder.prepare();
      const { ptr: cachedMercatorPtr, buffer: cachedMercatorBuffer } =
        cachedMercatorHolder.prepare();
      const { ptr: resultPtr, buffer: result } = resultHolder.prepare();

      cachedMercatorBuffer[0] = cachedMercator.x;
      cachedMercatorBuffer[1] = cachedMercator.y;
      cachedMercatorBuffer[2] = cachedMercator.z;

      wasm.calculatePerspectiveRatio(
        location.lng,
        location.lat,
        location.z ?? 0,
        cachedMercatorPtr,
        contextPtr,
        resultPtr
      );

      const ratio = result[0]!;
      return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    } else {
      const { ptr: contextPtr } = contextHolder.prepare();
      const { ptr: resultPtr, buffer: result } = resultHolder.prepare();

      wasm.calculatePerspectiveRatio(
        location.lng,
        location.lat,
        location.z ?? 0,
        0,
        contextPtr,
        resultPtr
      );

      const ratio = result[0]!;
      return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    }
  };

  calculatePerspectiveRatio.release = () => {
    contextHolder.release();
    resultHolder.release();
  };

  return calculatePerspectiveRatio;
};

// TODO: Other ProjectionHost members

//////////////////////////////////////////////////////////////////////////////////////

/** Resolved projection_wasm.cpp */
let projectionWasmResolved: ResolvedProjectionWasm | null | undefined;

/**
 * Intiialize wasm host.
 * @returns True if initialized, otherwise (include failing) false.
 */
export const initProjectionWasm = async (): Promise<boolean> => {
  if (projectionWasmResolved === undefined) {
    try {
      projectionWasmResolved = await instantiateProjectionWasm();
      console.log('maplibre-gl-layers: Initialized wasm module.');
    } catch (e: unknown) {
      console.log(e);
      projectionWasmResolved = null;
      return false;
    }
  }
  return projectionWasmResolved !== null;
};

/**
 * Create wasm-based calculation projection host.
 * @param params Projection parameters
 * @returns Projection host
 * @remarks This needs using before initialization (initProjectionWasm function)
 */
export const createWasmProjectionHost = (
  params: ProjectionHostParams
): ProjectionHost => {
  if (!projectionWasmResolved) {
    throw new Error(
      'Could not use WasmProjectionHost, needs before initialization.'
    );
  }

  // TODO: Base (will be overrided) pure implementation, finally remove this.
  const baseHost = createProjectionHost(params);

  // Prepare parameters.
  const preparedState = prepareProjectionState(params);

  //----------------------------------------------------------

  // Member: fromLngLat
  const fromLngLat = createFromLngLat(projectionWasmResolved);

  // Member: project
  const project = createProject(projectionWasmResolved, preparedState);

  // Member: unproject
  const unproject = createUnproject(projectionWasmResolved, preparedState);

  // Member: calculatePerspectiveRatio
  const calculatePerspectiveRatio = createCalculatePerspectiveRatio(
    projectionWasmResolved,
    preparedState
  );

  //----------------------------------------------------------

  // The projection host disposer
  const release = () => {
    fromLngLat.release();
    project.release();
    unproject.release();
    calculatePerspectiveRatio.release();
    baseHost.release();
  };

  return {
    ...baseHost,
    fromLngLat, // Overrided
    project, // Overrided
    unproject, // Overrided
    calculatePerspectiveRatio, // Overrided
    release,
  };
};
