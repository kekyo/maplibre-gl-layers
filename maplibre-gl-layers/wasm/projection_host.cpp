#include <cmath>
#include <cstddef>

#include <emscripten/emscripten.h>

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

}  // extern "C"
