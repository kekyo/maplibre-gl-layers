// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { Releaseable } from './internalTypes';
import type { SpriteLayerCalculationVariant } from './types';

//////////////////////////////////////////////////////////////////////////////////////

const BUFFER_POOL_ENTRY_TTL_MS = 5_000;
const BUFFER_POOL_SWEEP_INTERVAL_MS = 3_000;
const BUFFER_POOL_MAX_REUSE_RATIO = 2;

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

export type WasmPrepareDrawSpriteImages = (
  paramsPtr: number,
  resultPtr: number
) => boolean;

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Wasm raw pointer type.
 */
export type Pointer = number;

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
  readonly length: number;
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
  readonly prepare: () => { ptr: Pointer; buffer: TArray };
  /**
   * Release the buffer.
   * @returns
   */
  readonly release: () => void;
}

/**
 * Wasm host reference.
 */
export interface WasmHost {
  /**
   * Helper for wasm interoperation buffer.
   * @param TArray - A type for ArrayBufferView (ex: Float64Array)
   * @param ArrayType - ArrayBufferView constructor
   * @param elements - Buffer element count or copy in data array.
   */
  readonly allocateTypedBuffer: <TArray extends TypedArrayBufferView<TArray>>(
    ArrayType: TypedArrayConstructor<TArray>,
    elements: number | ArrayLike<TypedArrayElement<TArray>>
  ) => BufferHolder<TArray>;

  // ProjectionHost related functions.
  readonly fromLngLat: WasmFromLngLat;
  readonly project: WasmProject;
  readonly calculatePerspectiveRatio: WasmCalculatePerspectiveRatio;
  readonly unproject: WasmUnproject;
  readonly projectLngLatToClipSpace: WasmProjectLngLatToClipSpace;
  readonly calculateBillboardDepthKey: WasmCalculateBillboardDepthKey;
  readonly calculateSurfaceDepthKey: WasmCalculateSurfaceDepthKey;
  readonly prepareDrawSpriteImages?: WasmPrepareDrawSpriteImages;
}

export type WasmVariant = SpriteLayerCalculationVariant;

//////////////////////////////////////////////////////////////////////////////////////

type WasmBinaryVariant = Exclude<WasmVariant, 'disabled'>;

const WASM_BINARY_PATHS: Record<WasmBinaryVariant, string> = {
  simd: './wasm/offloads-simd.wasm',
  nosimd: './wasm/offloads-nosimd.wasm',
};

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
  readonly _prepareDrawSpriteImages?: WasmPrepareDrawSpriteImages;
  readonly prepareDrawSpriteImages?: WasmPrepareDrawSpriteImages;
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
const loadWasmBinary = async (
  variant: WasmBinaryVariant
): Promise<ArrayBuffer> => {
  const wasmUrl = new URL(WASM_BINARY_PATHS[variant], import.meta.url);

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
    throw new Error(`Failed to load ${variant} offloads WASM: ${wasmUrl.href}`);
  }
  return await response.arrayBuffer();
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Internal interface of BufferHolder.
 */
interface InternalBufferHolder<TArray extends TypedArrayBufferView<TArray>>
  extends BufferHolder<TArray> {
  __ptr: Pointer;
  __buffer: TArray;
  __capacity: number;
  __length: number;
  /** Is this pooled? */
  __pooled: boolean;
  /** Last time this holder returned to the pool. */
  __lastReleasedAt: number;
  /** Completely free heap memory */
  __free: () => void;
  prepare: () => { ptr: Pointer; buffer: TArray };
  release: () => void;
}

/**
 * Load wasm binary, instantiate and refer entry points.
 * @returns WasmHost
 */
