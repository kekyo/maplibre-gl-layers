// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  SpriteAnchor,
  SpriteLocation,
  SpritePoint,
  SpriteScalingOptions,
  SpriteScreenPoint,
} from '../types';
import type {
  InternalSpriteCurrentState,
  MatrixInput,
  ProjectionHost,
  SpriteMercatorCoordinate,
} from '../internalTypes';
import {
  DEG2RAD,
  DEFAULT_IMAGE_OFFSET,
  EARTH_RADIUS_METERS,
  RAD2DEG,
  TILE_SIZE,
  TRIANGLE_INDICES,
  UV_CORNERS,
} from '../const';
import { UNLIMITED_SPRITE_SCALING_OPTIONS } from '../default';

export type OffsetInput =
  | { offsetMeters?: number; offsetDeg?: number }
  | undefined;

const resolveOffsetInput = (offset: OffsetInput) => ({
  offsetMeters: offset?.offsetMeters ?? DEFAULT_IMAGE_OFFSET.offsetMeters,
  offsetDeg: offset?.offsetDeg ?? DEFAULT_IMAGE_OFFSET.offsetDeg,
});

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Produces a deep copy so later updates do not mutate the original object.
 */
export const cloneSpriteLocation = (
  location: SpriteLocation
): SpriteLocation => {
  if (location.z === undefined) {
    return { lng: location.lng, lat: location.lat };
  }
  return { lng: location.lng, lat: location.lat, z: location.z };
};

/**
 * Linearly interpolates longitude, latitude, and optionally altitude.
 * The `ratio` may fall outside [0, 1]; callers are responsible for clamping if needed.
 */
export const lerpSpriteLocation = (
  from: SpriteLocation,
  to: SpriteLocation,
  ratio: number
): SpriteLocation => {
  const zFrom = from.z ?? 0;
  const zTo = to.z ?? 0;
  const hasZ = from.z !== undefined || to.z !== undefined;

  const result: SpriteLocation = {
    lng: from.lng + (to.lng - from.lng) * ratio,
    lat: from.lat + (to.lat - from.lat) * ratio,
  };

  if (hasZ) {
    result.z = zFrom + (zTo - zFrom) * ratio;
  }

  return result;
};

/**
 * Compares two locations. Treats altitude as equal when either side is undefined.
 */
export const spriteLocationsEqual = (
  a: SpriteLocation,
  b: SpriteLocation
): boolean => {
  const zA = a.z ?? null;
  const zB = b.z ?? null;
  return a.lng === b.lng && a.lat === b.lat && zA === zB;
};

const toCartesianMeters = (
  location: Readonly<SpriteLocation>
): { x: number; y: number; z: number } => {
  const latitude = location.lat;
  const longitude = location.lng;
  const altitude = location.z ?? 0;
  const latRad = latitude * DEG2RAD;
  const lonRad = longitude * DEG2RAD;
  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);
  const cosLon = Math.cos(lonRad);
  const sinLon = Math.sin(lonRad);
  const radius = EARTH_RADIUS_METERS + altitude;
  return {
    x: radius * cosLat * cosLon,
    y: radius * cosLat * sinLon,
    z: radius * sinLat,
  };
};

