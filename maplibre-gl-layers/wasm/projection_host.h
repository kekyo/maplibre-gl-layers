#ifndef _PROJECTION_HOST_H
#define _PROJECTION_HOST_H

#include <cmath>
#include <cstddef>
#include <limits>

//////////////////////////////////////////////////////////////////////////////////////

constexpr double PI = 3.14159265358979323846264338327950288;
constexpr double MAX_MERCATOR_LATITUDE = 85.051129;
constexpr double DEG2RAD = PI / 180.0;
constexpr double EARTH_RADIUS_METERS = 6378137.0;

static inline double toFiniteOr(double value, double fallback) {
  return std::isfinite(value) ? value : fallback;
}

static inline double clamp(double value, double min, double max) {
  return std::fmax(std::fmin(value, max), min);
}

static inline double mercatorXfromLng(double lng) {
  return (180.0 + lng) / 360.0;
}

static inline double mercatorYfromLat(double lat) {
  const double constrained =
      clamp(lat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const double radians = constrained * DEG2RAD;
  return (180.0 - (180.0 / PI) *
      std::log(std::tan(PI / 4.0 + radians / 2.0))) /
      360.0;
}

static inline double circumferenceAtLatitude(double latitudeDeg) {
  return 2.0 * PI * EARTH_RADIUS_METERS *
    std::cos(latitudeDeg * DEG2RAD);
}

static inline double mercatorZfromAltitude(double altitude, double latDeg) {
  const double circumference = circumferenceAtLatitude(latDeg);
  if (circumference == 0.0) {
    return 0.0;
  }
  return altitude / circumference;
}

static inline double lngFromMercatorX(double x) {
  return x * 360.0 - 180.0;
}

static inline double latFromMercatorY(double y) {
  const double y2 = 180.0 - y * 360.0;
  return (360.0 / PI) * std::atan(std::exp((y2 * PI) / 180.0)) - 90.0;
}

static inline void multiplyMatrixAndVector(const double* matrix,
                                    double x,
                                    double y,
                                    double z,
                                    double w,
                                    double& outX,
                                    double& outY,
                                    double& outZ,
                                    double& outW) {
  outX =
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] * w;
  outY =
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] * w;
  outZ =
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14] * w;
  outW =
      matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] * w;
}

//////////////////////////////////////////////////////////////////////////////////////

static inline bool _fromLngLat(double lng,
                        double lat,
                        double altitude,
                        double* out) {
  const double finiteLng = toFiniteOr(lng, 0.0);
  const double finiteLat = toFiniteOr(lat, 0.0);
  const double constrainedLat =
      clamp(finiteLat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const double finiteAltitude = toFiniteOr(altitude, 0.0);

  out[0] = mercatorXfromLng(finiteLng);
  out[1] = mercatorYfromLat(constrainedLat);
  out[2] = mercatorZfromAltitude(finiteAltitude, constrainedLat);

  return true;
}

//////////////////////////////////////////////////////////////////////////////////////

static inline bool _project(double lng,
                     double lat,
                     double altitude,
                     double worldSize,
                     const double* matrix,
                     double* out) {
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
  if (!std::isfinite(clipX)) {
    return false;
  }

  const double clipY =
      matrix[1] * worldX + matrix[5] * worldY + matrix[9] * elevation +
      matrix[13];
  if (!std::isfinite(clipY)) {
    return false;
  }

  const double clipW =
      matrix[3] * worldX + matrix[7] * worldY + matrix[11] * elevation +
      matrix[15];
  if (!std::isfinite(clipW) || clipW <= 0.0) {
    return false;
  }

  const double projectedX = clipX / clipW;
  const double projectedY = clipY / clipW;

  out[0] = projectedX;
  out[1] = projectedY;

  return true;
}

//////////////////////////////////////////////////////////////////////////////////////

static inline bool _unproject(double pointX,
                       double pointY,
                       double worldSize,
                       const double* matrix,
                       double* out) {
  const double finiteX = toFiniteOr(pointX, 0.0);
  const double finiteY = toFiniteOr(pointY, 0.0);

  double coord0X = 0.0, coord0Y = 0.0, coord0Z = 0.0, coord0W = 0.0;
  multiplyMatrixAndVector(
      matrix, finiteX, finiteY, 0.0, 1.0, coord0X, coord0Y, coord0Z, coord0W);

  double coord1X = 0.0, coord1Y = 0.0, coord1Z = 0.0, coord1W = 0.0;
  multiplyMatrixAndVector(
      matrix, finiteX, finiteY, 1.0, 1.0, coord1X, coord1Y, coord1Z, coord1W);

  if (!std::isfinite(coord0W) || !std::isfinite(coord1W) ||
      coord0W == 0.0 || coord1W == 0.0) {
    return false;
  }

  const double world0X = coord0X / coord0W;
  const double world0Y = coord0Y / coord0W;
  const double world0Z = coord0Z / coord0W;
  const double world1X = coord1X / coord1W;
  const double world1Y = coord1Y / coord1W;
  const double world1Z = coord1Z / coord1W;

  if (!std::isfinite(world0X) || !std::isfinite(world0Y) ||
      !std::isfinite(world0Z) || !std::isfinite(world1X) ||
      !std::isfinite(world1Y) || !std::isfinite(world1Z)) {
    return false;
  }

  const double denominator = world1Z - world0Z;
  const double t =
      denominator == 0.0 ? 0.0 : (0.0 - world0Z) / denominator;

  const double worldX = world0X + (world1X - world0X) * t;
  const double worldY = world0Y + (world1Y - world0Y) * t;

  if (!std::isfinite(worldX) || !std::isfinite(worldY)) {
    return false;
  }

  const double mercatorX = worldX / worldSize;
  const double mercatorY = worldY / worldSize;

  if (!std::isfinite(mercatorX) || !std::isfinite(mercatorY)) {
    return false;
  }

  const double lng = lngFromMercatorX(mercatorX);
  const double lat = clamp(
      latFromMercatorY(mercatorY), -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);

  if (!std::isfinite(lng) || !std::isfinite(lat)) {
    return false;
  }

  out[0] = lng;
  out[1] = lat;
  return true;
}

//////////////////////////////////////////////////////////////////////////////////////

static inline bool _calculatePerspectiveRatio(double lng,
                                       double lat,
                                       double altitude,
                                       const double* cachedMercator,
                                       double cameraToCenterDistance,
                                       const double* matrix,
                                       double* out) {
  const double* mercator;
  double _mercator[3];
  if (cachedMercator) {
    mercator = cachedMercator;
  } else {
    if (!_fromLngLat(lng, lat, altitude, _mercator)) {
      return false;
    }
    mercator = _mercator;
  }

  double clipX;
  double clipY;
  double clipZ;
  double clipW = 0.0;
  multiplyMatrixAndVector(matrix,
                          mercator[0],
                          mercator[1],
                          mercator[2],
                          1.0,
                          clipX,
                          clipY,
                          clipZ,
                          clipW);

  if (!std::isfinite(clipW) || clipW <= 0.0) {
    return false;
  }

  const double ratio = cameraToCenterDistance / clipW;
  if (std::isfinite(ratio) && ratio > 0.0) {
    out[0] = ratio;
    return true;
  } else {
    return false;
  }
}

#endif
