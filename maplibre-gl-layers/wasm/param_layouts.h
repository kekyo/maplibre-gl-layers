// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo)
// Under MIT

#pragma once

#ifndef _PARAM_LAYOUTS_H
#define _PARAM_LAYOUTS_H

#include <cstddef>
#include <cstdint>

////////////////////////////////////////////////////////////////////////////////
// Constants that mirror the TypeScript definitions in src/wasmCalculationHost.ts

constexpr std::size_t INPUT_HEADER_LENGTH = 15;
constexpr std::size_t INPUT_FRAME_CONSTANT_LENGTH = 24;
constexpr std::size_t INPUT_MATRIX_LENGTH = 48;
constexpr std::size_t RESOURCE_STRIDE = 9;
constexpr std::size_t SPRITE_STRIDE = 6;
constexpr std::size_t ITEM_STRIDE = 27;

constexpr std::size_t RESULT_HEADER_LENGTH = 7;
constexpr std::size_t RESULT_VERTEX_COMPONENT_LENGTH = 36;
constexpr std::size_t RESULT_HIT_TEST_COMPONENT_LENGTH = 8;
constexpr std::size_t RESULT_COMMON_ITEM_LENGTH = 19;
constexpr std::size_t RESULT_SURFACE_BLOCK_LENGTH = 68;
constexpr std::size_t RESULT_ITEM_STRIDE =
    RESULT_COMMON_ITEM_LENGTH + RESULT_VERTEX_COMPONENT_LENGTH +
    RESULT_HIT_TEST_COMPONENT_LENGTH + RESULT_SURFACE_BLOCK_LENGTH;

// Interpolation batch layouts mirrored in TypeScript (src/wasmCalculationHost.ts).
constexpr std::size_t INTERPOLATION_BATCH_HEADER_LENGTH = 1;
constexpr std::size_t DISTANCE_INTERPOLATION_ITEM_LENGTH = 7;
constexpr std::size_t DISTANCE_INTERPOLATION_RESULT_LENGTH = 3;
constexpr std::size_t DEGREE_INTERPOLATION_ITEM_LENGTH = 7;
constexpr std::size_t DEGREE_INTERPOLATION_RESULT_LENGTH = 3;
constexpr std::size_t SPRITE_INTERPOLATION_ITEM_LENGTH = 11;
constexpr std::size_t SPRITE_INTERPOLATION_RESULT_LENGTH = 6;
constexpr std::size_t PROCESS_INTERPOLATIONS_HEADER_LENGTH = 3;

struct ProcessInterpolationsHeader {
  double distanceCount;
  double degreeCount;
  double spriteCount;
};

static_assert(sizeof(ProcessInterpolationsHeader) ==
              PROCESS_INTERPOLATIONS_HEADER_LENGTH * sizeof(double));

static inline const ProcessInterpolationsHeader*
AsProcessInterpolationsHeader(const double* ptr) {
  return reinterpret_cast<const ProcessInterpolationsHeader*>(ptr);
}

static inline ProcessInterpolationsHeader*
AsProcessInterpolationsHeader(double* ptr) {
  return reinterpret_cast<ProcessInterpolationsHeader*>(ptr);
}

////////////////////////////////////////////////////////////////////////////////
// Input buffer layout

struct InputBufferHeader {
  double totalLength;
  double frameConstCount;
  double matrixOffset;
  double resourceCount;
  double resourceOffset;
  double spriteCount;
  double spriteOffset;
  double itemCount;
  double itemOffset;
  double flags;
  double reserved0;
  double reserved1;
  double reserved2;
  double reserved3;
  double reserved4;
};

static_assert(sizeof(InputBufferHeader) == INPUT_HEADER_LENGTH * sizeof(double));

struct InputResourceEntry {
  double handle;
  double width;
  double height;
  double textureReady;
  double atlasPageIndex;
  double atlasU0;
  double atlasV0;
  double atlasU1;
  double atlasV1;
};

static_assert(sizeof(InputResourceEntry) == RESOURCE_STRIDE * sizeof(double));

struct InputSpriteEntry {
  double lng;
  double lat;
  double altitude;
  double mercatorX;
  double mercatorY;
  double mercatorZ;
};

static_assert(sizeof(InputSpriteEntry) == SPRITE_STRIDE * sizeof(double));

struct InputItemEntry {
  double spriteHandle;
  double resourceHandle;
  double originTargetIndex;
  double originUseResolvedAnchor;
  double mode;
  double scale;
  double opacity;
  double anchorX;
  double anchorY;
  double offsetMeters;
  double offsetDeg;
  double displayedRotateDeg;
  double resolvedBaseRotateDeg;
  double rotateDeg;
  double order;
  double subLayer;
  double originReferenceKey;
  double bucketReferenceKey;
  double bucketReferenceIndex;
  double imageHandle;
  double spriteLng;
  double spriteLat;
  double spriteZ;
  double originSubLayer;
  double originOrder;
  double originUseAnchor;
  double bucketIndex;
};

static_assert(sizeof(InputItemEntry) == ITEM_STRIDE * sizeof(double));

static inline const InputBufferHeader* AsInputHeader(const double* ptr) {
  return reinterpret_cast<const InputBufferHeader*>(ptr);
}

static inline InputBufferHeader* AsInputHeader(double* ptr) {
  return reinterpret_cast<InputBufferHeader*>(ptr);
}

////////////////////////////////////////////////////////////////////////////////
// Result buffer layout

struct ResultBufferHeader {
  double preparedCount;
  double itemStride;
  double vertexComponentCount;
  double surfaceCornerCount;
  double flags;
  double reserved0;
  double reserved1;
};

static_assert(sizeof(ResultBufferHeader) == RESULT_HEADER_LENGTH * sizeof(double));

struct ResultItemEntry {
  double spriteHandle;
  double imageIndex;
  double resourceIndex;
  double opacity;
  double screenToClipScaleX;
  double screenToClipScaleY;
  double screenToClipOffsetX;
  double screenToClipOffsetY;
  double useShaderSurface;
  double surfaceClipEnabled;
  double useShaderBillboard;
  double billboardCenterX;
  double billboardCenterY;
  double billboardHalfWidth;
  double billboardHalfHeight;
  double billboardAnchorX;
  double billboardAnchorY;
  double billboardSin;
  double billboardCos;
  // Followed by RESULT_VERTEX_COMPONENT_LENGTH doubles,
  // RESULT_HIT_TEST_COMPONENT_LENGTH doubles and RESULT_SURFACE_BLOCK_LENGTH doubles.
};

static_assert(sizeof(ResultItemEntry) == RESULT_COMMON_ITEM_LENGTH * sizeof(double));

static inline const ResultBufferHeader* AsResultHeader(const double* ptr) {
  return reinterpret_cast<const ResultBufferHeader*>(ptr);
}

static inline ResultBufferHeader* AsResultHeader(double* ptr) {
  return reinterpret_cast<ResultBufferHeader*>(ptr);
}

#endif
