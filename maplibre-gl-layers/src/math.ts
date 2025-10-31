// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  SpriteAnchor,
  SpriteImageOffset,
  SpriteLocation,
  SpriteScalingOptions,
} from './types';
import { UNLIMITED_SPRITE_SCALING_OPTIONS } from './const';

/**
 * WGS84-compatible Earth radius in meters.
 * Used to convert one radian of longitude into meters when scaling sprites.
 * @constant
 */
export const EARTH_RADIUS_METERS = 6378137;

/**
 * Multiplier for converting degrees to radians.
 * @constant
 */
export const DEG2RAD = Math.PI / 180;

/**
 * Multiplier for converting radians to degrees.
 * @constant
 */
export const RAD2DEG = 180 / Math.PI;

/**
 * Default MapLibre tile size used for Web Mercator calculations.
 * @constant
 */
export const TILE_SIZE = 512;

/**
 * Structure holding resolved sprite scaling options.
 * @property {number} metersPerPixel - Effective number of meters represented by each rendered pixel.
 * @property {number} zoomMin - Lowest zoom level at which scaling interpolation begins.
 * @property {number} zoomMax - Highest zoom level at which scaling interpolation ends.
 * @property {number} scaleMin - Scale multiplier applied at {@link ResolvedSpriteScalingOptions.zoomMin}.
 * @property {number} scaleMax - Scale multiplier applied at {@link ResolvedSpriteScalingOptions.zoomMax}.
 * @property {number} spriteMinPixel - Lower clamp for sprite size in pixels.
 * @property {number} spriteMaxPixel - Upper clamp for sprite size in pixels.
 */
export interface ResolvedSpriteScalingOptions {
  metersPerPixel: number;
  zoomMin: number;
  zoomMax: number;
  scaleMin: number;
  scaleMax: number;
  spriteMinPixel: number;
  spriteMaxPixel: number;
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

  const fallbackZoomMin = Number.isFinite(base.zoomMin) ? base.zoomMin! : 0;
  let zoomMin =
    options?.zoomMin !== undefined ? options.zoomMin : fallbackZoomMin;
  if (!Number.isFinite(zoomMin)) {
    if (options?.zoomMin !== undefined) {
      warnings.push(
        `zoomMin(${String(options.zoomMin)}) is not finite; using ${fallbackZoomMin}`
      );
    }
    zoomMin = fallbackZoomMin;
  }

  const fallbackZoomMax =
    Number.isFinite(base.zoomMax) && base.zoomMax! > fallbackZoomMin
      ? base.zoomMax!
      : fallbackZoomMin;
  let zoomMax =
    options?.zoomMax !== undefined ? options.zoomMax : fallbackZoomMax;
  if (!Number.isFinite(zoomMax)) {
    if (options?.zoomMax !== undefined) {
      warnings.push(
        `zoomMax(${String(options.zoomMax)}) is not finite; using ${fallbackZoomMax}`
      );
    }
    zoomMax = fallbackZoomMax;
  }

  if (zoomMax < zoomMin) {
    warnings.push(
      `zoomMax(${zoomMax}) < zoomMin(${zoomMin}); swapped values to maintain ascending order`
    );
    [zoomMin, zoomMax] = [zoomMax, zoomMin];
  }

  const fallbackScaleMin = Number.isFinite(base.scaleMin) ? base.scaleMin! : 1;
  let scaleMin =
    options?.scaleMin !== undefined ? options.scaleMin : fallbackScaleMin;
  if (!Number.isFinite(scaleMin)) {
    if (options?.scaleMin !== undefined) {
      warnings.push(
        `scaleMin(${String(options.scaleMin)}) is not finite; using ${fallbackScaleMin}`
      );
    }
    scaleMin = fallbackScaleMin;
  }
  if (scaleMin < 0) {
    warnings.push(`scaleMin(${scaleMin}) is negative; clamped to 0`);
    scaleMin = 0;
  }

  const fallbackScaleMax = Number.isFinite(base.scaleMax) ? base.scaleMax! : 1;
  let scaleMax =
    options?.scaleMax !== undefined ? options.scaleMax : fallbackScaleMax;
  if (!Number.isFinite(scaleMax)) {
    if (options?.scaleMax !== undefined) {
      warnings.push(
        `scaleMax(${String(options.scaleMax)}) is not finite; using ${fallbackScaleMax}`
      );
    }
    scaleMax = fallbackScaleMax;
  }
  if (scaleMax < 0) {
    warnings.push(`scaleMax(${scaleMax}) is negative; clamped to 0`);
    scaleMax = 0;
  }

