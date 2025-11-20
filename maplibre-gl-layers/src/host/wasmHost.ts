// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { Releasable } from '../internalTypes';
import type { SpriteLayerCalculationVariant } from '../types';
import wasmConfig from '../wasm/config.json' assert { type: 'json' };

//////////////////////////////////////////////////////////////////////////////////////

const BUFFER_POOL_ENTRY_TTL_MS = 5_000;
const BUFFER_POOL_SWEEP_INTERVAL_MS = 3_000;
const BUFFER_POOL_MAX_REUSE_RATIO = 2;
const CONFIGURED_PTHREAD_POOL_SIZE =
  typeof wasmConfig?.pthreadPoolSize === 'number'
    ? Math.max(0, Math.trunc(wasmConfig.pthreadPoolSize))
    : 0;

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

export type WasmProcessInterpolations = (
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
   * Element count (Float64Array: mod 8)
   */
  readonly length: number;
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
  readonly unproject: WasmUnproject;
  readonly calculatePerspectiveRatio: WasmCalculatePerspectiveRatio;
  readonly projectLngLatToClipSpace: WasmProjectLngLatToClipSpace;

  // CalculationHost related functions.
  readonly calculateBillboardDepthKey: WasmCalculateBillboardDepthKey;
  readonly calculateSurfaceDepthKey: WasmCalculateSurfaceDepthKey;
  readonly prepareDrawSpriteImages: WasmPrepareDrawSpriteImages;
  readonly processInterpolations: WasmProcessInterpolations;
}

export type WasmVariant = SpriteLayerCalculationVariant;

//////////////////////////////////////////////////////////////////////////////////////

type WasmBinaryVariant = Exclude<WasmVariant, 'disabled'>;

type WasmAssetKind = 'wasm' | 'js' | 'worker';

const WASM_ASSET_FILES: Record<
  WasmBinaryVariant,
  Partial<Record<WasmAssetKind, string>>
> = {
  'simd-mt': {
    wasm: 'offloads-simd-mt.wasm',
    js: 'offloads-simd-mt.js',
    worker: 'offloads-simd-mt.worker.js',
  },
  simd: {
    wasm: 'offloads-simd.wasm',
  },
  nosimd: {
    wasm: 'offloads-nosimd.wasm',
  },
};

const VARIANT_FALLBACKS: Record<WasmBinaryVariant, WasmBinaryVariant[]> = {
  'simd-mt': ['simd-mt', 'simd', 'nosimd'],
  simd: ['simd', 'nosimd'],
  nosimd: ['nosimd'],
};

let threadedVariantWarningPrinted = false;

const ensureTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value : `${value}/`;

const resolveRuntimeBase = (): string => {
  const runtimeLocation = (globalThis as { location?: Location }).location;
  if (runtimeLocation?.href) {
    return runtimeLocation.href;
  }
  return import.meta.url;
};

const buildAssetUrlFromFile = (fileName: string): URL => {
  if (wasmBaseUrlOverride !== undefined) {
    const normalizedBase = ensureTrailingSlash(wasmBaseUrlOverride);
    const baseUrl = resolveBaseUrl(normalizedBase);
    return new URL(fileName, baseUrl);
  }
  return new URL(`../wasm/${fileName}`, import.meta.url);
};

const resolveVariantAssetUrl = (
  variant: WasmBinaryVariant,
  kind: WasmAssetKind
): URL => {
  const files = WASM_ASSET_FILES[variant];
  const fileName = files?.[kind];
  if (!fileName) {
    throw new Error(`Asset ${kind} is not defined for variant "${variant}".`);
  }
  return buildAssetUrlFromFile(fileName);
};

const resolveBaseUrl = (base: string): URL => {
  try {
    return new URL(base);
  } catch {
    return new URL(base, resolveRuntimeBase());
  }
};

let wasmBaseUrlOverride: string | undefined;

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

const canUseThreadedWasm = (): boolean => {
  if (isNodeEnvironment) {
    return true;
  }
  if (typeof SharedArrayBuffer === 'undefined') {
    return false;
  }
  const globalFlags = globalThis as { crossOriginIsolated?: boolean };
  if ('crossOriginIsolated' in globalFlags) {
    return !!globalFlags.crossOriginIsolated;
  }
  return false;
};

const importNodeModule = async <T>(specifier: string): Promise<T> =>
  (await import(/* @vite-ignore */ specifier)) as T;

const createImportNamespace = (
  additional?: Record<string, unknown>
): Record<string, unknown> => {
  const functionStub = () => 0;
  const target: Record<string, unknown> = additional ? { ...additional } : {};
  return new Proxy(target, {
    get(currentTarget, prop: string) {
      if (prop in currentTarget) {
        return currentTarget[prop];
      }
      return functionStub;
    },
  });
};

/**
 * Load wasm binary.
 * @returns Raw wasm binary stream.
 */
