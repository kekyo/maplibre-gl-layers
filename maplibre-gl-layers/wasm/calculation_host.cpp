// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo)
// Under MIT

#include <emscripten/emscripten.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cmath>
#include <functional>
#include <limits>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "projection_host.h"
#include "param_layouts.h"

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

constexpr std::size_t SURFACE_CLIP_CORNER_COUNT = 4;

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

static inline bool convertToInt64(double value, int64_t& out) {
  if (!std::isfinite(value)) {
    return false;
  }
  const double truncated = std::trunc(value);
  if (!std::isfinite(truncated)) {
    return false;
  }
  const auto candidate = static_cast<int64_t>(truncated);
  if (static_cast<double>(candidate) != truncated) {
    return false;
  }
  out = candidate;
  return true;
}

static inline bool toBool(double value) {
  return value != 0.0;
}

static inline bool validateSpan(std::size_t totalLength,
                  std::size_t offset,
                  std::size_t length) {
  if (offset > totalLength) {
    return false;
  }
  if (length > totalLength - offset) {
    return false;
  }
  return true;
}


struct SpritePoint {
  double x = 0.0;
  double y = 0.0;
};

struct SpriteScreenPoint {
  double x = 0.0;
  double y = 0.0;
};

struct SpriteAnchor {
  double x = 0.0;
  double y = 0.0;
};

struct SpriteImageOffset {
  double offsetMeters = 0.0;
  double offsetDeg = 0.0;
};

static inline SpriteAnchor resolveAnchor(const InputItemEntry& entry) {
  return SpriteAnchor{entry.anchorX, entry.anchorY};
}

static inline SpriteImageOffset resolveOffset(const InputItemEntry& entry) {
  return SpriteImageOffset{entry.offsetMeters, entry.offsetDeg};
}

static inline double resolveImageScale(const InputItemEntry& entry) {
  return entry.scale != 0.0 ? entry.scale : 1.0;
}

static inline double resolveTotalRotateDeg(const InputItemEntry& entry) {
  if (std::isfinite(entry.displayedRotateDeg)) {
    return entry.displayedRotateDeg;
  }
  return normalizeAngleDeg(entry.resolvedBaseRotateDeg + entry.rotateDeg);
}

struct SurfaceCorner {
  double east = 0.0;
  double north = 0.0;
};

struct SpriteLocation {
  double lng = 0.0;
  double lat = 0.0;
  double z = 0.0;
};

struct SpriteMercatorCoordinate {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct QuadCorner {
  double x = 0.0;
  double y = 0.0;
  double u = 0.0;
  double v = 0.0;
};

struct BillboardCenterResult {
  SpriteScreenPoint center;
  double halfWidth = 0.0;
  double halfHeight = 0.0;
  double pixelWidth = 0.0;
  double pixelHeight = 0.0;
  SpritePoint anchorShift;
  SpritePoint offsetShift;
};

struct SurfaceWorldDimensions {
  double width = 0.0;
  double height = 0.0;
  double scaleAdjustment = 1.0;
};

struct SurfaceCenterResult {
  std::optional<SpriteScreenPoint> center;
  SurfaceWorldDimensions worldDimensions;
  SurfaceCorner totalDisplacement;
  SpriteLocation displacedLngLat;
  std::optional<SpriteScreenPoint> anchorlessCenter;
  std::optional<SurfaceCorner> anchorlessDisplacement;
  std::optional<SpriteLocation> anchorlessLngLat;
};

struct SurfaceShaderCornerModel {
  double east = 0.0;
  double north = 0.0;
  double lng = 0.0;
  double lat = 0.0;
};

struct ResourceInfo {
  std::size_t handle = 0;
  double width = 0.0;
  double height = 0.0;
  bool textureReady = false;
};

static inline const ResourceInfo* findResourceByHandle(
    const std::vector<ResourceInfo>& resources, double handleValue) {
  std::size_t handleIndex = 0;
  if (!convertToSizeT(handleValue, handleIndex)) {
    return nullptr;
  }
  if (handleIndex >= resources.size()) {
    return nullptr;
  }
  return &resources[handleIndex];
}

struct BucketItem {
  const InputItemEntry* entry = nullptr;
  std::size_t index = 0;
  const ResourceInfo* resource = nullptr;
  SpriteLocation spriteLocation;
  SpriteMercatorCoordinate mercator;
  bool hasMercator = false;
  SpriteScreenPoint projected;
  bool projectedValid = false;
  int64_t spriteHandle = 0;
};

using ResolveOriginFn =
    std::function<const BucketItem*(const BucketItem&)>;

struct ImageCenterCacheKey {
  double subLayer = 0.0;
  double order = 0.0;

  bool operator==(const ImageCenterCacheKey& other) const noexcept {
    return subLayer == other.subLayer && order == other.order;
  }
};

struct ImageCenterCacheKeyHash {
  std::size_t operator()(const ImageCenterCacheKey& key) const noexcept {
    const std::size_t h1 = std::hash<double>{}(key.subLayer);
    const std::size_t h2 = std::hash<double>{}(key.order);
    return h1 ^ (h2 + 0x9e3779b97f4a7c15ULL + (h1 << 6) + (h1 >> 2));
  }
};

struct ImageCenterCacheEntry {
  bool hasAnchorApplied = false;
  SpritePoint anchorApplied;
  bool hasAnchorless = false;
  SpritePoint anchorless;
};

using ImageCenterCache =
    std::unordered_map<ImageCenterCacheKey,
                       ImageCenterCacheEntry,
                       ImageCenterCacheKeyHash>;

using SpriteCenterCacheMap =
    std::unordered_map<int64_t, ImageCenterCache>;

struct DepthItem {
  const BucketItem* item = nullptr;
  double depthKey = 0.0;
};

struct DepthCollectionResult {
  std::vector<DepthItem> items;
  SpriteCenterCacheMap centerCache;
};

using ProjectToClipSpaceFn =
    std::function<bool(const SpriteLocation&, std::array<double, 4>&)>;
using ProjectLngLatFn =
    std::function<bool(const SpriteLocation&, SpriteScreenPoint&)>;

struct SurfaceCenterParams {
  SpriteLocation baseLngLat;
  double imageWidth = 0.0;
  double imageHeight = 0.0;
  double baseMetersPerPixel = 0.0;
  double imageScale = 1.0;
  double zoomScaleFactor = 1.0;
  double totalRotateDeg = 0.0;
  const SpriteAnchor* anchor = nullptr;
  const SpriteImageOffset* offset = nullptr;
  double effectivePixelsPerMeter = 0.0;
  double spriteMinPixel = 0.0;
  double spriteMaxPixel = 0.0;
  ProjectLngLatFn project;
  ProjectToClipSpaceFn projectToClipSpace;
  double drawingBufferWidth = 0.0;
  double drawingBufferHeight = 0.0;
  double pixelRatio = 0.0;
  bool resolveAnchorless = false;
};

constexpr std::array<std::array<double, 2>, 4> BILLBOARD_BASE_CORNERS = {
    std::array<double, 2>{-1.0, 1.0}, std::array<double, 2>{1.0, 1.0},
    std::array<double, 2>{-1.0, -1.0}, std::array<double, 2>{1.0, -1.0}};

constexpr std::array<std::array<double, 2>, 4> UV_CORNERS = {
    std::array<double, 2>{0.0, 0.0}, std::array<double, 2>{1.0, 0.0},
    std::array<double, 2>{0.0, 1.0}, std::array<double, 2>{1.0, 1.0}};

constexpr std::array<int32_t, 6> TRIANGLE_INDICES = {0, 1, 2, 2, 1, 3};

constexpr std::array<std::array<double, 2>, 4> SURFACE_BASE_CORNERS = {
    std::array<double, 2>{-1.0, 1.0}, std::array<double, 2>{1.0, 1.0},
    std::array<double, 2>{-1.0, -1.0}, std::array<double, 2>{1.0, -1.0}};

constexpr double MIN_CLIP_Z_EPSILON = 1e-7;

static inline bool __projectLngLatToClipSpace(double lng,
                                              double lat,
                                              double altitude,
                                              const double* matrix,
                                              double* out);
static inline SurfaceWorldDimensions calculateSurfaceWorldDimensions(
    double imageWidth,
    double imageHeight,
    double baseMetersPerPixel,
    double imageScale,
    double zoomScaleFactor,
    double effectivePixelsPerMeter,
    double spriteMinPixel,
    double spriteMaxPixel);
static inline std::vector<SurfaceCorner> calculateSurfaceCornerDisplacements(
    double worldWidthMeters,
    double worldHeightMeters,
    const SpriteAnchor* anchor,
    double totalRotateDeg,
    const SurfaceCorner& offsetMeters);
static inline std::vector<SurfaceShaderCornerModel>
computeSurfaceCornerShaderModel(const SpriteLocation& baseLngLat,
                                double worldWidthMeters,
                                double worldHeightMeters,
                                const SpriteAnchor* anchor,
                                double totalRotateDeg,
                                const SurfaceCorner& offsetMeters);
static inline SurfaceCenterResult calculateSurfaceCenterPosition(
    const SurfaceCenterParams& params);
static inline BillboardCenterResult calculateBillboardCenterPosition(
    const SpriteScreenPoint& base,
    double imageWidth,
    double imageHeight,
    double baseMetersPerPixel,
    double imageScale,
    double zoomScaleFactor,
    double effectivePixelsPerMeter,
    double spriteMinPixel,
    double spriteMaxPixel,
    double totalRotateDeg,
    const SpriteAnchor* anchor,
    const SpriteImageOffset* offset);
static inline std::array<QuadCorner, 4> calculateBillboardCornerScreenPositions(
    const SpriteScreenPoint& center,
    double halfWidth,
    double halfHeight,
    const SpriteAnchor* anchor,
    double totalRotateDeg);
static inline bool __calculateBillboardDepthKey(double centerX,
                                                double centerY,
                                                double worldSize,
                                                const double* inverseMatrix,
                                                const double* mercatorMatrix,
                                                double* out);
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
                                              double* out);

