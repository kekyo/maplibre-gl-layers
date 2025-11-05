// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  PreparedDrawSpriteImageParams,
  PrepareDrawSpriteImageParams,
  RenderCalculationHost,
} from './internalTypes';
import { prepareWasmHost, type WasmHost } from './wasmHost';
import {
  prepareProjectionState,
  type PreparedProjectionState,
  type ProjectionHostParams,
} from './projectionHost';
import { createCalculationHost } from './calculationHost';

//////////////////////////////////////////////////////////////////////////////////////

// TODO: To be implementing in wasm side.
const prepareDrawSpriteImagesInternal = <TTag>(
  _wasm: WasmHost,
  _preparedState: PreparedProjectionState,
  _params: PrepareDrawSpriteImageParams<TTag>
): PreparedDrawSpriteImageParams<TTag>[] => {
  // TODO: To be implementing in wasm side.
  return undefined!;
};
void prepareDrawSpriteImagesInternal;

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Create calculation host that wasm implementation.
 * @param TTag Tag type.
 * @param params Projection host params.
 * @returns Calculation host.
 */
export const createWasmCalculationHost = <TTag>(
  params: ProjectionHostParams
): RenderCalculationHost<TTag> => {
  // Get wasm host.
  const wasm = prepareWasmHost();
  void wasm; // (ignored warning)

  // Prepare parameters.
  const preparedState = prepareProjectionState(params);
  void preparedState; // (ignored warning)

  // TODO: Remove this when wasm implementation is done.
  const baseHost = createCalculationHost<TTag>(params);

  return {
    prepareDrawSpriteImages: (params) =>
      baseHost.prepareDrawSpriteImages(params),
    //prepareDrawSpriteImagesInternal(wasm, preparedState, params),
    release: () => {},
  };
};
