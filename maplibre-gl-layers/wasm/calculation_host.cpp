// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo)
// Under MIT

#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#if defined(__EMSCRIPTEN_PTHREADS__)
#include <emscripten/threading.h>
#endif

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cmath>
#include <cstring>
#include <limits>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>
#if defined(__EMSCRIPTEN_PTHREADS__)
#include <thread>
#endif

#ifdef SIMD_ENABLED
#include <wasm_simd128.h>
#endif

#include "projection_host.h"
#include "param_layouts.h"

#if defined(__EMSCRIPTEN_PTHREADS__)
static std::size_t g_threadPoolLimit = 0;

extern "C" {
EMSCRIPTEN_KEEPALIVE void setThreadPoolSize(double value) {
  if (std::isnan(value) || value <= 0.0) {
    g_threadPoolLimit = 0;
    return;
  }
  const double floored = std::floor(value + 0.5);
  if (!std::isfinite(floored)) {
    return;
  }
  const auto converted = static_cast<std::size_t>(floored);
  g_threadPoolLimit = converted > 0 ? converted : 0;
}
}

static inline std::size_t clampToAvailableThreads(std::size_t requested) {
  if (g_threadPoolLimit > 0) {
    return std::min<std::size_t>(requested, g_threadPoolLimit);
  }
  unsigned int hw = std::thread::hardware_concurrency();
  if (hw == 0u) {
    hw = 4u;
  }
  return std::min<std::size_t>(requested, static_cast<std::size_t>(hw));
}
#else
extern "C" {
EMSCRIPTEN_KEEPALIVE void setThreadPoolSize(double value) {
  (void)value;
}
}

static inline std::size_t clampToAvailableThreads(std::size_t requested) {
  return requested;
}
#endif

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