constexpr int32_t SPRITE_ORIGIN_REFERENCE_INDEX_NONE = -1;
constexpr int32_t SPRITE_ORIGIN_REFERENCE_KEY_NONE = -1;

constexpr int INPUT_FLAG_USE_SHADER_SURFACE_GEOMETRY = 1 << 0;
constexpr int INPUT_FLAG_USE_SHADER_BILLBOARD_GEOMETRY = 1 << 1;
constexpr int INPUT_FLAG_ENABLE_NDC_BIAS_SURFACE = 1 << 2;

constexpr int RESULT_FLAG_HAS_HIT_TEST = 1 << 0;
constexpr int RESULT_FLAG_HAS_SURFACE_INPUTS = 1 << 1;

struct ClampSpritePixelSizeResult {
  double width = 0.0;
  double height = 0.0;
  double scaleAdjustment = 1.0;
};

static inline double ensureFinite(double value) {
  return std::isfinite(value) ? value : 0.0;
}

static inline ClampSpritePixelSizeResult clampSpritePixelSize(double width,
                                                double height,
                                                double spriteMinPixel,
                                                double spriteMaxPixel) {
  const double largest = std::max(width, height);
  if (!std::isfinite(largest) || largest <= 0.0) {
    return {width, height, 1.0};
  }

  double nextWidth = width;
  double nextHeight = height;
  double scaleAdjustment = 1.0;
  double adjustedLargest = largest;

  if (spriteMinPixel > 0.0 && largest < spriteMinPixel) {
    const double factor = spriteMinPixel / largest;
    nextWidth *= factor;
    nextHeight *= factor;
    scaleAdjustment *= factor;
    adjustedLargest *= factor;
  }

  if (spriteMaxPixel > 0.0 && adjustedLargest > spriteMaxPixel) {
    const double factor = spriteMaxPixel / adjustedLargest;
    nextWidth *= factor;
    nextHeight *= factor;
    scaleAdjustment *= factor;
  }

  return {nextWidth, nextHeight, scaleAdjustment};
}

static inline ResultBufferHeader* initializeResultHeader(double* resultPtr) {
  auto* header = AsResultHeader(resultPtr);
  header->preparedCount = 0;
  header->itemStride = RESULT_ITEM_STRIDE;
  header->vertexComponentCount = RESULT_VERTEX_COMPONENT_LENGTH;
  header->surfaceCornerCount = SURFACE_CLIP_CORNER_COUNT;
  header->flags = 0;
  header->reserved0 = 0;
  header->reserved1 = 0;
  return header;
}

struct FrameConstants {
  double zoom = 0.0;
  double worldSize = 0.0;
  double pixelPerMeter = 0.0;
  double cameraToCenterDistance = 0.0;
  double baseMetersPerPixel = 1.0;
  double spriteMinPixel = 0.0;
  double spriteMaxPixel = 0.0;
  double drawingBufferWidth = 0.0;
  double drawingBufferHeight = 0.0;
  double pixelRatio = 1.0;
  double zoomScaleFactor = 1.0;
  double identityScaleX = 1.0;
  double identityScaleY = 1.0;
  double identityOffsetX = 0.0;
  double identityOffsetY = 0.0;
  double screenToClipScaleX = 1.0;
  double screenToClipScaleY = 1.0;
  double screenToClipOffsetX = 0.0;
  double screenToClipOffsetY = 0.0;
  double minClipZEpsilon = MIN_CLIP_Z_EPSILON;
  double orderBucket = 1.0;
  double orderMax = 1.0;
  double epsNdc = 0.0;
  bool enableNdcBiasSurface = false;
};

static inline FrameConstants readFrameConstants(const double* ptr,
                                                std::size_t length) {
  FrameConstants constants;
  if (!ptr || length < INPUT_FRAME_CONSTANT_LENGTH) {
    return constants;
  }
  constants.zoom = ptr[0];
  constants.worldSize = ptr[1];
  constants.pixelPerMeter = ptr[2];
  constants.cameraToCenterDistance = ptr[3];
  constants.baseMetersPerPixel = ptr[4];
  constants.spriteMinPixel = ptr[5];
  constants.spriteMaxPixel = ptr[6];
  constants.drawingBufferWidth = ptr[7];
  constants.drawingBufferHeight = ptr[8];
  constants.pixelRatio = ptr[9];
  constants.zoomScaleFactor = ptr[10];
  constants.identityScaleX = ptr[11];
  constants.identityScaleY = ptr[12];
  constants.identityOffsetX = ptr[13];
  constants.identityOffsetY = ptr[14];
  constants.screenToClipScaleX = ptr[15];
  constants.screenToClipScaleY = ptr[16];
  constants.screenToClipOffsetX = ptr[17];
  constants.screenToClipOffsetY = ptr[18];
  constants.minClipZEpsilon = ptr[19];
  constants.orderBucket = ptr[20];
  constants.orderMax = ptr[21];
  constants.epsNdc = ptr[22];
  constants.enableNdcBiasSurface = toBool(ptr[23]);
  return constants;
}

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

static inline void applySurfaceDisplacement(const SpriteLocation& base,
                                            const SurfaceCorner& corner,
                                            SpriteLocation& out) {
  double lng = 0.0;
  double lat = 0.0;
  double alt = base.z;
  applySurfaceDisplacement(base.lng,
                           base.lat,
                           base.z,
                           corner.east,
                           corner.north,
                           lng,
                           lat,
                           alt);
  out.lng = lng;
  out.lat = lat;
  out.z = alt;
}

static inline double calculateMetersPerPixelAtLatitude(double zoom,
                                                       double latitude) {
  const double cosLatitude = std::cos(latitude * DEG2RAD);
  const double scale = std::pow(2.0, zoom);
  const double circumference = 2.0 * PI * EARTH_RADIUS_METERS;
  return (cosLatitude * circumference) / (512.0 * scale);
}

static inline double calculateEffectivePixelsPerMeter(
    double metersPerPixelAtLatitude, double perspectiveRatio) {
  if (!std::isfinite(metersPerPixelAtLatitude) ||
      metersPerPixelAtLatitude <= 0.0) {
    return 0.0;
  }
  const double basePixelsPerMeter = 1.0 / metersPerPixelAtLatitude;
  const double clampedPerspective =
      (std::isfinite(perspectiveRatio) && perspectiveRatio > 0.0)
          ? perspectiveRatio
          : 1.0;
  return basePixelsPerMeter * clampedPerspective;
}

static inline ClampSpritePixelSizeResult calculateBillboardPixelDimensions(
    double imageWidth,
    double imageHeight,
    double baseMetersPerPixel,
    double imageScale,
    double zoomScaleFactor,
    double effectivePixelsPerMeter,
    double spriteMinPixel,
    double spriteMaxPixel) {
  if (imageWidth <= 0.0 || imageHeight <= 0.0 || baseMetersPerPixel <= 0.0 ||
      effectivePixelsPerMeter <= 0.0) {
    return {0.0, 0.0, 1.0};
  }
  const double scaleFactor = baseMetersPerPixel * imageScale *
                             zoomScaleFactor * effectivePixelsPerMeter;
  const double rawWidth = ensureFinite(imageWidth * scaleFactor);
  const double rawHeight = ensureFinite(imageHeight * scaleFactor);
  return clampSpritePixelSize(
      rawWidth, rawHeight, spriteMinPixel, spriteMaxPixel);
}

static inline SpritePoint calculateBillboardOffsetPixels(
    const SpriteImageOffset* offset,
    double imageScale,
    double zoomScaleFactor,
    double effectivePixelsPerMeter,
    double sizeScaleAdjustment = 1.0) {
  const double offsetMeters = (offset ? offset->offsetMeters : 0.0) *
                              imageScale * zoomScaleFactor;
  const double offsetPixels =
      offsetMeters * effectivePixelsPerMeter * sizeScaleAdjustment;
  const double offsetRad = (offset ? offset->offsetDeg : 0.0) * DEG2RAD;
  return {offsetPixels * std::sin(offsetRad),
          offsetPixels * std::cos(offsetRad)};
}

static inline SpritePoint calculateBillboardAnchorShiftPixels(
    double halfWidth,
    double halfHeight,
    const SpriteAnchor* anchor,
    double totalRotateDeg) {
  if (halfWidth <= 0.0 || halfHeight <= 0.0) {
    return {0.0, 0.0};
  }
  const double anchorX = (anchor ? anchor->x : 0.0) * halfWidth;
  const double anchorY = (anchor ? anchor->y : 0.0) * halfHeight;
  if (anchorX == 0.0 && anchorY == 0.0) {
    return {0.0, 0.0};
  }
  const double rad = -totalRotateDeg * DEG2RAD;
  const double cosR = std::cos(rad);
  const double sinR = std::sin(rad);
  const double shiftX = -anchorX * cosR + anchorY * sinR;
  const double shiftY = -anchorX * sinR - anchorY * cosR;
  return {shiftX, shiftY};
}

static inline SurfaceCorner calculateSurfaceAnchorShiftMeters(
    double halfWidthMeters,
    double halfHeightMeters,
    const SpriteAnchor* anchor,
    double totalRotateDeg) {
  if (halfWidthMeters <= 0.0 || halfHeightMeters <= 0.0) {
    return {0.0, 0.0};
  }
  const double anchorEast = (anchor ? anchor->x : 0.0) * halfWidthMeters;
  const double anchorNorth = (anchor ? anchor->y : 0.0) * halfHeightMeters;
  if (anchorEast == 0.0 && anchorNorth == 0.0) {
    return {0.0, 0.0};
  }
  const double rad = -totalRotateDeg * DEG2RAD;
  const double cosR = std::cos(rad);
  const double sinR = std::sin(rad);
  const double east = -anchorEast * cosR + anchorNorth * sinR;
  const double north = -anchorEast * sinR - anchorNorth * cosR;
  return {east, north};
}

