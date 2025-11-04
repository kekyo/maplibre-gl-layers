// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import {
  createProjectionHost,
  type ProjectionHostParams,
} from './projectionHost';
import type { ProjectionHost, SpriteMercatorCoordinate } from './internalTypes';
import type { SpriteLocation } from './types';

//////////////////////////////////////////////////////////////////////////////////////

const WASM_FromLngLat_RESULT_ELEMENT_COUNT = 3;
const WASM_FromLngLat_RESULT_BYTES =
  Float64Array.BYTES_PER_ELEMENT * WASM_FromLngLat_RESULT_ELEMENT_COUNT;

type WasmFromLngLat = (
  lng: number,
  lat: number,
  altitude: number,
  outPtr: number
) => void;

interface RawProjectionWasmExports {
  readonly memory?: WebAssembly.Memory;
  readonly _fromLngLat?: WasmFromLngLat;
  readonly fromLngLat?: WasmFromLngLat;
  readonly _malloc?: (size: number) => number;
  readonly malloc?: (size: number) => number;
  readonly _free?: (ptr: number) => void;
  readonly free?: (ptr: number) => void;
  readonly __wasm_call_ctors?: () => void;
}

interface ResolvedProjectionWasm {
  readonly memory: WebAssembly.Memory;
  readonly fromLngLat: WasmFromLngLat;
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
  const malloc =
    (exports._malloc as ((size: number) => number) | undefined) ??
    (exports.malloc as ((size: number) => number) | undefined);
  const free =
    (exports._free as ((ptr: number) => void) | undefined) ??
    (exports.free as ((ptr: number) => void) | undefined);

  if (!memory || !fromLngLat || !malloc || !free) {
    throw new Error('Projection host WASM exports are incomplete.');
  }

  return {
    memory,
    fromLngLat,
    malloc,
    free,
  };
};

//////////////////////////////////////////////////////////////////////////////////////

//const toFiniteOr = (value: number | undefined, fallback: number): number =>
//  Number.isFinite(value) ? (value as number) : fallback;

/**
 * Create `fromLngLat` delegator.
 * @param wasm Wasm hosted reference.
 * @returns fromLngLat function object.
 */
const createFromLngLat = (wasm: ResolvedProjectionWasm) => {
  let resultBuffer = wasm.malloc(WASM_FromLngLat_RESULT_BYTES);
  let results = new Float64Array(
    wasm.memory.buffer,
    resultBuffer,
    WASM_FromLngLat_RESULT_ELEMENT_COUNT
  );

  // fromLngLat delegation body
  const fromLngLat = (
    location: Readonly<SpriteLocation>
  ): SpriteMercatorCoordinate => {
    // Call wasm entry point.
    wasm.fromLngLat(location.lng, location.lat, location.z ?? 0, resultBuffer);

    // Extract results from the wasm buffer.
    const x = results[0]!;
    const y = results[1]!;
    const z = results[2]!;

    return { x, y, z };
  };

  // Buffer releaser
  const release = () => {
    wasm.free(resultBuffer);
    results = undefined!;
    resultBuffer = 0;
  };
  fromLngLat.release = release;

  return fromLngLat;
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

  // TODO: Fallback pure implementation, finally remove this.
  const fallbackHost = createProjectionHost(params);

  // Member: fromLngLat
  const fromLngLat = createFromLngLat(projectionWasmResolved);

  // TODO: Other ProjectionHost members

  // The projection host disposer
  const release = () => {
    fromLngLat.release();
  };

  return {
    ...fallbackHost,
    fromLngLat, // Overrided
    release,
  };
};