export const calculateCartesianDistanceMeters = (
  a: Readonly<SpriteLocation>,
  b: Readonly<SpriteLocation>
): number => {
  const cartA = toCartesianMeters(a);
  const cartB = toCartesianMeters(b);
  const dx = cartA.x - cartB.x;
  const dy = cartA.y - cartB.y;
  const dz = cartA.z - cartB.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/**
 * Normalizes an angle in degrees to the [0, 360) range.
 */
export const normalizeAngleDeg = (angle: number): number => {
  if (!Number.isFinite(angle)) {
    return 0;
  }
  const wrapped = angle % 360;
  const normalized = wrapped < 0 ? wrapped + 360 : wrapped;
  return Object.is(normalized, -0) ? 0 : normalized;
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Multiplies a 4x4 matrix with a 4-component vector using row-major indexing.
 * @param {MatrixInput} matrix - Matrix to multiply.
 * @param {number} x - X component of the vector.
 * @param {number} y - Y component of the vector.
 * @param {number} z - Z component of the vector.
 * @param {number} w - W component of the vector.
 * @returns {[number, number, number, number]} Resulting homogeneous coordinate.
 */
export const multiplyMatrixAndVector = (
  matrix: MatrixInput,
  x: number,
  y: number,
  z: number,
  w: number
): [number, number, number, number] => {
  const m0 = matrix[0] ?? 0;
  const m1 = matrix[1] ?? 0;
  const m2 = matrix[2] ?? 0;
  const m3 = matrix[3] ?? 0;
  const m4 = matrix[4] ?? 0;
  const m5 = matrix[5] ?? 0;
  const m6 = matrix[6] ?? 0;
  const m7 = matrix[7] ?? 0;
  const m8 = matrix[8] ?? 0;
  const m9 = matrix[9] ?? 0;
  const m10 = matrix[10] ?? 0;
  const m11 = matrix[11] ?? 0;
  const m12 = matrix[12] ?? 0;
  const m13 = matrix[13] ?? 0;
  const m14 = matrix[14] ?? 0;
  const m15 = matrix[15] ?? 0;
  return [
    m0 * x + m4 * y + m8 * z + m12 * w,
    m1 * x + m5 * y + m9 * z + m13 * w,
    m2 * x + m6 * y + m10 * z + m14 * w,
    m3 * x + m7 * y + m11 * z + m15 * w,
  ];
};

/**
 * Structure holding resolved sprite scaling options.
 */
export interface ResolvedSpriteScalingOptions {
  /** Effective number of meters represented by each rendered pixel. */
  metersPerPixel: number;
  /** Distance at or below which sprites stop growing further. */
  minScaleDistanceMeters: number;
  /** Distance at or above which sprites stop shrinking further. */
  maxScaleDistanceMeters: number;
}

/**
 * Fills missing {@link SpriteScalingOptions} values with defaults so downstream math can assume a complete object.
 * @param options Optional scaling configuration from the caller.
 * @returns {ResolvedSpriteScalingOptions} Resolved scaling settings covering every field.
 */
export const resolveScalingOptions = (
  options?: SpriteScalingOptions
): ResolvedSpriteScalingOptions => {
  const base = UNLIMITED_SPRITE_SCALING_OPTIONS;
  const warnings: string[] = [];

  const fallbackMetersPerPixel =
    Number.isFinite(base.metersPerPixel) && (base.metersPerPixel ?? 0) > 0
      ? base.metersPerPixel!
      : 1;
  let metersPerPixel =
    options?.metersPerPixel !== undefined
      ? options.metersPerPixel
      : fallbackMetersPerPixel;
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) {
    if (options?.metersPerPixel !== undefined) {
      warnings.push(
        `metersPerPixel(${String(options.metersPerPixel)}) is invalid; using ${fallbackMetersPerPixel}`
      );
    }
    metersPerPixel = fallbackMetersPerPixel;
  }

  const fallbackMinDistance =
    base.minScaleDistanceMeters !== undefined &&
    Number.isFinite(base.minScaleDistanceMeters) &&
    base.minScaleDistanceMeters! > 0
      ? base.minScaleDistanceMeters!
      : 0;
  let minScaleDistanceMeters =
    options?.minScaleDistanceMeters !== undefined
      ? options.minScaleDistanceMeters
      : fallbackMinDistance;
  if (!Number.isFinite(minScaleDistanceMeters) || minScaleDistanceMeters < 0) {
    if (options?.minScaleDistanceMeters !== undefined) {
      warnings.push(
        `minScaleDistanceMeters(${String(
          options.minScaleDistanceMeters
        )}) is invalid; using ${fallbackMinDistance}`
      );
    }
    minScaleDistanceMeters = fallbackMinDistance;
  }

  const baseMaxDistance =
    base.maxScaleDistanceMeters !== undefined &&
    base.maxScaleDistanceMeters! > 0
      ? base.maxScaleDistanceMeters!
      : Number.POSITIVE_INFINITY;
  const fallbackMaxDistance = Number.isFinite(baseMaxDistance)
    ? baseMaxDistance
    : Number.POSITIVE_INFINITY;
  let maxScaleDistanceMeters =
    options?.maxScaleDistanceMeters !== undefined
      ? options.maxScaleDistanceMeters
      : fallbackMaxDistance;
  const maxIsInfinite =
    maxScaleDistanceMeters === Number.POSITIVE_INFINITY &&
    options?.maxScaleDistanceMeters !== 0;
  if (!Number.isFinite(maxScaleDistanceMeters) && !maxIsInfinite) {
    if (options?.maxScaleDistanceMeters !== undefined) {
      warnings.push(
        `maxScaleDistanceMeters(${String(
          options.maxScaleDistanceMeters
        )}) is not finite; using ${fallbackMaxDistance}`
      );
    }
    maxScaleDistanceMeters = fallbackMaxDistance;
  } else if (
    Number.isFinite(maxScaleDistanceMeters) &&
    maxScaleDistanceMeters <= 0
  ) {
    warnings.push(
      `maxScaleDistanceMeters(${maxScaleDistanceMeters}) is non-positive; treated as unlimited`
    );
    maxScaleDistanceMeters = fallbackMaxDistance;
  }

  if (
    Number.isFinite(maxScaleDistanceMeters) &&
    maxScaleDistanceMeters < minScaleDistanceMeters
  ) {
    warnings.push(
      `maxScaleDistanceMeters(${maxScaleDistanceMeters}) < minScaleDistanceMeters(${minScaleDistanceMeters}); swapped values to maintain ascending order`
    );
    [minScaleDistanceMeters, maxScaleDistanceMeters] = [
      maxScaleDistanceMeters,
      minScaleDistanceMeters,
    ];
  }

  if (warnings.length > 0 && typeof console !== 'undefined') {
    const warn = console.warn ?? null;
    if (typeof warn === 'function') {
      warn(`[SpriteScalingOptions] ${warnings.join('; ')}`);
    }
  }

  return {
    metersPerPixel,
    minScaleDistanceMeters,
    maxScaleDistanceMeters,
  };
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Computes a scale factor based on camera-to-sprite distance.
 * @param {number} distanceMeters - Calculated distance from camera to sprite.
 * @param {ResolvedSpriteScalingOptions} scaling - Resolved scaling options.
 * @returns {number} Scale multiplier that clamps near/far distances to maintain consistent sizing.
 */
export const calculateDistanceScaleFactor = (
  distanceMeters: number,
  scaling: ResolvedSpriteScalingOptions
): number => {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return 1;
  }
  const minDistance = Math.max(0, scaling.minScaleDistanceMeters);
  const hasMax =
    Number.isFinite(scaling.maxScaleDistanceMeters) &&
    scaling.maxScaleDistanceMeters > 0;
  let clamped = distanceMeters;
  if (minDistance > 0 && distanceMeters < minDistance) {
    clamped = minDistance;
  } else if (hasMax && distanceMeters > scaling.maxScaleDistanceMeters) {
    clamped = scaling.maxScaleDistanceMeters;
  }
  if (clamped === distanceMeters || clamped === 0) {
    return 1;
  }
  return distanceMeters / clamped;
};

/**
 * Calculates meters per pixel at the given latitude.
 * Uses Web Mercator scale and applies the latitude-based cosine correction.
 * @param {number} zoom - Map zoom level used to determine the Mercator scale.
 * @param {number} latitude - Latitude in degrees where the meters-per-pixel value is resolved.
 * @returns {number} Distance in meters represented by a single pixel at the provided latitude.
 */
export const calculateMetersPerPixelAtLatitude = (
  zoom: number,
  latitude: number
): number => {
  const cosLatitude = Math.cos(latitude * DEG2RAD);
  const scale = Math.pow(2, zoom);
  const circumference = 2 * Math.PI * EARTH_RADIUS_METERS;
  return (cosLatitude * circumference) / (TILE_SIZE * scale);
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Checks whether a value is finite and not `NaN`.
 * @param {number} value - Value to validate.
 * @returns {boolean} `true` when the number is both finite and not `NaN`.
 */
export const isFiniteNumber = (value: number): boolean =>
  Number.isFinite(value) && !Number.isNaN(value);

/**
 * Ensures a number is finite, falling back to `0` when invalid.
 * @param {number} value - Value to sanitize.
 * @returns {number} Either the original finite value or the neutral fallback `0`.
 */
const ensureFinite = (value: number): number =>
  // Normalize infinite/NaN inputs so downstream multiplication results stay bounded.
  Number.isFinite(value) ? value : 0;

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Calculates the distance and bearing between two points in meters.
 * @param {SpriteLocation} from - Starting point expressed in longitude/latitude (degrees) and optional altitude.
 * @param {SpriteLocation} to - Destination point expressed in longitude/latitude (degrees) and optional altitude.
 * @returns {{ distanceMeters: number; bearingDeg: number }} Distance in meters and bearing clockwise from north.
 */
export const calculateDistanceAndBearingMeters = (
  from: SpriteLocation,
  to: SpriteLocation
): { distanceMeters: number; bearingDeg: number } => {
  const lat1Rad = from.lat * DEG2RAD;
  const lat2Rad = to.lat * DEG2RAD;
  const lng1Rad = from.lng * DEG2RAD;
  const lng2Rad = to.lng * DEG2RAD;

  const deltaLat = lat2Rad - lat1Rad;
  const deltaLng = lng2Rad - lng1Rad;

  const sinHalfLat = Math.sin(deltaLat / 2);
  const sinHalfLng = Math.sin(deltaLng / 2);
  const haversine =
    sinHalfLat * sinHalfLat +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinHalfLng * sinHalfLng;
  const clamped = Math.min(1, Math.max(0, haversine));
  const angularDistance =
    2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(Math.max(0, 1 - clamped)));
  const distanceMeters = EARTH_RADIUS_METERS * angularDistance;

  // Bail out when the computed distance is invalid or degenerate to avoid noisy bearings.
  if (!isFiniteNumber(distanceMeters) || distanceMeters <= 0) {
    return { distanceMeters: 0, bearingDeg: 0 };
  }

  const y = Math.sin(deltaLng) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(deltaLng);
  let bearingRad = Math.atan2(y, x);
  // Guard: when inputs align, atan2 can return NaN; normalize to zero.
  if (!Number.isFinite(bearingRad)) {
    bearingRad = 0;
  }
  let bearingDeg = bearingRad * RAD2DEG;
  // If the conversion produces an invalid number, reset the bearing so callers do not consume garbage.
  if (!isFiniteNumber(bearingDeg)) {
    bearingDeg = 0;
  } else {
    // Normalize to [0, 360) because MapLibre expects clockwise degrees from north.
    bearingDeg = (bearingDeg + 360) % 360;
  }

  return { distanceMeters, bearingDeg };
};

/**
 * Calculates billboard image dimensions in pixels.
 * @param {number | undefined} imageWidth - Source bitmap width in pixels.
 * @param {number | undefined} imageHeight - Source bitmap height in pixels.
 * @param {number} baseMetersPerPixel - Base scale derived from map zoom and latitude.
 * @param {number} imageScale - User-provided scale multiplier.
 * @param {number} distanceScaleFactor - Distance-dependent scale multiplier.
 * @param {number} effectivePixelsPerMeter - Conversion between world meters and screen pixels.
 * @returns {{ width: number; height: number; scaleAdjustment: number }} Pixel dimensions alongside the scale factor (always 1 without clamping).
 */
export const calculateBillboardPixelDimensions = (
  imageWidth: number | undefined,
  imageHeight: number | undefined,
  baseMetersPerPixel: number,
  imageScale: number,
  distanceScaleFactor: number,
  effectivePixelsPerMeter: number
): { width: number; height: number; scaleAdjustment: number } => {
  // Reject invalid inputs so the renderer can skip drawing without crashing downstream matrices.
  if (
    !imageWidth ||
    !imageHeight ||
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    baseMetersPerPixel <= 0 ||
    effectivePixelsPerMeter <= 0
  ) {
    return { width: 0, height: 0, scaleAdjustment: 1 };
  }
  const scaleFactor =
    baseMetersPerPixel *
    imageScale *
    distanceScaleFactor *
    effectivePixelsPerMeter;
  const width = ensureFinite(imageWidth * scaleFactor);
  const height = ensureFinite(imageHeight * scaleFactor);
  return { width, height, scaleAdjustment: 1 };
};

/**
 * Computes the billboard offset in screen-space pixels.
 * @param {OffsetInput} offset - Offset configuration describing length (meters) and heading (degrees).
 * @param {number} imageScale - User-provided scale multiplier applied to the offset distance.
 * @param {number} distanceScaleFactor - Distance-dependent scale multiplier.
 * @param {number} effectivePixelsPerMeter - Conversion factor from meters to pixels.
 * @param {number} [sizeScaleAdjustment=1] - Additional scale factor applied when sprite size is clamped.
 * @returns {SpriteScreenPoint} Screen-space offset relative to the billboard center.
 */
export const calculateBillboardOffsetPixels = (
  offset: OffsetInput,
  imageScale: number,
  distanceScaleFactor: number,
  effectivePixelsPerMeter: number,
  sizeScaleAdjustment = 1
): SpriteScreenPoint => {
  const resolved = resolveOffsetInput(offset);
  const offsetMeters = resolved.offsetMeters * imageScale * distanceScaleFactor;
  const offsetPixels =
    offsetMeters * effectivePixelsPerMeter * sizeScaleAdjustment;
  const offsetRad = resolved.offsetDeg * DEG2RAD;
  return {
    x: offsetPixels * Math.sin(offsetRad),
    y: offsetPixels * Math.cos(offsetRad),
  };
};

/**
 * Computes the screen-space shift caused by anchor rotation for billboards.
 * @param {number} halfWidth - Half of the sprite width in pixels.
 * @param {number} halfHeight - Half of the sprite height in pixels.
 * @param {SpriteAnchor | undefined} anchor - Anchor definition normalized to [-1, 1] range.
 * @param {number} totalRotateDeg - Rotation applied to the sprite, combining user and bearing rotations.
 * @returns {SpritePoint} Pixel delta required to bring the anchor back to the requested origin.
 */
export const calculateBillboardAnchorShiftPixels = (
  halfWidth: number,
  halfHeight: number,
  anchor: SpriteAnchor | undefined,
  totalRotateDeg: number
): SpritePoint => {
  // If we have no spatial extent, rotation/anchor math loses meaning, so skip adjustments.
  if (halfWidth <= 0 || halfHeight <= 0) {
    return { x: 0, y: 0 };
  }
  const anchorX = (anchor?.x ?? 0) * halfWidth;
  const anchorY = (anchor?.y ?? 0) * halfHeight;
  // When anchor sits at the geometric center, no compensating shift is needed.
  if (anchorX === 0 && anchorY === 0) {
    return { x: 0, y: 0 };
  }
  const rad = -totalRotateDeg * DEG2RAD;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const shiftX = -anchorX * cosR + anchorY * sinR;
  const shiftY = -anchorX * sinR - anchorY * cosR;
  return { x: shiftX, y: shiftY };
};

/**
 * Calculates surface image dimensions in world meters.
 * @param {number | undefined} imageWidth - Source bitmap width in pixels.
 * @param {number | undefined} imageHeight - Source bitmap height in pixels.
 * @param {number} baseMetersPerPixel - World meters represented by a pixel at the current zoom.
 * @param {number} imageScale - User-provided scale multiplier.
 * @param {number} distanceScaleFactor - Distance-dependent scale multiplier.
 * @returns {{ width: number; height: number; scaleAdjustment: number }} World dimensions in meters and the applied clamp scale factor (always 1 without clamping).
 */
export const calculateSurfaceWorldDimensions = (
  imageWidth: number | undefined,
  imageHeight: number | undefined,
  baseMetersPerPixel: number,
  imageScale: number,
  distanceScaleFactor: number
): { width: number; height: number; scaleAdjustment: number } => {
  // Reject invalid inputs to keep downstream displacement math finite.
  if (
    !imageWidth ||
    !imageHeight ||
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    baseMetersPerPixel <= 0
  ) {
    return { width: 0, height: 0, scaleAdjustment: 1 };
  }
  const scaleFactor = baseMetersPerPixel * imageScale * distanceScaleFactor;
  const width = ensureFinite(imageWidth * scaleFactor);
  const height = ensureFinite(imageHeight * scaleFactor);
  return { width, height, scaleAdjustment: 1 };
};

/**
 * Computes east/north shifts from anchor rotation on surface images.
 * @param {number} halfWidthMeters - Half of the world-space width.
 * @param {number} halfHeightMeters - Half of the world-space height.
 * @param {SpriteAnchor | undefined} anchor - Anchor definition normalized to [-1, 1] range.
 * @param {number} totalRotateDeg - Rotation angle applied to the surface.
 * @returns {SurfaceCorner} Displacement in meters required to apply the anchor.
 */
export const calculateSurfaceAnchorShiftMeters = (
  halfWidthMeters: number,
  halfHeightMeters: number,
  anchor: SpriteAnchor | undefined,
  totalRotateDeg: number
): SurfaceCorner => {
  // Degenerate dimensions mean the quad collapses; skip anchor adjustments.
  if (halfWidthMeters <= 0 || halfHeightMeters <= 0) {
    return { east: 0, north: 0 };
  }
  const anchorEast = (anchor?.x ?? 0) * halfWidthMeters;
  const anchorNorth = (anchor?.y ?? 0) * halfHeightMeters;
  // An anchor exactly at center produces no additional displacement.
  if (anchorEast === 0 && anchorNorth === 0) {
    return { east: 0, north: 0 };
  }
  const rad = -totalRotateDeg * DEG2RAD;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const east = -anchorEast * cosR + anchorNorth * sinR;
  const north = -anchorEast * sinR - anchorNorth * cosR;
  return { east, north };
};

/**
 * Calculates surface image offsets in meters.
 * @param {OffsetInput} offset - Offset configuration for the surface sprite.
 * @param {number} imageScale - User-provided scale multiplier applied to the offset distance.
 * @param {number} distanceScaleFactor - Distance-dependent scale multiplier.
 * @param {number} [sizeScaleAdjustment=1] - Additional scale factor applied when sprite size is clamped.
 * @returns {SurfaceCorner} Offset vector in meters.
 */
export const calculateSurfaceOffsetMeters = (
  offset: OffsetInput,
  imageScale: number,
  distanceScaleFactor: number,
  sizeScaleAdjustment = 1
): SurfaceCorner => {
  const resolved = resolveOffsetInput(offset);
  const offsetMeters = resolved.offsetMeters * imageScale * distanceScaleFactor;
  // Short-circuit when no displacement is requested to avoid redundant trig.
  if (offsetMeters === 0) {
    return { east: 0, north: 0 };
  }
  const rad = resolved.offsetDeg * DEG2RAD;
  return {
    east: offsetMeters * Math.sin(rad) * sizeScaleAdjustment,
    north: offsetMeters * Math.cos(rad) * sizeScaleAdjustment,
  };
};

/**
 * Lower bound used to avoid dividing by zero when cosine of latitude approaches zero at the poles.
 * @constant
 */
const MIN_COS_LAT = 1e-6;

/**
 * Adds east/north distances (meters) to a longitude/latitude pair.
 * @param {number} location - Base location in degrees.
 * @param {number} east - Eastward displacement in meters.
 * @param {number} north - Northward displacement in meters.
 * @returns {SpriteLocation} New geographic position after applying the displacement.
 */
export const applySurfaceDisplacement = (
  location: SpriteLocation,
  corner: SurfaceCorner
): SpriteLocation => {
  const deltaLat = (corner.north / EARTH_RADIUS_METERS) * RAD2DEG;
  const cosLat = Math.cos(location.lat * DEG2RAD);
  const deltaLng =
    (corner.east / (EARTH_RADIUS_METERS * Math.max(cosLat, MIN_COS_LAT))) *
    RAD2DEG;
  return {
    lng: location.lng + deltaLng,
    lat: location.lat + deltaLat,
    z: location.z,
  };
};

/**
 * Converts screen coordinates to clip space.
 * @param {number} point - Screen-space coordinate in CSS pixels.
 * @param {number} drawingBufferWidth - WebGL drawing buffer width in device pixels.
 * @param {number} drawingBufferHeight - WebGL drawing buffer height in device pixels.
 * @param {number} pixelRatio - Device pixel ratio used to scale CSS pixels to device pixels.
 * @returns {[number, number]} Clip-space coordinates in the range [-1, 1].
 */
export const screenToClip = (
  point: SpriteScreenPoint,
  drawingBufferWidth: number,
  drawingBufferHeight: number,
  pixelRatio: number
): [number, number] => {
  const deviceX = point.x * pixelRatio;
  const deviceY = point.y * pixelRatio;
  const clipX = (deviceX / drawingBufferWidth) * 2 - 1;
  const clipY = 1 - (deviceY / drawingBufferHeight) * 2;
  return [clipX, clipY];
};

/**
 * Converts homogeneous clip coordinates back into screen-space pixels.
 * @param {[number, number, number, number]} clipPosition - Homogeneous clip coordinates.
 * @param {number} drawingBufferWidth - WebGL drawing buffer width in device pixels.
 * @param {number} drawingBufferHeight - WebGL drawing buffer height in device pixels.
 * @param {number} pixelRatio - Device pixel ratio relating CSS pixels to device pixels.
 * @returns {SpriteScreenPoint | null} Screen-space coordinates or `null` when invalid.
 */
export const clipToScreen = (
  clipPosition: readonly [number, number, number, number],
  drawingBufferWidth: number,
  drawingBufferHeight: number,
  pixelRatio: number
): SpriteScreenPoint | null => {
  const [clipX, clipY, , clipW] = clipPosition;
  if (!Number.isFinite(clipW) || clipW === 0) {
    return null;
  }
  const invW = 1 / clipW;
  const ndcX = clipX * invW;
  const ndcY = clipY * invW;
  const deviceX = (ndcX + 1) * 0.5 * drawingBufferWidth;
  const deviceY = (1 - ndcY) * 0.5 * drawingBufferHeight;
  if (!Number.isFinite(deviceX) || !Number.isFinite(deviceY)) {
    return null;
  }
  if (!Number.isFinite(pixelRatio) || pixelRatio === 0) {
    return null;
  }
  return {
    x: deviceX / pixelRatio,
    y: deviceY / pixelRatio,
  };
};

/**
 * Calculates the conversion factor between meters and pixels taking perspective into account.
 * @param {number} metersPerPixelAtLatitude - Meters covered by a single pixel at the sprite latitude.
 * @param {number} perspectiveRatio - Additional scale factor introduced by perspective settings.
 * @returns {number} Effective pixels per meter along the camera ray.
 */
export const calculateEffectivePixelsPerMeter = (
  metersPerPixelAtLatitude: number,
  perspectiveRatio: number
): number => {
  // Invalid or non-positive meters-per-pixel would invert scaling, so treat as unusable.
  if (
    !Number.isFinite(metersPerPixelAtLatitude) ||
    metersPerPixelAtLatitude <= 0
  ) {
    return 0;
  }
  const basePixelsPerMeter = 1 / metersPerPixelAtLatitude;
  // When perspective is missing or invalid, fall back to 1 to mimic orthographic scaling.
  const clampedPerspective =
    Number.isFinite(perspectiveRatio) && perspectiveRatio > 0
      ? perspectiveRatio
      : 1;
  return basePixelsPerMeter * clampedPerspective;
};

/**
 * Projects a geographic coordinate and elevation into homogeneous clip space.
 * @typedef ProjectToClipSpaceFn
 * @param {number} location - Location in degrees.
 * @returns {[number, number, number, number] | undefined} Homogeneous clip coordinates or `undefined` when outside the view.
 */
export type ProjectToClipSpaceFn = (
  location: Readonly<SpriteLocation>
) => [number, number, number, number] | undefined;

/**
 * Unprojects a screen-space point back to longitude/latitude.
 * @typedef UnprojectPointFn
 * @param {SpriteScreenPoint} point - Screen-space coordinates in pixels.
 * @returns {SpriteLocation | undefined} Geographic location or `undefined` when unprojection fails.
 */
export type UnprojectPointFn = (
  point: Readonly<SpriteScreenPoint>
) => SpriteLocation | undefined;

/**
 * Resolves a depth key for billboards by sampling the clip-space Z at the sprite center.
 * @param {SpriteScreenPoint} center - Screen-space center of the billboard in pixels.
 * @param {SpriteLocation} spriteLocation - Geographic location including optional altitude.
 * @param {UnprojectPointFn} unproject - Function for converting screen coordinates to geographic coordinates.
 * @param {ProjectToClipSpaceFn} projectToClipSpace - Function that projects a geographic coordinate to clip space.
 * @returns {number | undefined} Negative normalized device coordinate Z used for depth sorting, or `undefined` when unavailable.
 */
export const calculateBillboardDepthKey = (
  center: Readonly<SpriteScreenPoint>,
  unproject: UnprojectPointFn,
  projectToClipSpace: ProjectToClipSpaceFn
): number | undefined => {
  const lngLat = unproject(center);
  // If the point cannot be unprojected (e.g., outside map), skip depth evaluation.
  if (!lngLat) {
    return undefined;
  }
  const clipPosition = projectToClipSpace(lngLat);
  // Projection failures indicate the sprite is outside the camera frustum.
  if (!clipPosition) {
    return undefined;
  }
  const [, , clipZ, clipW] = clipPosition;
  // Avoid dividing by zero when the homogeneous W collapses.
  const ndcZ = clipW !== 0 ? clipZ / clipW : clipZ;
  return -ndcZ;
};

/**
 * Signature for surface depth bias callbacks that tweak clip-space Z/W.
 * @typedef SurfaceDepthBiasFn
 * @param {{ index: number; clipZ: number; clipW: number }} params - Geometry index and unmodified clip coordinates.
 * @returns {{ clipZ: number; clipW: number }} Adjusted clip coordinates used for depth evaluation.
 */
export type SurfaceDepthBiasFn = (params: {
  index: number;
  clipZ: number;
  clipW: number;
}) => { clipZ: number; clipW: number };

/**
 * Computes a depth key for surface quads by projecting each corner and tracking the deepest point.
 * @param {SpriteLocation} baseLngLat - Base longitude/latitude of the quad center.
 * @param {readonly SurfaceCorner[]} displacements - Corner offsets in meters from the center.
 * @param {ProjectToClipSpaceFn} projectToClipSpace - Projection function used to reach clip space.
 * @param {{ readonly indices?: readonly number[]; readonly biasFn?: SurfaceDepthBiasFn }} [options] - Optional overrides.
 * @returns {number | undefined} Depth key suitable for sorting, or `undefined` when any corner cannot be projected.
 */
export const calculateSurfaceDepthKey = (
  baseLngLat: Readonly<SpriteLocation>,
  displacements: readonly SurfaceCorner[],
  projectToClipSpace: ProjectToClipSpaceFn,
  options?: {
    readonly indices?: readonly number[];
    readonly biasFn?: SurfaceDepthBiasFn;
  }
): number | undefined => {
  const indices = options?.indices ?? TRIANGLE_INDICES;
  let maxDepth = Number.NEGATIVE_INFINITY;

  // Iterate over requested indices so callers can restrict evaluation to specific triangles when needed.
  for (const index of indices) {
    const displacement = displacements[index];
    // Skip missing vertices; the caller may have provided partial geometry.
    if (!displacement) {
      continue;
    }

    const displaced = applySurfaceDisplacement(baseLngLat, displacement);

    const clipPosition = projectToClipSpace(displaced);
    // Any unprojectable corner invalidates the depth key for the entire surface.
    if (!clipPosition) {
      return undefined;
    }

    let [, , clipZ, clipW] = clipPosition;
    // Apply optional bias to mitigate z-fighting when stacking surfaces.
    if (options?.biasFn) {
      const biased = options.biasFn({ index, clipZ, clipW });
      clipZ = biased.clipZ;
      clipW = biased.clipW;
    }
    // Protect against divisions by zero when converting to NDC.
    const ndcZ = clipW !== 0 ? clipZ / clipW : clipZ;
    const depthCandidate = -ndcZ;
    // Track the farthest (largest depth) value so sorting can use a single key per surface.
    if (depthCandidate > maxDepth) {
      maxDepth = depthCandidate;
    }
  }

  return maxDepth;
};

/**
 * Projects a longitude/latitude pair to screen-space pixels.
 * @typedef ProjectLngLatFn
 * @param {SpriteLocation} lngLat - Geographic coordinate to project.
 * @returns {SpriteScreenPoint | undefined} Screen coordinates or `undefined` when projection fails.
 */
export type ProjectLngLatFn = (
  lngLat: Readonly<SpriteLocation>
) => SpriteScreenPoint | undefined;

/**
 * Parameters required to resolve a billboard center position.
 */
export interface BillboardCenterParams {
  /** Reference screen-space position (usually anchor point). */
  base: Readonly<SpriteScreenPoint>;
  /** Source bitmap width in pixels. */
  imageWidth?: number;
  /** Source bitmap height in pixels. */
  imageHeight?: number;
  /** Meters represented by a pixel at the sprite latitude. */
  baseMetersPerPixel: number;
  /** User-provided scaling multiplier. */
  imageScale: number;
  /** Distance-dependent scale multiplier. */
  distanceScaleFactor: number;
  /** Pixels per meter after perspective adjustments. */
  effectivePixelsPerMeter: number;
  /** Aggregate rotation applied to the sprite in degrees. */
  totalRotateDeg: number;
  /** Anchor definition normalized between -1 and 1. */
  anchor?: Readonly<SpriteAnchor>;
  /** Offset definition applied in meters/deg. */
  offset?: OffsetInput;
}

/**
 * Resolved properties describing the billboard center and derived dimensions.
 */
export interface BillboardCenterResult {
  /** Screen-space coordinate after offset adjustments. */
  center: SpriteScreenPoint;
  /** Half of the pixel width. */
  halfWidth: number;
  /** Half of the pixel height. */
  halfHeight: number;
  /** Full pixel width after scaling. */
  pixelWidth: number;
  /** Full pixel height after scaling. */
  pixelHeight: number;
  /** Pixel delta caused by anchor rotation. */
  anchorShift: SpritePoint;
  /** Pixel delta caused by radial offset. */
  offsetShift: SpritePoint;
  /** Scaling adjustment applied during pixel dimension calculation. */
  scaleAdjustment: number;
}

/**
 * Calculates the final billboard center position, applying scaling, anchor, and offset adjustments.
 * @param {BillboardCenterParams} params - Inputs describing sprite geometry and scaling context.
 * @returns {BillboardCenterResult} Computed center position and derived metrics for rendering.
 */
export const calculateBillboardCenterPosition = (
  params: BillboardCenterParams
): BillboardCenterResult => {
  const {
    base,
    imageWidth,
    imageHeight,
    baseMetersPerPixel,
    imageScale,
    distanceScaleFactor,
    effectivePixelsPerMeter,
    totalRotateDeg,
    anchor,
    offset,
  } = params;

  const pixelDims = calculateBillboardPixelDimensions(
    imageWidth,
    imageHeight,
    baseMetersPerPixel,
    imageScale,
    distanceScaleFactor,
    effectivePixelsPerMeter
  );
  const halfWidth = pixelDims.width / 2;
  const halfHeight = pixelDims.height / 2;

  const anchorShift = calculateBillboardAnchorShiftPixels(
    halfWidth,
    halfHeight,
    anchor,
    totalRotateDeg
  );
  const offsetShift = calculateBillboardOffsetPixels(
    offset,
    imageScale,
    distanceScaleFactor,
    effectivePixelsPerMeter,
    pixelDims.scaleAdjustment
  );

  // centerX/Y represent the image origin in screen space after anchor handling.
  // calculateBillboardCornerScreenPositions treats the anchor as its origin,
  // so this function applies only the offset and leaves anchor adjustments to the caller.
  const center: SpriteScreenPoint = {
    x: base.x + offsetShift.x,
    y: base.y - offsetShift.y,
  };

  return {
    center,
    halfWidth,
    halfHeight,
    pixelWidth: pixelDims.width,
    pixelHeight: pixelDims.height,
    anchorShift,
    offsetShift,
    scaleAdjustment: pixelDims.scaleAdjustment,
  };
};

/**
 * Parameters controlling how billboard corners are computed in screen space.
 */
export interface BillboardCornerParams {
  /** Screen-space coordinate for the billboard center after offsets. */
  center: Readonly<SpriteScreenPoint>;
  /** Half of the billboard width in pixels. */
  halfWidth: number;
  /** Half of the billboard height in pixels. */
  halfHeight: number;
  /** Optional anchor definition normalized between -1 and 1. */
  anchor?: Readonly<SpriteAnchor>;
  /** Total rotation applied to the billboard in degrees. */
  totalRotateDeg: number;
}

/**
 * Screen-space coordinates combined with UV data for a quad corner.
 */
export interface QuadCorner extends SpriteScreenPoint {
  /** Texture u coordinate. */
  readonly u: number;
  /** Texture v coordinate. */
  readonly v: number;
}

/**
 * Corner positions for an unrotated, unit-sized billboard.
 * @constant
 */
const BILLBOARD_BASE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, 1],
  [1, 1],
  [-1, -1],
  [1, -1],
] as const;

