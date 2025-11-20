// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { Rect } from './utils/looseQuadTree';
import type {
  SpriteAnchor,
  SpriteImageOffset,
  SpriteTextGlyphHorizontalAlign,
} from './types';
import type { RgbaColor } from './internalTypes';

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

/** Default threshold in meters for auto-rotation to treat movement as significant. */
export const DEFAULT_AUTO_ROTATION_MIN_DISTANCE_METERS = 20;

/** Default border width in meters for sprite image outlines. */
export const DEFAULT_BORDER_WIDTH_METERS = 1;

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

//////////////////////////////////////////////////////////////////////////////////////

const __CSS_KEYWORD_COLORS = {
  black: [0, 0, 0, 1] as RgbaColor,
  silver: [192, 192, 192, 1] as RgbaColor,
  gray: [128, 128, 128, 1] as RgbaColor,
  white: [255, 255, 255, 1] as RgbaColor,
  maroon: [128, 0, 0, 1] as RgbaColor,
  red: [255, 0, 0, 1] as RgbaColor,
  purple: [128, 0, 128, 1] as RgbaColor,
  fuchsia: [255, 0, 255, 1] as RgbaColor,
  green: [0, 128, 0, 1] as RgbaColor,
  lime: [0, 255, 0, 1] as RgbaColor,
  olive: [128, 128, 0, 1] as RgbaColor,
  yellow: [255, 255, 0, 1] as RgbaColor,
  navy: [0, 0, 128, 1] as RgbaColor,
  blue: [0, 0, 255, 1] as RgbaColor,
  teal: [0, 128, 128, 1] as RgbaColor,
  aqua: [0, 255, 255, 1] as RgbaColor,
  transparent: [0, 0, 0, 0] as RgbaColor,
};

export const CSS_KEYWORD_COLORS: typeof __CSS_KEYWORD_COLORS &
  Record<string, RgbaColor> = __CSS_KEYWORD_COLORS;

export const DEFAULT_BORDER_COLOR = 'red';
export const DEFAULT_BORDER_COLOR_RGBA = CSS_KEYWORD_COLORS.red;
