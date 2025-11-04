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

// TODO: Will add calculation host related function types.

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
    !unproject
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
 * A holder that createTypedBuffer.
 * @param TArray - A type for ArrayBufferView (ex: Float64Array)
 */
export interface BufferHolder<TArray extends ArrayBufferView> {
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

export type TypedArrayConstructor<TArray extends ArrayBufferView> = {
  readonly BYTES_PER_ELEMENT: number;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): TArray;
};

/**
 * Helper for wasm interoperation buffer.
 * @param TArray - A type for ArrayBufferView (ex: Float64Array)
 * @param wasm - WasmHost
 * @param ArrayType - ArrayBufferView constructor
 * @param elementCount - Buffer element count
 */
export const createTypedBuffer = <TArray extends ArrayBufferView>(
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