/**
 * Produces the rotated, anchor-adjusted screen-space positions for each billboard corner.
 * @param {BillboardCornerParams} params - Inputs describing the billboard geometry.
 * @returns {QuadCorner[]} Array containing screen- and texture-space information per corner.
 */
export const calculateBillboardCornerScreenPositions = (
  params: BillboardCornerParams
): QuadCorner[] => {
  const { center, halfWidth, halfHeight, anchor, totalRotateDeg } = params;

  // When the sprite has no area, fall back to placing all corners at the center to avoid invalid math.
  if (halfWidth <= 0 || halfHeight <= 0) {
    return UV_CORNERS.map(([u, v]) => ({ x: center.x, y: center.y, u, v }));
  }

  const anchorOffsetX = (anchor?.x ?? 0) * halfWidth;
  const anchorOffsetY = (anchor?.y ?? 0) * halfHeight;
  const rad = -totalRotateDeg * DEG2RAD;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  const corners: QuadCorner[] = [];
  // Iterate over base corners to rotate and translate each sprite vertex consistently.
  for (let i = 0; i < BILLBOARD_BASE_CORNERS.length; i++) {
    const [cornerXNorm, cornerYNorm] = BILLBOARD_BASE_CORNERS[i]!;
    const [u, v] = UV_CORNERS[i]!;
    const cornerX = cornerXNorm * halfWidth;
    const cornerY = cornerYNorm * halfHeight;
    const shiftedX = cornerX - anchorOffsetX;
    const shiftedY = cornerY - anchorOffsetY;

    const rotatedX = shiftedX * cosR - shiftedY * sinR;
    const rotatedY = shiftedX * sinR + shiftedY * cosR;

    corners.push({
      x: center.x + rotatedX,
      y: center.y - rotatedY,
      u,
      v,
    });
  }
  return corners;
};