static inline SurfaceCorner calculateSurfaceOffsetMeters(
    const SpriteImageOffset* offset,
    double imageScale,
    double zoomScaleFactor,
    double sizeScaleAdjustment = 1.0) {
  if (offset == nullptr) {
    return {0.0, 0.0};
  }
  const double offsetMeters = offset->offsetMeters * imageScale *
                              zoomScaleFactor * sizeScaleAdjustment;
  if (offsetMeters == 0.0) {
    return {0.0, 0.0};
  }
  const double rad = offset->offsetDeg * DEG2RAD;
  return {offsetMeters * std::sin(rad), offsetMeters * std::cos(rad)};
}

static inline bool clipToScreen(const std::array<double, 4>& clipPosition,
                                double drawingBufferWidth,
                                double drawingBufferHeight,
                                double pixelRatio,
                                SpriteScreenPoint& out) {
  const double clipW = clipPosition[3];
  if (!std::isfinite(clipW) || clipW == 0.0) {
    return false;
  }
  const double invW = 1.0 / clipW;
  const double ndcX = clipPosition[0] * invW;
  const double ndcY = clipPosition[1] * invW;
  const double deviceX = (ndcX + 1.0) * 0.5 * drawingBufferWidth;
  const double deviceY = (1.0 - ndcY) * 0.5 * drawingBufferHeight;
  if (!std::isfinite(deviceX) || !std::isfinite(deviceY)) {
    return false;
  }
  if (!std::isfinite(pixelRatio) || pixelRatio == 0.0) {
    return false;
  }
  out.x = deviceX / pixelRatio;
  out.y = deviceY / pixelRatio;
  return true;
}

struct ProjectionContext {
  double worldSize = 0.0;
  double cameraToCenterDistance = 0.0;
  const double* mercatorMatrix = nullptr;
  const double* pixelMatrix = nullptr;
  const double* pixelMatrixInverse = nullptr;
};

static inline bool projectSpritePoint(const ProjectionContext& ctx,
                                      const SpriteLocation& location,
                                      SpriteScreenPoint& out) {
  if (!ctx.pixelMatrix || ctx.worldSize <= 0.0) {
    return false;
  }
  double projected[2] = {0.0, 0.0};
  if (!__project(location.lng,
                 location.lat,
                 location.z,
                 ctx.worldSize,
                 ctx.pixelMatrix,
                 projected)) {
    return false;
  }
  out.x = projected[0];
  out.y = projected[1];
  return true;
}

static inline bool unprojectSpritePoint(const ProjectionContext& ctx,
                                        const SpritePoint& point,
                                        SpriteLocation& out) {
  if (!ctx.pixelMatrixInverse || ctx.worldSize <= 0.0) {
    return false;
  }
  double lngLat[2] = {0.0, 0.0};
  if (!__unproject(point.x,
                   point.y,
                   ctx.worldSize,
                   ctx.pixelMatrixInverse,
                   lngLat)) {
    return false;
  }
  out.lng = lngLat[0];
  out.lat = lngLat[1];
  out.z = 0.0;
  return true;
}

static inline bool projectLngLatToClip(const ProjectionContext& ctx,
                                       const SpriteLocation& location,
                                       std::array<double, 4>& out) {
  if (!ctx.mercatorMatrix) {
    return false;
  }
  return __projectLngLatToClipSpace(location.lng,
                                    location.lat,
                                    location.z,
                                    ctx.mercatorMatrix,
                                    out.data());
}

static inline bool calculateMercatorCoordinate(const SpriteLocation& location,
                                               SpriteMercatorCoordinate& out) {
  double buffer[3] = {0.0, 0.0, 0.0};
  if (!__fromLngLat(location.lng, location.lat, location.z, buffer)) {
    return false;
  }
  out.x = buffer[0];
  out.y = buffer[1];
  out.z = buffer[2];
  return true;
}

static inline double calculatePerspectiveRatio(const ProjectionContext& ctx,
                                               const SpriteLocation& location,
                                               const SpriteMercatorCoordinate* cached) {
  if (!ctx.mercatorMatrix || ctx.cameraToCenterDistance <= 0.0) {
    return 1.0;
  }

  double mercator[3] = {0.0, 0.0, 0.0};
  if (cached) {
    mercator[0] = cached->x;
    mercator[1] = cached->y;
    mercator[2] = cached->z;
  } else {
    SpriteMercatorCoordinate computed{};
    if (!calculateMercatorCoordinate(location, computed)) {
      return 1.0;
    }
    mercator[0] = computed.x;
    mercator[1] = computed.y;
    mercator[2] = computed.z;
  }

  double ratio = 1.0;
  if (!__calculatePerspectiveRatio(location.lng,
                                   location.lat,
                                   location.z,
                                   mercator,
                                   ctx.cameraToCenterDistance,
                                   ctx.mercatorMatrix,
                                   &ratio)) {
    return 1.0;
  }
  return std::isfinite(ratio) && ratio > 0.0 ? ratio : 1.0;
}

static inline SurfaceCorner calculateWorldToMercatorScale(
    const ProjectionContext& projection, const SpriteLocation& base) {
  SpriteMercatorCoordinate origin{};
  SpriteMercatorCoordinate east{};
  SpriteMercatorCoordinate north{};
  calculateMercatorCoordinate(base, origin);

  SpriteLocation eastLngLat = base;
  applySurfaceDisplacement(base, SurfaceCorner{1.0, 0.0}, eastLngLat);
  calculateMercatorCoordinate(eastLngLat, east);

  SpriteLocation northLngLat = base;
  applySurfaceDisplacement(base, SurfaceCorner{0.0, 1.0}, northLngLat);
  calculateMercatorCoordinate(northLngLat, north);

  return {east.x - origin.x, north.y - origin.y};
}

struct SurfaceShaderInputsData {
  SpriteMercatorCoordinate mercatorCenter;
  SurfaceCorner worldToMercatorScale;
  SurfaceCorner halfSizeMeters;
  SpriteAnchor anchor;
  SurfaceCorner offsetMeters;
  double sinValue = 0.0;
  double cosValue = 1.0;
  double totalRotateDeg = 0.0;
  double depthBiasNdc = 0.0;
  SurfaceCorner centerDisplacement;
  SpriteLocation baseLngLat;
  SpriteLocation displacedCenter;
  double scaleAdjustment = 1.0;
  std::vector<SurfaceShaderCornerModel> corners;
  std::array<double, 4> clipCenter = {0.0, 0.0, 0.0, 1.0};
  std::array<double, 4> clipBasisEast = {0.0, 0.0, 0.0, 0.0};
  std::array<double, 4> clipBasisNorth = {0.0, 0.0, 0.0, 0.0};
  std::vector<std::array<double, 4>> clipCorners;
};

static inline SurfaceShaderInputsData prepareSurfaceShaderInputs(
    const ProjectionContext& projection,
    const SpriteLocation& baseLngLat,
    double worldWidthMeters,
    double worldHeightMeters,
    const SpriteAnchor* anchor,
    double totalRotateDeg,
    const SurfaceCorner& offsetMeters,
    const SpriteLocation& displacedCenter,
    double depthBiasNdc,
    double scaleAdjustment,
    const SurfaceCorner& centerDisplacement) {
  const double halfWidth = worldWidthMeters * 0.5;
  const double halfHeight = worldHeightMeters * 0.5;
  const double rotationRad = -totalRotateDeg * DEG2RAD;
  const double sinR = std::sin(rotationRad);
  const double cosR = std::cos(rotationRad);

  SurfaceShaderInputsData data;
  calculateMercatorCoordinate(displacedCenter, data.mercatorCenter);
  data.worldToMercatorScale =
      calculateWorldToMercatorScale(projection, displacedCenter);
  data.halfSizeMeters = {halfWidth, halfHeight};
  data.anchor = anchor ? *anchor : SpriteAnchor{0.0, 0.0};
  data.offsetMeters = offsetMeters;
  data.sinValue = sinR;
  data.cosValue = cosR;
  data.totalRotateDeg = totalRotateDeg;
  data.depthBiasNdc = depthBiasNdc;
  data.centerDisplacement = centerDisplacement;
  data.baseLngLat = baseLngLat;
  data.displacedCenter = displacedCenter;
  data.scaleAdjustment = scaleAdjustment;
  data.corners = computeSurfaceCornerShaderModel(baseLngLat,
                                                 worldWidthMeters,
                                                 worldHeightMeters,
                                                 anchor,
                                                 totalRotateDeg,
                                                 offsetMeters);
  data.clipCorners.clear();
  data.clipCorners.reserve(SURFACE_BASE_CORNERS.size());
  return data;
}

static inline bool hasOriginLocation(const InputItemEntry& entry) {
  if (entry.originTargetIndex != SPRITE_ORIGIN_REFERENCE_INDEX_NONE) {
    return true;
  }
  if (entry.originSubLayer >= 0.0 && entry.originOrder >= 0.0) {
    return true;
  }
  return false;
}