const instantiateProjectionWasm = async (
  variant: WasmBinaryVariant
): Promise<WasmHost & Releaseable> => {
  // Load wasm binary and instantiate.
  const binary = await loadWasmBinary(variant);
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
  const unproject =
    (exports._unproject as WasmUnproject | undefined) ??
    (exports.unproject as WasmUnproject | undefined);
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
  const prepareDrawSpriteImages =
    (exports._prepareDrawSpriteImages as
      | WasmPrepareDrawSpriteImages
      | undefined) ??
    (exports.prepareDrawSpriteImages as
      | WasmPrepareDrawSpriteImages
      | undefined);

  if (
    !memory ||
    !malloc ||
    !free ||
    !fromLngLat ||
    !project ||
    !unproject ||
    !calculatePerspectiveRatio ||
    !projectLngLatToClipSpace ||
    !calculateBillboardDepthKey ||
    !calculateSurfaceDepthKey ||
    !prepareDrawSpriteImages
  ) {
    throw new Error('Projection host WASM exports are incomplete.');
  }

  /** Pooled BufferHolder, grouping by the type and length. */
  const pool = new Map<
    TypedArrayConstructor<any>,
    Map<number, InternalBufferHolder<any>[]>
  >();
  let destroyed = false;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;

  const getNow = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  const sweepPool = () => {
    if (destroyed || pool.size === 0) {
      return;
    }

    const limit = getNow() - BUFFER_POOL_ENTRY_TTL_MS;
    const emptyTypeKeys: TypedArrayConstructor<any>[] = [];
    pool.forEach((typedPool, typeKey) => {
      const emptyLengths: number[] = [];
      typedPool.forEach((stack, length) => {
        let writeIndex = 0;
        for (let i = 0; i < stack.length; i++) {
          const holder = stack[i]!;
          if (!holder.__pooled) {
            continue;
          }
          if (holder.__lastReleasedAt <= limit) {
            //console.log(`freed:${holder.__length}`);
            holder.__free();
            continue;
          }
          stack[writeIndex++] = holder;
        }
        if (writeIndex === 0) {
          stack.length = 0;
          emptyLengths.push(length);
        } else {
          stack.length = writeIndex;
        }
      });
      emptyLengths.forEach((length) => typedPool.delete(length));
      if (typedPool.size === 0) {
        emptyTypeKeys.push(typeKey);
      }
    });
    emptyTypeKeys.forEach((typeKey) => pool.delete(typeKey));

    if (!destroyed && pool.size > 0) {
      sweepTimer = setTimeout(() => {
        sweepTimer = undefined;
        sweepPool();
      }, BUFFER_POOL_SWEEP_INTERVAL_MS);
    }
  };

  const schedulePoolSweep = () => {
    if (destroyed || pool.size === 0 || sweepTimer) {
      return;
    }
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      sweepPool();
    }, BUFFER_POOL_SWEEP_INTERVAL_MS);
  };

  /**
   * Allocate a buffer.
   * @param TArray - A type for ArrayBufferView (ex: Float64Array)
   * @param length Buffer length (not size)
   * @param ArrayType - ArrayBufferView constructor
   * @returns `InternalBufferHolder<TArray>`
   */
  const allocate = <TArray extends TypedArrayBufferView<TArray>>(
    length: number,
    ArrayType: TypedArrayConstructor<TArray>
  ) => {
    let typedPool = pool.get(ArrayType);
    if (!typedPool) {
      typedPool = new Map();
      pool.set(ArrayType, typedPool);
    }

    let candidate: InternalBufferHolder<TArray> | undefined;
    const exactStack = typedPool.get(length) as
      | InternalBufferHolder<TArray>[]
      | undefined;
    if (exactStack && exactStack.length > 0) {
      candidate = exactStack.pop();
      if (exactStack.length === 0) {
        typedPool.delete(length);
        if (typedPool.size === 0) {
          pool.delete(ArrayType);
        }
      }
    }
    if (!candidate && typedPool.size > 0) {
      const maxCapacity = length * BUFFER_POOL_MAX_REUSE_RATIO;
      let bestCapacity: number | undefined;
      let bestStack: InternalBufferHolder<TArray>[] | undefined;
      typedPool.forEach((stack, capacity) => {
        if (stack.length === 0) {
          typedPool.delete(capacity);
          return;
        }
        if (capacity < length || capacity > maxCapacity) {
          return;
        }
        if (bestStack === undefined || capacity < (bestCapacity as number)) {
          bestStack = stack as InternalBufferHolder<TArray>[];
          bestCapacity = capacity;
        }
      });
      if (bestStack && bestStack.length > 0) {
        candidate = bestStack.pop();
        if (bestStack.length === 0) {
          typedPool.delete(bestCapacity!);
          if (typedPool.size === 0) {
            pool.delete(ArrayType);
          }
        }
      }
    }
    if (!candidate) {
      //console.log(`allocated: ${length}`);
      let ptr = malloc(length * ArrayType.BYTES_PER_ELEMENT);
      let buffer: TArray = new ArrayType(memory.buffer, ptr, length);
      const prepare = () => {
        if (candidate!.__ptr === 0) {
          throw new Error('Buffer already freed.');
        }
        // Out of dated the buffer
        if (
          candidate!.__buffer.buffer !== memory.buffer ||
          candidate!.__buffer.length !== candidate!.__length
        ) {
          candidate!.__buffer = new ArrayType(
            memory.buffer,
            candidate!.__ptr,
            candidate!.__length
          );
        }
        return { ptr: candidate!.__ptr, buffer: candidate!.__buffer };
      };
      const release = () => {
        if (candidate!.__pooled) {
          return;
        }
        if (destroyed) {
          candidate!.__free();
          return;
        }
        candidate!.__pooled = true;
        candidate!.__lastReleasedAt = getNow();
        const capacity = candidate!.__capacity;
        let stack = typedPool!.get(capacity);
        if (!stack) {
          stack = [];
          typedPool!.set(capacity, stack);
        }
        if (!pool.has(ArrayType)) {
          pool.set(ArrayType, typedPool!);
        }
        stack.push(candidate!);
        schedulePoolSweep();
      };
      const __free = () => {
        if (candidate!.__ptr) {
          //console.log(`freed: ${length}`);
          free(candidate!.__ptr);
          candidate!.__ptr = 0;
          candidate!.__buffer = undefined!;
          candidate!.__capacity = 0;
          candidate!.__length = 0;
          candidate!.__pooled = false;
          candidate!.__lastReleasedAt = 0;
          candidate!.__free = undefined!;
          candidate!.prepare = undefined!;
          candidate!.release = undefined!;
        }
      };
      candidate = {
        prepare,
        release,
        __ptr: ptr,
        __buffer: buffer,
        __capacity: length,
        __length: length,
        __pooled: false,
        __lastReleasedAt: 0,
        __free,
      };
    } else {
      candidate.__pooled = false;
      candidate.__length = length;
      candidate.__lastReleasedAt = 0;
    }

    return candidate;
  };

  /**
   * Helper for wasm interoperation buffer.
   * @param TArray - A type for ArrayBufferView (ex: Float64Array)
   * @param ArrayType - ArrayBufferView constructor
   * @param elements - Buffer element count or copy in data array.
   */
  const allocateTypedBuffer = <TArray extends TypedArrayBufferView<TArray>>(
    ArrayType: TypedArrayConstructor<TArray>,
    elements: number | ArrayLike<TypedArrayElement<TArray>>
  ): BufferHolder<TArray> => {
    const isElementLength = typeof elements === 'number';
    const length = isElementLength ? elements : elements.length;

    const candidate = allocate(length, ArrayType);

    // Copy in initial values
    if (!isElementLength) {
      const { buffer } = candidate.prepare();
      buffer.set(elements);
    }

    return candidate;
  };

  /**
   * Free overall pooled buffers.
   */
  const release = () => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    if (sweepTimer) {
      clearTimeout(sweepTimer);
      sweepTimer = undefined;
    }
    pool.forEach((typedPool) => {
      typedPool.forEach((stack) => {
        stack.forEach((holder) => {
          holder.__free();
        });
        stack.length = 0;
      });
      typedPool.clear();
    });
    pool.clear();
  };

  return {
    allocateTypedBuffer,
    fromLngLat,
    project,
    unproject,
    calculatePerspectiveRatio,
    projectLngLatToClipSpace,
    calculateBillboardDepthKey,
    calculateSurfaceDepthKey,
    prepareDrawSpriteImages,
    release,
  };
};

