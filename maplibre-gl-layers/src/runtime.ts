// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { createMutex } from 'async-primitives';

import type {
  SpriteLayerCalculationVariant,
  SpriteLayerHostOptions,
} from './types';
import {
  initializeWasmHost,
  releaseWasmHost,
  type WasmVariant,
} from './wasmHost';

//////////////////////////////////////////////////////////////////////////////////////

const spriteLayerHostInitializationMutex = createMutex();
let spriteLayerHostVariant: WasmVariant = 'disabled';
let wasmHostFatalError: unknown = null;

const logWasmFallback = (reason?: unknown) => {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(
      '[maplibre-gl-layers] Falling back to JS hosts due to a WASM error.',
      reason
    );
  }
};

export const isSpriteLayerHostEnabled = () =>
  spriteLayerHostVariant !== 'disabled' && wasmHostFatalError === null;

export const reportWasmRuntimeFailure = (reason?: unknown): void => {
  if (wasmHostFatalError !== null) {
    return;
  }
  wasmHostFatalError = reason ?? true;
  logWasmFallback(reason);
  releaseRuntimeHost();
};

/**
 * Initialize maplibre-gl-layers runtime host.
 * @param variantOrOptions Options.
 * @returns Initialized calculation variant.
 */
export const initializeRuntimeHost = async (
  options?: SpriteLayerHostOptions
): Promise<SpriteLayerCalculationVariant> => {
  const locker = await spriteLayerHostInitializationMutex.lock();
  try {
    if (wasmHostFatalError !== null) {
      logWasmFallback(
        'WASM hosts have been permanently disabled after a previous error.'
      );
      return 'disabled';
    }
    const requestedVariant = options?.variant ?? 'simd';
    if (requestedVariant === 'disabled') {
      releaseRuntimeHost();
      return 'disabled';
    }
    const forceReload = options !== undefined;
    spriteLayerHostVariant = await initializeWasmHost(requestedVariant, {
      force: forceReload,
      wasmBaseUrl: options?.wasmBaseUrl,
    });
    return spriteLayerHostVariant;
  } finally {
    locker.release();
  }
};

/**
 * Release maplibre-gl-layers runtime host.
 * @returns
 */
export const releaseRuntimeHost = (): void => {
  if (spriteLayerHostVariant === 'disabled') {
    return;
  }
  spriteLayerHostVariant = 'disabled';
  releaseWasmHost();
};

/**
 * SIMD and multi-threading module availability.
 */
export interface MultiThreadedModuleAvailability {
  /** Is available? */
  readonly available: boolean;
  /** Not available, reason text */
  readonly reason?: string;
}

/**
 * Detects SIMD and multi-threading module availability.
 * @returns MultiThreadedModuleAvailability.
 */
export const detectMultiThreadedModuleAvailability =
  (): MultiThreadedModuleAvailability => {
    const scope =
      typeof globalThis === 'object'
        ? (globalThis as typeof globalThis & {
            SharedArrayBuffer?: typeof SharedArrayBuffer;
            Atomics?: typeof Atomics;
            Worker?: typeof Worker;
            crossOriginIsolated?: boolean;
          })
        : undefined;
    if (!scope) {
      return {
        available: false,
        reason: 'Global scope is unavailable.',
      };
    }
    if (typeof scope.SharedArrayBuffer !== 'function') {
      return {
        available: false,
        reason: 'SharedArrayBuffer is not available in this environment.',
      };
    }
    if (typeof scope.Atomics !== 'object') {
      return {
        available: false,
        reason: 'Atomics API is not available in this environment.',
      };
    }
    if (typeof scope.Worker !== 'function') {
      return {
        available: false,
        reason: 'Web Worker API is unavailable in this environment.',
      };
    }
    if (scope.crossOriginIsolated !== true) {
      return {
        available: false,
        reason:
          'Enable cross-origin isolation (COOP/COEP) so SharedArrayBuffer can be used.',
      };
    }
    return { available: true };
  };
