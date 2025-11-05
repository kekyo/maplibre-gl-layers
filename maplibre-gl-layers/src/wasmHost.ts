// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

//////////////////////////////////////////////////////////////////////////////////////

/**
 * `fromLngLat` function parameter
 */
export type WasmFromLngLat = (
  lng: number,
  lat: number,
  altitude: number,
  outPtr: number
) => boolean;

/**
 * `project` function parameter
 */
export type WasmProject = (
  lng: number,
  lat: number,
  altitude: number,
  worldSize: number,
  matrixPtr: number,
  outPtr: number
) => boolean;

/**
 * `unproject` function parameter
 */
export type WasmUnproject = (
  x: number,
  y: number,
  worldSize: number,
  matrixPtr: number,
  outPtr: number
) => boolean;

/**
 * `calculatePerspectiveRatio` function parameter
 */
export type WasmCalculatePerspectiveRatio = (
  lng: number,
  lat: number,
  altitude: number,
  cachedMercatorPtr: number,
  cameraToCenterDistance: number,
  matrixPtr: number,
  outPtr: number
) => boolean;

export type WasmProjectLngLatToClipSpace = (
  lng: number,
  lat: number,
  altitude: number,
  matrixPtr: number,
  outPtr: number
) => boolean;

export type WasmCalculateBillboardDepthKey = (
  centerX: number,
  centerY: number,
  worldSize: number,
  inverseMatrixPtr: number,
  mercatorMatrixPtr: number,
  outPtr: number
) => boolean;

export type WasmCalculateSurfaceDepthKey = (
  baseLng: number,
  baseLat: number,
  baseAltitude: number,
  displacementPtr: number,
  displacementCount: number,
  indexPtr: number,
  indexCount: number,
  mercatorMatrixPtr: number,
  applyBias: number,
  biasNdc: number,
  minClipZEpsilon: number,
  outPtr: number
) => boolean;

/**
 * Wasm host reference.
 */
export interface WasmHost {
  readonly memory: WebAssembly.Memory;
  readonly malloc: (size: number) => number;
  readonly free: (ptr: number) => void;

  // ProjectionHost related functions.
  readonly fromLngLat: WasmFromLngLat;
  readonly project: WasmProject;
  readonly calculatePerspectiveRatio: WasmCalculatePerspectiveRatio;
  readonly unproject: WasmUnproject;
  readonly projectLngLatToClipSpace: WasmProjectLngLatToClipSpace;
  readonly calculateBillboardDepthKey: WasmCalculateBillboardDepthKey;
  readonly calculateSurfaceDepthKey: WasmCalculateSurfaceDepthKey;

  // TODO: Will add CalculationHost related functions.
}

//////////////////////////////////////////////////////////////////////////////////////

interface RawProjectionWasmExports {
  readonly memory?: WebAssembly.Memory;
  readonly _malloc?: (size: number) => number;
  readonly malloc?: (size: number) => number;
  readonly _free?: (ptr: number) => void;
  readonly free?: (ptr: number) => void;
  readonly __wasm_call_ctors?: () => void;

  readonly _fromLngLat?: WasmFromLngLat;
  readonly fromLngLat?: WasmFromLngLat;
  readonly _project?: WasmProject;
  readonly project?: WasmProject;
  readonly _unproject?: WasmUnproject;
  readonly unproject?: WasmUnproject;
  readonly _calculatePerspectiveRatio?: WasmCalculatePerspectiveRatio;
  readonly calculatePerspectiveRatio?: WasmCalculatePerspectiveRatio;
  readonly _projectLngLatToClipSpace?: WasmProjectLngLatToClipSpace;
  readonly projectLngLatToClipSpace?: WasmProjectLngLatToClipSpace;
  readonly _calculateBillboardDepthKey?: WasmCalculateBillboardDepthKey;
  readonly calculateBillboardDepthKey?: WasmCalculateBillboardDepthKey;
  readonly _calculateSurfaceDepthKey?: WasmCalculateSurfaceDepthKey;
  readonly calculateSurfaceDepthKey?: WasmCalculateSurfaceDepthKey;
}

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

/**
 * Load wasm binary.
 * @returns Raw wasm binary stream.
 */
const loadWasmBinary = async (): Promise<ArrayBuffer> => {
  const wasmUrl = new URL('./wasm/offloads.wasm', import.meta.url);

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
    throw new Error(`Failed to load offloads WASM: ${wasmUrl.href}`);
  }
  return await response.arrayBuffer();
};

/**
 * Load wasm binary, instantiate and refer entry points.
 * @returns WasmHost
 */
