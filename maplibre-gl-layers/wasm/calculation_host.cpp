#include "projection_host.h"

#include <emscripten/emscripten.h>

#include <cstdint>

//////////////////////////////////////////////////////////////////////////////////////

constexpr double MIN_CLIP_W = 1e-6;
constexpr double RAD2DEG = 180.0 / PI;
constexpr double MIN_COS_LAT = 1e-6;

static inline void applySurfaceDisplacement(double baseLng,
                                            double baseLat,
                                            double baseAltitude,
                                            double east,
                                            double north,
                                            double& outLng,
                                            double& outLat,
                                            double& outAltitude) {
  const double deltaLat = (north / EARTH_RADIUS_METERS) * RAD2DEG;
  const double cosLat = std::cos(baseLat * DEG2RAD);
  const double cosLatClamped = std::fmax(cosLat, MIN_COS_LAT);
  const double deltaLng =
      (east / (EARTH_RADIUS_METERS * cosLatClamped)) * RAD2DEG;

  outLng = baseLng + deltaLng;
  outLat = baseLat + deltaLat;
  outAltitude = baseAltitude;
}

static inline bool __projectLngLatToClipSpace(double lng,
                                              double lat,
                                              double altitude,
                                              const double* matrix,
                                              double* out) {
  double mercator[3] = {0.0, 0.0, 0.0};
  if (!__fromLngLat(lng, lat, altitude, mercator)) {
    return false;
  }

  double clipX = 0.0;
  double clipY = 0.0;
  double clipZ = 0.0;
  double clipW = 0.0;
  multiplyMatrixAndVector(
      matrix, mercator[0], mercator[1], mercator[2], 1.0, clipX, clipY, clipZ,
      clipW);

  if (!std::isfinite(clipX) || !std::isfinite(clipY) ||
      !std::isfinite(clipZ) || !std::isfinite(clipW) || clipW <= MIN_CLIP_W) {
    return false;
  }

  out[0] = clipX;
  out[1] = clipY;
  out[2] = clipZ;
  out[3] = clipW;

  return true;
}

//////////////////////////////////////////////////////////////////////////////////////

static inline bool __calculateBillboardDepthKey(double centerX,
                                                double centerY,
                                                double worldSize,
                                                const double* inverseMatrix,
                                                const double* mercatorMatrix,
                                                double* out) {
  if (!std::isfinite(worldSize) || worldSize <= 0.0) {
    return false;
  }

  double lngLat[2] = {0.0, 0.0};
  if (!__unproject(centerX, centerY, worldSize, inverseMatrix, lngLat)) {
    return false;
  }

  double mercator[3] = {0.0, 0.0, 0.0};
  if (!__fromLngLat(lngLat[0], lngLat[1], 0.0, mercator)) {
    return false;
  }

  double clipX = 0.0;
  double clipY = 0.0;
  double clipZ = 0.0;
  double clipW = 0.0;
  multiplyMatrixAndVector(mercatorMatrix,
                          mercator[0],
                          mercator[1],
                          mercator[2],
                          1.0,
                          clipX,
                          clipY,
                          clipZ,
                          clipW);

  if (!std::isfinite(clipX) || !std::isfinite(clipY) ||
      !std::isfinite(clipZ) || !std::isfinite(clipW)) {
    return false;
  }

  const double ndcZ = clipW != 0.0 ? (clipZ / clipW) : clipZ;
  if (!std::isfinite(ndcZ)) {
    return false;
  }

  *out = -ndcZ;
  return true;
}

//////////////////////////////////////////////////////////////////////////////////////

static inline bool __calculateSurfaceDepthKey(double baseLng,
                                              double baseLat,
                                              double baseAltitude,
                                              const double* displacements,
                                              int displacementCount,
                                              const int32_t* indices,
                                              int indexCount,
                                              const double* mercatorMatrix,
                                              bool applyBias,
                                              double biasNdc,
                                              double minClipZEpsilon,
                                              double* out) {
  if (displacementCount <= 0 || indexCount <= 0) {
    return false;
  }

  double clip[4] = {0.0, 0.0, 0.0, 0.0};
  double maxDepth = -std::numeric_limits<double>::infinity();

  for (int index = 0; index < indexCount; index++) {
    const int32_t displacementIndex = indices[index];
    if (displacementIndex < 0 || displacementIndex >= displacementCount) {
      continue;
    }

    const double east = displacements[displacementIndex * 2 + 0];
    const double north = displacements[displacementIndex * 2 + 1];

    double displacedLng = 0.0;
    double displacedLat = 0.0;
    double displacedAltitude = 0.0;
    applySurfaceDisplacement(baseLng,
                             baseLat,
                             baseAltitude,
                             east,
                             north,
                             displacedLng,
                             displacedLat,
                             displacedAltitude);

    if (!__projectLngLatToClipSpace(displacedLng,
                                    displacedLat,
                                    displacedAltitude,
                                    mercatorMatrix,
                                    clip)) {
      return false;
    }

    double clipZ = clip[2];
    const double clipW = clip[3];

    if (!std::isfinite(clipZ) || !std::isfinite(clipW)) {
      return false;
    }

    if (applyBias) {
      const double biasedClipZ = clipZ + biasNdc * clipW;
      const double minClipZ = -clipW + minClipZEpsilon;
      clipZ = biasedClipZ < minClipZ ? minClipZ : biasedClipZ;
    }

    const double ndcZ = clipW != 0.0 ? (clipZ / clipW) : clipZ;
    if (!std::isfinite(ndcZ)) {
      return false;
    }

    const double depthCandidate = -ndcZ;
    if (depthCandidate > maxDepth) {
      maxDepth = depthCandidate;
    }
  }

  if (!std::isfinite(maxDepth)) {
    return false;
  }

  *out = maxDepth;
  return true;
}

//////////////////////////////////////////////////////////////////////////////////////

extern "C" {

EMSCRIPTEN_KEEPALIVE bool projectLngLatToClipSpace(double lng,
                                                   double lat,
                                                   double altitude,
                                                   const double* matrix,
                                                   double* out) {
  if (matrix == nullptr || out == nullptr) {
    return false;
  }

  return __projectLngLatToClipSpace(lng, lat, altitude, matrix, out);
}

EMSCRIPTEN_KEEPALIVE bool calculateBillboardDepthKey(double centerX,
                                                     double centerY,
                                                     double worldSize,
                                                     const double* inverseMatrix,
                                                     const double* mercatorMatrix,
                                                     double* out) {
  if (inverseMatrix == nullptr || mercatorMatrix == nullptr || out == nullptr) {
    return false;
  }

  return __calculateBillboardDepthKey(
      centerX, centerY, worldSize, inverseMatrix, mercatorMatrix, out);
}

EMSCRIPTEN_KEEPALIVE bool calculateSurfaceDepthKey(double baseLng,
                                                   double baseLat,
                                                   double baseAltitude,
                                                   const double* displacements,
                                                   int displacementCount,
                                                   const int32_t* indices,
                                                   int indexCount,
                                                   const double* mercatorMatrix,
                                                   int applyBias,
                                                   double biasNdc,
                                                   double minClipZEpsilon,
                                                   double* out) {
  if (displacements == nullptr || indices == nullptr ||
      mercatorMatrix == nullptr || out == nullptr) {
    return false;
  }

  return __calculateSurfaceDepthKey(baseLng,
                                    baseLat,
                                    baseAltitude,
                                    displacements,
                                    displacementCount,
                                    indices,
                                    indexCount,
                                    mercatorMatrix,
                                    applyBias != 0,
                                    biasNdc,
                                    minClipZEpsilon,
                                    out);
}

} // extern "C"