static SpriteScreenPoint computeImageCenter(
    const BucketItem& bucketItem,
    bool useResolvedAnchor,
    const ProjectionContext& projection,
    const FrameConstants& frame,
    SpriteCenterCacheMap& cache,
    const ResourceInfo& resource,
    double effectivePixelsPerMeter,
    const ResolveOriginFn& resolveOrigin,
    bool clipContextAvailable) {
  SpriteScreenPoint fallbackCenter = bucketItem.projected;

  const int64_t spriteKey = bucketItem.spriteHandle;
  auto& spriteCache = cache[spriteKey];
  const ImageCenterCacheKey cacheKey{bucketItem.entry->subLayer,
                                     bucketItem.entry->order};
  auto cacheFound = spriteCache.find(cacheKey);
  if (cacheFound != spriteCache.end()) {
    const ImageCenterCacheEntry& entry = cacheFound->second;
    if (useResolvedAnchor && entry.hasAnchorApplied) {
      return {entry.anchorApplied.x, entry.anchorApplied.y};
    }
    if (!useResolvedAnchor && entry.hasAnchorless) {
      return {entry.anchorless.x, entry.anchorless.y};
    }
  }

  SpriteScreenPoint basePoint = bucketItem.projected;

  if (hasOriginLocation(*bucketItem.entry) && resolveOrigin) {
    const BucketItem* reference = resolveOrigin(bucketItem);
    if (reference && reference->resource) {
      const bool resolvedAnchor = toBool(bucketItem.entry->originUseResolvedAnchor);
      basePoint = computeImageCenter(*reference,
                                     resolvedAnchor,
                                     projection,
                                     frame,
                                     cache,
                                     *reference->resource,
                                     effectivePixelsPerMeter,
                                     resolveOrigin,
                                     clipContextAvailable);
    }
  }

  const SpriteAnchor anchor{bucketItem.entry->anchorX,
                            bucketItem.entry->anchorY};
  const SpriteImageOffset offset{bucketItem.entry->offsetMeters,
                                 bucketItem.entry->offsetDeg};
  const double imageScale = bucketItem.entry->scale != 0.0
                                ? bucketItem.entry->scale
                                : 1.0;
  const double displayedRotate = bucketItem.entry->displayedRotateDeg;
  const double totalRotateDeg = std::isfinite(displayedRotate)
      ? displayedRotate
      : normalizeAngleDeg(bucketItem.entry->resolvedBaseRotateDeg +
                          bucketItem.entry->rotateDeg);

  const bool isSurface = std::lround(bucketItem.entry->mode) == 0;

  SpriteScreenPoint anchorAppliedCenter = basePoint;
  SpriteScreenPoint anchorlessCenter = basePoint;

  if (resource.width <= 0.0 || resource.height <= 0.0) {
    return basePoint;
  }

  if (isSurface) {
    SpriteLocation baseLngLat = bucketItem.spriteLocation;
    if (hasOriginLocation(*bucketItem.entry)) {
      SpriteLocation unprojected{};
      if (unprojectSpritePoint(projection,
                               SpritePoint{basePoint.x, basePoint.y},
                               unprojected)) {
        baseLngLat = unprojected;
      }
    }

    ProjectToClipSpaceFn clipProjector;
    ProjectLngLatFn screenProjector;
    if (clipContextAvailable) {
      clipProjector = [&projection](const SpriteLocation& location,
                                    std::array<double, 4>& out) -> bool {
        return projectLngLatToClip(projection, location, out);
      };
    } else {
      screenProjector = [&projection](const SpriteLocation& location,
                                      SpriteScreenPoint& out) -> bool {
        return projectSpritePoint(projection, location, out);
      };
    }

    SurfaceCenterParams params;
    params.baseLngLat = baseLngLat;
    params.imageWidth = resource.width;
    params.imageHeight = resource.height;
    params.baseMetersPerPixel = frame.baseMetersPerPixel;
    params.imageScale = imageScale;
    params.zoomScaleFactor = frame.zoomScaleFactor;
    params.totalRotateDeg = totalRotateDeg;
    params.anchor = &anchor;
    params.offset = &offset;
    params.effectivePixelsPerMeter = effectivePixelsPerMeter;
    params.spriteMinPixel = frame.spriteMinPixel;
    params.spriteMaxPixel = frame.spriteMaxPixel;
    params.projectToClipSpace = clipProjector;
    params.drawingBufferWidth = frame.drawingBufferWidth;
    params.drawingBufferHeight = frame.drawingBufferHeight;
    params.pixelRatio = frame.pixelRatio;
    params.resolveAnchorless = true;
    params.project = clipContextAvailable ? ProjectLngLatFn() : screenProjector;

    const SurfaceCenterResult placement =
        calculateSurfaceCenterPosition(params);

    if (placement.anchorlessCenter) {
      anchorlessCenter = *placement.anchorlessCenter;
    } else {
      anchorlessCenter = fallbackCenter;
    }
    if (placement.center) {
      anchorAppliedCenter = *placement.center;
    } else {
      anchorAppliedCenter = anchorlessCenter;
    }
  } else {
    const BillboardCenterResult placement =
        calculateBillboardCenterPosition(basePoint,
                                         resource.width,
                                         resource.height,
                                         frame.baseMetersPerPixel,
                                         imageScale,
                                         frame.zoomScaleFactor,
                                         effectivePixelsPerMeter,
                                         frame.spriteMinPixel,
                                         frame.spriteMaxPixel,
                                         totalRotateDeg,
                                         &anchor,
                                         &offset);
    anchorAppliedCenter = placement.center;
    anchorlessCenter = {placement.center.x + placement.anchorShift.x,
                        placement.center.y - placement.anchorShift.y};
  }

  ImageCenterCacheEntry cacheEntry;
  cacheEntry.anchorApplied = {anchorAppliedCenter.x, anchorAppliedCenter.y};
  cacheEntry.anchorless = {anchorlessCenter.x, anchorlessCenter.y};
  cacheEntry.hasAnchorApplied = true;
  cacheEntry.hasAnchorless = true;
  spriteCache[cacheKey] = cacheEntry;

  return useResolvedAnchor ? anchorAppliedCenter : anchorlessCenter;
}

static DepthCollectionResult collectDepthSortedItemsInternal(
    const std::vector<BucketItem>& bucketItems,
    const ProjectionContext& projectionContext,
    const FrameConstants& frame,
    bool clipContextAvailable,
    bool enableSurfaceBias,
    const ResolveOriginFn& resolveOrigin) {
  DepthCollectionResult result;
  auto& centerCache = result.centerCache;
  std::vector<DepthItem> depthItems;
  depthItems.reserve(bucketItems.size());

  const auto* triangleIndices = TRIANGLE_INDICES.data();
  const int triangleIndexCount =
      static_cast<int>(TRIANGLE_INDICES.size());

  for (const BucketItem& bucketItem : bucketItems) {
    if (bucketItem.entry == nullptr || bucketItem.resource == nullptr) {
      continue;
    }
    if (!bucketItem.resource->textureReady) {
      continue;
    }
    if (!bucketItem.projectedValid) {
      continue;
    }

    const double metersPerPixelAtLat =
        calculateMetersPerPixelAtLatitude(frame.zoom,
                                          bucketItem.spriteLocation.lat);
    if (!std::isfinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0.0) {
      continue;
    }

    const double perspectiveRatio = calculatePerspectiveRatio(
        projectionContext,
        bucketItem.spriteLocation,
        bucketItem.hasMercator ? &bucketItem.mercator : nullptr);

    const double effectivePixelsPerMeter = calculateEffectivePixelsPerMeter(
        metersPerPixelAtLat, perspectiveRatio);
    if (effectivePixelsPerMeter <= 0.0) {
      continue;
    }

    SpriteScreenPoint depthCenter = computeImageCenter(
        bucketItem,
        true,
        projectionContext,
        frame,
        centerCache,
        *bucketItem.resource,
        effectivePixelsPerMeter,
        resolveOrigin,
        clipContextAvailable);

    double depthKey = 0.0;
    const bool isSurface = std::lround(bucketItem.entry->mode) == 0;

    if (isSurface) {
      if (!projectionContext.mercatorMatrix) {
        continue;
      }

      const double imageScale = resolveImageScale(*bucketItem.entry);
      const SpriteAnchor anchor = resolveAnchor(*bucketItem.entry);
      const SpriteImageOffset offset = resolveOffset(*bucketItem.entry);
      const double totalRotateDeg = resolveTotalRotateDeg(*bucketItem.entry);

      const SurfaceWorldDimensions worldDims = calculateSurfaceWorldDimensions(
          bucketItem.resource->width,
          bucketItem.resource->height,
          frame.baseMetersPerPixel,
          imageScale,
          frame.zoomScaleFactor,
          effectivePixelsPerMeter,
          frame.spriteMinPixel,
          frame.spriteMaxPixel);
      const SurfaceCorner offsetMeters = calculateSurfaceOffsetMeters(
          &offset,
          imageScale,
          frame.zoomScaleFactor,
          worldDims.scaleAdjustment);
      const std::vector<SurfaceCorner> cornerDisplacements =
          calculateSurfaceCornerDisplacements(worldDims.width,
                                              worldDims.height,
                                              &anchor,
                                              totalRotateDeg,
                                              offsetMeters);

      SpriteLocation baseLngLat = bucketItem.spriteLocation;
      if (hasOriginLocation(*bucketItem.entry)) {
        const BucketItem* reference = resolveOrigin(bucketItem);
        if (reference && reference->resource) {
          const bool useAnchorDisplacement =
              toBool(bucketItem.entry->originUseResolvedAnchor);
          const SpriteScreenPoint originCenter = computeImageCenter(
              *reference,
              useAnchorDisplacement,
              projectionContext,
              frame,
              centerCache,
              *reference->resource,
              effectivePixelsPerMeter,
              resolveOrigin,
              clipContextAvailable);
          SpriteLocation reprojection{};
          if (unprojectSpritePoint(projectionContext,
                                   SpritePoint{originCenter.x, originCenter.y},
                                   reprojection)) {
            baseLngLat = reprojection;
          }
        }
      }

      const bool applyBias = enableSurfaceBias;
      const double clampedOrder =
          std::fmin(bucketItem.entry->order, frame.orderMax - 1.0);
      const double biasIndex = bucketItem.entry->subLayer * frame.orderBucket +
                               clampedOrder;
      const double depthBiasNdc = applyBias ? -(biasIndex * frame.epsNdc) : 0.0;

      std::vector<double> displacementData(cornerDisplacements.size() * 2);
      for (std::size_t idx = 0; idx < cornerDisplacements.size(); ++idx) {
        displacementData[idx * 2 + 0] = cornerDisplacements[idx].east;
        displacementData[idx * 2 + 1] = cornerDisplacements[idx].north;
      }

      const int displacementCount =
          static_cast<int>(cornerDisplacements.size());

      if (!__calculateSurfaceDepthKey(baseLngLat.lng,
                                      baseLngLat.lat,
                                      baseLngLat.z,
                                      displacementData.data(),
                                      displacementCount,
                                      triangleIndices,
                                      triangleIndexCount,
                                      projectionContext.mercatorMatrix,
                                      applyBias,
                                      depthBiasNdc,
                                      frame.minClipZEpsilon,
                                      &depthKey)) {
        continue;
      }
    } else {
      if (!projectionContext.pixelMatrixInverse ||
          !projectionContext.mercatorMatrix) {
        continue;
      }
      if (!__calculateBillboardDepthKey(depthCenter.x,
                                        depthCenter.y,
                                        frame.worldSize,
                                        projectionContext.pixelMatrixInverse,
                                        projectionContext.mercatorMatrix,
                                        &depthKey)) {
        continue;
      }
    }

    depthItems.push_back(DepthItem{&bucketItem, depthKey});
  }

  std::sort(depthItems.begin(), depthItems.end(),
            [](const DepthItem& a, const DepthItem& b) {
              if (a.depthKey != b.depthKey) {
                return a.depthKey < b.depthKey;
              }
              const double orderA = a.item ? a.item->entry->order : 0.0;
              const double orderB = b.item ? b.item->entry->order : 0.0;
              if (orderA != orderB) {
                return orderA < orderB;
              }
              const int64_t spriteA = a.item ? a.item->spriteHandle : 0;
              const int64_t spriteB = b.item ? b.item->spriteHandle : 0;
              if (spriteA != spriteB) {
                return spriteA < spriteB;
              }
              const double imageA =
                  a.item ? a.item->entry->imageHandle : 0.0;
              const double imageB =
                  b.item ? b.item->entry->imageHandle : 0.0;
              return imageA < imageB;
            });

  result.items = std::move(depthItems);
  return result;
}