export interface SurfaceShaderModelParams {
  baseLngLat: Readonly<SpriteLocation>;
  worldWidthMeters: number;
  worldHeightMeters: number;
  anchor: Readonly<SpriteAnchor>;
  totalRotateDeg: number;
  offsetMeters: Readonly<SurfaceCorner>;
}

export type SurfaceShaderCornerModel = SurfaceCorner & SpriteLocation;

export const computeSurfaceCornerShaderModel = (
  params: SurfaceShaderModelParams
): SurfaceShaderCornerModel[] => {
  const {
    baseLngLat,
    worldWidthMeters,
    worldHeightMeters,
    anchor,
    totalRotateDeg,
    offsetMeters,
  } = params;

  const halfWidth = worldWidthMeters / 2;
  const halfHeight = worldHeightMeters / 2;

  if (halfWidth <= 0 || halfHeight <= 0) {
    const cosLat = Math.cos(baseLngLat.lat * DEG2RAD);
    const cosLatClamped = Math.max(cosLat, MIN_COS_LAT);
    const deltaLat = (offsetMeters.north / EARTH_RADIUS_METERS) * RAD2DEG;
    const deltaLng =
      (offsetMeters.east / (EARTH_RADIUS_METERS * cosLatClamped)) * RAD2DEG;
    return SURFACE_BASE_CORNERS.map(() => ({
      east: offsetMeters.east,
      north: offsetMeters.north,
      lng: baseLngLat.lng + deltaLng,
      lat: baseLngLat.lat + deltaLat,
    }));
  }

  const anchorEast = (anchor?.x ?? 0) * halfWidth;
  const anchorNorth = (anchor?.y ?? 0) * halfHeight;
  const rad = -totalRotateDeg * DEG2RAD;
  const sinR = Math.sin(rad);
  const cosR = Math.cos(rad);
  const cosLat = Math.cos(baseLngLat.lat * DEG2RAD);
  const cosLatClamped = Math.max(cosLat, MIN_COS_LAT);

  return SURFACE_BASE_CORNERS.map(([eastNorm, northNorm]) => {
    const cornerEast = eastNorm * halfWidth;
    const cornerNorth = northNorm * halfHeight;

    const localEast = cornerEast - anchorEast;
    const localNorth = cornerNorth - anchorNorth;

    const rotatedEast = localEast * cosR - localNorth * sinR;
    const rotatedNorth = localEast * sinR + localNorth * cosR;

    const east = rotatedEast + offsetMeters.east;
    const north = rotatedNorth + offsetMeters.north;

    const deltaLat = (north / EARTH_RADIUS_METERS) * RAD2DEG;
    const deltaLng = (east / (EARTH_RADIUS_METERS * cosLatClamped)) * RAD2DEG;

    return {
      east,
      north,
      lng: baseLngLat.lng + deltaLng,
      lat: baseLngLat.lat + deltaLat,
    };
  });
};

