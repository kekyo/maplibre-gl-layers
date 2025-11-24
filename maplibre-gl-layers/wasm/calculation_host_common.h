// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo)
// Under MIT

#pragma once

#ifndef _CALCULATION_HOST_COMMON_H
#define _CALCULATION_HOST_COMMON_H

#include <cmath>
#include <cstddef>

static inline double normalizeAngleDeg(double angle) {
  if (!std::isfinite(angle)) {
    return 0.0;
  }
  const double wrapped = std::fmod(angle, 360.0);
  double normalized = wrapped < 0.0 ? wrapped + 360.0 : wrapped;
  if (normalized == -0.0) {
    normalized = 0.0;
  }
  return normalized;
}

static inline bool convertToSizeT(double value, std::size_t& out) {
  if (!std::isfinite(value)) {
    return false;
  }
  if (value < 0.0) {
    return false;
  }
  const double truncated = std::floor(value + 0.5);
  if (!std::isfinite(truncated)) {
    return false;
  }
  const auto candidate = static_cast<std::size_t>(truncated);
  if (static_cast<double>(candidate) != truncated) {
    return false;
  }
  out = candidate;
  return true;
}

#endif