static bool prepareDrawSpriteImageInternal(
    const DepthItem& depth,
    SpriteCenterCacheMap& centerCache,
    const ProjectionContext& projectionContext,
    const FrameConstants& frame,
    bool clipContextAvailable,
    bool useShaderBillboardGeometry,
    bool useShaderSurfaceGeometry,
    const ResolveOriginFn& resolveOrigin,
    double* itemBase,
    bool& outHasHitTest,
    bool& outHasSurfaceInputs) {
  outHasHitTest = false;
  outHasSurfaceInputs = false;
  if (depth.item == nullptr || depth.item->entry == nullptr ||
      depth.item->resource == nullptr) {
    return false;
  }

  const BucketItem& bucketItem = *depth.item;
  const InputItemEntry& entry = *bucketItem.entry;
  const ResourceInfo& resource = *bucketItem.resource;

  if (!bucketItem.projectedValid || resource.width <= 0.0 ||
      resource.height <= 0.0) {
    return false;
  }

  const bool isSurface = std::lround(entry.mode) == 0;
  const bool enableSurfaceBias = frame.enableNdcBiasSurface;

  const double metersPerPixelAtLat =
      calculateMetersPerPixelAtLatitude(frame.zoom,
                                        bucketItem.spriteLocation.lat);
  if (!std::isfinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0.0) {
    return false;
  }

  const double perspectiveRatio = calculatePerspectiveRatio(
      projectionContext,
      bucketItem.spriteLocation,
      bucketItem.hasMercator ? &bucketItem.mercator : nullptr);
  const double effectivePixelsPerMeter = calculateEffectivePixelsPerMeter(
      metersPerPixelAtLat, perspectiveRatio);
  if (effectivePixelsPerMeter <= 0.0) {
    return false;
  }

  SpriteScreenPoint baseProjected = bucketItem.projected;
  if (hasOriginLocation(entry)) {
    const BucketItem* reference = resolveOrigin(bucketItem);
    if (reference && reference->resource) {
      const bool useAnchor = toBool(entry.originUseResolvedAnchor);
      baseProjected = computeImageCenter(*reference,
                                         useAnchor,
                                         projectionContext,
                                         frame,
                                         centerCache,
                                         *reference->resource,
                                         effectivePixelsPerMeter,
                                         resolveOrigin,
                                         clipContextAvailable);
    }
  }

  const SpriteAnchor anchor = resolveAnchor(entry);
  const SpriteImageOffset offset = resolveOffset(entry);
  const double imageScale = resolveImageScale(entry);
  const double totalRotateDeg = resolveTotalRotateDeg(entry);

  const double screenScaleX =
      isSurface ? frame.identityScaleX : frame.screenToClipScaleX;
  const double screenScaleY =
      isSurface ? frame.identityScaleY : frame.screenToClipScaleY;
  const double screenOffsetX =
      isSurface ? frame.identityOffsetX : frame.screenToClipOffsetX;
  const double screenOffsetY =
      isSurface ? frame.identityOffsetY : frame.screenToClipOffsetY;

  double useShaderSurfaceValue = 0.0;
  double surfaceClipEnabledValue = 0.0;
  double useShaderBillboardValue = 0.0;
  double billboardCenterX = 0.0;
  double billboardCenterY = 0.0;
  double billboardHalfWidth = 0.0;
  double billboardHalfHeight = 0.0;
  double billboardAnchorX = 0.0;
  double billboardAnchorY = 0.0;
  double billboardSin = 0.0;
  double billboardCos = 1.0;

  std::array<double, RESULT_VERTEX_COMPONENT_LENGTH> vertexData{};
  std::array<double, RESULT_HIT_TEST_COMPONENT_LENGTH> hitTestData{};
  std::array<double, RESULT_SURFACE_BLOCK_LENGTH> surfaceBlock{};
  surfaceBlock.fill(0.0);

  std::size_t imageIndex = 0;
  if (!convertToSizeT(entry.bucketIndex, imageIndex)) {
    imageIndex = 0;
  }
  const std::size_t resourceIndex = bucketItem.resource->handle;

  if (isSurface) {
    if (!clipContextAvailable || projectionContext.mercatorMatrix == nullptr) {
      return false;
    }

    SpriteLocation baseLngLat = bucketItem.spriteLocation;
    if (hasOriginLocation(entry)) {
      SpriteLocation unprojected{};
      if (unprojectSpritePoint(projectionContext,
                               SpritePoint{baseProjected.x, baseProjected.y},
                               unprojected)) {
        baseLngLat = unprojected;
      }
    }

    ProjectToClipSpaceFn projectToClipFn =
        [&projectionContext](const SpriteLocation& location,
                             std::array<double, 4>& out) -> bool {
          return projectLngLatToClip(projectionContext, location, out);
        };

    SurfaceCenterParams params{};
    params.baseLngLat = baseLngLat;
    params.imageWidth = resource.width;
    params.imageHeight = resource.height;
    params.baseMetersPerPixel = frame.baseMetersPerPixel;
    params.imageScale = imageScale;
    params.zoomScaleFactor = frame.zoomScaleFactor;
    params.totalRotateDeg = totalRotateDeg;
    params.anchor = &anchor;
    params.offset = &offset;
    params.effectivePixelsPerMeter = effectivePixelsPerMeter;
    params.spriteMinPixel = frame.spriteMinPixel;
    params.spriteMaxPixel = frame.spriteMaxPixel;
    params.projectToClipSpace = projectToClipFn;
    params.drawingBufferWidth = frame.drawingBufferWidth;
    params.drawingBufferHeight = frame.drawingBufferHeight;
    params.pixelRatio = frame.pixelRatio;
    params.resolveAnchorless = true;

    const SurfaceCenterResult surfaceCenter =
        calculateSurfaceCenterPosition(params);
    if (!surfaceCenter.center.has_value()) {
      return false;
    }

    const SurfaceCorner offsetMeters = calculateSurfaceOffsetMeters(
        &offset,
        imageScale,
        frame.zoomScaleFactor,
        surfaceCenter.worldDimensions.scaleAdjustment);
    const std::vector<SurfaceCorner> cornerDisplacements =
        calculateSurfaceCornerDisplacements(surfaceCenter.worldDimensions.width,
                                            surfaceCenter.worldDimensions.height,
                                            &anchor,
                                            totalRotateDeg,
                                            offsetMeters);

    const double orderIndex =
        std::fmin(entry.order, frame.orderMax - 1.0);
    const double biasIndex = entry.subLayer * frame.orderBucket + orderIndex;
    const double depthBiasNdc =
        enableSurfaceBias ? (-(biasIndex * frame.epsNdc)) : 0.0;

    const SpriteLocation displacedCenter = surfaceCenter.displacedLngLat;

    SurfaceShaderInputsData surfaceInputs = prepareSurfaceShaderInputs(
        projectionContext,
        baseLngLat,
        surfaceCenter.worldDimensions.width,
        surfaceCenter.worldDimensions.height,
        &anchor,
        totalRotateDeg,
        offsetMeters,
        displacedCenter,
        depthBiasNdc,
        surfaceCenter.worldDimensions.scaleAdjustment,
        surfaceCenter.totalDisplacement);

    const bool useShaderSurface = useShaderSurfaceGeometry && clipContextAvailable;
    useShaderSurfaceValue = useShaderSurface ? 1.0 : 0.0;

    std::array<std::array<double, 4>, 4> clipCornerPositions{};
    std::array<bool, 4> clipCornerValid{false, false, false, false};

    std::array<double, 4> clipCenterPosition{};
    bool clipCenterValid = projectLngLatToClip(projectionContext,
                                               displacedCenter,
                                               clipCenterPosition);

    std::size_t vertexCursor = 0;
    for (int idx : TRIANGLE_INDICES) {
      const std::size_t cornerIndex = static_cast<std::size_t>(idx);
      const SurfaceCorner& displacement = cornerDisplacements[cornerIndex];
      SpriteLocation displacedPoint;
      applySurfaceDisplacement(baseLngLat, displacement, displacedPoint);

      std::array<double, 4> clipPosition{};
      if (!projectLngLatToClip(projectionContext, displacedPoint, clipPosition)) {
        return false;
      }

      double clipX = clipPosition[0];
      double clipY = clipPosition[1];
      double clipZ = clipPosition[2];
      double clipW = clipPosition[3];
      if (depthBiasNdc != 0.0) {
        const double biasedClipZ = clipZ + depthBiasNdc * clipW;
        const double minClipZ = -clipW + frame.minClipZEpsilon;
        clipZ = biasedClipZ < minClipZ ? minClipZ : biasedClipZ;
      }

      if (!clipCornerValid[cornerIndex]) {
        clipCornerPositions[cornerIndex] = {clipX, clipY, clipZ, clipW};
        clipCornerValid[cornerIndex] = true;
        SpriteScreenPoint screenCorner;
        if (!clipToScreen(clipCornerPositions[cornerIndex],
                          frame.drawingBufferWidth,
                          frame.drawingBufferHeight,
                          frame.pixelRatio,
                          screenCorner)) {
          return false;
        }
        hitTestData[cornerIndex * 2 + 0] = screenCorner.x;
        hitTestData[cornerIndex * 2 + 1] = screenCorner.y;
      }

      if (useShaderSurface) {
        const auto& baseCorner = SURFACE_BASE_CORNERS[cornerIndex];
        vertexData[vertexCursor++] = baseCorner[0];
        vertexData[vertexCursor++] = baseCorner[1];
        vertexData[vertexCursor++] = 0.0;
        vertexData[vertexCursor++] = 1.0;
      } else {
        vertexData[vertexCursor++] = clipX;
        vertexData[vertexCursor++] = clipY;
        vertexData[vertexCursor++] = clipZ;
        vertexData[vertexCursor++] = clipW;
      }
      const auto& uv = UV_CORNERS[cornerIndex];
      vertexData[vertexCursor++] = uv[0];
      vertexData[vertexCursor++] = uv[1];
    }

    bool clipUniformEnabled = false;
    if (useShaderSurface && clipCenterValid &&
        std::all_of(clipCornerValid.begin(), clipCornerValid.end(),
                    [](bool v) { return v; })) {
      const auto& leftTop = clipCornerPositions[0];
      const auto& rightTop = clipCornerPositions[1];
      const auto& leftBottom = clipCornerPositions[2];
      const auto& rightBottom = clipCornerPositions[3];

      std::array<double, 4> clipBasisEast = {
          (rightTop[0] - leftTop[0]) * 0.5,
          (rightTop[1] - leftTop[1]) * 0.5,
          (rightTop[2] - leftTop[2]) * 0.5,
          (rightTop[3] - leftTop[3]) * 0.5};
      std::array<double, 4> clipBasisNorth = {
          (leftTop[0] - leftBottom[0]) * 0.5,
          (leftTop[1] - leftBottom[1]) * 0.5,
          (leftTop[2] - leftBottom[2]) * 0.5,
          (leftTop[3] - leftBottom[3]) * 0.5};

      surfaceInputs.clipCenter = clipCenterPosition;
      surfaceInputs.clipBasisEast = clipBasisEast;
      surfaceInputs.clipBasisNorth = clipBasisNorth;
      surfaceInputs.clipCorners.clear();
      for (std::size_t i = 0; i < clipCornerPositions.size(); ++i) {
        surfaceInputs.clipCorners.push_back(clipCornerPositions[i]);
      }
      clipUniformEnabled = true;
    }

    surfaceClipEnabledValue = clipUniformEnabled ? 1.0 : 0.0;

    if (useShaderSurface) {
      std::size_t surfaceCursor = 0;
      surfaceBlock[surfaceCursor++] = surfaceInputs.mercatorCenter.x;
      surfaceBlock[surfaceCursor++] = surfaceInputs.mercatorCenter.y;
      surfaceBlock[surfaceCursor++] = surfaceInputs.mercatorCenter.z;
      surfaceBlock[surfaceCursor++] =
          surfaceInputs.worldToMercatorScale.east;
      surfaceBlock[surfaceCursor++] =
          surfaceInputs.worldToMercatorScale.north;
      surfaceBlock[surfaceCursor++] = surfaceInputs.halfSizeMeters.east;
      surfaceBlock[surfaceCursor++] = surfaceInputs.halfSizeMeters.north;
      surfaceBlock[surfaceCursor++] = surfaceInputs.anchor.x;
      surfaceBlock[surfaceCursor++] = surfaceInputs.anchor.y;
      surfaceBlock[surfaceCursor++] = surfaceInputs.offsetMeters.east;
      surfaceBlock[surfaceCursor++] = surfaceInputs.offsetMeters.north;
      surfaceBlock[surfaceCursor++] = surfaceInputs.sinValue;
      surfaceBlock[surfaceCursor++] = surfaceInputs.cosValue;
      surfaceBlock[surfaceCursor++] = surfaceInputs.totalRotateDeg;
      surfaceBlock[surfaceCursor++] = depthBiasNdc;
      surfaceBlock[surfaceCursor++] = surfaceInputs.centerDisplacement.east;
      surfaceBlock[surfaceCursor++] = surfaceInputs.centerDisplacement.north;
      const auto writeVec4 = [&surfaceBlock, &surfaceCursor](
                                 const std::array<double, 4>& value) {
        surfaceBlock[surfaceCursor++] = value[0];
        surfaceBlock[surfaceCursor++] = value[1];
        surfaceBlock[surfaceCursor++] = value[2];
        surfaceBlock[surfaceCursor++] = value[3];
      };
      writeVec4(surfaceInputs.clipCenter);
      writeVec4(surfaceInputs.clipBasisEast);
      writeVec4(surfaceInputs.clipBasisNorth);
      for (std::size_t i = 0; i < 4; ++i) {
        std::array<double, 4> corner =
            i < surfaceInputs.clipCorners.size()
                ? surfaceInputs.clipCorners[i]
                : std::array<double, 4>{0.0, 0.0, 0.0, 1.0};
        writeVec4(corner);
      }
      surfaceBlock[surfaceCursor++] = surfaceInputs.baseLngLat.lng;
      surfaceBlock[surfaceCursor++] = surfaceInputs.baseLngLat.lat;
      surfaceBlock[surfaceCursor++] = surfaceInputs.baseLngLat.z;
      surfaceBlock[surfaceCursor++] = surfaceInputs.displacedCenter.lng;
      surfaceBlock[surfaceCursor++] = surfaceInputs.displacedCenter.lat;
      surfaceBlock[surfaceCursor++] = surfaceInputs.displacedCenter.z;
      surfaceBlock[surfaceCursor++] = surfaceInputs.scaleAdjustment;
      for (const auto& corner : surfaceInputs.corners) {
        surfaceBlock[surfaceCursor++] = corner.east;
        surfaceBlock[surfaceCursor++] = corner.north;
        surfaceBlock[surfaceCursor++] = corner.lng;
        surfaceBlock[surfaceCursor++] = corner.lat;
      }
      outHasSurfaceInputs = true;
    }

    useShaderBillboardValue = 0.0;
    outHasHitTest = true;
  } else {
    const BillboardCenterResult placement = calculateBillboardCenterPosition(
        baseProjected,
        resource.width,
        resource.height,
        frame.baseMetersPerPixel,
        imageScale,
        frame.zoomScaleFactor,
        effectivePixelsPerMeter,
        frame.spriteMinPixel,
        frame.spriteMaxPixel,
        totalRotateDeg,
        &anchor,
        &offset);

    std::array<QuadCorner, 4> resolvedCorners =
        calculateBillboardCornerScreenPositions(placement.center,
                                                placement.halfWidth,
                                                placement.halfHeight,
                                                &anchor,
                                                totalRotateDeg);

    const bool useShaderBillboard = useShaderBillboardGeometry;
    useShaderBillboardValue = useShaderBillboard ? 1.0 : 0.0;
    billboardCenterX = placement.center.x;
    billboardCenterY = placement.center.y;
    billboardHalfWidth = placement.halfWidth;
    billboardHalfHeight = placement.halfHeight;
    billboardAnchorX = anchor.x;
    billboardAnchorY = anchor.y;
    billboardSin = std::sin(-totalRotateDeg * DEG2RAD);
    billboardCos = std::cos(-totalRotateDeg * DEG2RAD);

    std::size_t vertexCursor = 0;
    for (int idx : TRIANGLE_INDICES) {
      if (useShaderBillboard) {
        const auto& baseCorner = BILLBOARD_BASE_CORNERS[idx];
        vertexData[vertexCursor++] = baseCorner[0];
        vertexData[vertexCursor++] = baseCorner[1];
      } else {
        vertexData[vertexCursor++] = resolvedCorners[idx].x;
        vertexData[vertexCursor++] = resolvedCorners[idx].y;
      }
      vertexData[vertexCursor++] = 0.0;
      vertexData[vertexCursor++] = 1.0;
      vertexData[vertexCursor++] = resolvedCorners[idx].u;
      vertexData[vertexCursor++] = resolvedCorners[idx].v;
    }

    for (std::size_t i = 0; i < resolvedCorners.size(); ++i) {
      hitTestData[i * 2 + 0] = resolvedCorners[i].x;
      hitTestData[i * 2 + 1] = resolvedCorners[i].y;
    }

    outHasHitTest = true;
  }

  std::size_t cursor = 0;
  itemBase[cursor++] = entry.spriteHandle;
  itemBase[cursor++] = static_cast<double>(imageIndex);
  itemBase[cursor++] = static_cast<double>(resourceIndex);
  itemBase[cursor++] = entry.opacity;
  itemBase[cursor++] = screenScaleX;
  itemBase[cursor++] = screenScaleY;
  itemBase[cursor++] = screenOffsetX;
  itemBase[cursor++] = screenOffsetY;
  itemBase[cursor++] = useShaderSurfaceValue;
  itemBase[cursor++] = surfaceClipEnabledValue;
  itemBase[cursor++] = useShaderBillboardValue;
  itemBase[cursor++] = billboardCenterX;
  itemBase[cursor++] = billboardCenterY;
  itemBase[cursor++] = billboardHalfWidth;
  itemBase[cursor++] = billboardHalfHeight;
  itemBase[cursor++] = billboardAnchorX;
  itemBase[cursor++] = billboardAnchorY;
  itemBase[cursor++] = billboardSin;
  itemBase[cursor++] = billboardCos;

  double* vertexPtr = itemBase + RESULT_COMMON_ITEM_LENGTH;
  std::copy(vertexData.begin(), vertexData.end(), vertexPtr);
  double* hitTestPtr = vertexPtr + RESULT_VERTEX_COMPONENT_LENGTH;
  std::copy(hitTestData.begin(), hitTestData.end(), hitTestPtr);
  double* surfacePtr = hitTestPtr + RESULT_HIT_TEST_COMPONENT_LENGTH;
  std::copy(surfaceBlock.begin(), surfaceBlock.end(), surfacePtr);

  return true;
}

