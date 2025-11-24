// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo)
// Under MIT

#include <emscripten/emscripten.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cmath>

#include "calculation_host_common.h"
#include "interpolation_layouts.h"

constexpr double DISTANCE_EPSILON = 1e-6;
constexpr double DEGREE_EPSILON = 1e-6;

static inline double clamp01(double value) {
  if (!std::isfinite(value)) {
    return 1.0;
  }
  if (value <= 0.0) {
    return 0.0;
  }
  if (value >= 1.0) {
    return 1.0;
  }
  return value;
}

static inline int decodeMode(double modeCode) {
  if (modeCode == 1.0) {
    return 1;  // in
  }
  if (modeCode == 2.0) {
    return 2;  // out
  }
  return 0;  // in-out
}

static inline double applyEasingPreset(double progress,
                                       int32_t presetId,
                                       double param0,
                                       double param1,
                                       double param2) {
  (void)param2;
  constexpr double PI = 3.14159265358979323846;
  const double t = clamp01(progress);
  switch (presetId) {
    case 0:  // linear
    default:
      return t;
    case 1: {  // ease (power param0, mode param1)
      const double power = param0 > 0.0 ? param0 : 3.0;
      const int mode = decodeMode(param1);
      if (mode == 1) {
        return std::pow(t, power);
      }
      if (mode == 2) {
        return 1.0 - std::pow(1.0 - t, power);
      }
      if (t < 0.5) {
        const double x = t * 2.0;
        return 0.5 * std::pow(x, power);
      }
      const double x = 2.0 - t * 2.0;
      return 1.0 - 0.5 * std::pow(x, power);
    }
    case 4: {  // exponential (exponent param0, mode param1)
      const double exponent = param0 > 0.0 ? param0 : 5.0;
      const int mode = decodeMode(param1);
      const double denom = std::expm1(exponent);
      auto expIn = [&](double v) -> double {
        if (v == 0.0) {
          return 0.0;
        }
        if (v == 1.0) {
          return 1.0;
        }
        return std::expm1(exponent * v) / denom;
      };
      auto expOut = [&](double v) -> double {
        if (v == 0.0) {
          return 0.0;
        }
        if (v == 1.0) {
          return 1.0;
        }
        return 1.0 - std::expm1(exponent * (1.0 - v)) / denom;
      };
      switch (mode) {
        case 1:  // in
          return expIn(t);
        case 2:  // out
          return expOut(t);
        default:  // in-out
          if (t < 0.5) {
            return 0.5 * expIn(t * 2.0);
          }
          return 0.5 + 0.5 * expOut(t * 2.0 - 1.0);
      }
    }
    case 5: {  // quadratic (mode param0)
      const int mode = decodeMode(param0);
      if (mode == 1) {
        return t * t;
      }
      if (mode == 2) {
        return 1.0 - (1.0 - t) * (1.0 - t);
      }
      if (t < 0.5) {
        const double x = t * 2.0;
        return 0.5 * x * x;
      }
      const double x = 2.0 - t * 2.0;
      return 1.0 - 0.5 * x * x;
    }
    case 6: {  // cubic (mode param0)
      const int mode = decodeMode(param0);
      if (mode == 1) {
        return t * t * t;
      }
      if (mode == 2) {
        const double inv = 1.0 - t;
        return 1.0 - inv * inv * inv;
      }
      if (t < 0.5) {
        const double x = t * 2.0;
        return 0.5 * x * x * x;
      }
      const double x = 2.0 - t * 2.0;
      return 1.0 - 0.5 * x * x * x;
    }
    case 7: {  // sine (mode param0, amplitude param1)
      const int mode = decodeMode(param0);
      const double amplitude = param1 > 0.0 ? param1 : 1.0;
      if (mode == 1) {  // in
        return amplitude * (1.0 - std::cos((PI / 2.0) * t));
      }
      if (mode == 2) {  // out
        return amplitude * std::sin((PI / 2.0) * t);
      }
      return amplitude * 0.5 * (1.0 - std::cos(PI * t));
    }
    case 8: {  // bounce (bounces param0, decay param1)
      const double bounces =
          std::max(1.0, std::round(param0 > 0.0 ? param0 : 3.0));
      const double decay =
          param1 <= 0.0 ? 0.5 : (param1 > 1.0 ? 1.0 : param1);
      const double oscillation = std::cos(PI * (bounces + 0.5) * t);
      const double dampening = std::pow(decay, t * bounces);
      return 1.0 - std::abs(oscillation) * dampening;
    }
    case 9: {  // back (overshoot param0)
      const double overshoot =
          (std::isfinite(param0) && param0 != 0.0) ? param0 : 1.70158;
      const double c3 = overshoot + 1.0;
      const double p = t - 1.0;
      return 1.0 + c3 * p * p * p + overshoot * p * p;
    }
  }
}