const loadWasmBinary = async (
  variant: WasmBinaryVariant
): Promise<ArrayBuffer> => {
  const wasmUrl = resolveVariantAssetUrl(variant, 'wasm');

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
 * Raw interface for wasm export functions.
 */
interface RawProjectionWasmExports {
  // Runtime related functions
  readonly memory?: WebAssembly.Memory;
  readonly _malloc?: (size: number) => number;
  readonly malloc?: (size: number) => number;
  readonly _free?: (ptr: number) => void;
  readonly free?: (ptr: number) => void;
  readonly __wasm_call_ctors?: () => void;

  // Wasm implementations
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
  readonly _processInterpolations?: WasmProcessInterpolations;
  readonly processInterpolations?: WasmProcessInterpolations;
  readonly _setThreadPoolSize?: (count: number) => void;
}

/**
 * Internal interface of BufferHolder.
 */
interface InternalBufferHolder<TArray extends TypedArrayBufferView<TArray>>
  extends BufferHolder<TArray> {
  /** Raw pointer */
  __ptr: Pointer;
  /** Buffer view (ex: Float64Array) */
  __buffer: TArray;
  /** Real capacity */
  __capacity: number;
  /** Is this pooled? */
  __pooled: boolean;
  /** Last time this holder returned to the pool. */
  __lastReleasedAt: number;
  /** Completely free heap memory */
  __free: () => void;
  /** Element count (Float64Array: mod 8) */
  length: number;

  // Mutable BufferHolder members
  prepare: () => { ptr: Pointer; buffer: TArray };
  release: () => void;
}

const resolveThreadPoolLimit = (): number => {
  const hardware =
    typeof navigator !== 'undefined' &&
    typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 0;
  if (CONFIGURED_PTHREAD_POOL_SIZE > 0 && hardware > 0) {
    return Math.min(CONFIGURED_PTHREAD_POOL_SIZE, hardware);
  }
  if (CONFIGURED_PTHREAD_POOL_SIZE > 0) {
    return CONFIGURED_PTHREAD_POOL_SIZE;
  }
  return hardware;
};

const instantiateThreadedProjectionWasm =
  async (): Promise<RawProjectionWasmExports> => {
    const scriptUrl = resolveVariantAssetUrl('simd-mt', 'js');
    const wasmUrl = resolveVariantAssetUrl('simd-mt', 'wasm');
    const workerUrl = resolveVariantAssetUrl('simd-mt', 'worker');

    const moduleFactory = await import(/* @vite-ignore */ scriptUrl.href);
    const createModule = (moduleFactory?.default ??
      moduleFactory?.Module ??
      moduleFactory) as
      | ((moduleArgs?: Record<string, unknown>) => Promise<unknown>)
      | undefined;

    if (typeof createModule !== 'function') {
      throw new Error('maplibre-gl-layers: simd-mt module is unavailable.');
    }

    const moduleInstance = (await createModule({
      locateFile: (path: string) => {
        if (path.endsWith('.wasm')) {
          return wasmUrl.href;
        }
        if (path.endsWith('.worker.js')) {
          return workerUrl.href;
        }
        return path;
      },
    })) as RawProjectionWasmExports;

    const threadLimit = resolveThreadPoolLimit();
    if (
      threadLimit > 0 &&
      typeof moduleInstance._setThreadPoolSize === 'function'
    ) {
      moduleInstance._setThreadPoolSize(threadLimit);
    }

    return moduleInstance;
  };

/**
 * Load wasm binary, instantiate and refer entry points.
 * @returns WasmHost
 */
const instantiateProjectionWasm = async (
  variant: WasmBinaryVariant
): Promise<WasmHost & Releasable> => {
  if (variant === 'simd-mt') {
    const threadedExports = await instantiateThreadedProjectionWasm();
    return createWasmHostFromExports(threadedExports);
  }

  const binary = await loadWasmBinary(variant);
  const imports: WebAssembly.Imports = {};
  const importTargets = imports as Record<string, unknown>;
  importTargets.wasi_snapshot_preview1 = createImportNamespace();
  importTargets.env = createImportNamespace();
  const { instance } = await WebAssembly.instantiate(binary, imports);
  const exports = instance.exports as RawProjectionWasmExports;
  return createWasmHostFromExports(exports);
};

const createWasmHostFromExports = (
  exports: RawProjectionWasmExports
): WasmHost & Releasable => {
  if (typeof exports.__wasm_call_ctors === 'function') {
    exports.__wasm_call_ctors();
  }

  const memory =
    exports.memory ??
    (exports as unknown as { wasmMemory?: WebAssembly.Memory }).wasmMemory;
  if (!memory) {
    throw new Error('maplibre-gl-layers: wasm memory is unavailable.');
  }
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
  const processInterpolations =
    (exports._processInterpolations as WasmProcessInterpolations | undefined) ??
    (exports.processInterpolations as WasmProcessInterpolations | undefined);

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
    !prepareDrawSpriteImages ||
    !processInterpolations
  ) {
    throw new Error('Projection host WASM exports are incomplete.');
  }

  //====================================================================

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
    // Find typed pool by `ArrayType` constructor.
    let typedPool = pool.get(ArrayType);
    if (!typedPool) {
      typedPool = new Map();
      pool.set(ArrayType, typedPool);
    }

    // Get exact length pooled holder
    let candidate: InternalBufferHolder<TArray> | undefined;
    const exactStack = typedPool.get(length);
    if (exactStack && exactStack.length > 0) {
      // Got and last one
      candidate = exactStack.pop()!;
      if (exactStack.length === 0) {
        // Shrink the maps.
        typedPool.delete(length);
        if (typedPool.size === 0) {
          pool.delete(ArrayType);
        }
      }
      candidate.__pooled = false;
      candidate.__lastReleasedAt = 0;
      return candidate;
    }

    // Could not get exact length holder and available remains
    if (typedPool.size > 0) {
      // Find not exact but loose fit holder
      const maxCapacity = length * BUFFER_POOL_MAX_REUSE_RATIO;
      let bestCapacity: number | undefined;
      let bestStack: InternalBufferHolder<TArray>[] | undefined;
      typedPool.forEach((stack, capacity) => {
        // Removed garbage
        if (stack.length === 0) {
          typedPool.delete(capacity);
          return;
        }
        // Ignore this when not loose fit
        if (capacity < length || capacity > maxCapacity) {
          return;
        }
        // Better than last one
        if (bestStack === undefined || capacity < (bestCapacity as number)) {
          // Found candidate stack
          bestStack = stack;
          bestCapacity = capacity;
        }
      });

      // Found it
      if (bestStack && bestStack.length > 0) {
        // Got holder
        candidate = bestStack.pop()!;
        // Shrink the maps.
        if (bestStack.length === 0) {
          typedPool.delete(bestCapacity!);
          if (typedPool.size === 0) {
            pool.delete(ArrayType);
          }
        }
        candidate.__pooled = false;
        candidate.__lastReleasedAt = 0;
        return candidate;
      }
    }

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
        candidate!.__buffer.length !== candidate!.length
      ) {
        candidate!.__buffer = new ArrayType(
          memory.buffer,
          candidate!.__ptr,
          candidate!.length
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
        candidate!.__pooled = false;
        candidate!.__lastReleasedAt = 0;
        candidate!.__free = undefined!;
        candidate!.length = 0;
        candidate!.prepare = undefined!;
        candidate!.release = undefined!;
      }
    };
    candidate = {
      length: length,
      prepare,
      release,
      __ptr: ptr,
      __buffer: buffer,
      __capacity: length,
      __pooled: false,
      __lastReleasedAt: 0,
      __free,
    };

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
    processInterpolations,
    release,
  };
};