static inline SurfaceWorldDimensions calculateSurfaceWorldDimensions(
    double imageWidth,
    double imageHeight,
    double baseMetersPerPixel,
    double imageScale,
    double zoomScaleFactor,
    double effectivePixelsPerMeter = 0.0,
    double spriteMinPixel = 0.0,
    double spriteMaxPixel = 0.0) {
  if (imageWidth <= 0.0 || imageHeight <= 0.0 || baseMetersPerPixel <= 0.0) {
    return {0.0, 0.0, 1.0};
  }

  const double scaleFactor = baseMetersPerPixel * imageScale * zoomScaleFactor;
  double width = ensureFinite(imageWidth * scaleFactor);
  double height = ensureFinite(imageHeight * scaleFactor);
  double scaleAdjustment = 1.0;

  if (effectivePixelsPerMeter > 0.0 && std::isfinite(effectivePixelsPerMeter) &&
      (spriteMinPixel > 0.0 || spriteMaxPixel > 0.0)) {
    const double largestMeters = std::max(width, height);
    if (largestMeters > 0.0 && std::isfinite(largestMeters)) {
      const double largestPixels = largestMeters * effectivePixelsPerMeter;
      if (largestPixels > 0.0 && std::isfinite(largestPixels)) {
        double scale = 1.0;
        if (spriteMinPixel > 0.0 && largestPixels < spriteMinPixel) {
          scale = spriteMinPixel / largestPixels;
        }
        const double scaledLargest = largestPixels * scale;
        if (spriteMaxPixel > 0.0 && scaledLargest > spriteMaxPixel) {
          scale = spriteMaxPixel / largestPixels;
        }
        if (scale != 1.0) {
          width *= scale;
          height *= scale;
          scaleAdjustment *= scale;
        }
      }
    }
  }

  return {width, height, scaleAdjustment};
}