  if (scaleMax < scaleMin) {
    warnings.push(
      `scaleMax(${scaleMax}) < scaleMin(${scaleMin}); swapped values to maintain ascending order`
    );
    [scaleMin, scaleMax] = [scaleMax, scaleMin];
  }

  const fallbackSpriteMin =
    Number.isFinite(base.spriteMinPixel) && base.spriteMinPixel! >= 0
      ? base.spriteMinPixel!
      : 0;
  let spriteMinPixel =
    options?.spriteMinPixel !== undefined
      ? options.spriteMinPixel
      : fallbackSpriteMin;
  if (!Number.isFinite(spriteMinPixel)) {
    if (options?.spriteMinPixel !== undefined) {
      warnings.push(
        `spriteMinPixel(${String(
          options.spriteMinPixel
        )}) is not finite; using ${fallbackSpriteMin}`
      );
    }
    spriteMinPixel = fallbackSpriteMin;
  } else if (spriteMinPixel < 0) {
    warnings.push(
      `spriteMinPixel(${spriteMinPixel}) is negative; clamped to 0`
    );
    spriteMinPixel = 0;
  }

  const fallbackSpriteMax =
    Number.isFinite(base.spriteMaxPixel) && base.spriteMaxPixel! >= 0
      ? base.spriteMaxPixel!
      : 0;
  let spriteMaxPixel =
    options?.spriteMaxPixel !== undefined
      ? options.spriteMaxPixel
      : fallbackSpriteMax;
  if (!Number.isFinite(spriteMaxPixel)) {
    if (options?.spriteMaxPixel !== undefined) {
      warnings.push(
        `spriteMaxPixel(${String(
          options.spriteMaxPixel
        )}) is not finite; using ${fallbackSpriteMax}`
      );
    }
    spriteMaxPixel = fallbackSpriteMax;
  } else if (spriteMaxPixel < 0) {
    warnings.push(
      `spriteMaxPixel(${spriteMaxPixel}) is negative; clamped to 0`
    );
    spriteMaxPixel = 0;
  }

  if (
    spriteMinPixel > 0 &&
    spriteMaxPixel > 0 &&
    spriteMaxPixel < spriteMinPixel
  ) {
    warnings.push(
      `spriteMaxPixel(${spriteMaxPixel}) < spriteMinPixel(${spriteMinPixel}); swapped values to maintain ascending order`
    );
    [spriteMinPixel, spriteMaxPixel] = [spriteMaxPixel, spriteMinPixel];
  }

  if (warnings.length > 0 && typeof console !== 'undefined') {
    const warn = console.warn ?? null;
    if (typeof warn === 'function') {
      warn(`[SpriteScalingOptions] ${warnings.join('; ')}`);
    }
  }

  return {
    metersPerPixel,
    zoomMin,
    zoomMax,
    scaleMin,
    scaleMax,
    spriteMinPixel,
    spriteMaxPixel,
  };
};

/**
 * Computes a linear scale factor based on zoom level.
 * @param {number} zoom - Current zoom level from MapLibre's camera.
 * @param {ResolvedSpriteScalingOptions} scaling - Resolved scaling options.
 * @returns {number} Scale value interpolated between {@link ResolvedSpriteScalingOptions.scaleMin} and {@link ResolvedSpriteScalingOptions.scaleMax}.
 */