const initializeWasmHostInternal = async (
  preferredVariant: WasmVariant
): Promise<[WasmVariant, (WasmHost & Releasable) | undefined]> => {
  if (preferredVariant === 'disabled') {
    console.log(
      'maplibre-gl-layers: Wasm execution disabled by configuration.'
    );
    return ['disabled', undefined];
  }

  const variantsToTry: WasmBinaryVariant[] = VARIANT_FALLBACKS[
    preferredVariant as WasmBinaryVariant
  ] ?? ['nosimd'];

  for (const variant of variantsToTry) {
    if (variant === 'simd-mt' && !canUseThreadedWasm()) {
      if (!threadedVariantWarningPrinted) {
        console.warn(
          'maplibre-gl-layers: SharedArrayBuffer is unavailable, skipping simd-mt wasm variant.'
        );
        threadedVariantWarningPrinted = true;
      }
      continue;
    }
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
let currentWasmHost: (WasmHost & Releasable) | undefined;

/**
 * Wasm initialization options.
 */
export interface InitializeWasmHostOptions {
  /** Force initialization. Default is false. */
  readonly force: boolean;
  /** Override the URL used to fetch wasm artifacts. */
  readonly wasmBaseUrl: string | undefined;
}

/**
 * Initialize wasm offload module.
 * @param preferredVariant Uses wasm offload module variant.
 * @param options Options.
 * @returns Initialized WasmHost.
 */
export const initializeWasmHost = async (
  preferredVariant: WasmVariant,
  options: InitializeWasmHostOptions
): Promise<WasmVariant> => {
  let nextBaseUrl = wasmBaseUrlOverride;
  if (options?.wasmBaseUrl !== undefined) {
    nextBaseUrl = options.wasmBaseUrl === '' ? undefined : options.wasmBaseUrl;
  }

  const baseChanged = nextBaseUrl !== wasmBaseUrlOverride;
  if (options?.wasmBaseUrl !== undefined) {
    wasmBaseUrlOverride = nextBaseUrl;
  }

  if (options?.force || baseChanged) {
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
