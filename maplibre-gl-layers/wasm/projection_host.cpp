#include <cmath>
#include <cstddef>
#include <limits>

#include <emscripten/emscripten.h>

//////////////////////////////////////////////////////////////////////////////////////

namespace {

constexpr double PI = 3.14159265358979323846264338327950288;
constexpr double MAX_MERCATOR_LATITUDE = 85.051129;
constexpr double DEG2RAD = PI / 180.0;
constexpr double EARTH_RADIUS_METERS = 6378137.0;

inline double toFiniteOr(double value, double fallback) {
  return std::isfinite(value) ? value : fallback;
}

inline double clamp(double value, double min, double max) {
  return std::fmax(std::fmin(value, max), min);
}

inline double mercatorXfromLng(double lng) {
  return (180.0 + lng) / 360.0;
}

inline double mercatorYfromLat(double lat) {
  const double constrained =
      clamp(lat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const double radians = constrained * DEG2RAD;
  return (180.0 - (180.0 / PI) *
      std::log(std::tan(PI / 4.0 + radians / 2.0))) /
      360.0;
}

inline double circumferenceAtLatitude(double latitudeDeg) {
  return 2.0 * PI * EARTH_RADIUS_METERS *
    std::cos(latitudeDeg * DEG2RAD);
}

inline double mercatorZfromAltitude(double altitude, double latDeg) {
  const double circumference = circumferenceAtLatitude(latDeg);
  if (circumference == 0.0) {
    return 0.0;
  }
  return altitude / circumference;
}

}  // namespace

//////////////////////////////////////////////////////////////////////////////////////

extern "C" {

EMSCRIPTEN_KEEPALIVE void fromLngLat(double lng,
                                     double lat,
                                     double altitude,
                                     double* out) {
  if (out == nullptr) {
    return;
  }

  const double finiteLng = toFiniteOr(lng, 0.0);
  const double finiteLat = toFiniteOr(lat, 0.0);
  const double constrainedLat =
      clamp(finiteLat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const double finiteAltitude = toFiniteOr(altitude, 0.0);

  out[0] = mercatorXfromLng(finiteLng);
  out[1] = mercatorYfromLat(constrainedLat);
  out[2] = mercatorZfromAltitude(finiteAltitude, constrainedLat);
}

//////////////////////////////////////////////////////////////////////////////////////

EMSCRIPTEN_KEEPALIVE void project(double lng,
                                  double lat,
                                  double altitude,
                                  const double* context,
                                  double* out) {
  if (context == nullptr || out == nullptr) {
    return;
  }

  const double worldSize = context[0];
  if (!std::isfinite(worldSize) || worldSize <= 0.0) {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    out[0] = nan;
    out[1] = nan;
    out[2] = nan;
    return;
  }

  const double* matrix = context + 1;

  const double finiteLng = toFiniteOr(lng, 0.0);
  const double finiteLat = toFiniteOr(lat, 0.0);
  const double constrainedLat =
      clamp(finiteLat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const double finiteAltitude = toFiniteOr(altitude, 0.0);

  const double mercatorX = mercatorXfromLng(finiteLng);
  const double mercatorY = mercatorYfromLat(constrainedLat);
  const double worldX = mercatorX * worldSize;
  const double worldY = mercatorY * worldSize;
  const double elevation = finiteAltitude;

  const double clipX =
      matrix[0] * worldX + matrix[4] * worldY + matrix[8] * elevation +
      matrix[12];
  const double clipY =
      matrix[1] * worldX + matrix[5] * worldY + matrix[9] * elevation +
      matrix[13];
  const double clipW =
      matrix[3] * worldX + matrix[7] * worldY + matrix[11] * elevation +
      matrix[15];

  if (!std::isfinite(clipX) || !std::isfinite(clipY) || !std::isfinite(clipW) ||
      clipW <= 0.0) {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    out[0] = nan;
    out[1] = nan;
    out[2] = nan;
    return;
  }

  const double projectedX = clipX / clipW;
  const double projectedY = clipY / clipW;

  if (!std::isfinite(projectedX) || !std::isfinite(projectedY)) {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    out[0] = nan;
    out[1] = nan;
    out[2] = nan;
    return;
  }

  out[0] = projectedX;
  out[1] = projectedY;
  out[2] = clipW;
}

}  // extern "C"
