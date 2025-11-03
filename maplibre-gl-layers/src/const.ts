// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { Rect } from './looseQuadTree';
import type {
  SpriteAnchor,
  SpriteImageOffset,
  SpriteTextGlyphHorizontalAlign,
} from './types';

//////////////////////////////////////////////////////////////////////////////////////

/** Default sprite anchor centered at the image origin. */
export const DEFAULT_ANCHOR: Readonly<SpriteAnchor> = {
  x: 0.0,
  y: 0.0,
} as const;

/** Default image offset applied when none is provided. */
export const DEFAULT_IMAGE_OFFSET: Readonly<SpriteImageOffset> = {
  offsetMeters: 0,
  offsetDeg: 0,
} as const;

export const DEFAULT_TEXT_GLYPH_FONT_FAMILY = 'sans-serif';
export const DEFAULT_TEXT_GLYPH_FONT_STYLE: 'normal' | 'italic' = 'normal';
export const DEFAULT_TEXT_GLYPH_FONT_WEIGHT = 'normal';
export const DEFAULT_TEXT_GLYPH_COLOR = '#000000';
export const DEFAULT_TEXT_GLYPH_ALIGN: SpriteTextGlyphHorizontalAlign =
  'center';
export const DEFAULT_TEXT_GLYPH_FONT_SIZE = 32;
export const DEFAULT_TEXT_GLYPH_RENDER_PIXEL_RATIO = 1;

//////////////////////////////////////////////////////////////////////////////////////

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

//////////////////////////////////////////////////////////////////////////////////////

// Clamp the clip-space w component to avoid instability near the clip plane.
export const MIN_CLIP_Z_EPSILON = 1e-7;

/** Small depth bias applied in NDC space. */
export const EPS_NDC = 1e-6;

/** Maximum number of order slots available within a sub-layer (0..ORDER_MAX-1). */
export const ORDER_MAX = 16;

/** Bucket width used to encode sub-layer and order into a single number. */
export const ORDER_BUCKET = 16;

export const MIN_CLIP_W = 1e-6;

//////////////////////////////////////////////////////////////////////////////////////

export const HIT_TEST_WORLD_BOUNDS: Rect = {
  x0: -180,
  y0: -90,
  x1: 180,
  y1: 90,
} as const;

/** Small tolerance used to handle floating-point error during hit testing. */
export const HIT_TEST_EPSILON = 1e-3;

//////////////////////////////////////////////////////////////////////////////////////

export const MAX_TEXT_GLYPH_RENDER_PIXEL_RATIO = 4;
export const MIN_TEXT_GLYPH_FONT_SIZE = 4;

//////////////////////////////////////////////////////////////////////////////////////

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