const instantiateProjectionWasm = async (): Promise<WasmHost> => {
  // Load wasm binary and instantiate.
  const binary = await loadWasmBinary();
  const imports: WebAssembly.Imports = {};
  const functionStub = createImportFunctionStub();
  const importTargets = imports as Record<string, unknown>;
  importTargets.wasi_snapshot_preview1 = functionStub;
  importTargets.env = functionStub;
  const { instance } = await WebAssembly.instantiate(binary, imports);
  const exports = instance.exports as RawProjectionWasmExports;

  // Call wasm side constructors.
  if (typeof exports.__wasm_call_ctors === 'function') {
    exports.__wasm_call_ctors();
  }

  // Resolve exposed wasm entry points.
  const memory = exports.memory;
  const malloc =
    (exports._malloc as ((size: number) => number) | undefined) ??
    (exports.malloc as ((size: number) => number) | undefined);
  const free =
    (exports._free as ((ptr: number) => void) | undefined) ??
    (exports.free as ((ptr: number) => void) | undefined);

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
  const projectLngLatToClipSpace =
    (exports._projectLngLatToClipSpace as
      | WasmProjectLngLatToClipSpace
      | undefined) ??
    (exports.projectLngLatToClipSpace as
      | WasmProjectLngLatToClipSpace
      | undefined);
  const calculateBillboardDepthKey =
    (exports._calculateBillboardDepthKey as
      | WasmCalculateBillboardDepthKey
      | undefined) ??
    (exports.calculateBillboardDepthKey as
      | WasmCalculateBillboardDepthKey
      | undefined);
  const calculateSurfaceDepthKey =
    (exports._calculateSurfaceDepthKey as
      | WasmCalculateSurfaceDepthKey
      | undefined) ??
    (exports.calculateSurfaceDepthKey as
      | WasmCalculateSurfaceDepthKey
      | undefined);
  const unproject =
    (exports._unproject as WasmUnproject | undefined) ??
    (exports.unproject as WasmUnproject | undefined);

  if (
    !memory ||
    !malloc ||
    !free ||
    !fromLngLat ||
    !project ||
    !calculatePerspectiveRatio ||
    !projectLngLatToClipSpace ||
    !calculateBillboardDepthKey ||
    !calculateSurfaceDepthKey ||
    !unproject
  ) {
    throw new Error('Projection host WASM exports are incomplete.');
  }

  return {
    memory,
    fromLngLat,
    project,
    calculatePerspectiveRatio,
    projectLngLatToClipSpace,
    calculateBillboardDepthKey,
    calculateSurfaceDepthKey,
    unproject,
    malloc,
    free,
  };
};

/** Resolved projection_wasm.cpp */
let projectionWasmResolved: WasmHost | null | undefined;

/**
 * Initialize wasm host.
 * @returns True if initialized, otherwise (include failing) false.
 */
export const initializeWasmHost = async (): Promise<boolean> => {
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
 * Get wasm host.
 * @returns Entry points.
 */
export const prepareWasmHost = (): WasmHost => {
  if (!projectionWasmResolved) {
    throw new Error('Could not use WasmHost, needs before initialization.');
  }
  return projectionWasmResolved;
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * An array element type that createTypedBuffer.
 * @param TArray - A type for ArrayBufferView (ex: Float64Array)
 */
export type TypedArrayElement<TArray> = TArray extends {
  [index: number]: infer T;
}
  ? T
  : never;

/**
 * Typed ArrayBufferView.
 * @param TArray - A type for ArrayBufferView (ex: Float64Array)
 */
export interface TypedArrayBufferView<TArray> extends ArrayBufferView {
  /**
   * Copy in an array.
   * @param from An array.
   */
  readonly set: (from: ArrayLike<TypedArrayElement<TArray>>) => void;
}

/**
 * TypedArrayBuffer view constructor type.
 * @param TArray - A type for ArrayBufferView (ex: Float64Array)
 */
export type TypedArrayConstructor<TArray extends TypedArrayBufferView<TArray>> =
  {
    readonly BYTES_PER_ELEMENT: number;
    new (buffer: ArrayBuffer, byteOffset: number, length: number): TArray;
  };

/**
 * The BufferHolder, capsule both wasm raw memory pointer and ArrayBufferBuffer.
 * @param TArray - A type for ArrayBufferView (ex: Float64Array)
 */
export interface BufferHolder<TArray extends TypedArrayBufferView<TArray>> {
  /**
   * Prepare and get the raw pointer and the buffer reference.
   * @returns The raw pointer and the buffer reference.
   */
  readonly prepare: () => { ptr: number; buffer: TArray };
  /**
   * Release the buffer.
   * @returns
   */
  readonly release: () => void;
}

/**
 * Helper for wasm interoperation buffer.
 * @param TArray - A type for ArrayBufferView (ex: Float64Array)
 * @param wasm - WasmHost
 * @param ArrayType - ArrayBufferView constructor
 * @param elements - Buffer element count or copy in data array.
 */
export const createTypedBuffer = <TArray extends TypedArrayBufferView<TArray>>(
  wasm: WasmHost,
  ArrayType: TypedArrayConstructor<TArray>,
  elements: number | ArrayLike<TypedArrayElement<TArray>>
): BufferHolder<TArray> => {
  const isElementLength = typeof elements === 'number';
  const length = isElementLength ? elements : elements.length;

  let ptr = wasm.malloc(length * ArrayType.BYTES_PER_ELEMENT);
  let buffer: TArray = new ArrayType(wasm.memory.buffer, ptr, length);

  if (!isElementLength) {
    buffer.set(elements);
  }

  const prepare = () => {
    if (ptr === 0) {
      throw new Error('Buffer already freed.');
    }
    // Out of dated the buffer
    if (buffer.buffer !== wasm.memory.buffer) {
      buffer = new ArrayType(wasm.memory.buffer, ptr, length);
    }
    return { ptr, buffer };
  };

  const release = () => {
    if (ptr !== 0) {
      wasm.free(ptr);
      ptr = 0;
      buffer = undefined!;
    }
  };

  return {
    prepare,
    release,
  };
};