static inline double applyEasingPreset(double progress, int32_t presetId) {
  switch (presetId) {
    case 0:  // linear
    default:
      return clamp01(progress);
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

static inline bool convertToRoundedInt32(double value, int32_t& out) {
  if (!std::isfinite(value)) {
     return false;
  }
  const double rounded = std::floor(value + 0.5);
  if (!std::isfinite(rounded)) {
    return false;
  }
  if (rounded < static_cast<double>(std::numeric_limits<int32_t>::min()) ||
      rounded > static_cast<double>(std::numeric_limits<int32_t>::max())) {
    return false;
  }
  out = static_cast<int32_t>(rounded);
  return true;
}

static inline uint64_t doubleToKeyBits(double value) {
  uint64_t bits = 0;
  std::memcpy(&bits, &value, sizeof(double));
  return bits;
}

static inline uint64_t hashCombineUint64(uint64_t a, uint64_t b) {
  const uint64_t magic = 0x9e3779b97f4a7c15ULL;
  return a ^ (b + magic + (a << 6) + (a >> 2));
}

static inline uint64_t makeSpriteCenterCacheKey(double subLayer, double order) {
  int32_t subLayerKey = 0;
  int32_t orderKey = 0;
  if (convertToRoundedInt32(subLayer, subLayerKey) &&
      convertToRoundedInt32(order, orderKey)) {
    return (static_cast<uint64_t>(static_cast<uint32_t>(subLayerKey)) << 32) |
           static_cast<uint32_t>(orderKey);
  }
  const uint64_t subBits = doubleToKeyBits(subLayer);
  const uint64_t orderBits = doubleToKeyBits(order);
  return hashCombineUint64(subBits, orderBits);
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

/**
 * @brief Sprite positional offset expressed in meters and bearing degrees.
 */
struct SpriteImageOffset {
  double offsetMeters = 0.0;
  double offsetDeg = 0.0;
};

/**
 * @brief Rotation metadata shared by all geometry computations for one sprite.
 *
 * The cached sine/cosine of the normalized (negative) angle avoids repeated
 * calls into libm trigonometric helpers across billboard and surface builders.
 */
struct RotationCache {
  double degrees = 0.0;
  double sinNegativeRad = 0.0;
  double cosNegativeRad = 1.0;
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

/**
 * @brief Resolves the effective rotation angle for a sprite entry.
 */
static inline double resolveTotalRotateDeg(const InputItemEntry& entry) {
  if (std::isfinite(entry.displayedRotateDeg)) {
    return entry.displayedRotateDeg;
  }
  return normalizeAngleDeg(entry.resolvedBaseRotateDeg + entry.rotateDeg);
}

/**
 * @brief Builds a RotationCache; invoked exactly once per bucket item.
 */
static inline RotationCache buildRotationCache(double totalRotateDeg) {
  RotationCache cache;
  cache.degrees = totalRotateDeg;
  const double rad = -totalRotateDeg * DEG2RAD;
  cache.sinNegativeRad = std::sin(rad);
  cache.cosNegativeRad = std::cos(rad);
  return cache;
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
  double atlasPageIndex = -1.0;
  double atlasU0 = 0.0;
  double atlasV0 = 0.0;
  double atlasU1 = 1.0;
  double atlasV1 = 1.0;
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

/**
 * @brief CPU-side staging record for each sprite processed in the current frame.
 */
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
  double metersPerPixelAtLat = 0.0;
  double perspectiveRatio = 1.0;
  double effectivePixelsPerMeter = 0.0;
  bool hasEffectivePixelsPerMeter = false;
  RotationCache rotation;
  SpriteScreenPoint resolvedAnchorCenter;
  bool hasResolvedAnchorCenter = false;
  SpriteScreenPoint anchorlessCenter;
  bool hasAnchorlessCenter = false;
};

static inline bool tryGetPrecomputedCenter(const BucketItem& bucket,
                                           bool useResolvedAnchor,
                                           SpriteScreenPoint& out) {
  if (useResolvedAnchor && bucket.hasResolvedAnchorCenter) {
    out = bucket.resolvedAnchorCenter;
    return true;
  }
  if (!useResolvedAnchor && bucket.hasAnchorlessCenter) {
    out = bucket.anchorlessCenter;
    return true;
  }
  return false;
}

struct DepthItem {
  const BucketItem* item = nullptr;
  double depthKey = 0.0;
  bool hasSurfaceData = false;
  SurfaceWorldDimensions surfaceWorldDimensions;
  SurfaceCorner surfaceOffsetMeters;
  std::array<SurfaceCorner, SURFACE_CLIP_CORNER_COUNT> surfaceCornerDisplacements;
};

struct DepthCollectionResult {
  std::vector<DepthItem> items;
};

struct ProjectionContext;
struct FrameConstants;

static inline bool ensureBucketEffectivePixelsPerMeter(
    BucketItem& bucketItem,
    const ProjectionContext& projectionContext,
    const FrameConstants& frame);


/**
 * @brief Parameters required to compute surface sprite centers and bounds.
 *
 * This structure now carries cached sine/cosine values so that all downstream
 * helpers operate purely on precomputed rotation data.
 */
struct SurfaceCenterParams {
  SpriteLocation baseLngLat;
  double imageWidth = 0.0;
  double imageHeight = 0.0;
  double baseMetersPerPixel = 0.0;
  double imageScale = 1.0;
  double zoomScaleFactor = 1.0;
  double totalRotateDeg = 0.0;
  double sinNegativeRotation = 0.0;
  double cosNegativeRotation = 1.0;
  const SpriteAnchor* anchor = nullptr;
  const SpriteImageOffset* offset = nullptr;
  double effectivePixelsPerMeter = 0.0;
  double spriteMinPixel = 0.0;
  double spriteMaxPixel = 0.0;
  const ProjectionContext* projection = nullptr;
  bool enableClipProjection = false;
  bool enableScreenProjection = false;
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

#ifdef SIMD_ENABLED
alignas(16) constexpr double SURFACE_BASE_EAST_SIMD[4] = {-1.0, 1.0, -1.0, 1.0};
alignas(16) constexpr double SURFACE_BASE_NORTH_SIMD[4] = {1.0, 1.0, -1.0, -1.0};
alignas(16) constexpr double BILLBOARD_BASE_X_SIMD[4] = {-1.0, 1.0, -1.0, 1.0};
alignas(16) constexpr double BILLBOARD_BASE_Y_SIMD[4] = {1.0, 1.0, -1.0, -1.0};
#endif

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
static inline std::array<SurfaceCorner, SURFACE_CLIP_CORNER_COUNT>
    calculateSurfaceCornerDisplacements(
    double worldWidthMeters,
    double worldHeightMeters,
    const SpriteAnchor* anchor,
    double sinNegativeRotation,
    double cosNegativeRotation,
    const SurfaceCorner& offsetMeters);
static inline std::array<SurfaceShaderCornerModel, SURFACE_CLIP_CORNER_COUNT>
computeSurfaceCornerShaderModel(const SpriteLocation& baseLngLat,
                                double worldWidthMeters,
                                double worldHeightMeters,
                                const SpriteAnchor* anchor,
                                double sinNegativeRotation,
                                double cosNegativeRotation,
                                const SurfaceCorner& offsetMeters);
static inline SurfaceCenterResult calculateSurfaceCenterPosition(
    const SurfaceCenterParams& params);
/**
 * @brief Computes billboard center, size and anchor/offset shifts in screen space.
 *
 * All rotation math uses `RotationCache` so the caller pays trigonometric cost
 * only once per sprite.
 */
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
    const RotationCache& rotation,
    const SpriteAnchor* anchor,
    const SpriteImageOffset* offset);
/**
 * @brief Generates rotated billboard quad corners around the computed center.
 */
static inline std::array<QuadCorner, 4> calculateBillboardCornerScreenPositions(
    const SpriteScreenPoint& center,
    double halfWidth,
    double halfHeight,
    const SpriteAnchor* anchor,
    const RotationCache& rotation);
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

static inline const BucketItem* resolveOriginBucketItem(
    const BucketItem& current,
    const std::vector<BucketItem>& bucketItems) {
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
}

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

#ifdef SIMD_ENABLED
static inline void storeVec2(double*& dst, double v0, double v1) {
  const v128_t packed = wasm_f64x2_make(v0, v1);
  wasm_v128_store(dst, packed);
  dst += 2;
}

static inline void storeVec2At(double* dst, double v0, double v1) {
  const v128_t packed = wasm_f64x2_make(v0, v1);
  wasm_v128_store(dst, packed);
}
#else
static inline void storeVec2(double*& dst, double v0, double v1) {
  dst[0] = v0;
  dst[1] = v1;
  dst += 2;
}

static inline void storeVec2At(double* dst, double v0, double v1) {
  dst[0] = v0;
  dst[1] = v1;
}
#endif

static inline void storeScalar(double*& dst, double value) {
  *dst++ = value;
}

static inline void storeVec4(double*& dst,
                             double v0,
                             double v1,
                             double v2,
                             double v3) {
#ifdef SIMD_ENABLED
  const v128_t first = wasm_f64x2_make(v0, v1);
  const v128_t second = wasm_f64x2_make(v2, v3);
  wasm_v128_store(dst, first);
  dst += 2;
  wasm_v128_store(dst, second);
  dst += 2;
#else
  dst[0] = v0;
  dst[1] = v1;
  dst[2] = v2;
  dst[3] = v3;
  dst += 4;
#endif
}

static inline void storeVec4(double*& dst, const std::array<double, 4>& values) {
  storeVec4(dst, values[0], values[1], values[2], values[3]);
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
  double zoomExp2 = 1.0;
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
  constants.zoomExp2 = std::exp2(constants.zoom);
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

static inline double calculateMetersPerPixelAtLatitude(double zoomExp2,
                                                       double latitude) {
  const double cosLatitude = std::cos(latitude * DEG2RAD);
  const double scale = zoomExp2;
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

/**
 * @brief Computes how far the billboard anchor shifts in screen pixels.
 *
 * Uses cached rotation values to avoid redundant trigonometric evaluations.
 */
static inline SpritePoint calculateBillboardAnchorShiftPixels(
    double halfWidth,
    double halfHeight,
    const SpriteAnchor* anchor,
    const RotationCache& rotation) {
  if (halfWidth <= 0.0 || halfHeight <= 0.0) {
    return {0.0, 0.0};
  }
  const double anchorX = (anchor ? anchor->x : 0.0) * halfWidth;
  const double anchorY = (anchor ? anchor->y : 0.0) * halfHeight;
  if (anchorX == 0.0 && anchorY == 0.0) {
    return {0.0, 0.0};
  }
  const double cosR = rotation.cosNegativeRad;
  const double sinR = rotation.sinNegativeRad;
  const double shiftX = -anchorX * cosR + anchorY * sinR;
  const double shiftY = -anchorX * sinR - anchorY * cosR;
  return {shiftX, shiftY};
}

/**
 * @brief Calculates the anchor shift for surface sprites in world meters.
 */
static inline SurfaceCorner calculateSurfaceAnchorShiftMeters(
    double halfWidthMeters,
    double halfHeightMeters,
    const SpriteAnchor* anchor,
    double sinNegRotation,
    double cosNegRotation) {
  if (halfWidthMeters <= 0.0 || halfHeightMeters <= 0.0) {
    return {0.0, 0.0};
  }
  const double anchorEast = (anchor ? anchor->x : 0.0) * halfWidthMeters;
  const double anchorNorth = (anchor ? anchor->y : 0.0) * halfHeightMeters;
  if (anchorEast == 0.0 && anchorNorth == 0.0) {
    return {0.0, 0.0};
  }
  const double cosR = cosNegRotation;
  const double sinR = sinNegRotation;
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

/**
 * @brief Bundle of surface shader uniforms derived from CPU-side calculations.
 */
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
  std::array<SurfaceShaderCornerModel, SURFACE_CLIP_CORNER_COUNT> corners{};
  std::array<double, 4> clipCenter = {0.0, 0.0, 0.0, 1.0};
  std::array<double, 4> clipBasisEast = {0.0, 0.0, 0.0, 0.0};
  std::array<double, 4> clipBasisNorth = {0.0, 0.0, 0.0, 0.0};
  std::array<std::array<double, 4>, SURFACE_CLIP_CORNER_COUNT> clipCorners{};
  std::size_t clipCornerCount = 0;
};

/**
 * @brief Prepares per-surface shader inputs using cached rotation data.
 */
static inline SurfaceShaderInputsData prepareSurfaceShaderInputs(
    const ProjectionContext& projection,
    const SpriteLocation& baseLngLat,
    double worldWidthMeters,
    double worldHeightMeters,
    const SpriteAnchor* anchor,
    const RotationCache& rotation,
    const SurfaceCorner& offsetMeters,
    const SpriteLocation& displacedCenter,
    double depthBiasNdc,
    double scaleAdjustment,
    const SurfaceCorner& centerDisplacement) {
  const double halfWidth = worldWidthMeters * 0.5;
  const double halfHeight = worldHeightMeters * 0.5;
  const double sinR = rotation.sinNegativeRad;
  const double cosR = rotation.cosNegativeRad;

  SurfaceShaderInputsData data;
  calculateMercatorCoordinate(displacedCenter, data.mercatorCenter);
  data.worldToMercatorScale =
      calculateWorldToMercatorScale(projection, displacedCenter);
  data.halfSizeMeters = {halfWidth, halfHeight};
  data.anchor = anchor ? *anchor : SpriteAnchor{0.0, 0.0};
  data.offsetMeters = offsetMeters;
  data.sinValue = sinR;
  data.cosValue = cosR;
  data.totalRotateDeg = rotation.degrees;
  data.depthBiasNdc = depthBiasNdc;
  data.centerDisplacement = centerDisplacement;
  data.baseLngLat = baseLngLat;
  data.displacedCenter = displacedCenter;
  data.scaleAdjustment = scaleAdjustment;
  data.corners = computeSurfaceCornerShaderModel(baseLngLat,
                                                 worldWidthMeters,
                                                 worldHeightMeters,
                                                 anchor,
                                                 sinR,
                                                 cosR,
                                                 offsetMeters);
  data.clipCornerCount = 0;
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

/**
 * @brief Resolves the on-screen center of an item, honoring anchors/origins.
 *
 * The function now consumes rotation cache data indirectly through the
 * `BucketItem`, so recomputing trigonometric values while walking origin chains
 * is unnecessary.
 */
static SpriteScreenPoint computeImageCenter(
    const BucketItem& bucketItem,
    bool useResolvedAnchor,
    const ProjectionContext& projection,
    const FrameConstants& frame,
    const ResourceInfo& resource,
    double effectivePixelsPerMeter,
    const std::vector<BucketItem>& bucketItems,
    bool clipContextAvailable) {
  SpriteScreenPoint fallbackCenter = bucketItem.projected;

  SpriteScreenPoint basePoint = bucketItem.projected;

  if (hasOriginLocation(*bucketItem.entry)) {
    const BucketItem* reference =
        resolveOriginBucketItem(bucketItem, bucketItems);
    if (reference && reference->resource) {
      const bool resolvedAnchor = toBool(bucketItem.entry->originUseResolvedAnchor);
      basePoint = computeImageCenter(*reference,
                                     resolvedAnchor,
                                     projection,
                                     frame,
                                     *reference->resource,
                                     effectivePixelsPerMeter,
                                     bucketItems,
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
  const double totalRotateDeg = bucketItem.rotation.degrees;

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

    SurfaceCenterParams params;
    params.baseLngLat = baseLngLat;
    params.imageWidth = resource.width;
    params.imageHeight = resource.height;
    params.baseMetersPerPixel = frame.baseMetersPerPixel;
    params.imageScale = imageScale;
    params.zoomScaleFactor = frame.zoomScaleFactor;
    params.totalRotateDeg = totalRotateDeg;
    params.sinNegativeRotation = bucketItem.rotation.sinNegativeRad;
    params.cosNegativeRotation = bucketItem.rotation.cosNegativeRad;
    params.anchor = &anchor;
    params.offset = &offset;
    params.effectivePixelsPerMeter = effectivePixelsPerMeter;
    params.spriteMinPixel = frame.spriteMinPixel;
    params.spriteMaxPixel = frame.spriteMaxPixel;
    params.projection = &projection;
    params.enableClipProjection = clipContextAvailable;
    params.enableScreenProjection = !clipContextAvailable;
    params.drawingBufferWidth = frame.drawingBufferWidth;
    params.drawingBufferHeight = frame.drawingBufferHeight;
    params.pixelRatio = frame.pixelRatio;
    params.resolveAnchorless = true;

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
                                         bucketItem.rotation,
                                         &anchor,
                                         &offset);
    anchorAppliedCenter = placement.center;
    anchorlessCenter = {placement.center.x + placement.anchorShift.x,
                        placement.center.y - placement.anchorShift.y};
  }

  return useResolvedAnchor ? anchorAppliedCenter : anchorlessCenter;
}

static void precomputeBucketCenters(std::vector<BucketItem>& bucketItems,
                                    const ProjectionContext& projection,
                                    const FrameConstants& frame,
                                    bool clipContextAvailable) {
  for (BucketItem& bucket : bucketItems) {
    if (bucket.entry == nullptr || bucket.resource == nullptr) {
      continue;
    }
    if (!bucket.projectedValid) {
      continue;
    }
    if (!ensureBucketEffectivePixelsPerMeter(bucket, projection, frame)) {
      continue;
    }

    const double effectivePixelsPerMeter = bucket.effectivePixelsPerMeter;
    SpriteScreenPoint resolvedCenter =
        computeImageCenter(bucket,
                           true,
                           projection,
                           frame,
                           *bucket.resource,
                           effectivePixelsPerMeter,
                           bucketItems,
                           clipContextAvailable);
    bucket.resolvedAnchorCenter = resolvedCenter;
    bucket.hasResolvedAnchorCenter = true;

    SpriteScreenPoint anchorlessCenter =
        computeImageCenter(bucket,
                           false,
                           projection,
                           frame,
                           *bucket.resource,
                           effectivePixelsPerMeter,
                           bucketItems,
                           clipContextAvailable);
    bucket.anchorlessCenter = anchorlessCenter;
    bucket.hasAnchorlessCenter = true;
  }
}

/**
 * @brief Lazily computes per-sprite meters/pixel and perspective ratio.
 *
 * Result is cached on the BucketItem so depth collection and draw prep share it.
 */
static inline bool ensureBucketEffectivePixelsPerMeter(
    BucketItem& bucketItem,
    const ProjectionContext& projectionContext,
    const FrameConstants& frame) {
  if (bucketItem.hasEffectivePixelsPerMeter &&
      bucketItem.effectivePixelsPerMeter > 0.0 &&
      std::isfinite(bucketItem.effectivePixelsPerMeter)) {
    return true;
  }

  const double metersPerPixelAtLat =
      calculateMetersPerPixelAtLatitude(frame.zoomExp2,
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
  if (!std::isfinite(effectivePixelsPerMeter) ||
      effectivePixelsPerMeter <= 0.0) {
    return false;
  }

  bucketItem.metersPerPixelAtLat = metersPerPixelAtLat;
  bucketItem.perspectiveRatio = perspectiveRatio;
  bucketItem.effectivePixelsPerMeter = effectivePixelsPerMeter;
  bucketItem.hasEffectivePixelsPerMeter = true;
  return true;
}

struct DepthWorkerContext {
  std::vector<BucketItem>* bucketItems = nullptr;
  const ProjectionContext* projectionContext = nullptr;
  const FrameConstants* frame = nullptr;
  bool enableSurfaceBias = false;
};

#if defined(__EMSCRIPTEN_PTHREADS__)
constexpr std::size_t DEPTH_PARALLEL_MIN_ITEMS = 512;
constexpr std::size_t DEPTH_PARALLEL_SLICE = 256;
#endif

static inline std::size_t determineDepthWorkerCount(std::size_t totalItems) {
#if defined(__EMSCRIPTEN_PTHREADS__)
  if (totalItems < DEPTH_PARALLEL_MIN_ITEMS) {
    return 1;
  }
  unsigned int hw = std::thread::hardware_concurrency();
  if (hw == 0u) {
    hw = 4u;
  }
  const std::size_t maxWorkers = static_cast<std::size_t>(hw);
  const std::size_t bySize =
      std::max<std::size_t>(1, totalItems / DEPTH_PARALLEL_SLICE);
  return clampToAvailableThreads(
      std::min<std::size_t>(maxWorkers, bySize));
#else
  (void)totalItems;
  return 1;
#endif
}

static void processDepthRange(const DepthWorkerContext& ctx,
                              std::size_t startIndex,
                              std::size_t endIndex,
                              std::vector<DepthItem>& outDepthItems) {
  outDepthItems.clear();
  if (ctx.bucketItems == nullptr || ctx.projectionContext == nullptr ||
      ctx.frame == nullptr) {
    return;
  }

  auto& bucketItems = *ctx.bucketItems;
  const ProjectionContext& projectionContext = *ctx.projectionContext;
  const FrameConstants& frame = *ctx.frame;

  if (startIndex >= bucketItems.size()) {
    return;
  }
  endIndex = std::min(endIndex, bucketItems.size());
  if (startIndex >= endIndex) {
    return;
  }

  outDepthItems.reserve(endIndex - startIndex);

  const auto* triangleIndices = TRIANGLE_INDICES.data();
  const int triangleIndexCount =
      static_cast<int>(TRIANGLE_INDICES.size());

  for (std::size_t idx = startIndex; idx < endIndex; ++idx) {
    BucketItem& bucketItem = bucketItems[idx];
    if (bucketItem.entry == nullptr || bucketItem.resource == nullptr) {
      continue;
    }
    if (!bucketItem.resource->textureReady) {
      continue;
    }
    if (!bucketItem.projectedValid) {
      continue;
    }

    if (!ensureBucketEffectivePixelsPerMeter(bucketItem,
                                             projectionContext,
                                             frame)) {
      continue;
    }

    const double effectivePixelsPerMeter = bucketItem.effectivePixelsPerMeter;

    SpriteScreenPoint depthCenter = bucketItem.projected;
    tryGetPrecomputedCenter(bucketItem, true, depthCenter);

    double depthKey = 0.0;
    const bool isSurface = std::lround(bucketItem.entry->mode) == 0;
    DepthItem depthEntry;
    depthEntry.item = &bucketItem;

    if (isSurface) {
      if (!projectionContext.mercatorMatrix) {
        continue;
      }

      const double imageScale = resolveImageScale(*bucketItem.entry);
      const SpriteAnchor anchor = resolveAnchor(*bucketItem.entry);
      const SpriteImageOffset offset = resolveOffset(*bucketItem.entry);

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
      const auto cornerDisplacements =
          calculateSurfaceCornerDisplacements(worldDims.width,
                                              worldDims.height,
                                              &anchor,
                                              bucketItem.rotation.sinNegativeRad,
                                              bucketItem.rotation.cosNegativeRad,
                                              offsetMeters);

      SpriteLocation baseLngLat = bucketItem.spriteLocation;
      if (hasOriginLocation(*bucketItem.entry)) {
        const BucketItem* reference =
            resolveOriginBucketItem(bucketItem, bucketItems);
        if (reference && reference->resource) {
          const bool useAnchorDisplacement =
              toBool(bucketItem.entry->originUseResolvedAnchor);
          SpriteScreenPoint originCenter = reference->projected;
          tryGetPrecomputedCenter(*reference, useAnchorDisplacement,
                                  originCenter);
          SpriteLocation reprojection{};
          if (unprojectSpritePoint(projectionContext,
                                   SpritePoint{originCenter.x, originCenter.y},
                                   reprojection)) {
            baseLngLat = reprojection;
          }
        }
      }

      const bool applyBias = ctx.enableSurfaceBias;
      const double clampedOrder =
          std::fmin(bucketItem.entry->order, frame.orderMax - 1.0);
      const double biasIndex = bucketItem.entry->subLayer * frame.orderBucket +
                               clampedOrder;
      const double depthBiasNdc = applyBias ? -(biasIndex * frame.epsNdc) : 0.0;

      std::array<double, SURFACE_CLIP_CORNER_COUNT * 2> displacementData{};
      for (std::size_t corner = 0; corner < SURFACE_CLIP_CORNER_COUNT;
           ++corner) {
        displacementData[corner * 2 + 0] = cornerDisplacements[corner].east;
        displacementData[corner * 2 + 1] = cornerDisplacements[corner].north;
      }

      const int displacementCount =
          static_cast<int>(SURFACE_CLIP_CORNER_COUNT);

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

      depthEntry.hasSurfaceData = true;
      depthEntry.surfaceWorldDimensions = worldDims;
      depthEntry.surfaceOffsetMeters = offsetMeters;
      depthEntry.surfaceCornerDisplacements = cornerDisplacements;
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

    depthEntry.depthKey = depthKey;
  outDepthItems.push_back(std::move(depthEntry));
  }
}

#if defined(__EMSCRIPTEN_PTHREADS__)
constexpr std::size_t PREPARE_PARALLEL_MIN_ITEMS = 256;
constexpr std::size_t PREPARE_PARALLEL_SLICE = 128;
#endif

static inline std::size_t determinePrepareWorkerCount(std::size_t totalItems) {
#if defined(__EMSCRIPTEN_PTHREADS__)
  if (totalItems < PREPARE_PARALLEL_MIN_ITEMS) {
    return 1;
  }
  unsigned int hw = std::thread::hardware_concurrency();
  if (hw == 0u) {
    hw = 4u;
  }
  const std::size_t maxWorkers = static_cast<std::size_t>(hw);
  const std::size_t bySize =
      std::max<std::size_t>(1, totalItems / PREPARE_PARALLEL_SLICE);
  return clampToAvailableThreads(
      std::min<std::size_t>(maxWorkers, bySize));
#else
  (void)totalItems;
  return 1;
#endif
}

static DepthCollectionResult collectDepthSortedItemsInternal(
    std::vector<BucketItem>& bucketItems,
    const ProjectionContext& projectionContext,
    const FrameConstants& frame,
    bool clipContextAvailable,
    bool enableSurfaceBias) {
  (void)clipContextAvailable;
  DepthCollectionResult result;
  std::vector<DepthItem> depthItems;
  depthItems.reserve(bucketItems.size());

  DepthWorkerContext ctx;
  ctx.bucketItems = &bucketItems;
  ctx.projectionContext = &projectionContext;
  ctx.frame = &frame;
  ctx.enableSurfaceBias = enableSurfaceBias;

  const std::size_t workerCount =
      determineDepthWorkerCount(bucketItems.size());

  if (workerCount <= 1) {
    processDepthRange(ctx, 0, bucketItems.size(), depthItems);
  } else {
#if defined(__EMSCRIPTEN_PTHREADS__)
    std::vector<std::vector<DepthItem>> workerOutputs(workerCount);
    std::vector<std::thread> workers;
    workers.reserve(workerCount);

    const std::size_t sliceSize =
        (bucketItems.size() + workerCount - 1) / workerCount;

    for (std::size_t workerIndex = 0; workerIndex < workerCount; ++workerIndex) {
      const std::size_t start = workerIndex * sliceSize;
      if (start >= bucketItems.size()) {
        break;
      }
      const std::size_t end = std::min(bucketItems.size(), start + sliceSize);
      workers.emplace_back(
          [ctx, start, end, &workerOutputs, workerIndex]() {
            processDepthRange(ctx, start, end, workerOutputs[workerIndex]);
          });
    }

    for (std::thread& worker : workers) {
      if (worker.joinable()) {
        worker.join();
      }
    }

    depthItems.clear();
    depthItems.reserve(bucketItems.size());
    for (auto& workerVector : workerOutputs) {
      for (DepthItem& item : workerVector) {
        depthItems.push_back(std::move(item));
      }
    }
#else
    processDepthRange(ctx, 0, bucketItems.size(), depthItems);
#endif
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
    const ProjectionContext& projectionContext,
    const FrameConstants& frame,
    bool clipContextAvailable,
    bool useShaderBillboardGeometry,
    bool useShaderSurfaceGeometry,
    const std::vector<BucketItem>& bucketItems,
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
  const double atlasU0 = resource.atlasU0;
  const double atlasV0 = resource.atlasV0;
  const double atlasU1 = resource.atlasU1;
  const double atlasV1 = resource.atlasV1;
  const double atlasUSpan = atlasU1 - atlasU0;
  const double atlasVSpan = atlasV1 - atlasV0;

  if (!bucketItem.projectedValid || resource.width <= 0.0 ||
      resource.height <= 0.0) {
    return false;
  }

  const bool isSurface = std::lround(entry.mode) == 0;
  const bool enableSurfaceBias = frame.enableNdcBiasSurface;

  if (!bucketItem.hasEffectivePixelsPerMeter ||
      !std::isfinite(bucketItem.effectivePixelsPerMeter) ||
      bucketItem.effectivePixelsPerMeter <= 0.0) {
    return false;
  }
  const double effectivePixelsPerMeter = bucketItem.effectivePixelsPerMeter;

  SpriteScreenPoint baseProjected = bucketItem.projected;
  if (hasOriginLocation(entry)) {
      const BucketItem* reference =
          resolveOriginBucketItem(bucketItem, bucketItems);
      if (reference && reference->resource) {
        const bool useAnchor = toBool(entry.originUseResolvedAnchor);
        SpriteScreenPoint originCenter = reference->projected;
        tryGetPrecomputedCenter(*reference, useAnchor, originCenter);
        baseProjected = originCenter;
      }
    }

  const SpriteAnchor anchor = resolveAnchor(entry);
  const SpriteImageOffset offset = resolveOffset(entry);
  const double imageScale = resolveImageScale(entry);
  const double totalRotateDeg = bucketItem.rotation.degrees;

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

    SurfaceCenterParams params{};
    params.baseLngLat = baseLngLat;
    params.imageWidth = resource.width;
    params.imageHeight = resource.height;
    params.baseMetersPerPixel = frame.baseMetersPerPixel;
    params.imageScale = imageScale;
    params.zoomScaleFactor = frame.zoomScaleFactor;
    params.totalRotateDeg = totalRotateDeg;
    params.sinNegativeRotation = bucketItem.rotation.sinNegativeRad;
    params.cosNegativeRotation = bucketItem.rotation.cosNegativeRad;
    params.anchor = &anchor;
    params.offset = &offset;
    params.effectivePixelsPerMeter = effectivePixelsPerMeter;
    params.spriteMinPixel = frame.spriteMinPixel;
    params.spriteMaxPixel = frame.spriteMaxPixel;
    params.projection = &projectionContext;
    params.enableClipProjection = true;
    params.enableScreenProjection = false;
    params.drawingBufferWidth = frame.drawingBufferWidth;
    params.drawingBufferHeight = frame.drawingBufferHeight;
    params.pixelRatio = frame.pixelRatio;
    params.resolveAnchorless = true;

    const SurfaceCenterResult surfaceCenter =
        calculateSurfaceCenterPosition(params);
    if (!surfaceCenter.center.has_value()) {
      return false;
    }

    if (!depth.hasSurfaceData) {
      return false;
    }
    const SurfaceWorldDimensions& cachedWorldDims =
        depth.surfaceWorldDimensions;
    const SurfaceCorner offsetMeters = depth.surfaceOffsetMeters;
    const auto& cornerDisplacements = depth.surfaceCornerDisplacements;

    const double orderIndex =
        std::fmin(entry.order, frame.orderMax - 1.0);
    const double biasIndex = entry.subLayer * frame.orderBucket + orderIndex;
    const double depthBiasNdc =
        enableSurfaceBias ? (-(biasIndex * frame.epsNdc)) : 0.0;

    const SpriteLocation displacedCenter = surfaceCenter.displacedLngLat;

    SurfaceShaderInputsData surfaceInputs = prepareSurfaceShaderInputs(
        projectionContext,
        baseLngLat,
        cachedWorldDims.width,
        cachedWorldDims.height,
        &anchor,
        bucketItem.rotation,
        offsetMeters,
        displacedCenter,
        depthBiasNdc,
        cachedWorldDims.scaleAdjustment,
        surfaceCenter.totalDisplacement);

    const bool useShaderSurface = useShaderSurfaceGeometry && clipContextAvailable;
    useShaderSurfaceValue = useShaderSurface ? 1.0 : 0.0;

    std::array<std::array<double, 4>, 4> clipCornerPositions{};
    std::array<bool, 4> clipCornerValid{false, false, false, false};

    std::array<double, 4> clipCenterPosition{};
    bool clipCenterValid = projectLngLatToClip(projectionContext,
                                               displacedCenter,
                                               clipCenterPosition);

    double* vertexWrite = vertexData.data();
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
        storeVec2At(hitTestData.data() + cornerIndex * 2,
                    screenCorner.x,
                    screenCorner.y);
      }

      if (useShaderSurface) {
        const auto& baseCorner = SURFACE_BASE_CORNERS[cornerIndex];
        storeVec4(vertexWrite, baseCorner[0], baseCorner[1], 0.0, 1.0);
      } else {
        storeVec4(vertexWrite, clipPosition);
      }
      const auto& uv = UV_CORNERS[cornerIndex];
      const double resolvedU = atlasU0 + uv[0] * atlasUSpan;
      const double resolvedV = atlasV0 + uv[1] * atlasVSpan;
      storeVec2(vertexWrite, resolvedU, resolvedV);
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
      surfaceInputs.clipCornerCount = clipCornerPositions.size();
      for (std::size_t i = 0; i < clipCornerPositions.size(); ++i) {
        surfaceInputs.clipCorners[i] = clipCornerPositions[i];
      }
      clipUniformEnabled = true;
    }

    surfaceClipEnabledValue = clipUniformEnabled ? 1.0 : 0.0;

    if (useShaderSurface) {
      double* surfaceWrite = surfaceBlock.data();
      storeVec2(surfaceWrite,
                surfaceInputs.mercatorCenter.x,
                surfaceInputs.mercatorCenter.y);
      storeScalar(surfaceWrite, surfaceInputs.mercatorCenter.z);
      storeVec2(surfaceWrite,
                surfaceInputs.worldToMercatorScale.east,
                surfaceInputs.worldToMercatorScale.north);
      storeVec2(surfaceWrite,
                surfaceInputs.halfSizeMeters.east,
                surfaceInputs.halfSizeMeters.north);
      storeVec2(surfaceWrite, surfaceInputs.anchor.x, surfaceInputs.anchor.y);
      storeVec2(surfaceWrite,
                surfaceInputs.offsetMeters.east,
                surfaceInputs.offsetMeters.north);
      storeVec2(surfaceWrite, surfaceInputs.sinValue, surfaceInputs.cosValue);
      storeVec2(surfaceWrite, surfaceInputs.totalRotateDeg, depthBiasNdc);
      storeVec2(surfaceWrite,
                surfaceInputs.centerDisplacement.east,
                surfaceInputs.centerDisplacement.north);
      storeVec4(surfaceWrite, surfaceInputs.clipCenter);
      storeVec4(surfaceWrite, surfaceInputs.clipBasisEast);
      storeVec4(surfaceWrite, surfaceInputs.clipBasisNorth);
      const std::array<double, 4> defaultCorner{0.0, 0.0, 0.0, 1.0};
      for (std::size_t i = 0; i < SURFACE_CLIP_CORNER_COUNT; ++i) {
        const std::array<double, 4>& corner =
            (i < surfaceInputs.clipCornerCount)
                ? surfaceInputs.clipCorners[i]
                : defaultCorner;
        storeVec4(surfaceWrite, corner);
      }
      storeVec2(surfaceWrite,
                surfaceInputs.baseLngLat.lng,
                surfaceInputs.baseLngLat.lat);
      storeScalar(surfaceWrite, surfaceInputs.baseLngLat.z);
      storeVec2(surfaceWrite,
                surfaceInputs.displacedCenter.lng,
                surfaceInputs.displacedCenter.lat);
      storeScalar(surfaceWrite, surfaceInputs.displacedCenter.z);
      storeScalar(surfaceWrite, surfaceInputs.scaleAdjustment);
      for (const auto& corner : surfaceInputs.corners) {
        storeVec4(surfaceWrite, corner.east, corner.north, corner.lng, corner.lat);
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
        bucketItem.rotation,
        &anchor,
        &offset);

    std::array<QuadCorner, 4> resolvedCorners =
        calculateBillboardCornerScreenPositions(placement.center,
                                                placement.halfWidth,
                                                placement.halfHeight,
                                                &anchor,
                                                bucketItem.rotation);

    const bool useShaderBillboard = useShaderBillboardGeometry;
    useShaderBillboardValue = useShaderBillboard ? 1.0 : 0.0;
    billboardCenterX = placement.center.x;
    billboardCenterY = placement.center.y;
    billboardHalfWidth = placement.halfWidth;
    billboardHalfHeight = placement.halfHeight;
    billboardAnchorX = anchor.x;
    billboardAnchorY = anchor.y;
    billboardSin = bucketItem.rotation.sinNegativeRad;
    billboardCos = bucketItem.rotation.cosNegativeRad;

    double* vertexWrite = vertexData.data();
    for (int idx : TRIANGLE_INDICES) {
      if (useShaderBillboard) {
        const auto& baseCorner = BILLBOARD_BASE_CORNERS[idx];
        storeVec4(vertexWrite, baseCorner[0], baseCorner[1], 0.0, 1.0);
      } else {
        storeVec4(vertexWrite,
                  resolvedCorners[idx].x,
                  resolvedCorners[idx].y,
                  0.0,
                  1.0);
      }
      const double resolvedU = atlasU0 + resolvedCorners[idx].u * atlasUSpan;
      const double resolvedV = atlasV0 + resolvedCorners[idx].v * atlasVSpan;
      storeVec2(vertexWrite, resolvedU, resolvedV);
    }

    double* hitTestWrite = hitTestData.data();
    for (const auto& corner : resolvedCorners) {
      storeVec2(hitTestWrite, corner.x, corner.y);
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

/**
 * @brief Generates the rotated displacement for each surface corner.
 */
static inline std::array<SurfaceCorner, SURFACE_CLIP_CORNER_COUNT>
    calculateSurfaceCornerDisplacements(
    double worldWidthMeters,
    double worldHeightMeters,
    const SpriteAnchor* anchor,
    double sinNegativeRotation,
    double cosNegativeRotation,
    const SurfaceCorner& offsetMeters) {
  std::array<SurfaceCorner, SURFACE_CLIP_CORNER_COUNT> corners{};
  if (worldWidthMeters <= 0.0 || worldHeightMeters <= 0.0) {
    corners.fill(offsetMeters);
    return corners;
  }

  const double halfWidth = worldWidthMeters / 2.0;
  const double halfHeight = worldHeightMeters / 2.0;
  const double anchorEast = (anchor ? anchor->x : 0.0) * halfWidth;
  const double anchorNorth = (anchor ? anchor->y : 0.0) * halfHeight;
  const double cosR = cosNegativeRotation;
  const double sinR = sinNegativeRotation;

#ifdef SIMD_ENABLED
  const v128_t widthVec = wasm_f64x2_splat(halfWidth);
  const v128_t heightVec = wasm_f64x2_splat(halfHeight);
  const v128_t anchorEastVec = wasm_f64x2_splat(anchorEast);
  const v128_t anchorNorthVec = wasm_f64x2_splat(anchorNorth);
  const v128_t cosVec = wasm_f64x2_splat(cosR);
  const v128_t sinVec = wasm_f64x2_splat(sinR);
  const v128_t offsetEastVec = wasm_f64x2_splat(offsetMeters.east);
  const v128_t offsetNorthVec = wasm_f64x2_splat(offsetMeters.north);

  for (std::size_t idx = 0; idx < SURFACE_CLIP_CORNER_COUNT; idx += 2) {
    v128_t east = wasm_f64x2_mul(wasm_v128_load(&SURFACE_BASE_EAST_SIMD[idx]),
                                 widthVec);
    v128_t north = wasm_f64x2_mul(wasm_v128_load(&SURFACE_BASE_NORTH_SIMD[idx]),
                                  heightVec);
    east = wasm_f64x2_sub(east, anchorEastVec);
    north = wasm_f64x2_sub(north, anchorNorthVec);

    const v128_t rotatedEast =
        wasm_f64x2_sub(wasm_f64x2_mul(east, cosVec),
                       wasm_f64x2_mul(north, sinVec));
    const v128_t rotatedNorth =
        wasm_f64x2_add(wasm_f64x2_mul(east, sinVec),
                       wasm_f64x2_mul(north, cosVec));

    alignas(16) double eastStore[2];
    alignas(16) double northStore[2];
    wasm_v128_store(eastStore,
                    wasm_f64x2_add(rotatedEast, offsetEastVec));
    wasm_v128_store(northStore,
                    wasm_f64x2_add(rotatedNorth, offsetNorthVec));
    for (std::size_t lane = 0; lane < 2; ++lane) {
      const std::size_t cornerIndex = idx + lane;
      corners[cornerIndex] = {eastStore[lane], northStore[lane]};
    }
  }
#else
  for (std::size_t idx = 0; idx < SURFACE_BASE_CORNERS.size(); ++idx) {
    const auto& baseCorner = SURFACE_BASE_CORNERS[idx];
    const double cornerEast = baseCorner[0] * halfWidth;
    const double cornerNorth = baseCorner[1] * halfHeight;
    const double localEast = cornerEast - anchorEast;
    const double localNorth = cornerNorth - anchorNorth;
    const double rotatedEast = localEast * cosR - localNorth * sinR;
    const double rotatedNorth = localEast * sinR + localNorth * cosR;
    corners[idx] = {rotatedEast + offsetMeters.east,
                    rotatedNorth + offsetMeters.north};
  }
#endif
  return corners;
}

/**
 * @brief Builds shader-friendly geodetic data for each rotated surface corner.
 */
static inline std::array<SurfaceShaderCornerModel, SURFACE_CLIP_CORNER_COUNT>
computeSurfaceCornerShaderModel(const SpriteLocation& baseLngLat,
                                double worldWidthMeters,
                                double worldHeightMeters,
                                const SpriteAnchor* anchor,
                                double sinNegativeRotation,
                                double cosNegativeRotation,
                                const SurfaceCorner& offsetMeters) {
  const double cosLat = std::cos(baseLngLat.lat * DEG2RAD);
  const double cosLatClamped = std::max(cosLat, MIN_COS_LAT);

  std::array<SurfaceShaderCornerModel, SURFACE_CLIP_CORNER_COUNT> corners{};

  const auto rotatedCorners = calculateSurfaceCornerDisplacements(
      worldWidthMeters,
      worldHeightMeters,
      anchor,
      sinNegativeRotation,
      cosNegativeRotation,
      offsetMeters);

  for (std::size_t idx = 0; idx < rotatedCorners.size(); ++idx) {
    const double east = rotatedCorners[idx].east;
    const double north = rotatedCorners[idx].north;
    const double deltaLat = (north / EARTH_RADIUS_METERS) * RAD2DEG;
    const double deltaLng =
        (east / (EARTH_RADIUS_METERS * cosLatClamped)) * RAD2DEG;

    corners[idx] = {east,
                    north,
                    baseLngLat.lng + deltaLng,
                    baseLngLat.lat + deltaLat};
  }

  return corners;
}

static inline SurfaceCenterResult calculateSurfaceCenterPosition(
    const SurfaceCenterParams& params) {
  const bool clipProjectionAvailable =
      params.enableClipProjection && params.projection &&
      params.drawingBufferWidth > 0.0 && params.drawingBufferHeight > 0.0 &&
      params.pixelRatio != 0.0 && std::isfinite(params.pixelRatio);
  const bool screenProjectionAvailable =
      params.enableScreenProjection && params.projection;

  auto projectPoint = [&](const SpriteLocation& lngLat,
                          SpriteScreenPoint& out) -> bool {
    if (clipProjectionAvailable) {
      std::array<double, 4> clip{};
      if (projectLngLatToClip(*params.projection, lngLat, clip) &&
          clipToScreen(clip,
                       params.drawingBufferWidth,
                       params.drawingBufferHeight,
                       params.pixelRatio,
                       out)) {
        return true;
      }
    }
    if (screenProjectionAvailable) {
      return projectSpritePoint(*params.projection, lngLat, out);
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
      halfWidthMeters,
      halfHeightMeters,
      params.anchor,
      params.sinNegativeRotation,
      params.cosNegativeRotation);
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
    const RotationCache& rotation,
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
                                          rotation);
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
    const RotationCache& rotation) {
  std::array<QuadCorner, 4> corners{};
  if (halfWidth <= 0.0 || halfHeight <= 0.0) {
    for (std::size_t i = 0; i < corners.size(); ++i) {
      corners[i] = {center.x, center.y, UV_CORNERS[i][0], UV_CORNERS[i][1]};
    }
    return corners;
  }

  const double anchorOffsetX = (anchor ? anchor->x : 0.0) * halfWidth;
  const double anchorOffsetY = (anchor ? anchor->y : 0.0) * halfHeight;
  const double cosR = rotation.cosNegativeRad;
  const double sinR = rotation.sinNegativeRad;

#ifdef SIMD_ENABLED
  const v128_t halfWidthVec = wasm_f64x2_splat(halfWidth);
  const v128_t halfHeightVec = wasm_f64x2_splat(halfHeight);
  const v128_t anchorXVec = wasm_f64x2_splat(anchorOffsetX);
  const v128_t anchorYVec = wasm_f64x2_splat(anchorOffsetY);
  const v128_t cosVec = wasm_f64x2_splat(cosR);
  const v128_t sinVec = wasm_f64x2_splat(sinR);
  const v128_t centerXVec = wasm_f64x2_splat(center.x);
  const v128_t centerYVec = wasm_f64x2_splat(center.y);

  for (std::size_t idx = 0; idx < BILLBOARD_BASE_CORNERS.size(); idx += 2) {
    v128_t cornerX = wasm_f64x2_mul(wasm_v128_load(&BILLBOARD_BASE_X_SIMD[idx]),
                                    halfWidthVec);
    v128_t cornerY = wasm_f64x2_mul(wasm_v128_load(&BILLBOARD_BASE_Y_SIMD[idx]),
                                    halfHeightVec);
    cornerX = wasm_f64x2_sub(cornerX, anchorXVec);
    cornerY = wasm_f64x2_sub(cornerY, anchorYVec);

    const v128_t rotatedX =
        wasm_f64x2_sub(wasm_f64x2_mul(cornerX, cosVec),
                       wasm_f64x2_mul(cornerY, sinVec));
    const v128_t rotatedY =
        wasm_f64x2_add(wasm_f64x2_mul(cornerX, sinVec),
                       wasm_f64x2_mul(cornerY, cosVec));

    alignas(16) double xStore[2];
    alignas(16) double yStore[2];
    wasm_v128_store(xStore, wasm_f64x2_add(centerXVec, rotatedX));
    wasm_v128_store(yStore, wasm_f64x2_sub(centerYVec, rotatedY));

    for (std::size_t lane = 0; lane < 2; ++lane) {
      const std::size_t cornerIndex = idx + lane;
      corners[cornerIndex] = {xStore[lane],
                              yStore[lane],
                              UV_CORNERS[cornerIndex][0],
                              UV_CORNERS[cornerIndex][1]};
    }
  }
#else
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
#endif

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
    info.atlasPageIndex = entry.atlasPageIndex;
    info.atlasU0 = entry.atlasU0;
    info.atlasV0 = entry.atlasV0;
    info.atlasU1 = entry.atlasU1;
    info.atlasV1 = entry.atlasV1;
    if (!std::isfinite(info.atlasU0)) {
      info.atlasU0 = 0.0;
    }
    if (!std::isfinite(info.atlasV0)) {
      info.atlasV0 = 0.0;
    }
    if (!std::isfinite(info.atlasU1)) {
      info.atlasU1 = 1.0;
    }
    if (!std::isfinite(info.atlasV1)) {
      info.atlasV1 = 1.0;
    }
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
    const double resolvedRotate = resolveTotalRotateDeg(*bucket.entry);
    bucket.rotation = buildRotationCache(resolvedRotate);
    bucketItems[i] = bucket;
  }

  precomputeBucketCenters(bucketItems,
                          projectionContext,
                          frame,
                          clipContextAvailable);

  DepthCollectionResult depthResult = collectDepthSortedItemsInternal(
      bucketItems,
      projectionContext,
      frame,
      clipContextAvailable,
      enableSurfaceBias);

  const std::size_t depthCount = depthResult.items.size();
  std::vector<double> stagedResults(depthCount * RESULT_ITEM_STRIDE, 0.0);
  std::vector<uint8_t> preparedFlags(depthCount, 0);
  std::vector<uint8_t> hitTestFlags(depthCount, 0);
  std::vector<uint8_t> surfaceFlags(depthCount, 0);

  auto prepareRange = [&](std::size_t start, std::size_t end) {
    if (start >= depthCount) {
      return;
    }
    end = std::min(end, depthCount);
    double* stagedBase = stagedResults.data();
    for (std::size_t idx = start; idx < end; ++idx) {
      const DepthItem& depth = depthResult.items[idx];
      double* itemBase = stagedBase + idx * RESULT_ITEM_STRIDE;
      bool itemHasHitTest = false;
      bool itemHasSurfaceInputs = false;
      if (prepareDrawSpriteImageInternal(depth,
                                         projectionContext,
                                         frame,
                                         clipContextAvailable,
                                         useShaderBillboardGeometry,
                                         useShaderSurfaceGeometry,
                                         bucketItems,
                                         itemBase,
                                         itemHasHitTest,
                                         itemHasSurfaceInputs)) {
        preparedFlags[idx] = 1;
        if (itemHasHitTest) {
          hitTestFlags[idx] = 1;
        }
        if (itemHasSurfaceInputs) {
          surfaceFlags[idx] = 1;
        }
      }
    }
  };

  const std::size_t prepareWorkerCount =
      determinePrepareWorkerCount(depthCount);
  if (prepareWorkerCount <= 1 || depthCount == 0) {
    prepareRange(0, depthCount);
  } else {
#if defined(__EMSCRIPTEN_PTHREADS__)
    std::vector<std::thread> workers;
    workers.reserve(prepareWorkerCount);
    const std::size_t sliceSize =
        (depthCount + prepareWorkerCount - 1) / prepareWorkerCount;
    for (std::size_t workerIndex = 0; workerIndex < prepareWorkerCount;
         ++workerIndex) {
      const std::size_t start = workerIndex * sliceSize;
      if (start >= depthCount) {
        break;
      }
      const std::size_t end = std::min(depthCount, start + sliceSize);
      workers.emplace_back([&, start, end]() { prepareRange(start, end); });
    }
    for (std::thread& worker : workers) {
      if (worker.joinable()) {
        worker.join();
      }
    }
#else
    prepareRange(0, depthCount);
#endif
  }

  double* writePtr = resultPtr + RESULT_HEADER_LENGTH;
  std::size_t preparedCount = 0;
  bool hasHitTest = false;
  bool hasSurfaceInputs = false;

  for (std::size_t idx = 0; idx < depthCount; ++idx) {
    if (preparedCount >= itemCount) {
      break;
    }
    if (preparedFlags[idx] == 0) {
      continue;
    }
    double* stagedBase = stagedResults.data() + idx * RESULT_ITEM_STRIDE;
    double* dest = writePtr + preparedCount * RESULT_ITEM_STRIDE;
    std::memcpy(dest,
                stagedBase,
                sizeof(double) * RESULT_ITEM_STRIDE);
    preparedCount += 1;
    hasHitTest = hasHitTest || (hitTestFlags[idx] != 0);
    hasSurfaceInputs = hasSurfaceInputs || (surfaceFlags[idx] != 0);
  }

  resultHeader->preparedCount = static_cast<double>(preparedCount);
  resultHeader->flags = (hasHitTest ? RESULT_FLAG_HAS_HIT_TEST : 0) |
                        (hasSurfaceInputs ? RESULT_FLAG_HAS_SURFACE_INPUTS
                                          : 0);

  return true;
}

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
    readCursor += DISTANCE_INTERPOLATION_ITEM_LENGTH;

    const double timestamp = resolveTimestamp(timestampRaw);
    const double effectiveStart =
        resolveEffectiveStart(startTimestamp, timestamp);

    double resultValue = finalValue;
    bool completed = true;
    if (duration > 0.0 && std::fabs(to - from) > DISTANCE_EPSILON) {
      const double elapsed = timestamp - effectiveStart;
      const double rawProgress = duration <= 0.0 ? 1.0 : elapsed / duration;
      const double eased = applyEasingPreset(rawProgress, easingPresetId);
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
    readCursor += DEGREE_INTERPOLATION_ITEM_LENGTH;

    const double timestamp = resolveTimestamp(timestampRaw);
    const double effectiveStart =
        resolveEffectiveStart(startTimestamp, timestamp);

    double resultValue = finalValue;
    bool completed = true;
    if (duration > 0.0 && std::fabs(to - from) > DEGREE_EPSILON) {
      const double elapsed = timestamp - effectiveStart;
      const double rawProgress = duration <= 0.0 ? 1.0 : elapsed / duration;
      const double eased = applyEasingPreset(rawProgress, easingPresetId);
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
      const double eased = applyEasingPreset(rawProgress, easingPresetId);
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