const initializeWasmHostInternal = async (
  preferredVariant: WasmVariant
): Promise<[WasmVariant, (WasmHost & Releaseable) | undefined]> => {
  if (preferredVariant === 'disabled') {
    console.log(
      'maplibre-gl-layers: Wasm execution disabled by configuration.'
    );
    return ['disabled', undefined];
  }

  const variantsToTry: WasmBinaryVariant[] =
    preferredVariant === 'simd' ? ['simd', 'nosimd'] : ['nosimd'];

  for (const variant of variantsToTry) {
    try {
      const wasmHost = await instantiateProjectionWasm(variant);
      console.log(
        `maplibre-gl-layers: Initialized wasm module (variant: ${variant}).`
      );
      return [variant, wasmHost];
    } catch (error) {
      console.warn(
        `maplibre-gl-layers: Failed to initialize ${variant} wasm module.`,
        error
      );
    }
  }

  console.warn(
    'maplibre-gl-layers: Falling back to JavaScript implementation.'
  );
  return ['disabled', undefined];
};

let currentVariant: WasmVariant = 'disabled';
let currentWasmHost: (WasmHost & Releaseable) | undefined;

/**
 * Wasm initialization options.
 */
export interface InitializeWasmHostOptions {
  /** Force initialization. Default is false. */
  readonly force?: boolean;
}

/**
 * Initialize wasm offload module.
 * @param preferredVariant Uses wasm offload module variant.
 * @param options Options.
 * @returns Initialized WasmHost.
 */
export const initializeWasmHost = async (
  preferredVariant: WasmVariant,
  options?: InitializeWasmHostOptions
): Promise<WasmVariant> => {
  if (options?.force) {
    currentWasmHost = undefined;
  }

  if (currentWasmHost !== undefined) {
    return currentVariant;
  }

  const [variant, wasmHost] =
    await initializeWasmHostInternal(preferredVariant);
  currentVariant = variant;
  currentWasmHost = wasmHost;

  return variant;
};

/**
 * Release wasm offload module.
 */
export const releaseWasmHost = () => {
  if (currentWasmHost) {
    currentWasmHost.release();
    currentWasmHost = undefined;
    currentVariant = 'disabled';
  }
};

/**
 * Get wasm host.
 * @returns Entry points.
 */
export const prepareWasmHost = (): WasmHost => {
  if (!currentWasmHost) {
    throw new Error('Could not use WasmHost, needs before initialization.');
  }
  return currentWasmHost;
};