/**
 * Parameters for projecting a surface sprite's center into screen space.
 */
export interface SurfaceCenterParams {
  /** Base geographic location of the sprite. */
  baseLngLat: Readonly<SpriteLocation>;
  /** Source bitmap width in pixels. */
  imageWidth?: number;
  /** Source bitmap height in pixels. */
  imageHeight?: number;
  /** Base meters per pixel at the sprite latitude. */
  baseMetersPerPixel: number;
  /** User-provided scaling multiplier. */
  imageScale: number;
  /** Distance-dependent scale multiplier. */
  distanceScaleFactor: number;
  /** Rotation applied to the sprite in degrees. */
  totalRotateDeg: number;
  /** Anchor definition normalized between -1 and 1. */
  anchor?: Readonly<SpriteAnchor>;
  /** Offset definition applied in meters/deg. */
  offset?: OffsetInput;
  /** Projection function mapping longitude/latitude to screen space. */
  project?: ProjectLngLatFn;
  /** Projection into clip space when available. */
  projectToClipSpace?: ProjectToClipSpaceFn;
  /** WebGL drawing buffer width in device pixels. */
  drawingBufferWidth?: number;
  /** WebGL drawing buffer height in device pixels. */
  drawingBufferHeight?: number;
  /** Device pixel ratio relating CSS pixels to device pixels. */
  pixelRatio?: number;
  /** When true, also computes the anchorless center. */
  resolveAnchorless?: boolean;
}

