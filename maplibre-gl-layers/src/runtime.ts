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

export const isSpriteLayerHostEnabled = () =>
  spriteLayerHostVariant !== 'disabled';

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