static inline std::vector<SurfaceCorner> calculateSurfaceCornerDisplacements(
    double worldWidthMeters,
    double worldHeightMeters,
    const SpriteAnchor* anchor,
    double totalRotateDeg,
    const SurfaceCorner& offsetMeters) {
  if (worldWidthMeters <= 0.0 || worldHeightMeters <= 0.0) {
    return std::vector<SurfaceCorner>(
        SURFACE_BASE_CORNERS.size(), offsetMeters);
  }

  const double halfWidth = worldWidthMeters / 2.0;
  const double halfHeight = worldHeightMeters / 2.0;
  const double anchorEast = (anchor ? anchor->x : 0.0) * halfWidth;
  const double anchorNorth = (anchor ? anchor->y : 0.0) * halfHeight;
  const double rad = -totalRotateDeg * DEG2RAD;
  const double cosR = std::cos(rad);
  const double sinR = std::sin(rad);

  std::vector<SurfaceCorner> corners;
  corners.reserve(SURFACE_BASE_CORNERS.size());
  for (const auto& baseCorner : SURFACE_BASE_CORNERS) {
    const double cornerEast = baseCorner[0] * halfWidth;
    const double cornerNorth = baseCorner[1] * halfHeight;
    const double localEast = cornerEast - anchorEast;
    const double localNorth = cornerNorth - anchorNorth;
    const double rotatedEast = localEast * cosR - localNorth * sinR;
    const double rotatedNorth = localEast * sinR + localNorth * cosR;
    corners.push_back({rotatedEast + offsetMeters.east,
                       rotatedNorth + offsetMeters.north});
  }
  return corners;
}

static inline std::vector<SurfaceShaderCornerModel>
computeSurfaceCornerShaderModel(const SpriteLocation& baseLngLat,
                                double worldWidthMeters,
                                double worldHeightMeters,
                                const SpriteAnchor* anchor,
                                double totalRotateDeg,
                                const SurfaceCorner& offsetMeters) {
  const double halfWidth = worldWidthMeters / 2.0;
  const double halfHeight = worldHeightMeters / 2.0;
  const double rad = -totalRotateDeg * DEG2RAD;
  const double sinR = std::sin(rad);
  const double cosR = std::cos(rad);
  const double cosLat = std::cos(baseLngLat.lat * DEG2RAD);
  const double cosLatClamped = std::max(cosLat, MIN_COS_LAT);

  std::vector<SurfaceShaderCornerModel> corners;
  corners.reserve(SURFACE_BASE_CORNERS.size());

  const double anchorEast = (anchor ? anchor->x : 0.0) * halfWidth;
  const double anchorNorth = (anchor ? anchor->y : 0.0) * halfHeight;

  for (const auto& baseCorner : SURFACE_BASE_CORNERS) {
    const double cornerEast = baseCorner[0] * halfWidth;
    const double cornerNorth = baseCorner[1] * halfHeight;

    const double localEast = cornerEast - anchorEast;
    const double localNorth = cornerNorth - anchorNorth;

    const double rotatedEast = localEast * cosR - localNorth * sinR;
    const double rotatedNorth = localEast * sinR + localNorth * cosR;

    const double east = rotatedEast + offsetMeters.east;
    const double north = rotatedNorth + offsetMeters.north;

    const double deltaLat = (north / EARTH_RADIUS_METERS) * RAD2DEG;
    const double deltaLng =
        (east / (EARTH_RADIUS_METERS * cosLatClamped)) * RAD2DEG;

    corners.push_back({east,
                       north,
                       baseLngLat.lng + deltaLng,
                       baseLngLat.lat + deltaLat});
  }

  return corners;
}

static inline SurfaceCenterResult calculateSurfaceCenterPosition(
    const SurfaceCenterParams& params) {
  const bool hasClipProjection =
      params.drawingBufferWidth > 0.0 && params.drawingBufferHeight > 0.0 &&
      params.pixelRatio != 0.0 && std::isfinite(params.pixelRatio) &&
      static_cast<bool>(params.projectToClipSpace);

  auto projectPoint = [&](const SpriteLocation& lngLat,
                          SpriteScreenPoint& out) -> bool {
    if (hasClipProjection && params.projectToClipSpace) {
      std::array<double, 4> clip{};
      if (params.projectToClipSpace(lngLat, clip) &&
          clipToScreen(clip,
                       params.drawingBufferWidth,
                       params.drawingBufferHeight,
                       params.pixelRatio,
                       out)) {
        return true;
      }
    }
    if (params.project) {
      return params.project(lngLat, out);
    }
    return false;
  };

  const SurfaceWorldDimensions worldDims = calculateSurfaceWorldDimensions(
      params.imageWidth,
      params.imageHeight,
      params.baseMetersPerPixel,
      params.imageScale,
      params.zoomScaleFactor,
      params.effectivePixelsPerMeter,
      params.spriteMinPixel,
      params.spriteMaxPixel);

  const double halfWidthMeters = worldDims.width * 0.5;
  const double halfHeightMeters = worldDims.height * 0.5;

  const SurfaceCorner anchorShiftMeters = calculateSurfaceAnchorShiftMeters(
      halfWidthMeters, halfHeightMeters, params.anchor, params.totalRotateDeg);
  const SurfaceCorner offsetMeters = calculateSurfaceOffsetMeters(
      params.offset,
      params.imageScale,
      params.zoomScaleFactor,
      worldDims.scaleAdjustment);

  SurfaceCorner totalDisplacement{
      anchorShiftMeters.east + offsetMeters.east,
      anchorShiftMeters.north + offsetMeters.north};

  SpriteLocation displaced = params.baseLngLat;
  applySurfaceDisplacement(params.baseLngLat, totalDisplacement, displaced);

  std::optional<SpriteScreenPoint> center;
  SpriteScreenPoint projected{};
  if (projectPoint(displaced, projected)) {
    center = projected;
  }

  SurfaceCenterResult result;
  result.center = center;
  result.worldDimensions = worldDims;
  result.totalDisplacement = totalDisplacement;
  result.displacedLngLat = displaced;

  if (params.resolveAnchorless) {
    SurfaceCorner anchorlessDisplacement = offsetMeters;
    SpriteLocation anchorlessLngLat = params.baseLngLat;
    applySurfaceDisplacement(
        params.baseLngLat, anchorlessDisplacement, anchorlessLngLat);
    SpriteScreenPoint anchorlessPoint{};
    if (projectPoint(anchorlessLngLat, anchorlessPoint)) {
      result.anchorlessCenter = anchorlessPoint;
    } else {
      result.anchorlessCenter = std::nullopt;
    }
    result.anchorlessDisplacement = anchorlessDisplacement;
    result.anchorlessLngLat = anchorlessLngLat;
  }

  return result;
}

static inline BillboardCenterResult calculateBillboardCenterPosition(
    const SpriteScreenPoint& base,
    double imageWidth,
    double imageHeight,
    double baseMetersPerPixel,
    double imageScale,
    double zoomScaleFactor,
    double effectivePixelsPerMeter,
    double spriteMinPixel,
    double spriteMaxPixel,
    double totalRotateDeg,
    const SpriteAnchor* anchor,
    const SpriteImageOffset* offset) {
  const auto pixelDims = calculateBillboardPixelDimensions(
      imageWidth,
      imageHeight,
      baseMetersPerPixel,
      imageScale,
      zoomScaleFactor,
      effectivePixelsPerMeter,
      spriteMinPixel,
      spriteMaxPixel);
  const double halfWidth = pixelDims.width * 0.5;
  const double halfHeight = pixelDims.height * 0.5;

  const SpritePoint anchorShift =
      calculateBillboardAnchorShiftPixels(halfWidth, halfHeight, anchor,
                                          totalRotateDeg);
  const SpritePoint offsetShift = calculateBillboardOffsetPixels(
      offset,
      imageScale,
      zoomScaleFactor,
      effectivePixelsPerMeter,
      pixelDims.scaleAdjustment);

  SpriteScreenPoint center{base.x + offsetShift.x,
                           base.y - offsetShift.y};

  return {center,
          halfWidth,
          halfHeight,
          pixelDims.width,
          pixelDims.height,
          anchorShift,
          offsetShift};
}