/**
 * Output describing the resolved surface center and displacement details.
 */
export interface SurfaceCenterResult {
  /** Projected screen coordinates or `undefined` when projection fails. */
  center: Readonly<SpriteScreenPoint> | undefined;
  /** Sprite dimensions in world meters. */
  worldDimensions: Readonly<{
    width: number;
    height: number;
    scaleAdjustment: number;
  }>;
  /** Combined anchor and offset displacement in meters. */
  totalDisplacement: Readonly<SurfaceCorner>;
  /** Geographic coordinates after applying displacement. */
  displacedLngLat: Readonly<SpriteLocation>;
  /** Anchorless screen coordinates when requested. */
  anchorlessCenter?: Readonly<SpriteScreenPoint> | null;
  /** Offset-only displacement when requested. */
  anchorlessDisplacement?: Readonly<SurfaceCorner>;
  /** Anchorless geographic coordinate when requested. */
  anchorlessLngLat?: Readonly<SpriteLocation>;
}

/**
 * Calculates the projected center of a surface sprite and derives related world-space displacements.
 * @param {SurfaceCenterParams} params - Inputs describing the sprite geometry and projection context.
 * @returns {SurfaceCenterResult} Result containing projection output and displacement metadata.
 */
export const calculateSurfaceCenterPosition = (
  params: SurfaceCenterParams
): SurfaceCenterResult => {
  const {
    baseLngLat,
    imageWidth,
    imageHeight,
    baseMetersPerPixel,
    imageScale,
    distanceScaleFactor,
    totalRotateDeg,
    anchor,
    offset,
    project,
    projectToClipSpace,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio,
    resolveAnchorless = false,
  } = params;

  const hasClipProjection =
    typeof drawingBufferWidth === 'number' &&
    drawingBufferWidth > 0 &&
    typeof drawingBufferHeight === 'number' &&
    drawingBufferHeight > 0 &&
    typeof pixelRatio === 'number' &&
    Number.isFinite(pixelRatio) &&
    pixelRatio !== 0 &&
    typeof projectToClipSpace === 'function';

  const projectPoint = (
    lngLat: Readonly<SpriteLocation>
  ): SpriteScreenPoint | undefined => {
    if (hasClipProjection && projectToClipSpace) {
      const clip = projectToClipSpace(lngLat);
      if (clip) {
        const screen = clipToScreen(
          clip,
          drawingBufferWidth!,
          drawingBufferHeight!,
          pixelRatio!
        );
        if (screen) {
          return screen;
        }
      }
    }
    return project ? project(lngLat) : undefined;
  };

  const worldDims = calculateSurfaceWorldDimensions(
    imageWidth,
    imageHeight,
    baseMetersPerPixel,
    imageScale,
    distanceScaleFactor
  );
  const halfWidthMeters = worldDims.width / 2;
  const halfHeightMeters = worldDims.height / 2;

  const anchorShiftMeters = calculateSurfaceAnchorShiftMeters(
    halfWidthMeters,
    halfHeightMeters,
    anchor,
    totalRotateDeg
  );
  const offsetMeters = calculateSurfaceOffsetMeters(
    offset,
    imageScale,
    distanceScaleFactor,
    worldDims.scaleAdjustment
  );

  const totalDisplacement: SurfaceCorner = {
    east: anchorShiftMeters.east + offsetMeters.east,
    north: anchorShiftMeters.north + offsetMeters.north,
  };

  const displaced = applySurfaceDisplacement(baseLngLat, totalDisplacement);

  const center = projectPoint(displaced);

  let anchorlessCenter: Readonly<SpriteScreenPoint> | null | undefined;
  let anchorlessDisplacement: Readonly<SurfaceCorner> | undefined;
  let anchorlessLngLat: Readonly<SpriteLocation> | undefined;

  if (resolveAnchorless) {
    anchorlessDisplacement = offsetMeters;
    anchorlessLngLat = applySurfaceDisplacement(
      baseLngLat,
      anchorlessDisplacement
    );
    anchorlessCenter = projectPoint(anchorlessLngLat) ?? null;
  }

  return {
    center,
    worldDimensions: worldDims,
    totalDisplacement,
    displacedLngLat: displaced,
    anchorlessCenter,
    anchorlessDisplacement,
    anchorlessLngLat,
  };
};