static inline double resolveTimestamp(double timestamp) {
  if (std::isfinite(timestamp)) {
    return timestamp;
  }
  return emscripten_get_now();
}

static inline double resolveEffectiveStart(double startTimestamp,
                                           double timestamp) {
  return startTimestamp >= 0.0 ? startTimestamp : timestamp;
}

static inline double lerp(double from, double to, double ratio) {
  return from + (to - from) * ratio;
}

static inline void writeNumericInterpolationResult(double* target,
                                                   double value,
                                                   bool completed,
                                                   double effectiveStart) {
  target[0] = value;
  target[1] = completed ? 1.0 : 0.0;
  target[2] = effectiveStart;
}

static inline void writeSpriteInterpolationResult(double* target,
                                                  double lng,
                                                  double lat,
                                                  double z,
                                                  bool hasZ,
                                                  bool completed,
                                                  double effectiveStart) {
  target[0] = lng;
  target[1] = lat;
  target[2] = hasZ ? z : 0.0;
  target[3] = hasZ ? 1.0 : 0.0;
  target[4] = completed ? 1.0 : 0.0;
  target[5] = effectiveStart;
}

extern "C" {

static inline bool evaluateDistanceInterpolationsImpl(
    std::size_t count,
    const double* cursor,
    double* write) {
  const double* readCursor = cursor;
  double* writeCursor = write;
  for (std::size_t i = 0; i < count; ++i) {
    const double duration = readCursor[0];
    const double from = readCursor[1];
    const double to = readCursor[2];
    const double finalValue = readCursor[3];
    const double startTimestamp = readCursor[4];
    const double timestampRaw = readCursor[5];
    const int32_t easingPresetId = static_cast<int32_t>(readCursor[6]);
    const double easingParam0 = readCursor[7];
    const double easingParam1 = readCursor[8];
    const double easingParam2 = readCursor[9];
    readCursor += DISTANCE_INTERPOLATION_ITEM_LENGTH;

    const double timestamp = resolveTimestamp(timestampRaw);
    const double effectiveStart =
        resolveEffectiveStart(startTimestamp, timestamp);

    double resultValue = finalValue;
    bool completed = true;
    if (duration > 0.0 && std::fabs(to - from) > DISTANCE_EPSILON) {
      const double elapsed = timestamp - effectiveStart;
      const double rawProgress = duration <= 0.0 ? 1.0 : elapsed / duration;
      const double eased = applyEasingPreset(
          rawProgress, easingPresetId, easingParam0, easingParam1,
          easingParam2);
      const double interpolated = lerp(from, to, eased);
      completed = rawProgress >= 1.0;
      resultValue = completed ? finalValue : interpolated;
    }

    writeNumericInterpolationResult(
        writeCursor, resultValue, completed, effectiveStart);
    writeCursor += DISTANCE_INTERPOLATION_RESULT_LENGTH;
  }
  return true;
}

EMSCRIPTEN_KEEPALIVE bool evaluateDistanceInterpolations(const double* paramsPtr,
                                                         double* resultPtr) {
  if (paramsPtr == nullptr || resultPtr == nullptr) {
    return false;
  }
  std::size_t count = 0;
  if (!convertToSizeT(paramsPtr[0], count)) {
    return false;
  }
  const double* cursor = paramsPtr + INTERPOLATION_BATCH_HEADER_LENGTH;
  double* write = resultPtr + INTERPOLATION_BATCH_HEADER_LENGTH;
  resultPtr[0] = static_cast<double>(count);
  return evaluateDistanceInterpolationsImpl(count, cursor, write);
}

static inline bool evaluateDegreeInterpolationsImpl(
    std::size_t count,
    const double* cursor,
    double* write) {
  const double* readCursor = cursor;
  double* writeCursor = write;
  for (std::size_t i = 0; i < count; ++i) {
    const double duration = readCursor[0];
    const double from = readCursor[1];
    const double to = readCursor[2];
    const double finalValue = readCursor[3];
    const double startTimestamp = readCursor[4];
    const double timestampRaw = readCursor[5];
    const int32_t easingPresetId = static_cast<int32_t>(readCursor[6]);
    const double easingParam0 = readCursor[7];
    const double easingParam1 = readCursor[8];
    const double easingParam2 = readCursor[9];
    readCursor += DEGREE_INTERPOLATION_ITEM_LENGTH;

    const double timestamp = resolveTimestamp(timestampRaw);
    const double effectiveStart =
        resolveEffectiveStart(startTimestamp, timestamp);

    double resultValue = finalValue;
    bool completed = true;
    if (duration > 0.0 && std::fabs(to - from) > DEGREE_EPSILON) {
      const double elapsed = timestamp - effectiveStart;
      const double rawProgress = duration <= 0.0 ? 1.0 : elapsed / duration;
      const double eased = applyEasingPreset(
          rawProgress, easingPresetId, easingParam0, easingParam1,
          easingParam2);
      const double interpolated = lerp(from, to, eased);
      completed = rawProgress >= 1.0;
      resultValue = completed ? finalValue : interpolated;
    }

    writeNumericInterpolationResult(writeCursor,
                                    normalizeAngleDeg(resultValue), completed,
                                    effectiveStart);
    writeCursor += DEGREE_INTERPOLATION_RESULT_LENGTH;
  }
  return true;
}

EMSCRIPTEN_KEEPALIVE bool evaluateDegreeInterpolations(const double* paramsPtr,
                                                       double* resultPtr) {
  if (paramsPtr == nullptr || resultPtr == nullptr) {
    return false;
  }
  std::size_t count = 0;
  if (!convertToSizeT(paramsPtr[0], count)) {
    return false;
  }
  const double* cursor = paramsPtr + INTERPOLATION_BATCH_HEADER_LENGTH;
  double* write = resultPtr + INTERPOLATION_BATCH_HEADER_LENGTH;
  resultPtr[0] = static_cast<double>(count);
  return evaluateDegreeInterpolationsImpl(count, cursor, write);
}

static inline bool evaluateSpriteInterpolationsImpl(
    std::size_t count,
    const double* cursor,
    double* write) {
  const double* readCursor = cursor;
  double* writeCursor = write;
  for (std::size_t i = 0; i < count; ++i) {
    const double duration = readCursor[0];
    const double fromLng = readCursor[1];
    const double fromLat = readCursor[2];
    const double fromZ = readCursor[3];
    const double toLng = readCursor[4];
    const double toLat = readCursor[5];
    const double toZ = readCursor[6];
    const bool hasZ = readCursor[7] != 0.0;
    const double startTimestamp = readCursor[8];
    const double timestampRaw = readCursor[9];
    const int32_t easingPresetId = static_cast<int32_t>(readCursor[10]);
    const double easingParam0 = readCursor[11];
    const double easingParam1 = readCursor[12];
    const double easingParam2 = readCursor[13];
    readCursor += SPRITE_INTERPOLATION_ITEM_LENGTH;

    const double timestamp = resolveTimestamp(timestampRaw);
    const double effectiveStart =
        resolveEffectiveStart(startTimestamp, timestamp);

    double resultLng = toLng;
    double resultLat = toLat;
    double resultZ = toZ;
    bool completed = true;

    const bool requiresInterpolation =
        duration > 0.0 &&
        (std::fabs(toLng - fromLng) > DISTANCE_EPSILON ||
         std::fabs(toLat - fromLat) > DISTANCE_EPSILON ||
         (hasZ && std::fabs(toZ - fromZ) > DISTANCE_EPSILON));

    if (requiresInterpolation) {
      const double elapsed = timestamp - effectiveStart;
      const double rawProgress = duration <= 0.0 ? 1.0 : elapsed / duration;
      const double eased = applyEasingPreset(
          rawProgress, easingPresetId, easingParam0, easingParam1,
          easingParam2);
      completed = rawProgress >= 1.0;
      if (!completed) {
        resultLng = lerp(fromLng, toLng, eased);
        resultLat = lerp(fromLat, toLat, eased);
        if (hasZ) {
          resultZ = lerp(fromZ, toZ, eased);
        }
      }
    }

    writeSpriteInterpolationResult(writeCursor, resultLng, resultLat, resultZ,
                                   hasZ, completed, effectiveStart);
    writeCursor += SPRITE_INTERPOLATION_RESULT_LENGTH;
  }
  return true;
}

EMSCRIPTEN_KEEPALIVE bool evaluateSpriteInterpolations(const double* paramsPtr,
                                                       double* resultPtr) {
  if (paramsPtr == nullptr || resultPtr == nullptr) {
    return false;
  }
  std::size_t count = 0;
  if (!convertToSizeT(paramsPtr[0], count)) {
    return false;
  }
  const double* cursor = paramsPtr + INTERPOLATION_BATCH_HEADER_LENGTH;
  double* write = resultPtr + INTERPOLATION_BATCH_HEADER_LENGTH;
  resultPtr[0] = static_cast<double>(count);
  return evaluateSpriteInterpolationsImpl(count, cursor, write);
}

EMSCRIPTEN_KEEPALIVE bool processInterpolations(const double* paramsPtr,
                                                double* resultPtr) {
  if (paramsPtr == nullptr || resultPtr == nullptr) {
    return false;
  }
  const auto* paramHeader = AsProcessInterpolationsHeader(paramsPtr);
  auto* resultHeader = AsProcessInterpolationsHeader(resultPtr);
  std::size_t distanceCount = 0;
  std::size_t degreeCount = 0;
  std::size_t spriteCount = 0;
  if (!convertToSizeT(paramHeader->distanceCount, distanceCount) ||
      !convertToSizeT(paramHeader->degreeCount, degreeCount) ||
      !convertToSizeT(paramHeader->spriteCount, spriteCount)) {
    return false;
  }

  const double* cursor = paramsPtr + PROCESS_INTERPOLATIONS_HEADER_LENGTH;
  double* write = resultPtr + PROCESS_INTERPOLATIONS_HEADER_LENGTH;
  resultHeader->distanceCount = static_cast<double>(distanceCount);
  resultHeader->degreeCount = static_cast<double>(degreeCount);
  resultHeader->spriteCount = static_cast<double>(spriteCount);

  if (!evaluateDistanceInterpolationsImpl(distanceCount, cursor, write)) {
    return false;
  }
  cursor += distanceCount * DISTANCE_INTERPOLATION_ITEM_LENGTH;
  write += distanceCount * DISTANCE_INTERPOLATION_RESULT_LENGTH;

  if (!evaluateDegreeInterpolationsImpl(degreeCount, cursor, write)) {
    return false;
  }
  cursor += degreeCount * DEGREE_INTERPOLATION_ITEM_LENGTH;
  write += degreeCount * DEGREE_INTERPOLATION_RESULT_LENGTH;

  if (!evaluateSpriteInterpolationsImpl(spriteCount, cursor, write)) {
    return false;
  }

  return true;
}

} // extern "C"