static inline std::array<QuadCorner, 4> calculateBillboardCornerScreenPositions(
    const SpriteScreenPoint& center,
    double halfWidth,
    double halfHeight,
    const SpriteAnchor* anchor,
    double totalRotateDeg) {
  std::array<QuadCorner, 4> corners{};
  if (halfWidth <= 0.0 || halfHeight <= 0.0) {
    for (std::size_t i = 0; i < corners.size(); ++i) {
      corners[i] = {center.x, center.y, UV_CORNERS[i][0], UV_CORNERS[i][1]};
    }
    return corners;
  }

  const double anchorOffsetX = (anchor ? anchor->x : 0.0) * halfWidth;
  const double anchorOffsetY = (anchor ? anchor->y : 0.0) * halfHeight;
  const double rad = -totalRotateDeg * DEG2RAD;
  const double cosR = std::cos(rad);
  const double sinR = std::sin(rad);

  for (std::size_t i = 0; i < BILLBOARD_BASE_CORNERS.size(); ++i) {
    const double cornerX = BILLBOARD_BASE_CORNERS[i][0] * halfWidth;
    const double cornerY = BILLBOARD_BASE_CORNERS[i][1] * halfHeight;
    const double shiftedX = cornerX - anchorOffsetX;
    const double shiftedY = cornerY - anchorOffsetY;
    const double rotatedX = shiftedX * cosR - shiftedY * sinR;
    const double rotatedY = shiftedX * sinR + shiftedY * cosR;
    corners[i] = {center.x + rotatedX,
                  center.y - rotatedY,
                  UV_CORNERS[i][0],
                  UV_CORNERS[i][1]};
  }

  return corners;
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

EMSCRIPTEN_KEEPALIVE bool
prepareDrawSpriteImages(const double* paramsPtr, double* resultPtr) {
  if (paramsPtr == nullptr || resultPtr == nullptr) {
    return false;
  }

  ResultBufferHeader* resultHeader = initializeResultHeader(resultPtr);
  (void)resultHeader;

  const InputBufferHeader* header = AsInputHeader(paramsPtr);
  if (header == nullptr) {
    return false;
  }

  std::size_t totalLength = 0;
  if (!convertToSizeT(header->totalLength, totalLength)) {
    return false;
  }
  if (totalLength < INPUT_HEADER_LENGTH) {
    return false;
  }

  std::size_t frameConstCount = 0;
  if (!convertToSizeT(header->frameConstCount, frameConstCount)) {
    return false;
  }
  if (frameConstCount != INPUT_FRAME_CONSTANT_LENGTH) {
    return false;
  }

  std::size_t matrixOffset = 0;
  if (!convertToSizeT(header->matrixOffset, matrixOffset)) {
    return false;
  }
  if (!validateSpan(totalLength, matrixOffset, INPUT_MATRIX_LENGTH)) {
    return false;
  }

  std::size_t resourceCount = 0;
  if (!convertToSizeT(header->resourceCount, resourceCount)) {
    return false;
  }
  std::size_t resourceOffset = 0;
  if (!convertToSizeT(header->resourceOffset, resourceOffset)) {
    return false;
  }
  if (!validateSpan(totalLength, resourceOffset,
                    resourceCount * RESOURCE_STRIDE)) {
    return false;
  }

  std::size_t spriteCount = 0;
  if (!convertToSizeT(header->spriteCount, spriteCount)) {
    return false;
  }
  std::size_t spriteOffset = 0;
  if (!convertToSizeT(header->spriteOffset, spriteOffset)) {
    return false;
  }
  if (!validateSpan(totalLength, spriteOffset, spriteCount * SPRITE_STRIDE)) {
    return false;
  }

  std::size_t itemCount = 0;
  if (!convertToSizeT(header->itemCount, itemCount)) {
    return false;
  }
  std::size_t itemOffset = 0;
  if (!convertToSizeT(header->itemOffset, itemOffset)) {
    return false;
  }
  if (!validateSpan(totalLength, itemOffset, itemCount * ITEM_STRIDE)) {
    return false;
  }

  if (!validateSpan(totalLength, INPUT_HEADER_LENGTH, frameConstCount)) {
    return false;
  }

  const double* frameConstPtr = paramsPtr + INPUT_HEADER_LENGTH;
  const double* matrixPtr = paramsPtr + matrixOffset;
  const double* resourcePtr = paramsPtr + resourceOffset;
  const double* itemPtr = paramsPtr + itemOffset;

  const FrameConstants frame = readFrameConstants(
      frameConstPtr, frameConstCount);

  const double* mercatorMatrix = matrixPtr;
  const double* pixelMatrix = matrixPtr + 16;
  const double* pixelMatrixInverse = matrixPtr + 32;

  ProjectionContext projectionContext;
  projectionContext.worldSize = frame.worldSize;
  projectionContext.cameraToCenterDistance = frame.cameraToCenterDistance;
  projectionContext.mercatorMatrix = mercatorMatrix;
  projectionContext.pixelMatrix = pixelMatrix;
  projectionContext.pixelMatrixInverse = pixelMatrixInverse;

  const bool clipContextAvailable =
      frame.drawingBufferWidth > 0.0 && frame.drawingBufferHeight > 0.0 &&
      frame.pixelRatio != 0.0 && std::isfinite(frame.pixelRatio) &&
      mercatorMatrix != nullptr;

  const int inputFlags = static_cast<int>(header->flags);
  const bool useShaderSurfaceGeometry =
      (inputFlags & INPUT_FLAG_USE_SHADER_SURFACE_GEOMETRY) != 0;
  const bool useShaderBillboardGeometry =
      (inputFlags & INPUT_FLAG_USE_SHADER_BILLBOARD_GEOMETRY) != 0;
  const bool enableSurfaceBias =
      (inputFlags & INPUT_FLAG_ENABLE_NDC_BIAS_SURFACE) != 0 &&
      frame.enableNdcBiasSurface;

  const auto* resourceEntries =
      reinterpret_cast<const InputResourceEntry*>(resourcePtr);
  std::vector<ResourceInfo> resources(resourceCount);
  for (std::size_t i = 0; i < resourceCount; ++i) {
    const auto& entry = resourceEntries[i];
    ResourceInfo info;
    info.handle = i;
    info.width = entry.width;
    info.height = entry.height;
    info.textureReady = entry.textureReady != 0.0;
    resources[i] = info;
  }

  const auto* itemEntries = reinterpret_cast<const InputItemEntry*>(itemPtr);
  std::vector<BucketItem> bucketItems(itemCount);
  for (std::size_t i = 0; i < itemCount; ++i) {
    BucketItem bucket;
    bucket.entry = &itemEntries[i];
    bucket.index = i;
    bucket.resource =
        findResourceByHandle(resources, bucket.entry->resourceHandle);
    bucket.spriteLocation = {bucket.entry->spriteLng,
                             bucket.entry->spriteLat,
                             bucket.entry->spriteZ};
    bucket.projectedValid =
        projectSpritePoint(projectionContext, bucket.spriteLocation,
                           bucket.projected);
    bucket.hasMercator =
        calculateMercatorCoordinate(bucket.spriteLocation, bucket.mercator);
    if (!convertToInt64(bucket.entry->spriteHandle, bucket.spriteHandle)) {
      bucket.spriteHandle = 0;
    }
    bucketItems[i] = bucket;
  }

  ResolveOriginFn resolveOrigin =
      [&bucketItems](const BucketItem& current) -> const BucketItem* {
    int64_t originIndex = 0;
    if (!convertToInt64(current.entry->originTargetIndex, originIndex)) {
      return nullptr;
    }
    if (originIndex == SPRITE_ORIGIN_REFERENCE_INDEX_NONE) {
      return nullptr;
    }
    if (originIndex < 0 ||
        static_cast<std::size_t>(originIndex) >= bucketItems.size()) {
      return nullptr;
    }
    const BucketItem& candidate =
        bucketItems[static_cast<std::size_t>(originIndex)];
    if (candidate.entry == nullptr) {
      return nullptr;
    }
    if (candidate.spriteHandle != current.spriteHandle) {
      return nullptr;
    }
    return &candidate;
  };

  DepthCollectionResult depthResult = collectDepthSortedItemsInternal(
      bucketItems,
      projectionContext,
      frame,
      clipContextAvailable,
      enableSurfaceBias,
      resolveOrigin);

  double* writePtr = resultPtr + RESULT_HEADER_LENGTH;
  std::size_t preparedCount = 0;
  bool hasHitTest = false;
  bool hasSurfaceInputs = false;

  for (const DepthItem& depth : depthResult.items) {
    if (preparedCount >= itemCount) {
      break;
    }
    double* itemBase = writePtr + preparedCount * RESULT_ITEM_STRIDE;
    bool itemHasHitTest = false;
    bool itemHasSurfaceInputs = false;
    if (prepareDrawSpriteImageInternal(depth,
                                       depthResult.centerCache,
                                       projectionContext,
                                       frame,
                                       clipContextAvailable,
                                       useShaderBillboardGeometry,
                                       useShaderSurfaceGeometry,
                                       resolveOrigin,
                                       itemBase,
                                       itemHasHitTest,
                                       itemHasSurfaceInputs)) {
      preparedCount += 1;
      hasHitTest = hasHitTest || itemHasHitTest;
      hasSurfaceInputs = hasSurfaceInputs || itemHasSurfaceInputs;
    }
  }

  resultHeader->preparedCount = static_cast<double>(preparedCount);
  resultHeader->flags = (hasHitTest ? RESULT_FLAG_HAS_HIT_TEST : 0) |
                        (hasSurfaceInputs ? RESULT_FLAG_HAS_SURFACE_INPUTS
                                          : 0);

  return true;
}

} // extern "C"