/**
 * Parameters describing how to compute each surface corner displacement.
 */
export interface SurfaceCornerParams {
  /** Width of the sprite footprint in meters. */
  worldWidthMeters: number;
  /** Height of the sprite footprint in meters. */
  worldHeightMeters: number;
  /** Anchor definition normalized between -1 and 1. */
  anchor: Readonly<SpriteAnchor>;
  /** Rotation applied to the surface in degrees. */
  totalRotateDeg: number;
  /** Additional displacement applied uniformly to all corners. */
  offsetMeters: Readonly<SurfaceCorner>;
}

/**
 * East/north displacement for an individual surface corner.
 */
export interface SurfaceCorner {
  /** Eastward offset in meters relative to the base center. */
  readonly east: number;
  /** Northward offset in meters relative to the base center. */
  readonly north: number;
}

/**
 * Corner list for a unit, axis-aligned surface quad before rotation and scaling.
 */
const SURFACE_BASE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, 1],
  [1, 1],
  [-1, -1],
  [1, -1],
] as const;

/**
 * Number of surface corners returns from `calculateSurfaceCornerDisplacements`.
 */
export const SURFACE_CORNER_DISPLACEMENT_COUNT = SURFACE_BASE_CORNERS.length;

/**
 * Converts normalized surface corners into world-space displacements honoring anchor, rotation, and offsets.
 * @param {SurfaceCornerParams} params - Inputs describing quad geometry and positioning.
 * @returns {SurfaceCorner[]} Array of corner displacements in meters relative to the base center.
 */
