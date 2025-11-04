#include "projection_host.h"

#include <emscripten/emscripten.h>

extern "C" {

//////////////////////////////////////////////////////////////////////////////////////

EMSCRIPTEN_KEEPALIVE bool fromLngLat(double lng,
                                     double lat,
                                     double altitude,
                                     double* out) {
  // Input guards
  if (out == nullptr) {
    return false;
  }

  // Invoke main body
  return _fromLngLat(lng, lat, altitude, out);
}

//////////////////////////////////////////////////////////////////////////////////////

EMSCRIPTEN_KEEPALIVE bool project(double lng,
                                  double lat,
                                  double altitude,
                                  double worldSize,
                                  const double* matrix,
                                  double* out) {
  // Input guards
  if (matrix == nullptr || out == nullptr) {
    return false;
  }
  if (!std::isfinite(worldSize) || worldSize <= 0.0) {
    return false;
  }

  // Invoke main body
  return _project(lng, lat, altitude, worldSize, matrix, out);
}

//////////////////////////////////////////////////////////////////////////////////////

EMSCRIPTEN_KEEPALIVE bool unproject(double pointX,
                                    double pointY,
                                    double worldSize,
                                    const double* matrix,
                                    double* out) {
  // Input guards
  if (matrix == nullptr || out == nullptr) {
    return false;
  }
  if (!std::isfinite(worldSize) || worldSize <= 0.0) {
    return false;
  }

  // Invoke main body
  return _unproject(pointX, pointY, worldSize, matrix, out);
}

//////////////////////////////////////////////////////////////////////////////////////

EMSCRIPTEN_KEEPALIVE bool calculatePerspectiveRatio(double lng,
                                                    double lat,
                                                    double altitude,
                                                    const double* cachedMercator,
                                                    double cameraToCenterDistance,
                                                    const double* matrix,
                                                    double* out) {
  // Input guard
  if (matrix == nullptr || out == nullptr) {
    return false;
  }

  // Invoke main body
  return _calculatePerspectiveRatio(lng,
                             lat,
                             altitude,
                             cachedMercator,
                             cameraToCenterDistance,
                             matrix,
                             out);
}

}  // extern "C"
