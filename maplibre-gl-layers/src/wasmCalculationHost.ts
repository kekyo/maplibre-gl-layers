// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  CollectDepthSortedItemsInputs,
  DepthSortedItem,
  PreparedDrawSpriteImageParams,
  PrepareDrawSpriteImageInputs,
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
const collectDepthSortedItemsInternal = <T>(
  _wasm: WasmHost,
  _preparedState: PreparedProjectionState,
  _inputs: CollectDepthSortedItemsInputs<T>
): DepthSortedItem<T>[] => {
  return undefined!;
};
void collectDepthSortedItemsInternal;

// TODO: To be implementing in wasm side.
const prepareDrawSpriteImagesInternal = <T>(
  _wasm: WasmHost,
  _preparedState: PreparedProjectionState,
  _items: readonly Readonly<DepthSortedItem<T>>[],
  _inputs: PrepareDrawSpriteImageInputs<T>
): PreparedDrawSpriteImageParams<T>[] => {
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
    collectDepthSortedItems: (inputs) =>
      baseHost.collectDepthSortedItems(inputs),
    //prepareDrawSpriteImagesInternal(wasm, preparedState, inputs),
    prepareDrawSpriteImages: (items, inputs) =>
      baseHost.prepareDrawSpriteImages(items, inputs),
    //prepareDrawSpriteImagesInternal(wasm, preparedState, items, inputs),
    release: () => {},
  };
};