export const calculateZoomScaleFactor = (
  zoom: number,
  scaling: ResolvedSpriteScalingOptions
): number => {
  const { zoomMin, zoomMax, scaleMin, scaleMax } = scaling;
  // When the configured range collapses (max <= min), treat scale as constant to avoid division by zero.
  if (zoomMax <= zoomMin) {
    return scaleMax;
  }
  // Clamp low zooms to the minimum scale so sprites do not grow further when zooming out.
  if (zoom <= zoomMin) {
    return scaleMin;
  }
  // Clamp zooms beyond the upper bound to the maximum scale for stability when zooming in.
  if (zoom >= zoomMax) {
    return scaleMax;
  }
  const t = (zoom - zoomMin) / (zoomMax - zoomMin);
  return scaleMin + (scaleMax - scaleMin) * t;
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
 * Clamps sprite dimensions so they stay within the configured pixel bounds while preserving aspect ratio.
 * @param {number} width - Calculated sprite width in pixels.
 * @param {number} height - Calculated sprite height in pixels.
 * @param {number} spriteMinPixel - Minimum allowed pixel extent for the sprite's largest side.
 * @param {number} spriteMaxPixel - Maximum allowed pixel extent for the sprite's largest side.
 * @returns {{ width: number; height: number }} Dimensions adjusted to satisfy min/max constraints.
 */
const clampSpritePixelSize = (
  width: number,
  height: number,
  spriteMinPixel: number,
  spriteMaxPixel: number
): { width: number; height: number; scaleAdjustment: number } => {
  const largest = Math.max(width, height);
  // If the measured size is invalid or zero, skip clamping to avoid divisions.
  if (!Number.isFinite(largest) || largest <= 0) {
    return { width, height, scaleAdjustment: 1 };
  }
  let nextWidth = width;
  let nextHeight = height;
  let scaleAdjustment = 1;
  let adjustedLargest = largest;
  // Expand sprites that would render too small so visibility constraints are respected.
  if (spriteMinPixel > 0 && largest < spriteMinPixel) {
    const factor = spriteMinPixel / largest;
    nextWidth *= factor;
    nextHeight *= factor;
    scaleAdjustment *= factor;
    adjustedLargest *= factor;
  }
  // Shrink sprites that would exceed the configured maximum to protect layer.
  if (spriteMaxPixel > 0 && adjustedLargest > spriteMaxPixel) {
    const factor = spriteMaxPixel / adjustedLargest;
    nextWidth *= factor;
    nextHeight *= factor;
    scaleAdjustment *= factor;
  }
  return { width: nextWidth, height: nextHeight, scaleAdjustment };
};

/**
 * Calculates billboard image dimensions in pixels and clamps them to display limits.
 * @param {number | undefined} imageWidth - Source bitmap width in pixels.
 * @param {number | undefined} imageHeight - Source bitmap height in pixels.
 * @param {number} baseMetersPerPixel - Base scale derived from map zoom and latitude.
 * @param {number} imageScale - User-provided scale multiplier.
 * @param {number} zoomScaleFactor - Zoom-dependent scale multiplier derived from {@link calculateZoomScaleFactor}.
 * @param {number} effectivePixelsPerMeter - Conversion between world meters and screen pixels.
 * @param {number} spriteMinPixel - Lower pixel clamp for the sprite's largest side.
 * @param {number} spriteMaxPixel - Upper pixel clamp for the sprite's largest side.
 * @returns {{ width: number; height: number; scaleAdjustment: number }} Pixel dimensions alongside the scale factor applied during clamping.
 */
export const calculateBillboardPixelDimensions = (
  imageWidth: number | undefined,
  imageHeight: number | undefined,
  baseMetersPerPixel: number,
  imageScale: number,
  zoomScaleFactor: number,
  effectivePixelsPerMeter: number,
  spriteMinPixel: number,
  spriteMaxPixel: number
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
    baseMetersPerPixel * imageScale * zoomScaleFactor * effectivePixelsPerMeter;
  const rawWidth = ensureFinite(imageWidth * scaleFactor);
  const rawHeight = ensureFinite(imageHeight * scaleFactor);
  return clampSpritePixelSize(
    rawWidth,
    rawHeight,
    spriteMinPixel,
    spriteMaxPixel
  );
};

/**
 * Computes the billboard offset in screen-space pixels.
 * @param {SpriteImageOffset | undefined} offset - Offset configuration describing length (meters) and heading (degrees).
 * @param {number} imageScale - User-provided scale multiplier applied to the offset distance.
 * @param {number} zoomScaleFactor - Zoom-dependent scale multiplier.
 * @param {number} effectivePixelsPerMeter - Conversion factor from meters to pixels.
 * @param {number} [sizeScaleAdjustment=1] - Additional scale factor applied when sprite size is clamped.
 * @returns {{ x: number; y: number }} Screen-space offset relative to the billboard center.
 */
export const calculateBillboardOffsetPixels = (
  offset: SpriteImageOffset | undefined,
  imageScale: number,
  zoomScaleFactor: number,
  effectivePixelsPerMeter: number,
  sizeScaleAdjustment = 1
): { x: number; y: number } => {
  const offsetMeters =
    (offset?.offsetMeters ?? 0) * imageScale * zoomScaleFactor;
  const offsetPixels =
    offsetMeters * effectivePixelsPerMeter * sizeScaleAdjustment;
  const offsetRad = (offset?.offsetDeg ?? 0) * DEG2RAD;
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
 * @returns {{ x: number; y: number }} Pixel delta required to bring the anchor back to the requested origin.
 */
export const calculateBillboardAnchorShiftPixels = (
  halfWidth: number,
  halfHeight: number,
  anchor: SpriteAnchor | undefined,
  totalRotateDeg: number
): { x: number; y: number } => {
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
 * @param {number} zoomScaleFactor - Zoom-dependent scale multiplier.
 * @returns {{ width: number; height: number; scaleAdjustment: number }} World dimensions in meters and the applied clamp scale factor.
 */
export const calculateSurfaceWorldDimensions = (
  imageWidth: number | undefined,
  imageHeight: number | undefined,
  baseMetersPerPixel: number,
  imageScale: number,
  zoomScaleFactor: number,
  options?: {
    effectivePixelsPerMeter?: number;
    spriteMinPixel?: number;
    spriteMaxPixel?: number;
  }
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
  const scaleFactor = baseMetersPerPixel * imageScale * zoomScaleFactor;
  let width = ensureFinite(imageWidth * scaleFactor);
  let height = ensureFinite(imageHeight * scaleFactor);
  let scaleAdjustment = 1;

  const effectivePixelsPerMeter =
    options?.effectivePixelsPerMeter !== undefined
      ? options.effectivePixelsPerMeter
      : 0;
  const spriteMinPixel = options?.spriteMinPixel ?? 0;
  const spriteMaxPixel = options?.spriteMaxPixel ?? 0;

  if (
    effectivePixelsPerMeter > 0 &&
    Number.isFinite(effectivePixelsPerMeter) &&
    (spriteMinPixel > 0 || spriteMaxPixel > 0)
  ) {
    const largestMeters = Math.max(width, height);
    if (largestMeters > 0 && Number.isFinite(largestMeters)) {
      const largestPixels = largestMeters * effectivePixelsPerMeter;
      if (Number.isFinite(largestPixels) && largestPixels > 0) {
        let scale = 1;
        if (spriteMinPixel > 0 && largestPixels < spriteMinPixel) {
          scale = spriteMinPixel / largestPixels;
        }
        const scaledLargest = largestPixels * scale;
        if (spriteMaxPixel > 0 && scaledLargest > spriteMaxPixel) {
          scale = spriteMaxPixel / largestPixels;
        }
        if (scale !== 1) {
          width *= scale;
          height *= scale;
          scaleAdjustment *= scale;
        }
      }
    }
  }

  return { width, height, scaleAdjustment };
};

/**
 * Computes east/north shifts from anchor rotation on surface images.
 * @param {number} halfWidthMeters - Half of the world-space width.
 * @param {number} halfHeightMeters - Half of the world-space height.
 * @param {SpriteAnchor | undefined} anchor - Anchor definition normalized to [-1, 1] range.
 * @param {number} totalRotateDeg - Rotation angle applied to the surface.
 * @returns {{ east: number; north: number }} Displacement in meters required to apply the anchor.
 */
export const calculateSurfaceAnchorShiftMeters = (
  halfWidthMeters: number,
  halfHeightMeters: number,
  anchor: SpriteAnchor | undefined,
  totalRotateDeg: number
): { east: number; north: number } => {
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
 * @param {SpriteImageOffset | undefined} offset - Offset configuration for the surface sprite.
 * @param {number} imageScale - User-provided scale multiplier applied to the offset distance.
 * @param {number} zoomScaleFactor - Zoom-dependent scale multiplier.
 * @param {number} [sizeScaleAdjustment=1] - Additional scale factor applied when sprite size is clamped.
 * @returns {{ east: number; north: number }} Offset vector in meters.
 */
export const calculateSurfaceOffsetMeters = (
  offset: SpriteImageOffset | undefined,
  imageScale: number,
  zoomScaleFactor: number,
  sizeScaleAdjustment = 1
): { east: number; north: number } => {
  const offsetMeters =
    (offset?.offsetMeters ?? 0) * imageScale * zoomScaleFactor;
  // Short-circuit when no displacement is requested to avoid redundant trig.
  if (offsetMeters === 0) {
    return { east: 0, north: 0 };
  }
  const rad = (offset?.offsetDeg ?? 0) * DEG2RAD;
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
 * @param {number} baseLng - Base longitude in degrees.
 * @param {number} baseLat - Base latitude in degrees.
 * @param {number} east - Eastward displacement in meters.
 * @param {number} north - Northward displacement in meters.
 * @returns {SpriteLocation} New geographic position after applying the displacement.
 */
export const applySurfaceDisplacement = (
  baseLng: number,
  baseLat: number,
  east: number,
  north: number
): SpriteLocation => {
  const deltaLat = (north / EARTH_RADIUS_METERS) * RAD2DEG;
  const cosLat = Math.cos(baseLat * DEG2RAD);
  const deltaLng =
    (east / (EARTH_RADIUS_METERS * Math.max(cosLat, MIN_COS_LAT))) * RAD2DEG;
  return {
    lng: baseLng + deltaLng,
    lat: baseLat + deltaLat,
  };
};

/**
 * Converts screen coordinates to clip space.
 * @param {number} x - Screen-space x coordinate in CSS pixels.
 * @param {number} y - Screen-space y coordinate in CSS pixels.
 * @param {number} drawingBufferWidth - WebGL drawing buffer width in device pixels.
 * @param {number} drawingBufferHeight - WebGL drawing buffer height in device pixels.
 * @param {number} pixelRatio - Device pixel ratio used to scale CSS pixels to device pixels.
 * @returns {[number, number]} Clip-space coordinates in the range [-1, 1].
 */
export const screenToClip = (
  x: number,
  y: number,
  drawingBufferWidth: number,
  drawingBufferHeight: number,
  pixelRatio: number
): [number, number] => {
  const deviceX = x * pixelRatio;
  const deviceY = y * pixelRatio;
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
 * @returns {{ x: number; y: number } | null} Screen-space coordinates or `null` when invalid.
 */
export const clipToScreen = (
  clipPosition: readonly [number, number, number, number],
  drawingBufferWidth: number,
  drawingBufferHeight: number,
  pixelRatio: number
): { x: number; y: number } | null => {
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
 * Index order used to decompose a quad into two triangles.
 * @constant
 */
export const TRIANGLE_INDICES = [0, 1, 2, 2, 1, 3] as const;

/**
 * UV coordinates for each corner of a quad following the index order in {@link TRIANGLE_INDICES}.
 * @constant
 */
export const UV_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.0],
  [1.0, 0.0],
  [0.0, 1.0],
  [1.0, 1.0],
] as const;

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
 * @param {number} lng - Longitude in degrees.
 * @param {number} lat - Latitude in degrees.
 * @param {number} elevationMeters - Elevation offset in meters.
 * @returns {[number, number, number, number] | null} Homogeneous clip coordinates or `null` when outside the view.
 */
export type ProjectToClipSpaceFn = (
  lng: number,
  lat: number,
  elevationMeters: number
) => [number, number, number, number] | null;

/**
 * Unprojects a screen-space point back to longitude/latitude.
 * @typedef UnprojectPointFn
 * @param {{ x: number; y: number }} point - Screen-space coordinates in pixels.
 * @returns {SpriteLocation | null} Geographic location or `null` when unprojection fails.
 */
export type UnprojectPointFn = (point: {
  x: number;
  y: number;
}) => SpriteLocation | null;

/**
 * Resolves a depth key for billboards by sampling the clip-space Z at the sprite center.
 * @param {{ x: number; y: number }} center - Screen-space center of the billboard in pixels.
 * @param {SpriteLocation} spriteLocation - Geographic location including optional altitude.
 * @param {UnprojectPointFn} unproject - Function for converting screen coordinates to geographic coordinates.
 * @param {ProjectToClipSpaceFn} projectToClipSpace - Function that projects a geographic coordinate to clip space.
 * @returns {number | null} Negative normalized device coordinate Z used for depth sorting, or `null` when unavailable.
 */
export const calculateBillboardDepthKey = (
  center: { x: number; y: number },
  spriteLocation: SpriteLocation,
  unproject: UnprojectPointFn,
  projectToClipSpace: ProjectToClipSpaceFn
): number | null => {
  const lngLat = unproject(center);
  // If the point cannot be unprojected (e.g., outside map), skip depth evaluation.
  if (!lngLat) {
    return null;
  }
  const clipPosition = projectToClipSpace(
    lngLat.lng,
    lngLat.lat,
    spriteLocation.z ?? 0
  );
  // Projection failures indicate the sprite is outside the camera frustum.
  if (!clipPosition) {
    return null;
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
 * @param {SpriteLocation} spriteLocation - Sprite world location including optional altitude.
 * @param {ProjectToClipSpaceFn} projectToClipSpace - Projection function used to reach clip space.
 * @param {{ readonly indices?: readonly number[]; readonly biasFn?: SurfaceDepthBiasFn }} [options] - Optional overrides.
 * @returns {number | null} Depth key suitable for sorting, or `null` when any corner cannot be projected.
 */
export const calculateSurfaceDepthKey = (
  baseLngLat: SpriteLocation,
  displacements: readonly SurfaceCorner[],
  spriteLocation: SpriteLocation,
  projectToClipSpace: ProjectToClipSpaceFn,
  options?: {
    readonly indices?: readonly number[];
    readonly biasFn?: SurfaceDepthBiasFn;
  }
): number | null => {
  const indices = options?.indices ?? TRIANGLE_INDICES;
  let maxDepth = Number.NEGATIVE_INFINITY;

  // Iterate over requested indices so callers can restrict evaluation to specific triangles when needed.
  for (const index of indices) {
    const displacement = displacements[index];
    // Skip missing vertices; the caller may have provided partial geometry.
    if (!displacement) {
      continue;
    }

    const displaced = applySurfaceDisplacement(
      baseLngLat.lng,
      baseLngLat.lat,
      displacement.east,
      displacement.north
    );

    const clipPosition = projectToClipSpace(
      displaced.lng,
      displaced.lat,
      spriteLocation.z ?? 0
    );
    // Any unprojectable corner invalidates the depth key for the entire surface.
    if (!clipPosition) {
      return null;
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
 * @returns {{ x: number; y: number } | null} Screen coordinates or `null` when projection fails.
 */
export type ProjectLngLatFn = (
  lngLat: SpriteLocation
) => { x: number; y: number } | null;

/**
 * Parameters required to resolve a billboard center position.
 * @typedef BillboardCenterParams
 * @property {{ x: number; y: number }} base - Reference screen-space position (usually anchor point).
 * @property {number} [imageWidth] - Source bitmap width in pixels.
 * @property {number} [imageHeight] - Source bitmap height in pixels.
 * @property {number} baseMetersPerPixel - Meters represented by a pixel at the sprite latitude.
 * @property {number} imageScale - User-provided scaling multiplier.
 * @property {number} zoomScaleFactor - Zoom-dependent scale multiplier.
 * @property {number} effectivePixelsPerMeter - Pixels per meter after perspective adjustments.
 * @property {number} spriteMinPixel - Lower clamp for the sprite's largest pixel dimension.
 * @property {number} spriteMaxPixel - Upper clamp for the sprite's largest pixel dimension.
 * @property {number} totalRotateDeg - Aggregate rotation applied to the sprite in degrees.
 * @property {SpriteAnchor} [anchor] - Anchor definition normalized between -1 and 1.
 * @property {SpriteImageOffset} [offset] - Offset definition applied in meters/deg.
 */
export type BillboardCenterParams = {
  base: { x: number; y: number };
  imageWidth?: number;
  imageHeight?: number;
  baseMetersPerPixel: number;
  imageScale: number;
  zoomScaleFactor: number;
  effectivePixelsPerMeter: number;
  spriteMinPixel: number;
  spriteMaxPixel: number;
  totalRotateDeg: number;
  anchor?: SpriteAnchor;
  offset?: SpriteImageOffset;
};

/**
 * Resolved properties describing the billboard center and derived dimensions.
 * @typedef BillboardCenterResult
 * @property {number} centerX - Screen-space x coordinate after offset adjustments.
 * @property {number} centerY - Screen-space y coordinate after offset adjustments.
 * @property {number} halfWidth - Half of the clamped pixel width.
 * @property {number} halfHeight - Half of the clamped pixel height.
 * @property {number} pixelWidth - Full pixel width after scaling and clamping.
 * @property {number} pixelHeight - Full pixel height after scaling and clamping.
 * @property {{ x: number; y: number }} anchorShift - Pixel delta caused by anchor rotation.
 * @property {{ x: number; y: number }} offsetShift - Pixel delta caused by radial offset.
 */
export type BillboardCenterResult = {
  centerX: number;
  centerY: number;
  halfWidth: number;
  halfHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  anchorShift: { x: number; y: number };
  offsetShift: { x: number; y: number };
};

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
    zoomScaleFactor,
    effectivePixelsPerMeter,
    spriteMinPixel,
    spriteMaxPixel,
    totalRotateDeg,
    anchor,
    offset,
  } = params;

  const pixelDims = calculateBillboardPixelDimensions(
    imageWidth,
    imageHeight,
    baseMetersPerPixel,
    imageScale,
    zoomScaleFactor,
    effectivePixelsPerMeter,
    spriteMinPixel,
    spriteMaxPixel
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
    zoomScaleFactor,
    effectivePixelsPerMeter,
    pixelDims.scaleAdjustment
  );

  // centerX/Y represent the image origin in screen space after anchor handling.
  // calculateBillboardCornerScreenPositions treats the anchor as its origin,
  // so this function applies only the offset and leaves anchor adjustments to the caller.
  const centerX = base.x + offsetShift.x;
  const centerY = base.y - offsetShift.y;

  return {
    centerX,
    centerY,
    halfWidth,
    halfHeight,
    pixelWidth: pixelDims.width,
    pixelHeight: pixelDims.height,
    anchorShift,
    offsetShift,
  };
};

/**
 * Parameters controlling how billboard corners are computed in screen space.
 * @typedef BillboardCornerParams
 * @property {number} centerX - Screen-space x coordinate for the billboard center after offsets.
 * @property {number} centerY - Screen-space y coordinate for the billboard center after offsets.
 * @property {number} halfWidth - Half of the billboard width in pixels.
 * @property {number} halfHeight - Half of the billboard height in pixels.
 * @property {SpriteAnchor} [anchor] - Optional anchor definition normalized between -1 and 1.
 * @property {number} totalRotateDeg - Total rotation applied to the billboard in degrees.
 */
export type BillboardCornerParams = {
  centerX: number;
  centerY: number;
  halfWidth: number;
  halfHeight: number;
  anchor?: SpriteAnchor;
  totalRotateDeg: number;
};

/**
 * Screen-space coordinates combined with UV data for a quad corner.
 * @typedef QuadCorner
 * @property {number} x - Screen-space x coordinate.
 * @property {number} y - Screen-space y coordinate.
 * @property {number} u - Texture u coordinate.
 * @property {number} v - Texture v coordinate.
 */
export type QuadCorner = {
  x: number;
  y: number;
  u: number;
  v: number;
};

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
  const { centerX, centerY, halfWidth, halfHeight, anchor, totalRotateDeg } =
    params;

  // When the sprite has no area, fall back to placing all corners at the center to avoid invalid math.
  if (halfWidth <= 0 || halfHeight <= 0) {
    return UV_CORNERS.map(([u, v]) => ({ x: centerX, y: centerY, u, v }));
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
      x: centerX + rotatedX,
      y: centerY - rotatedY,
      u,
      v,
    });
  }
  return corners;
};

/**
 * Parameters for projecting a surface sprite's center into screen space.
 * @typedef SurfaceCenterParams
 * @property {SpriteLocation} baseLngLat - Base geographic location of the sprite.
 * @property {number} [imageWidth] - Source bitmap width in pixels.
 * @property {number} [imageHeight] - Source bitmap height in pixels.
 * @property {number} baseMetersPerPixel - Base meters per pixel at the sprite latitude.
 * @property {number} imageScale - User-provided scaling multiplier.
 * @property {number} zoomScaleFactor - Zoom-dependent scale multiplier.
 * @property {number} totalRotateDeg - Rotation applied to the sprite in degrees.
 * @property {SpriteAnchor} [anchor] - Anchor definition normalized between -1 and 1.
 * @property {SpriteImageOffset} [offset] - Offset definition applied in meters/deg.
 * @property {number} [effectivePixelsPerMeter] - Conversion rate from meters to on-screen pixels.
 * @property {number} [spriteMinPixel] - Lower clamp for the sprite's largest pixel dimension.
 * @property {number} [spriteMaxPixel] - Upper clamp for the sprite's largest pixel dimension.
 * @property {ProjectLngLatFn} [project] - Projection function mapping longitude/latitude to screen space.
 * @property {ProjectToClipSpaceFn} [projectToClipSpace] - Projection into clip space when available.
 * @property {number} [drawingBufferWidth] - WebGL drawing buffer width in device pixels.
 * @property {number} [drawingBufferHeight] - WebGL drawing buffer height in device pixels.
 * @property {number} [pixelRatio] - Device pixel ratio relating CSS pixels to device pixels.
 * @property {number} [altitudeMeters] - Altitude used when projecting points into clip space.
 * @property {boolean} [resolveAnchorless] - When true, also computes the anchorless center.
 */
export type SurfaceCenterParams = {
  baseLngLat: SpriteLocation;
  imageWidth?: number;
  imageHeight?: number;
  baseMetersPerPixel: number;
  imageScale: number;
  zoomScaleFactor: number;
  totalRotateDeg: number;
  anchor?: SpriteAnchor;
  offset?: SpriteImageOffset;
  effectivePixelsPerMeter?: number;
  spriteMinPixel?: number;
  spriteMaxPixel?: number;
  project?: ProjectLngLatFn;
  projectToClipSpace?: ProjectToClipSpaceFn;
  drawingBufferWidth?: number;
  drawingBufferHeight?: number;
  pixelRatio?: number;
  altitudeMeters?: number;
  resolveAnchorless?: boolean;
};

/**
 * Output describing the resolved surface center and displacement details.
 * @typedef SurfaceCenterResult
 * @property {{ x: number; y: number } | null} center - Projected screen coordinates or `null` when projection fails.
 * @property {{ width: number; height: number; scaleAdjustment: number }} worldDimensions - Sprite dimensions in world meters.
 * @property {{ east: number; north: number }} totalDisplacement - Combined anchor and offset displacement in meters.
 * @property {SpriteLocation} displacedLngLat - Geographic coordinates after applying displacement.
 * @property {{ x: number; y: number } | null | undefined} [anchorlessCenter] - Anchorless screen coordinates when requested.
 * @property {{ east: number; north: number } | undefined} [anchorlessDisplacement] - Offset-only displacement when requested.
 * @property {SpriteLocation | undefined} [anchorlessLngLat] - Anchorless geographic coordinate when requested.
 */
export type SurfaceCenterResult = {
  center: { x: number; y: number } | null;
  worldDimensions: { width: number; height: number; scaleAdjustment: number };
  totalDisplacement: { east: number; north: number };
  displacedLngLat: SpriteLocation;
  anchorlessCenter?: { x: number; y: number } | null;
  anchorlessDisplacement?: { east: number; north: number };
  anchorlessLngLat?: SpriteLocation;
};

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
    zoomScaleFactor,
    totalRotateDeg,
    anchor,
    offset,
    effectivePixelsPerMeter = 0,
    spriteMinPixel = 0,
    spriteMaxPixel = 0,
    project,
    projectToClipSpace,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio,
    altitudeMeters,
    resolveAnchorless = false,
  } = params;

  const baseAltitude = Number.isFinite(altitudeMeters)
    ? altitudeMeters!
    : (baseLngLat.z ?? 0);

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
    lngLat: SpriteLocation
  ): { x: number; y: number } | null => {
    if (hasClipProjection && projectToClipSpace) {
      const clip = projectToClipSpace(
        lngLat.lng,
        lngLat.lat,
        lngLat.z ?? baseAltitude
      );
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
    return project ? project(lngLat) : null;
  };

  const worldDims = calculateSurfaceWorldDimensions(
    imageWidth,
    imageHeight,
    baseMetersPerPixel,
    imageScale,
    zoomScaleFactor,
    {
      effectivePixelsPerMeter,
      spriteMinPixel,
      spriteMaxPixel,
    }
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
    zoomScaleFactor,
    worldDims.scaleAdjustment
  );

  const totalEast = anchorShiftMeters.east + offsetMeters.east;
  const totalNorth = anchorShiftMeters.north + offsetMeters.north;

  const displaced = applySurfaceDisplacement(
    baseLngLat.lng,
    baseLngLat.lat,
    totalEast,
    totalNorth
  );

  const center = projectPoint(displaced);

  let anchorlessCenter: { x: number; y: number } | null | undefined;
  let anchorlessDisplacement: { east: number; north: number } | undefined;
  let anchorlessLngLat: SpriteLocation | undefined;

  if (resolveAnchorless) {
    anchorlessDisplacement = {
      east: offsetMeters.east,
      north: offsetMeters.north,
    };
    anchorlessLngLat = applySurfaceDisplacement(
      baseLngLat.lng,
      baseLngLat.lat,
      anchorlessDisplacement.east,
      anchorlessDisplacement.north
    );
    anchorlessCenter = projectPoint(anchorlessLngLat) ?? null;
  }

  return {
    center,
    worldDimensions: worldDims,
    totalDisplacement: { east: totalEast, north: totalNorth },
    displacedLngLat: displaced,
    anchorlessCenter,
    anchorlessDisplacement,
    anchorlessLngLat,
  };
};

/**
 * Parameters describing how to compute each surface corner displacement.
 * @typedef SurfaceCornerParams
 * @property {number} worldWidthMeters - Width of the sprite footprint in meters.
 * @property {number} worldHeightMeters - Height of the sprite footprint in meters.
 * @property {SpriteAnchor} anchor - Anchor definition normalized between -1 and 1.
 * @property {number} totalRotateDeg - Rotation applied to the surface in degrees.
 * @property {{ east: number; north: number }} offsetMeters - Additional displacement applied uniformly to all corners.
 */
export type SurfaceCornerParams = {
  worldWidthMeters: number;
  worldHeightMeters: number;
  anchor: SpriteAnchor;
  totalRotateDeg: number;
  offsetMeters: { east: number; north: number };
};

/**
 * East/north displacement for an individual surface corner.
 * @typedef SurfaceCorner
 * @property {number} east - Eastward offset in meters relative to the base center.
 * @property {number} north - Northward offset in meters relative to the base center.
 */
export type SurfaceCorner = {
  east: number;
  north: number;
};

/**
 * Corner list for a unit, axis-aligned surface quad before rotation and scaling.
 * @constant
 */
const SURFACE_BASE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, 1],
  [1, 1],
  [-1, -1],
  [1, -1],
] as const;

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
    return SURFACE_BASE_CORNERS.map(() => ({
      east: offsetMeters.east,
      north: offsetMeters.north,
    }));
  }

  const halfWidth = worldWidthMeters / 2;
  const halfHeight = worldHeightMeters / 2;
  const anchorEast = (anchor?.x ?? 0) * halfWidth;
  const anchorNorth = (anchor?.y ?? 0) * halfHeight;
  const rad = -totalRotateDeg * DEG2RAD;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  const corners: SurfaceCorner[] = [];
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
