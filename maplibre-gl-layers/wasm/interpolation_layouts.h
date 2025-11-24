// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo)
// Under MIT

#pragma once

#ifndef _INTERPOLATION_LAYOUTS_H
#define _INTERPOLATION_LAYOUTS_H

#include <cstddef>

// Interpolation batch layouts mirrored in TypeScript (src/wasmCalculationHost.ts).
constexpr std::size_t INTERPOLATION_BATCH_HEADER_LENGTH = 1;
constexpr std::size_t DISTANCE_INTERPOLATION_ITEM_LENGTH = 10;
constexpr std::size_t DISTANCE_INTERPOLATION_RESULT_LENGTH = 3;
constexpr std::size_t DEGREE_INTERPOLATION_ITEM_LENGTH = 10;
constexpr std::size_t DEGREE_INTERPOLATION_RESULT_LENGTH = 3;
constexpr std::size_t SPRITE_INTERPOLATION_ITEM_LENGTH = 14;
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

#endif