export const calculateSurfaceCornerDisplacements = (
  params: SurfaceCornerParams
): SurfaceCorner[] => {
  const {
    worldWidthMeters,
    worldHeightMeters,
    anchor,
    totalRotateDeg,
    offsetMeters,
  } = params;

  // Degenerate quads fallback to offset-only displacements so rendering can continue safely.
  if (worldWidthMeters <= 0 || worldHeightMeters <= 0) {
    return SURFACE_BASE_CORNERS.map(() => offsetMeters);
  }

  const halfWidth = worldWidthMeters / 2;
  const halfHeight = worldHeightMeters / 2;
  const anchorEast = (anchor?.x ?? 0) * halfWidth;
  const anchorNorth = (anchor?.y ?? 0) * halfHeight;
  const rad = -totalRotateDeg * DEG2RAD;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  const corners: Readonly<SurfaceCorner>[] = [];
  // Iterate over normalized unit corners to rotate and translate them into world space.
  for (const [eastNorm, northNorm] of SURFACE_BASE_CORNERS) {
    const cornerEast = eastNorm * halfWidth;
    const cornerNorth = northNorm * halfHeight;

    const localEast = cornerEast - anchorEast;
    const localNorth = cornerNorth - anchorNorth;

    const rotatedEast = localEast * cosR - localNorth * sinR;
    const rotatedNorth = localEast * sinR + localNorth * cosR;

    corners.push({
      east: rotatedEast + offsetMeters.east,
      north: rotatedNorth + offsetMeters.north,
    });
  }

  return corners;
};

/**
 * Ensures the sprite's cached Mercator coordinate matches its current location.
 * Recomputes the coordinate lazily when longitude/latitude/altitude change.
 * @param {ProjectionHost} projectionHost - Projection host.
 * @param {InternalSpriteCurrentState<T>} sprite - Target sprite.
 * @returns {SpriteMercatorCoordinate} Cached Mercator coordinate representing the current location.
 */
export const resolveSpriteMercator = <T>(
  projectionHost: ProjectionHost,
  sprite: InternalSpriteCurrentState<T>
): SpriteMercatorCoordinate => {
  const location = sprite.location.current;
  if (
    sprite.cachedMercator &&
    sprite.cachedMercatorLng === location.lng &&
    sprite.cachedMercatorLat === location.lat &&
    sprite.cachedMercatorZ === location.z
  ) {
    return sprite.cachedMercator;
  }
  const mercator = projectionHost.fromLngLat(location);
  sprite.cachedMercator = mercator;
  sprite.cachedMercatorLng = location.lng;
  sprite.cachedMercatorLat = location.lat;
  sprite.cachedMercatorZ = location.z;
  return mercator;
};

/**
 * Clamp opacity value.
 * @param value Value
 * @returns Clamped value
 */
export const clampOpacity = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
};
