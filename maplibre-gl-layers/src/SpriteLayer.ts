// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

/**
 * SpriteLayer.ts
 *
 * Module that manages large numbers of sprites as a custom MapLibre WebGL layer, handling scaling,
 * interpolation animations, and buffer management for parallel rendering.
 * Includes CustomLayerInterface implementations, texture utilities, interpolation logic,
 * ordering rules, and depth-normalization helpers for avoiding Z-buffer issues.
 */

import { type Map as MapLibreMap } from 'maplibre-gl';
import type { CustomRenderMethodInput } from 'maplibre-gl';

import {
  type SpriteInit,
  type SpriteInitCollection,
  type SpriteLayerInterface,
  type SpriteLayerOptions,
  type SpriteTextureFilteringOptions,
  type SpriteTextureMagFilter,
  type SpriteTextureMinFilter,
  type SpriteAnchor,
  type SpriteLocation,
  type SpriteCurrentState,
  type SpriteLayerEventMap,
  type SpriteLayerEventListener,
  type SpriteUpdateEntry,
  type SpriteUpdaterEntry,
  type SpriteImageDefinitionInit,
  type SpriteImageDefinitionUpdate,
  type SpriteLayerHoverEvent,
  type SpriteMutateCallbacks,
  type SpriteMutateSourceItem,
  type SpriteImageOffset,
  type SpriteInterpolationOptions,
  type SpriteImageOriginLocation,
  type SpriteScreenPoint,
  type SpriteLayerClickEvent,
  type SpriteImageState,
  type SpriteTextGlyphDimensions,
  type SpriteTextGlyphOptions,
  type SpriteTextGlyphHorizontalAlign,
  type SpriteTextGlyphPaddingPixel,
  type SpriteTextGlyphBorderSide,
  type SpriteImageRegisterOptions,
} from './types';
import type {
  ResolvedTextureFilteringOptions,
  RegisteredImage,
  ResolvedTextGlyphPadding,
  ResolvedBorderSides,
  ResolvedTextGlyphOptions,
  Canvas2DContext,
  Canvas2DSource,
  InternalSpriteImageState,
  InternalSpriteCurrentState,
  SurfaceShaderInputs,
  ProjectionHost,
  PreparedDrawSpriteImageParams,
  RenderCalculationHost,
  SpriteOriginReference,
  SpriteOriginReferenceKey,
} from './internalTypes';
import {
  SPRITE_ORIGIN_REFERENCE_KEY_NONE,
  SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
} from './internalTypes';
import { loadImageBitmap, SvgSizeResolutionError } from './image';
import {
  createInterpolationState,
  evaluateInterpolation,
} from './interpolation';
import { normalizeAngleDeg } from './rotationInterpolation';
import {
  calculateDistanceAndBearingMeters,
  calculateMetersPerPixelAtLatitude,
  calculateZoomScaleFactor,
  calculateSurfaceOffsetMeters,
  calculateSurfaceWorldDimensions,
  applySurfaceDisplacement,
  isFiniteNumber,
  resolveScalingOptions,
  calculateBillboardAnchorShiftPixels,
  calculateBillboardPixelDimensions,
  calculateBillboardOffsetPixels,
  calculateEffectivePixelsPerMeter,
  calculateSurfaceCornerDisplacements,
  cloneSpriteLocation,
  spriteLocationsEqual,
  resolveSpriteMercator,
} from './math';
import {
  applyOffsetUpdate,
  clearOffsetDegInterpolation,
  clearOffsetMetersInterpolation,
  stepSpriteImageInterpolations,
  syncImageRotationChannel,
} from './interpolationChannels';
import { DEFAULT_TEXTURE_FILTERING_OPTIONS } from './default';
import {
  createLooseQuadTree,
  type Item as LooseQuadTreeItem,
  type LooseQuadTree,
  type Rect as LooseQuadTreeRect,
} from './looseQuadTree';
import {
  POSITION_COMPONENT_COUNT,
  UV_COMPONENT_COUNT,
  VERTEX_STRIDE,
  UV_OFFSET,
  QUAD_VERTEX_COUNT,
  VERTEX_SHADER_SOURCE,
  FRAGMENT_SHADER_SOURCE,
  INITIAL_QUAD_VERTICES,
  DEBUG_OUTLINE_VERTEX_SHADER_SOURCE,
  DEBUG_OUTLINE_FRAGMENT_SHADER_SOURCE,
  DEBUG_OUTLINE_VERTEX_COUNT,
  DEBUG_OUTLINE_POSITION_COMPONENT_COUNT,
  DEBUG_OUTLINE_VERTEX_STRIDE,
  DEBUG_OUTLINE_VERTEX_SCRATCH,
  DEBUG_OUTLINE_COLOR,
  DEBUG_OUTLINE_CORNER_ORDER,
  createShaderProgram,
} from './shader';
import { createCalculationHost } from './calculationHost';
import {
  createProjectionHost,
  createProjectionHostParamsFromMapLibre,
} from './projectionHost';
import { createWasmProjectionHost } from './wasmProjectionHost';
import { createWasmCalculationHost } from './wasmCalculationHost';
import {
  DEFAULT_ANCHOR,
  DEFAULT_IMAGE_OFFSET,
  DEFAULT_TEXT_GLYPH_ALIGN,
  DEFAULT_TEXT_GLYPH_COLOR,
  DEFAULT_TEXT_GLYPH_FONT_FAMILY,
  DEFAULT_TEXT_GLYPH_FONT_SIZE,
  DEFAULT_TEXT_GLYPH_FONT_STYLE,
  DEFAULT_TEXT_GLYPH_FONT_WEIGHT,
  DEFAULT_TEXT_GLYPH_RENDER_PIXEL_RATIO,
  HIT_TEST_EPSILON,
  HIT_TEST_WORLD_BOUNDS,
  MAX_TEXT_GLYPH_RENDER_PIXEL_RATIO,
  MIN_TEXT_GLYPH_FONT_SIZE,
} from './const';
import {
  SL_DEBUG,
  ATLAS_QUEUE_CHUNK_SIZE,
  ATLAS_QUEUE_TIME_BUDGET_MS,
  TEXT_GLYPH_QUEUE_CHUNK_SIZE,
  TEXT_GLYPH_QUEUE_TIME_BUDGET_MS,
} from './config';
import {
  createImageHandleBufferController,
  createIdHandler,
  createSpriteOriginReference,
  createRenderTargetBucketBuffers,
} from './utils';
import {
  createAtlasManager,
  type AtlasPageState,
  createAtlasOperationQueue,
} from './atlas';
import {
  createDeferred,
  onAbort,
  type Deferred,
  type Releasable,
} from 'async-primitives';
import { isSpriteLayerHostEnabled } from './runtime';

//////////////////////////////////////////////////////////////////////////////////////

// Sprite definition and rendering flow:
// The order of calculations below is significant; changing it produces incorrect rendering.
// * Skip processing when no images are registered via registerImage or no sprites exist.
// * Each sprite (SpriteCompositeInit<T>) assigns images by subLayer and order. Although the logical
//   structure is sprite -> images, rendering must process grouped images by sub-layer, then order, then sprite.
// * Every sprite has a single base location (A: SpriteLocation).
// * A sprite may contain zero or more images, each with its own SpriteImageDefinition attributes.
// * When isEnabled is false, the sprite has zero images, every image has opacity 0.0, or all image IDs are invalid,
//   the sprite can be ignored for the remainder of the pipeline.
// * When movement interpolation (SpriteLocationInterpolationOptions) is enabled, it operates per sprite (not per image),
//   producing an interpolated position B relative to the base position A. Rotation angles are not interpolated.
//   SpriteInterpolationMode supports feedback and feed-forward:
//   * Feedback: interpolate between the previous and current base locations over durationMs when the position changes.
//   * Feed-forward: double the delta vector between the previous and current base locations to determine a destination,
//     then interpolate from the current position toward that point over durationMs, treating the destination as the
//     position reached after durationMs elapses.
// * Images with opacity 0.0 or invalid image IDs are skipped entirely.
// * Each image applies opacity to its alpha.
// * SpriteMode determines whether calculations assume a viewport-facing plane or the map surface.
// * originLocation selects the anchor point (I). Without a reference, use the sprite's interpolated position B. When
//   referencing another image, reuse that image's anchor (resolving recursively within the same sprite).
// * Anchors (C: SpriteAnchor) determine each image's base position relative to B.
// * Image scale (D) enlarges or shrinks the rendered image.
// * Offsets (SpriteImageOffset) derived from the scaled anchor (E) decide the final placement.
// * When autoRotation is enabled, compute heading from movement around A to obtain the base rotation angle (F),
//   causing surface-mode images to face the travel direction. The rotation value itself is mode-agnostic; billboard
//   mode may ignore it visually. Movement shorter than autoRotationMinDistanceMeters (G) does not update F. Retain the
//   last origin position (H) and update it only after exceeding G so rotation changes occur at meaningful distances.
// * rotateDeg applies an additional rotation on top of F using the anchor-adjusted position (E) as the pivot.

// Baseline computation values:
// SpriteScalingOptions parameters are used here.

//////////////////////////////////////////////////////////////////////////////////////

/** Default threshold in meters for auto-rotation to treat movement as significant. */
const DEFAULT_AUTO_ROTATION_MIN_DISTANCE_METERS = 20;

/** Sentinel used when an image has not been placed on any atlas page. */
const ATLAS_PAGE_INDEX_NONE = -1;

/** Query radius (in CSS pixels) when sampling the hit-test QuadTree. */
const HIT_TEST_QUERY_RADIUS_PIXELS = 32;

/** List of acceptable minification filters exposed to callers. */
const MIN_FILTER_VALUES: readonly SpriteTextureMinFilter[] = [
  'nearest',
  'linear',
  'nearest-mipmap-nearest',
  'nearest-mipmap-linear',
  'linear-mipmap-nearest',
  'linear-mipmap-linear',
] as const;

/** List of acceptable magnification filters. */
const MAG_FILTER_VALUES: readonly SpriteTextureMagFilter[] = [
  'nearest',
  'linear',
] as const;

//////////////////////////////////////////////////////////////////////////////////////

/** Minification filters that require mipmaps to produce complete textures. */
const MIPMAP_MIN_FILTERS: ReadonlySet<SpriteTextureMinFilter> =
  new Set<SpriteTextureMinFilter>([
    'nearest-mipmap-nearest',
    'nearest-mipmap-linear',
    'linear-mipmap-nearest',
    'linear-mipmap-linear',
  ]);

const filterRequiresMipmaps = (filter: SpriteTextureMinFilter): boolean =>
  MIPMAP_MIN_FILTERS.has(filter);

const resolveTextureFilteringOptions = (
  options?: SpriteTextureFilteringOptions
): ResolvedTextureFilteringOptions => {
  const minCandidate = options?.minFilter;
  const minFilter: SpriteTextureMinFilter = MIN_FILTER_VALUES.includes(
    minCandidate as SpriteTextureMinFilter
  )
    ? (minCandidate as SpriteTextureMinFilter)
    : DEFAULT_TEXTURE_FILTERING_OPTIONS.minFilter!;

  const magCandidate = options?.magFilter;
  const magFilter: SpriteTextureMagFilter = MAG_FILTER_VALUES.includes(
    magCandidate as SpriteTextureMagFilter
  )
    ? (magCandidate as SpriteTextureMagFilter)
    : DEFAULT_TEXTURE_FILTERING_OPTIONS.magFilter!;

  let generateMipmaps =
    options?.generateMipmaps ??
    DEFAULT_TEXTURE_FILTERING_OPTIONS.generateMipmaps!;
  if (filterRequiresMipmaps(minFilter)) {
    generateMipmaps = true;
  }

  let maxAnisotropy =
    options?.maxAnisotropy ?? DEFAULT_TEXTURE_FILTERING_OPTIONS.maxAnisotropy!;
  if (!Number.isFinite(maxAnisotropy) || maxAnisotropy < 1) {
    maxAnisotropy = 1;
  }

  return {
    minFilter,
    magFilter,
    generateMipmaps,
    maxAnisotropy,
  };
};

const ANISOTROPY_EXTENSION_NAMES = [
  'EXT_texture_filter_anisotropic',
  'WEBKIT_EXT_texture_filter_anisotropic',
  'MOZ_EXT_texture_filter_anisotropic',
] as const;

const resolveAnisotropyExtension = (
  glContext: WebGLRenderingContext
): EXT_texture_filter_anisotropic | null => {
  for (const name of ANISOTROPY_EXTENSION_NAMES) {
    const extension = glContext.getExtension(name);
    if (extension) {
      return extension as EXT_texture_filter_anisotropic;
    }
  }
  return null;
};

const isPowerOfTwo = (value: number): boolean =>
  value > 0 && (value & (value - 1)) === 0;

const resolveGlMinFilter = (
  glContext: WebGLRenderingContext,
  filter: SpriteTextureMinFilter
): number => {
  switch (filter) {
    case 'nearest':
      return glContext.NEAREST;
    case 'nearest-mipmap-nearest':
      return glContext.NEAREST_MIPMAP_NEAREST;
    case 'nearest-mipmap-linear':
      return glContext.NEAREST_MIPMAP_LINEAR;
    case 'linear-mipmap-nearest':
      return glContext.LINEAR_MIPMAP_NEAREST;
    case 'linear-mipmap-linear':
      return glContext.LINEAR_MIPMAP_LINEAR;
    case 'linear':
    default:
      return glContext.LINEAR;
  }
};

const resolveGlMagFilter = (
  glContext: WebGLRenderingContext,
  filter: SpriteTextureMagFilter
): number => {
  switch (filter) {
    case 'nearest':
      return glContext.NEAREST;
    case 'linear':
    default:
      return glContext.LINEAR;
  }
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Applies auto-rotation to all images within a sprite when movement exceeds the configured threshold.
 * @template T Arbitrary sprite tag type.
 * @param {InternalSpriteCurrentState<T>} sprite - Sprite undergoing potential rotation update.
 * @param {SpriteLocation} nextLocation - Destination location used to derive bearing and distance.
 * @returns {boolean} `true` when auto-rotation was applied, `false` otherwise.
 */
export const applyAutoRotation = <T>(
  sprite: InternalSpriteCurrentState<T>,
  nextLocation: SpriteLocation
): boolean => {
  let hasAutoRotation = false;
  let requiredDistance = 0;

  sprite.images.forEach((orderMap) => {
    orderMap.forEach((image) => {
      // Images without auto-rotation contribute nothing; continue scanning others.
      if (!image.autoRotation) {
        return;
      }
      hasAutoRotation = true;
      const minDistance = Math.max(0, image.autoRotationMinDistanceMeters ?? 0);
      // Track the largest minimum distance across images so we respect all constraints.
      if (minDistance > requiredDistance) {
        requiredDistance = minDistance;
      }
    });
  });

  // No auto-rotating images means nothing to update.
  if (!hasAutoRotation) {
    return false;
  }

  const { distanceMeters, bearingDeg } = calculateDistanceAndBearingMeters(
    sprite.lastAutoRotationLocation,
    nextLocation
  );

  // Guard against zero/invalid distances (e.g., same point) to avoid jitter.
  if (!isFiniteNumber(distanceMeters) || distanceMeters <= 0) {
    return false;
  }

  // Ignore movement shorter than the required threshold to reduce noise.
  if (distanceMeters < requiredDistance) {
    return false;
  }

  const resolvedAngleRaw = isFiniteNumber(bearingDeg)
    ? bearingDeg
    : sprite.lastAutoRotationAngleDeg;
  const resolvedAngle = normalizeAngleDeg(resolvedAngleRaw);

  sprite.images.forEach((orderMap) => {
    orderMap.forEach((image) => {
      // Only update images participating in auto-rotation; others preserve their manual angles.
      if (!image.autoRotation) {
        return;
      }
      image.resolvedBaseRotateDeg = resolvedAngle;
      syncImageRotationChannel(image);
    });
  });

  sprite.lastAutoRotationLocation = cloneSpriteLocation(nextLocation);
  sprite.lastAutoRotationAngleDeg = resolvedAngle;

  return true;
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Resolves text padding into a fully populated structure with non-negative values.
 * @param {SpriteTextGlyphPaddingPixel} [padding] - Caller-supplied padding definition.
 * @returns {ResolvedTextGlyphPadding} Padding ready for measurement and drawing.
 */
const resolveTextGlyphPadding = (
  padding?: SpriteTextGlyphPaddingPixel
): ResolvedTextGlyphPadding => {
  if (typeof padding === 'number' && Number.isFinite(padding)) {
    const safeValue = Math.max(0, padding);
    return {
      top: safeValue,
      right: safeValue,
      bottom: safeValue,
      left: safeValue,
    };
  }

  if (typeof padding === 'object' && padding !== null) {
    const safe = (value?: number): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : 0;

    return {
      top: safe(padding.top),
      right: safe(padding.right),
      bottom: safe(padding.bottom),
      left: safe(padding.left),
    };
  }

  return { top: 0, right: 0, bottom: 0, left: 0 };
};

/**
 * Normalizes the border sides definition, defaulting to all sides when unspecified or invalid.
 * @param {readonly SpriteTextGlyphBorderSide[]} [sides] - Requested border sides.
 * @returns {ResolvedBorderSides} Derived sides ready for rendering.
 */
const resolveBorderSides = (
  sides?: readonly SpriteTextGlyphBorderSide[]
): ResolvedBorderSides => {
  if (!Array.isArray(sides) || sides.length === 0) {
    return { top: true, right: true, bottom: true, left: true };
  }

  let top = false;
  let right = false;
  let bottom = false;
  let left = false;

  for (const side of sides) {
    switch (side) {
      case 'top':
        top = true;
        break;
      case 'right':
        right = true;
        break;
      case 'bottom':
        bottom = true;
        break;
      case 'left':
        left = true;
        break;
      default:
        break;
    }
  }

  if (!top && !right && !bottom && !left) {
    return { top: true, right: true, bottom: true, left: true };
  }

  return { top, right, bottom, left };
};

/**
 * Picks a valid horizontal alignment, defaulting to center when unspecified.
 * @param {SpriteTextGlyphHorizontalAlign} [align] - Requested alignment.
 * @returns {SpriteTextGlyphHorizontalAlign} Derived alignment used during layer.
 */
const resolveTextAlign = (
  align?: SpriteTextGlyphHorizontalAlign
): SpriteTextGlyphHorizontalAlign => {
  switch (align) {
    case 'left':
    case 'right':
      return align;
    case 'center':
    default:
      return DEFAULT_TEXT_GLYPH_ALIGN;
  }
};

/**
 * Returns the font style when provided, falling back to the default when invalid.
 * @param {'normal' | 'italic'} [style] - Requested font style.
 * @returns {'normal' | 'italic'} Style to use for drawing.
 */
const resolveFontStyle = (style?: 'normal' | 'italic'): 'normal' | 'italic' =>
  style === 'italic' ? 'italic' : DEFAULT_TEXT_GLYPH_FONT_STYLE;

/**
 * Validates that a numeric value is positive and finite; otherwise returns a fallback.
 * @param {number | undefined} value - Value to test.
 * @param {number} fallback - Value to use when the test fails.
 * @returns {number} Positive finite number suitable for layer math.
 */
const resolvePositiveFinite = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return value > 0 ? value : fallback;
};

/**
 * Normalizes a finite number to be non-negative, falling back when invalid.
 * @param {number | undefined} value - Value to validate.
 * @param {number} [fallback=0] - Fallback used when the value is negative or invalid.
 * @returns {number} Non-negative finite value.
 */
const resolveNonNegativeFinite = (value: number | undefined, fallback = 0) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return value >= 0 ? value : fallback;
};

/**
 * Resolves optional numeric values, returning a fallback when not finite.
 * @param {number | undefined} value - Value to test.
 * @param {number} fallback - Replacement when the value is invalid.
 * @returns {number} Provided value or fallback.
 */
const resolveFiniteOrDefault = (
  value: number | undefined,
  fallback: number
): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Ensures the text glyph render pixel ratio stays within supported bounds.
 * @param {number} [value] - Requested pixel ratio.
 * @returns {number} Clamped pixel ratio for rendering.
 */
const resolveRenderPixelRatio = (value?: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TEXT_GLYPH_RENDER_PIXEL_RATIO;
  }
  return Math.min(
    Math.max(value, DEFAULT_TEXT_GLYPH_RENDER_PIXEL_RATIO),
    MAX_TEXT_GLYPH_RENDER_PIXEL_RATIO
  );
};

/**
 * Merges text glyph options with defaults, producing a fully resolved configuration.
 * @param {SpriteTextGlyphOptions} [options] - User-specified options.
 * @param {number} [preferredLineHeight] - Optional line height used as fallback for font size.
 * @returns {ResolvedTextGlyphOptions} Resolved options ready for glyph rendering.
 */
const resolveTextGlyphOptions = (
  options?: SpriteTextGlyphOptions,
  preferredLineHeight?: number
): ResolvedTextGlyphOptions => {
  const fallbackFontSize =
    typeof preferredLineHeight === 'number' && preferredLineHeight > 0
      ? // When a preferred line height is provided, use it as the baseline font size.
        preferredLineHeight
      : // Otherwise fall back to the default glyph font size.
        DEFAULT_TEXT_GLYPH_FONT_SIZE;

  const resolvedFontSize = resolvePositiveFinite(
    options?.fontSizePixelHint,
    fallbackFontSize
  );

  return {
    fontFamily: options?.fontFamily ?? DEFAULT_TEXT_GLYPH_FONT_FAMILY,
    fontStyle: resolveFontStyle(options?.fontStyle),
    fontWeight: options?.fontWeight ?? DEFAULT_TEXT_GLYPH_FONT_WEIGHT,
    fontSizePixel: resolvedFontSize,
    color: options?.color ?? DEFAULT_TEXT_GLYPH_COLOR,
    letterSpacingPixel: resolveFiniteOrDefault(options?.letterSpacingPixel, 0),
    backgroundColor: options?.backgroundColor,
    paddingPixel: resolveTextGlyphPadding(options?.paddingPixel),
    borderColor: options?.borderColor,
    borderWidthPixel: resolveNonNegativeFinite(options?.borderWidthPixel, 0),
    borderRadiusPixel: resolveNonNegativeFinite(options?.borderRadiusPixel, 0),
    borderSides: resolveBorderSides(options?.borderSides),
    textAlign: resolveTextAlign(options?.textAlign),
    renderPixelRatio: resolveRenderPixelRatio(options?.renderPixelRatio),
  };
};

/**
 * Coerces glyph dimensions to positive integers to satisfy canvas requirements.
 * @param {number} value - Raw dimension.
 * @returns {number} Rounded, positive dimension.
 */
const clampGlyphDimension = (value: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : 1;
};

/**
 * Creates a 2D canvas context using either `OffscreenCanvas` or a DOM canvas as fallback.
 * @param {number} width - Canvas width in pixels.
 * @param {number} height - Canvas height in pixels.
 * @returns {{ canvas: Canvas2DSource; ctx: Canvas2DContext }} Canvas and rendering context.
 * @throws When no 2D canvas implementation is available.
 */
const createCanvas2D = (
  width: number,
  height: number
): { canvas: Canvas2DSource; ctx: Canvas2DContext } => {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2d context for text glyph rendering.');
    }
    return { canvas, ctx };
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2d context for text glyph rendering.');
    }
    return { canvas, ctx };
  }

  throw new Error('Canvas 2D is not supported in this environment.');
};

/**
 * Creates an ImageBitmap from a canvas, optionally resizing when a pixel ratio is applied.
 * @param {Canvas2DSource} canvas - Source canvas.
 * @param {number} renderWidth - Width of the rendered content before scaling.
 * @param {number} renderHeight - Height of the rendered content before scaling.
 * @param {number} targetWidth - Width after applying pixel ratio adjustments.
 * @param {number} targetHeight - Height after applying pixel ratio adjustments.
 * @param {number} renderPixelRatio - Pixel ratio used to calculate resize hints.
 * @returns {Promise<ImageBitmap>} Bitmap ready for texture upload.
 */
const createImageBitmapFromCanvas = async (
  canvas: Canvas2DSource,
  renderWidth: number,
  renderHeight: number,
  targetWidth: number,
  targetHeight: number,
  renderPixelRatio: number
): Promise<ImageBitmap> => {
  if (typeof createImageBitmap === 'function') {
    // When renderPixelRatio differs from 1 we request the browser to perform the resize.
    if (renderPixelRatio !== 1) {
      return await createImageBitmap(
        canvas as any,
        0,
        0,
        renderWidth,
        renderHeight,
        {
          resizeWidth: targetWidth,
          resizeHeight: targetHeight,
        }
      );
    }
    return await createImageBitmap(canvas as any);
  }

  const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  if (hasOffscreenCanvas && canvas instanceof OffscreenCanvas) {
    // OffscreenCanvas can provide transferToImageBitmap without DOM involvement.
    if (renderPixelRatio !== 1) {
      const targetCanvas = new OffscreenCanvas(targetWidth, targetHeight);
      const targetCtx = targetCanvas.getContext('2d');
      if (!targetCtx) {
        throw new Error('Failed to acquire 2d context for image resizing.');
      }
      targetCtx.imageSmoothingEnabled = true;
      targetCtx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
      return targetCanvas.transferToImageBitmap();
    }
    return canvas.transferToImageBitmap();
  }

  if (hasOffscreenCanvas) {
    const targetCanvas = new OffscreenCanvas(targetWidth, targetHeight);
    const targetCtx = targetCanvas.getContext('2d');
    if (!targetCtx) {
      throw new Error('Failed to acquire 2d context for image resizing.');
    }
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.drawImage(
      canvas as HTMLCanvasElement,
      0,
      0,
      targetWidth,
      targetHeight
    );
    return targetCanvas.transferToImageBitmap();
  }

  throw new Error('ImageBitmap API is not supported in this environment.');
};

/**
 * Builds a CSS font string from resolved text glyph options.
 * @param {ResolvedTextGlyphOptions} options - Resolved typography options.
 * @returns {string} CSS font shorthand string.
 */
const buildFontString = (options: ResolvedTextGlyphOptions): string =>
  `${options.fontStyle} ${options.fontWeight} ${options.fontSizePixel}px ${options.fontFamily}`;

/**
 * Draws a rounded rectangle path into the provided canvas context.
 * @param {Canvas2DContext} ctx - Canvas 2D context.
 * @param {number} x - X coordinate of the rectangle origin.
 * @param {number} y - Y coordinate of the rectangle origin.
 * @param {number} width - Width of the rectangle.
 * @param {number} height - Height of the rectangle.
 * @param {number} radius - Corner radius in pixels.
 */
const drawRoundedRectPath = (
  ctx: Canvas2DContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) => {
  const maxRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  // If the radius collapses, fall back to a plain rectangle.
  if (maxRadius === 0) {
    ctx.rect(x, y, width, height);
    return;
  }

  ctx.moveTo(x + maxRadius, y);
  ctx.lineTo(x + width - maxRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + maxRadius);
  ctx.lineTo(x + width, y + height - maxRadius);
  ctx.quadraticCurveTo(
    x + width,
    y + height,
    x + width - maxRadius,
    y + height
  );
  ctx.lineTo(x + maxRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - maxRadius);
  ctx.lineTo(x, y + maxRadius);
  ctx.quadraticCurveTo(x, y, x + maxRadius, y);
};

/**
 * Fills a rounded rectangle, preserving canvas state.
 * @param {Canvas2DContext} ctx - Canvas context.
 * @param {number} width - Rectangle width.
 * @param {number} height - Rectangle height.
 * @param {number} radius - Corner radius.
 * @param {string} color - Fill color.
 */
const fillRoundedRect = (
  ctx: Canvas2DContext,
  width: number,
  height: number,
  radius: number,
  color: string
) => {
  ctx.save();
  ctx.beginPath();
  drawRoundedRectPath(ctx, 0, 0, width, height, radius);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
};

/**
 * Strokes a rounded rectangle, preserving canvas state.
 * @param {Canvas2DContext} ctx - Canvas context.
 * @param {number} width - Rectangle width.
 * @param {number} height - Rectangle height.
 * @param {number} radius - Corner radius.
 * @param {string} color - Stroke color.
 * @param {number} lineWidth - Stroke width in pixels.
 * @param {ResolvedBorderSides} sides - Border sides to render.
 */
const strokeRoundedRect = (
  ctx: Canvas2DContext,
  width: number,
  height: number,
  radius: number,
  color: string,
  lineWidth: number,
  sides: ResolvedBorderSides
) => {
  const { top, right, bottom, left } = sides;
  if (lineWidth <= 0 || (!top && !right && !bottom && !left)) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;

  const cornerRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  const previousCap = ctx.lineCap;
  ctx.lineCap = cornerRadius === 0 ? 'square' : 'butt';

  if (top) {
    const startX = cornerRadius;
    const endX = width - cornerRadius;
    if (endX > startX) {
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(endX, 0);
      ctx.stroke();
    }
  }

  if (right) {
    const startY = cornerRadius;
    const endY = height - cornerRadius;
    if (endY > startY) {
      ctx.beginPath();
      ctx.moveTo(width, startY);
      ctx.lineTo(width, endY);
      ctx.stroke();
    }
  }

  if (bottom) {
    const startX = width - cornerRadius;
    const endX = cornerRadius;
    if (startX > endX) {
      ctx.beginPath();
      ctx.moveTo(startX, height);
      ctx.lineTo(endX, height);
      ctx.stroke();
    }
  }

  if (left) {
    const startY = height - cornerRadius;
    const endY = cornerRadius;
    if (startY > endY) {
      ctx.beginPath();
      ctx.moveTo(0, startY);
      ctx.lineTo(0, endY);
      ctx.stroke();
    }
  }

  ctx.lineCap = previousCap;
  ctx.restore();
};

/**
 * Measures text width while considering custom letter spacing.
 * @param {Canvas2DContext} ctx - Canvas context.
 * @param {string} text - Text to measure.
 * @param {number} letterSpacing - Additional spacing between glyphs.
 * @returns {number} Width in pixels.
 */
const measureTextWidthWithSpacing = (
  ctx: Canvas2DContext,
  text: string,
  letterSpacing: number
): number => {
  // Empty strings contribute zero width regardless of spacing.
  if (text.length === 0) {
    return 0;
  }
  // When no spacing is requested rely on the built-in measurement.
  if (letterSpacing === 0) {
    return ctx.measureText(text).width;
  }

  const glyphs = Array.from(text);
  let total = 0;
  for (const glyph of glyphs) {
    total += ctx.measureText(glyph).width;
  }
  return total + letterSpacing * Math.max(0, glyphs.length - 1);
};

/**
 * Estimates text height using font metrics with fallbacks for older browsers.
 * @param {Canvas2DContext} ctx - Canvas context.
 * @param {string} text - Text to measure.
 * @param {number} fontSize - Font size in pixels used to derive fallbacks.
 * @returns {number} Text height in pixels.
 */
const measureTextHeight = (
  ctx: Canvas2DContext,
  text: string,
  fontSize: number
): number => {
  const metrics = ctx.measureText(text);
  const fallbackAscent = fontSize * 0.8;
  const fallbackDescent = fontSize * 0.2;
  const ascent = Number.isFinite(metrics.actualBoundingBoxAscent)
    ? metrics.actualBoundingBoxAscent
    : fallbackAscent;
  const descent = Number.isFinite(metrics.actualBoundingBoxDescent)
    ? metrics.actualBoundingBoxDescent
    : fallbackDescent;
  const height = ascent + descent;
  // Use measured height only when valid; otherwise fall back to font size for readability.
  if (Number.isFinite(height) && height > 0) {
    return height;
  }
  return Math.max(fontSize, 1);
};

/**
 * Draws text while applying uniform letter spacing between glyphs.
 * @param {Canvas2DContext} ctx - Canvas context.
 * @param {string} text - Text to render.
 * @param {number} startX - Initial X coordinate.
 * @param {number} y - Baseline Y coordinate.
 * @param {number} letterSpacing - Additional spacing per glyph.
 */
const drawTextWithLetterSpacing = (
  ctx: Canvas2DContext,
  text: string,
  startX: number,
  y: number,
  letterSpacing: number
) => {
  if (text.length === 0) {
    return;
  }
  // When spacing is zero fall back to a single fillText call for performance.
  if (letterSpacing === 0) {
    ctx.fillText(text, startX, y);
    return;
  }

  const glyphs = Array.from(text);
  let cursorX = startX;
  for (const glyph of glyphs) {
    ctx.fillText(glyph, cursorX, y);
    cursorX += ctx.measureText(glyph).width + letterSpacing;
  }
};

/**
 * Clones an optional origin location descriptor to avoid mutating caller state.
 * @param {SpriteImageOriginLocation} [origin] - Source origin definition.
 * @returns {SpriteImageOriginLocation | undefined} Deep clone of the origin or `undefined` when absent.
 */
const cloneOriginLocation = (
  origin?: SpriteImageOriginLocation
): SpriteImageOriginLocation | undefined => {
  if (!origin) {
    return undefined;
  }
  const result: SpriteImageOriginLocation = {
    subLayer: origin.subLayer,
    order: origin.order,
  };
  if (origin.useResolvedAnchor !== undefined) {
    result.useResolvedAnchor = origin.useResolvedAnchor;
  }
  return result;
};

/**
 * Clones a sprite anchor, defaulting to the origin when none supplied.
 * @param {SpriteAnchor} [anchor] - Anchor to clone.
 * @returns {SpriteAnchor} Safe copy for mutation within the layer state.
 */
export const cloneAnchor = (anchor?: SpriteAnchor): SpriteAnchor => {
  if (!anchor) {
    return { ...DEFAULT_ANCHOR };
  }
  return { x: anchor.x, y: anchor.y };
};

/**
 * Clones an image offset, applying defaults when missing.
 * @param {SpriteImageOffset} [offset] - Offset definition to copy.
 * @returns {SpriteImageOffset} Cloned offset structure.
 */
export const cloneOffset = (offset?: SpriteImageOffset): SpriteImageOffset => {
  if (!offset) {
    return { ...DEFAULT_IMAGE_OFFSET };
  }
  return {
    offsetMeters: offset.offsetMeters,
    offsetDeg: offset.offsetDeg,
  };
};

/**
 * Deep-clones interpolation options to prevent shared references between sprites.
 * @param {SpriteInterpolationOptions} options - Options provided by the user.
 * @returns {SpriteInterpolationOptions} Cloned options object.
 */
export const cloneInterpolationOptions = (
  options: SpriteInterpolationOptions
): SpriteInterpolationOptions => {
  return {
    mode: options.mode,
    durationMs: options.durationMs,
    easing: options.easing,
  };
};

/**
 * Creates internal sprite image state from initialization data and layer bookkeeping fields.
 * @param {SpriteImageDefinitionInit} imageInit - Caller-provided image definition.
 * @param {number} subLayer - Sub-layer index the image belongs to.
 * @param {number} order - Ordering slot within the sub-layer.
 * @param {SpriteOriginReference} originReference - Encode/Decode origin reference.
 * @returns {InternalSpriteImageState} Normalized internal state ready for rendering.
 */
export const createImageStateFromInit = (
  imageInit: SpriteImageDefinitionInit,
  subLayer: number,
  order: number,
  originReference: SpriteOriginReference
): InternalSpriteImageState => {
  const mode = imageInit.mode ?? 'surface';
  const autoRotationDefault = mode === 'surface';
  const initialOffset = cloneOffset(imageInit.offset);
  const initialRotateDeg = normalizeAngleDeg(imageInit.rotateDeg ?? 0);
  const originLocation = cloneOriginLocation(imageInit.originLocation);
  const originReferenceKey =
    originLocation !== undefined
      ? originReference.encodeKey(originLocation.subLayer, originLocation.order)
      : SPRITE_ORIGIN_REFERENCE_KEY_NONE;
  const state: InternalSpriteImageState = {
    subLayer,
    order,
    imageId: imageInit.imageId,
    imageHandle: 0,
    mode,
    opacity: imageInit.opacity ?? 1.0,
    scale: imageInit.scale ?? 1.0,
    anchor: cloneAnchor(imageInit.anchor),
    offset: initialOffset,
    rotateDeg: imageInit.rotateDeg ?? 0,
    displayedRotateDeg: initialRotateDeg,
    autoRotation: imageInit.autoRotation ?? autoRotationDefault,
    autoRotationMinDistanceMeters:
      imageInit.autoRotationMinDistanceMeters ??
      DEFAULT_AUTO_ROTATION_MIN_DISTANCE_METERS,
    resolvedBaseRotateDeg: 0,
    originLocation,
    originReferenceKey,
    originRenderTargetIndex: SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
    rotationInterpolationState: null,
    rotationInterpolationOptions: null,
    offsetDegInterpolationState: null,
    offsetMetersInterpolationState: null,
    lastCommandRotateDeg: initialRotateDeg,
    lastCommandOffsetDeg: initialOffset.offsetDeg,
    lastCommandOffsetMeters: initialOffset.offsetMeters,
  };
  // Preload rotation interpolation defaults when supplied on initialization; otherwise treat as absent.
  const rotateInitOption = imageInit.interpolation?.rotateDeg ?? null;
  if (rotateInitOption) {
    state.rotationInterpolationOptions =
      cloneInterpolationOptions(rotateInitOption);
  }

  syncImageRotationChannel(state);

  return state;
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Factory that creates the MapLibre layer interface for the sprite layer.
 * Implements the CustomLayerInterface lifecycle (init -> render -> dispose), packing thousands
 * of sprites into GPU buffers for efficient rendering. Supports optional scaling controls for
 * billboard and surface modes.
 *
 * @template T Arbitrary tag type for per-sprite metadata.
 * @param {SpriteLayerOptions} [options] Initial layer options such as ID or scaling settings.
 * @returns {SpriteLayerInterface<T>} Interface for sprite add/update/remove operations and MapLibre hooks.
 */
export const createSpriteLayer = <T = any>(
  options?: SpriteLayerOptions
): SpriteLayerInterface<T> => {
  // Use caller-supplied layer ID when provided, otherwise fall back to a default identifier.
  const id = options?.id ?? 'sprite-layer';
  let resolvedScaling = resolveScalingOptions(options?.spriteScaling);
  const resolvedTextureFiltering = resolveTextureFilteringOptions(
    options?.textureFiltering
  );
  const showDebugBounds = options?.showDebugBounds === true;

  const createProjectionHostForMap = (
    mapInstance: MapLibreMap
  ): ProjectionHost => {
    const params = createProjectionHostParamsFromMapLibre(mapInstance);
    if (isSpriteLayerHostEnabled()) {
      return createWasmProjectionHost(params);
    }
    return createProjectionHost(params);
    // return createMapLibreProjectionHost(mapInstance);
  };

  const createCalculationHostForMap = (
    mapInstance: MapLibreMap
  ): RenderCalculationHost<T> => {
    const params = createProjectionHostParamsFromMapLibre(mapInstance);
    if (isSpriteLayerHostEnabled()) {
      return createWasmCalculationHost<T>(params, {
        imageIdHandler,
        imageHandleBuffersController,
        originReference,
        spriteIdHandler,
      });
    }
    return createCalculationHost<T>(params);
    // return createMapLibreCalculationHost<TTag>(mapInstance);
  };

  /** WebGL context supplied by MapLibre, assigned during onAdd. */
  let gl: WebGLRenderingContext | null = null;
  /** MapLibre map instance provided to the custom layer. */
  let map: MapLibreMap | null = null;
  /** Compiled WebGL program. */
  let program: WebGLProgram | null = null;
  /** Vertex buffer used for quad geometry. */
  let vertexBuffer: WebGLBuffer | null = null;
  /** Attribute location for vertex positions. */
  let attribPositionLocation = -1;
  /** Attribute location for UV coordinates. */
  let attribUvLocation = -1;
  /** Uniform location for the texture sampler. */
  let uniformTextureLocation: WebGLUniformLocation | null = null;
  /** Uniform location for sprite opacity. */
  let uniformOpacityLocation: WebGLUniformLocation | null = null;
  /** Uniform location for the screen-to-clip scale vector. */
  let uniformScreenToClipScaleLocation: WebGLUniformLocation | null = null;
  /** Uniform location for the screen-to-clip offset vector. */
  let uniformScreenToClipOffsetLocation: WebGLUniformLocation | null = null;
  /** Uniform location toggling shader-based billboard geometry. */
  let uniformBillboardModeLocation: WebGLUniformLocation | null = null;
  /** Uniform location for the billboard center in screen space. */
  let uniformBillboardCenterLocation: WebGLUniformLocation | null = null;
  /** Uniform location for the billboard half-size in pixels. */
  let uniformBillboardHalfSizeLocation: WebGLUniformLocation | null = null;
  /** Uniform location for the billboard anchor vector. */
  let uniformBillboardAnchorLocation: WebGLUniformLocation | null = null;
  /** Uniform location for billboard rotation sine/cosine. */
  let uniformBillboardSinCosLocation: WebGLUniformLocation | null = null;
  /** Uniform location toggling shader-based surface geometry. */
  let uniformSurfaceModeLocation: WebGLUniformLocation | null = null;
  /** Uniform location for surface depth bias multiplier. */
  let uniformSurfaceDepthBiasLocation: WebGLUniformLocation | null = null;
  /** Uniform enabling clip-space surface reconstruction. */
  let uniformSurfaceClipEnabledLocation: WebGLUniformLocation | null = null;
  /** Uniform location for the surface clip-space center. */
  let uniformSurfaceClipCenterLocation: WebGLUniformLocation | null = null;
  /** Uniform location for the surface clip-space east basis vector. */
  let uniformSurfaceClipBasisEastLocation: WebGLUniformLocation | null = null;
  /** Uniform location for the surface clip-space north basis vector. */
  let uniformSurfaceClipBasisNorthLocation: WebGLUniformLocation | null = null;
  /** Cached anisotropic filtering extension instance (when available). */
  let anisotropyExtension: EXT_texture_filter_anisotropic | null = null;
  /** Maximum anisotropy supported by the current context. */
  let maxSupportedAnisotropy = 1;
  /** Debug outline shader program for rendering hit-test rectangles. */
  let debugProgram: WebGLProgram | null = null;
  /** Vertex buffer storing quad outline vertices during debug rendering. */
  let debugVertexBuffer: WebGLBuffer | null = null;
  /** Attribute location for debug outline vertex positions. */
  let debugAttribPositionLocation = -1;
  /** Uniform location for debug outline color. */
  let debugUniformColorLocation: WebGLUniformLocation | null = null;
  /** Debug uniform location for converting screen to clip space. */
  let debugUniformScreenToClipScaleLocation: WebGLUniformLocation | null = null;
  /** Debug uniform location for the screen-to-clip offset vector. */
  let debugUniformScreenToClipOffsetLocation: WebGLUniformLocation | null =
    null;

  //////////////////////////////////////////////////////////////////////////

  /** Sprite image atlas manager coordinating page packing. */
  const atlasManager = createAtlasManager();
  /** Active WebGL textures keyed by atlas page index. */
  const atlasPageTextures = new Map<number, WebGLTexture>();
  /** Flag indicating atlas pages require GPU upload. */
  let atlasNeedsUpload = false;
  /** Deferred handler invoked when the atlas queue processes entries. */
  let handleAtlasQueueChunkProcessed: (() => void) | null = null;

  const atlasQueue = createAtlasOperationQueue(
    atlasManager,
    {
      maxOperationsPerPass: ATLAS_QUEUE_CHUNK_SIZE,
      timeBudgetMs: ATLAS_QUEUE_TIME_BUDGET_MS,
    },
    {
      onChunkProcessed: () => {
        handleAtlasQueueChunkProcessed?.();
      },
    }
  );

  /** Pending text glyph identifiers awaiting generation. */
  const pendingTextGlyphIds = new Set<string>();

  interface TextGlyphQueueEntry {
    readonly glyphId: string;
    readonly text: string;
    readonly dimensions: SpriteTextGlyphDimensions;
    readonly options?: SpriteTextGlyphOptions;
    readonly deferred: Deferred<boolean>;
    readonly signal?: AbortSignal;
    readonly abortHandle: Releasable | null;
  }

  const textGlyphQueue: TextGlyphQueueEntry[] = [];
  let textGlyphQueueTimer: ReturnType<typeof setTimeout> | null = null;
  let isProcessingTextGlyphQueue = false;

  const now = (): number =>
    typeof performance !== 'undefined' ? performance.now() : Date.now();

  const scheduleTextGlyphQueueProcessing = (): void => {
    if (textGlyphQueueTimer) {
      return;
    }
    textGlyphQueueTimer = setTimeout(() => {
      textGlyphQueueTimer = null;
      void processTextGlyphQueueChunk();
    }, 0);
  };

  const enqueueTextGlyphJob = (entry: TextGlyphQueueEntry): void => {
    textGlyphQueue.push(entry);
    scheduleTextGlyphQueueProcessing();
  };

  const cancelPendingTextGlyphJob = (imageId: string, reason?: Error): void => {
    for (let idx = textGlyphQueue.length - 1; idx >= 0; idx -= 1) {
      const entry = textGlyphQueue[idx];
      if (entry && entry.glyphId === imageId) {
        textGlyphQueue.splice(idx, 1);
        pendingTextGlyphIds.delete(imageId);
        entry.abortHandle?.release();
        entry.deferred.reject(
          reason ??
            new Error(
              `[SpriteLayer][GlyphQueue] Image "${imageId}" was cancelled before generation.`
            )
        );
      }
    }
  };

  const rejectAllPendingTextGlyphJobs = (reason: Error): void => {
    while (textGlyphQueue.length > 0) {
      const entry = textGlyphQueue.shift();
      if (entry) {
        pendingTextGlyphIds.delete(entry.glyphId);
        entry.abortHandle?.release();
        entry.deferred.reject(reason);
      }
    }
  };

  const executeTextGlyphJob = async (
    entry: TextGlyphQueueEntry
  ): Promise<void> => {
    if (entry.signal?.aborted) {
      entry.abortHandle?.release();
      entry.deferred.reject(entry.signal.reason);
      pendingTextGlyphIds.delete(entry.glyphId);
      return;
    }
    if (images.has(entry.glyphId)) {
      entry.abortHandle?.release();
      entry.deferred.resolve(false);
      pendingTextGlyphIds.delete(entry.glyphId);
      return;
    }
    if (!pendingTextGlyphIds.has(entry.glyphId)) {
      entry.abortHandle?.release();
      entry.deferred.reject(
        new Error(
          `[SpriteLayer][GlyphQueue] Image "${entry.glyphId}" was removed before generation.`
        )
      );
      return;
    }
    let registeredImage: RegisteredImage | null = null;
    try {
      const { bitmap, width, height } = await renderTextGlyphBitmap(
        entry.text,
        entry.dimensions,
        entry.options
      );
      const handle = imageIdHandler.allocate(entry.glyphId);
      registeredImage = {
        id: entry.glyphId,
        handle,
        width,
        height,
        bitmap,
        texture: undefined,
        atlasPageIndex: ATLAS_PAGE_INDEX_NONE,
        atlasU0: 0,
        atlasV0: 0,
        atlasU1: 1,
        atlasV1: 1,
      };
      images.set(entry.glyphId, registeredImage);
      imageIdHandler.store(handle, registeredImage);
      updateSpriteImageHandles(entry.glyphId, handle);
      imageHandleBuffersController.markDirty(images);

      const atlasDeferred = createDeferred<boolean>();
      atlasQueue.enqueueUpsert({
        imageId: entry.glyphId,
        bitmap,
        deferred: atlasDeferred,
      });
      await atlasDeferred.promise;

      entry.deferred.resolve(true);
    } catch (error) {
      if (registeredImage) {
        images.delete(entry.glyphId);
        imageIdHandler.release(entry.glyphId);
        updateSpriteImageHandles(entry.glyphId, 0);
        imageHandleBuffersController.markDirty(images);
        atlasManager.removeImage(entry.glyphId);
        registeredImage.bitmap.close?.();
      }
      entry.deferred.reject(error);
    }
    pendingTextGlyphIds.delete(entry.glyphId);
    entry.abortHandle?.release();
  };

  const processTextGlyphQueueChunk = async (): Promise<void> => {
    if (isProcessingTextGlyphQueue || textGlyphQueue.length === 0) {
      return;
    }
    isProcessingTextGlyphQueue = true;
    const budgetStart = now();
    let processedCount = 0;
    try {
      while (textGlyphQueue.length > 0) {
        const entry = textGlyphQueue.shift()!;
        await executeTextGlyphJob(entry);
        processedCount += 1;
        if (processedCount >= TEXT_GLYPH_QUEUE_CHUNK_SIZE) {
          break;
        }
        if (now() - budgetStart >= TEXT_GLYPH_QUEUE_TIME_BUDGET_MS) {
          break;
        }
      }
    } finally {
      isProcessingTextGlyphQueue = false;
    }
    if (textGlyphQueue.length > 0) {
      scheduleTextGlyphQueueProcessing();
    }
  };

  /**
   * Determines whether any atlas page requires uploading or missing texture recreation.
   * @param pageStates Optional atlas page list to evaluate.
   * @returns True when at least one page is dirty or lacks a matching GL texture.
   */
  const shouldUploadAtlasPages = (
    pageStates?: readonly AtlasPageState[]
  ): boolean => {
    const pages = pageStates ?? atlasManager.getPages();
    for (const page of pages) {
      if (page.needsUpload) {
        return true;
      }
      if (!atlasPageTextures.has(page.index)) {
        return true;
      }
    }
    return false;
  };

  /**
   * Registry of loaded images, pairing ImageBitmaps with WebGL textures.
   */
  const images = new Map<string, RegisteredImage>();

  /**
   * Maps image identifiers to their numeric handles.
   * @remarks It is used for (wasm) interoperability for image identity.
   */
  const imageIdHandler = createIdHandler<RegisteredImage>();

  /**
   * Maps sprite identifiers to numeric handles for wasm interop.
   */
  const spriteIdHandler = createIdHandler<InternalSpriteCurrentState<T>>();

  /**
   * Create image handle buffer controller.
   * @remarks It is used for (wasm) interoperability for image identity.
   */
  const imageHandleBuffersController = createImageHandleBufferController();

  /**
   * Resolve registered image handle for specified identifier.
   * @param imageId Image identifier.
   * @returns Image handle or 0 when not registered.
   * @remarks It is used for (wasm) interoperability for image identity.
   */
  const resolveImageHandle = (imageId: string): number => {
    const resource = images.get(imageId);
    return resource ? resource.handle : 0;
  };

  /**
   * Encode/Decode for a (subLayer, order) pair into a compact numeric key.
   */
  const originReference = createSpriteOriginReference();

  /**
   * Synchronizes atlas placements from the atlas manager into registered images.
   * Marks atlas textures as dirty when placements change.
   */
  const syncAtlasPlacementsFromManager = (): void => {
    let placementsChanged = false;
    images.forEach((image, imageId) => {
      const placement = atlasManager.getImagePlacement(imageId);
      if (!placement) {
        if (
          image.atlasPageIndex !== ATLAS_PAGE_INDEX_NONE ||
          image.atlasU0 !== 0 ||
          image.atlasV0 !== 0 ||
          image.atlasU1 !== 1 ||
          image.atlasV1 !== 1
        ) {
          image.atlasPageIndex = ATLAS_PAGE_INDEX_NONE;
          image.atlasU0 = 0;
          image.atlasV0 = 0;
          image.atlasU1 = 1;
          image.atlasV1 = 1;
          image.texture = undefined;
          placementsChanged = true;
        }
        return;
      }
      if (
        image.atlasPageIndex !== placement.pageIndex ||
        image.atlasU0 !== placement.u0 ||
        image.atlasV0 !== placement.v0 ||
        image.atlasU1 !== placement.u1 ||
        image.atlasV1 !== placement.v1
      ) {
        image.atlasPageIndex = placement.pageIndex;
        image.atlasU0 = placement.u0;
        image.atlasV0 = placement.v0;
        image.atlasU1 = placement.u1;
        image.atlasV1 = placement.v1;
        image.texture = undefined;
        placementsChanged = true;
      }
    });
    if (placementsChanged) {
      imageHandleBuffersController.markDirty(images);
    }
    atlasNeedsUpload = placementsChanged || shouldUploadAtlasPages();
  };

  /**
   * Collection of sprites currently managed by the layer.
   */
  const sprites = new Map<string, InternalSpriteCurrentState<T>>();

  /**
   * Updates image handle for every sprite image referencing the specified identifier.
   * @param imageId Image identifier.
   * @param handle Resolved handle (0 when not registered).
   */
  const updateSpriteImageHandles = (imageId: string, handle: number): void => {
    sprites.forEach((sprite) => {
      sprite.images.forEach((orderMap) => {
        orderMap.forEach((imageState) => {
          if (imageState.imageId === imageId) {
            imageState.imageHandle = handle;
          }
        });
      });
    });
  };

  /**
   * State stored in the QuadTree used for hit testing.
   */
  interface HitTestTreeState {
    readonly sprite: Readonly<InternalSpriteCurrentState<T>>;
    readonly image: Readonly<InternalSpriteImageState>;
    drawIndex: number;
  }

  /**
   * Hit-test QuadTree based on longitude and latitude.
   */
  const hitTestTree: LooseQuadTree<HitTestTreeState> = createLooseQuadTree({
    bounds: HIT_TEST_WORLD_BOUNDS,
  });

  interface HitTestTreeHandle {
    rect: Readonly<LooseQuadTreeRect>;
    item: Readonly<LooseQuadTreeItem<HitTestTreeState>>;
  }

  /**
   * Reverse lookup table from an image state to the corresponding QuadTree item.
   * Using a WeakMap avoids blocking GC when an image is disposed.
   */
  let hitTestTreeItems = new WeakMap<
    InternalSpriteImageState,
    HitTestTreeHandle
  >();

  let isHitTestEnabled = true;

  /**
   * Computes an axis-aligned rectangle that encloses the given longitude/latitude points.
   * @param {SpriteLocation[]} points - List of geographic coordinates to include.
   * @returns {LooseQuadTreeRect | null} Generated rectangle; returns null when the input is invalid.
   */
  const rectFromLngLatPoints = (
    points: readonly Readonly<SpriteLocation>[]
  ): LooseQuadTreeRect | null => {
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;

    for (const point of points) {
      if (
        !point ||
        !Number.isFinite(point.lng) ||
        !Number.isFinite(point.lat)
      ) {
        continue;
      }
      if (point.lng < minLng) minLng = point.lng;
      if (point.lng > maxLng) maxLng = point.lng;
      if (point.lat < minLat) minLat = point.lat;
      if (point.lat > maxLat) maxLat = point.lat;
    }

    if (
      minLng === Number.POSITIVE_INFINITY ||
      maxLng === Number.NEGATIVE_INFINITY ||
      minLat === Number.POSITIVE_INFINITY ||
      maxLat === Number.NEGATIVE_INFINITY
    ) {
      return null;
    }

    return {
      x0: Math.max(
        HIT_TEST_WORLD_BOUNDS.x0,
        Math.min(minLng, HIT_TEST_WORLD_BOUNDS.x1)
      ),
      y0: Math.max(
        HIT_TEST_WORLD_BOUNDS.y0,
        Math.min(minLat, HIT_TEST_WORLD_BOUNDS.y1)
      ),
      x1: Math.max(
        HIT_TEST_WORLD_BOUNDS.x0,
        Math.min(maxLng, HIT_TEST_WORLD_BOUNDS.x1)
      ),
      y1: Math.max(
        HIT_TEST_WORLD_BOUNDS.y0,
        Math.min(maxLat, HIT_TEST_WORLD_BOUNDS.y1)
      ),
    };
  };

  /**
   * Creates a rectangle based on the built-in safety radius shared by surface and billboard modes.
   * @param {SpriteLocation} base - Center geographic coordinate.
   * @param {number} radiusMeters - Safety radius in meters along east-west and north-south.
   * @returns {LooseQuadTreeRect | null} Generated rectangle.
   */
  const rectFromRadiusMeters = (
    base: Readonly<SpriteLocation>,
    radiusMeters: number
  ): LooseQuadTreeRect | null => {
    if (
      !Number.isFinite(base.lng) ||
      !Number.isFinite(base.lat) ||
      !Number.isFinite(radiusMeters) ||
      radiusMeters <= 0
    ) {
      return null;
    }

    const cornerNE = applySurfaceDisplacement(base, {
      east: radiusMeters,
      north: radiusMeters,
    });
    const cornerSW = applySurfaceDisplacement(base, {
      east: -radiusMeters,
      north: -radiusMeters,
    });

    return rectFromLngLatPoints([cornerNE, cornerSW]);
  };

  /**
   * Estimates the geographic rectangle that a surface-mode image may occupy.
   * @param {ProjectionHost} projectionHost - Projection host.
   * @param {InternalSpriteCurrentState<T>} sprite - Target sprite.
   * @param {InternalSpriteImageState} image - Target image.
   * @returns {LooseQuadTreeRect | null} Estimated rectangle.
   */
  const estimateSurfaceImageBounds = (
    projectionHost: ProjectionHost,
    sprite: Readonly<InternalSpriteCurrentState<T>>,
    image: Readonly<InternalSpriteImageState>
  ): LooseQuadTreeRect | null => {
    const imageResource = images.get(image.imageId);
    if (!imageResource) {
      return null;
    }

    const baseLocation = sprite.currentLocation;
    const zoom = projectionHost.getZoom();
    const zoomScaleFactor = calculateZoomScaleFactor(zoom, resolvedScaling);
    const metersPerPixelAtLat = calculateMetersPerPixelAtLatitude(
      zoom,
      baseLocation.lat
    );
    if (!Number.isFinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0) {
      return null;
    }

    const spriteMercator = resolveSpriteMercator(projectionHost, sprite);
    const perspectiveRatio = projectionHost.calculatePerspectiveRatio(
      baseLocation,
      spriteMercator
    );
    const effectivePixelsPerMeter = calculateEffectivePixelsPerMeter(
      metersPerPixelAtLat,
      perspectiveRatio
    );
    if (
      !Number.isFinite(effectivePixelsPerMeter) ||
      effectivePixelsPerMeter <= 0
    ) {
      return null;
    }

    const imageScale = image.scale ?? 1;
    const baseMetersPerPixel = resolvedScaling.metersPerPixel;
    const spriteMinPixel = resolvedScaling.spriteMinPixel;
    const spriteMaxPixel = resolvedScaling.spriteMaxPixel;

    const worldDims = calculateSurfaceWorldDimensions(
      imageResource.width,
      imageResource.height,
      baseMetersPerPixel,
      imageScale,
      zoomScaleFactor,
      {
        effectivePixelsPerMeter,
        spriteMinPixel,
        spriteMaxPixel,
      }
    );
    if (worldDims.width <= 0 || worldDims.height <= 0) {
      return null;
    }

    const anchor = image.anchor ?? DEFAULT_ANCHOR;
    const offsetDef = image.offset ?? DEFAULT_IMAGE_OFFSET;
    const offsetMetersVec = calculateSurfaceOffsetMeters(
      offsetDef,
      imageScale,
      zoomScaleFactor,
      worldDims.scaleAdjustment
    );

    const totalRotateDeg = Number.isFinite(image.displayedRotateDeg)
      ? image.displayedRotateDeg
      : normalizeAngleDeg(
          (image.resolvedBaseRotateDeg ?? 0) + (image.rotateDeg ?? 0)
        );

    const cornerDisplacements = calculateSurfaceCornerDisplacements({
      worldWidthMeters: worldDims.width,
      worldHeightMeters: worldDims.height,
      anchor,
      totalRotateDeg,
      offsetMeters: offsetMetersVec,
    });

    const corners = cornerDisplacements.map((corner) =>
      applySurfaceDisplacement(baseLocation, corner)
    );
    return rectFromLngLatPoints(corners);
  };

  /**
   * Estimates the geographic rectangle that a billboard-mode image may occupy.
   * Currently evaluates it using a safety radius converted from screen pixels to meters.
   * @param {InternalSpriteCurrentState<T>} sprite - Target sprite.
   * @param {InternalSpriteImageState} image - Target image.
   * @returns {LooseQuadTreeRect | null} Estimated rectangle.
   */
  const estimateBillboardImageBounds = (
    projectionHost: ProjectionHost,
    sprite: InternalSpriteCurrentState<T>,
    image: InternalSpriteImageState
  ): LooseQuadTreeRect | null => {
    const imageResource = images.get(image.imageId);
    if (!imageResource) {
      return null;
    }

    const baseLocation = sprite.currentLocation;
    const zoom = projectionHost.getZoom();
    const zoomScaleFactor = calculateZoomScaleFactor(zoom, resolvedScaling);
    const metersPerPixelAtLat = calculateMetersPerPixelAtLatitude(
      zoom,
      baseLocation.lat
    );
    if (!Number.isFinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0) {
      return null;
    }

    const spriteMercator = resolveSpriteMercator(projectionHost, sprite);
    const perspectiveRatio = projectionHost.calculatePerspectiveRatio(
      baseLocation,
      spriteMercator
    );
    const effectivePixelsPerMeter = calculateEffectivePixelsPerMeter(
      metersPerPixelAtLat,
      perspectiveRatio
    );
    if (
      !Number.isFinite(effectivePixelsPerMeter) ||
      effectivePixelsPerMeter <= 0
    ) {
      return null;
    }

    const baseMetersPerPixel = resolvedScaling.metersPerPixel;
    const spriteMinPixel = resolvedScaling.spriteMinPixel;
    const spriteMaxPixel = resolvedScaling.spriteMaxPixel;
    const imageScale = image.scale ?? 1;
    const totalRotateDeg = Number.isFinite(image.displayedRotateDeg)
      ? image.displayedRotateDeg
      : normalizeAngleDeg(
          (image.resolvedBaseRotateDeg ?? 0) + (image.rotateDeg ?? 0)
        );

    const pixelDims = calculateBillboardPixelDimensions(
      imageResource.width,
      imageResource.height,
      baseMetersPerPixel,
      imageScale,
      zoomScaleFactor,
      effectivePixelsPerMeter,
      spriteMinPixel,
      spriteMaxPixel
    );

    const halfWidthMeters = pixelDims.width / 2 / effectivePixelsPerMeter;
    const halfHeightMeters = pixelDims.height / 2 / effectivePixelsPerMeter;

    const anchorShift = calculateBillboardAnchorShiftPixels(
      pixelDims.width / 2,
      pixelDims.height / 2,
      image.anchor,
      totalRotateDeg
    );

    const offsetShift = calculateBillboardOffsetPixels(
      image.offset ?? DEFAULT_IMAGE_OFFSET,
      imageScale,
      zoomScaleFactor,
      effectivePixelsPerMeter
    );

    const anchorShiftMeters =
      Math.hypot(anchorShift.x, anchorShift.y) / effectivePixelsPerMeter;
    const offsetShiftMeters =
      Math.hypot(offsetShift.x, offsetShift.y) / effectivePixelsPerMeter;
    const safetyRadius =
      Math.hypot(halfWidthMeters, halfHeightMeters) +
      anchorShiftMeters +
      offsetShiftMeters;

    return rectFromRadiusMeters(baseLocation, safetyRadius);
  };

  /**
   * Estimates the geographic bounding box of an image.
   * @param {ProjectionHost} projectionHost - Projection host.
   * @param {InternalSpriteCurrentState<T>} sprite - Target sprite.
   * @param {InternalSpriteImageState} image - Target image.
   * @returns {LooseQuadTreeRect | null} Estimated rectangle.
   */
  const estimateImageBounds = (
    projectionHost: ProjectionHost,
    sprite: Readonly<InternalSpriteCurrentState<T>>,
    image: Readonly<InternalSpriteImageState>
  ): LooseQuadTreeRect | null => {
    if (image.opacity <= 0 || !sprite.isEnabled) {
      return null;
    }
    if (image.mode === 'surface') {
      return estimateSurfaceImageBounds(projectionHost, sprite, image);
    }
    return estimateBillboardImageBounds(projectionHost, sprite, image);
  };

  const removeImageBoundsFromHitTestTree = (
    image: InternalSpriteImageState
  ): void => {
    const handle = hitTestTreeItems.get(image);
    if (!handle) {
      return;
    }
    hitTestTree.remove(
      handle.rect.x0,
      handle.rect.y0,
      handle.rect.x1,
      handle.rect.y1,
      handle.item
    );
    hitTestTreeItems.delete(image);
  };

  const setItemRect = (
    item: LooseQuadTreeItem<HitTestTreeState>,
    rect: LooseQuadTreeRect
  ): void => {
    const mutable = item as unknown as {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    };
    mutable.x0 = rect.x0;
    mutable.y0 = rect.y0;
    mutable.x1 = rect.x1;
    mutable.y1 = rect.y1;
  };

  const registerImageBoundsInHitTestTree = (
    projectionHost: ProjectionHost,
    sprite: Readonly<InternalSpriteCurrentState<T>>,
    image: Readonly<InternalSpriteImageState>
  ): void => {
    const existingHandle = hitTestTreeItems.get(image);

    if (!isHitTestEnabled) {
      if (existingHandle) {
        removeImageBoundsFromHitTestTree(image);
      }
      return;
    }

    const rect = estimateImageBounds(projectionHost, sprite, image);

    if (!rect) {
      if (existingHandle) {
        removeImageBoundsFromHitTestTree(image);
      }
      return;
    }
    if (!existingHandle) {
      const handle: HitTestTreeHandle = {
        rect,
        item: {
          x0: rect.x0,
          y0: rect.y0,
          x1: rect.x1,
          y1: rect.y1,
          state: {
            sprite,
            image,
            drawIndex: 0,
          },
        },
      };
      hitTestTree.add(handle.item);
      hitTestTreeItems.set(image, handle);
      return;
    }

    const currentRect = existingHandle.rect;
    const unchanged =
      currentRect.x0 === rect.x0 &&
      currentRect.y0 === rect.y0 &&
      currentRect.x1 === rect.x1 &&
      currentRect.y1 === rect.y1;

    if (unchanged) {
      return;
    }

    const updated = hitTestTree.update(
      currentRect.x0,
      currentRect.y0,
      currentRect.x1,
      currentRect.y1,
      rect.x0,
      rect.y0,
      rect.x1,
      rect.y1,
      existingHandle.item
    );

    if (updated) {
      existingHandle.rect = rect;
      setItemRect(existingHandle.item, rect);
      return;
    }

    // Fallback: remove and re-add when update failed (e.g., stale registry).
    removeImageBoundsFromHitTestTree(image);
    const newHandle: HitTestTreeHandle = {
      rect,
      item: {
        x0: rect.x0,
        y0: rect.y0,
        x1: rect.x1,
        y1: rect.y1,
        state: {
          sprite,
          image,
          drawIndex: 0,
        },
      },
    };
    hitTestTree.add(newHandle.item);
    hitTestTreeItems.set(image, newHandle);
  };

  const refreshSpriteHitTestBounds = (
    projectionHost: ProjectionHost,
    sprite: Readonly<InternalSpriteCurrentState<T>>
  ): void => {
    sprite.images.forEach((orderMap) => {
      orderMap.forEach((image) => {
        registerImageBoundsInHitTestTree(projectionHost, sprite, image);
      });
    });
  };

  // Helpers for manipulating image maps.

  /**
   * Looks up an image state for the given sprite, sub-layer, and ordering slot.
   * @param {InternalSpriteCurrentState<T>} sprite - Sprite whose image map is queried.
   * @param {number} subLayer - Sub-layer identifier.
   * @param {number} order - Order position within the sub-layer.
   * @returns {InternalSpriteImageState | undefined} Image state when present.
   */
  const getImageState = (
    sprite: Readonly<InternalSpriteCurrentState<T>>,
    subLayer: number,
    order: number
  ): InternalSpriteImageState | undefined =>
    // Use optional chaining to safely traverse the nested map hierarchy.
    sprite.images.get(subLayer)?.get(order);

  /**
   * Inserts or replaces an image state inside the sprite hierarchy, creating buckets when needed.
   * @param {InternalSpriteCurrentState<T>} sprite - Sprite receiving the image state.
   * @param {InternalSpriteImageState} state - Image state to store.
   * @returns {void}
   */
  const setImageState = (
    sprite: Readonly<InternalSpriteCurrentState<T>>,
    state: Readonly<InternalSpriteImageState>
  ): void => {
    let inner = sprite.images.get(state.subLayer);
    if (!inner) {
      inner = new Map<number, InternalSpriteImageState>();
      sprite.images.set(state.subLayer, inner);
    }
    inner.set(state.order, state);
  };

  /**
   * Tests whether a sprite contains an image entry at the specified sub-layer/order slot.
   * @param {InternalSpriteCurrentState<T>} sprite - Sprite to inspect.
   * @param {number} subLayer - Sub-layer identifier.
   * @param {number} order - Order index within the sub-layer.
   * @returns {boolean} `true` when an image state exists.
   */
  const hasImageState = (
    sprite: Readonly<InternalSpriteCurrentState<T>>,
    subLayer: number,
    order: number
  ): boolean =>
    // Return true only when the nested map exists and contains the desired order entry.
    sprite.images.get(subLayer)?.has(order) ?? false;

  /**
   * Removes an image entry from the sprite, pruning empty sub-layer maps when necessary.
   * @param {InternalSpriteCurrentState<T>} sprite - Sprite to mutate.
   * @param {number} subLayer - Sub-layer identifier containing the image.
   * @param {number} order - Order index to remove.
   * @returns {boolean} `true` when the image existed and was deleted.
   */
  const deleteImageState = (
    sprite: Readonly<InternalSpriteCurrentState<T>>,
    subLayer: number,
    order: number
  ): boolean => {
    const inner = sprite.images.get(subLayer);
    if (!inner) return false;
    const deleted = inner.delete(order);
    // Drop the sub-layer bucket entirely when it no longer contains images.
    if (inner.size === 0) {
      sprite.images.delete(subLayer);
    }
    return deleted;
  };

  type RenderTargetEntry = readonly [
    InternalSpriteCurrentState<T>,
    InternalSpriteImageState,
  ];

  interface HitTestEntry {
    readonly sprite: InternalSpriteCurrentState<T>;
    readonly image: InternalSpriteImageState;
    readonly corners: readonly [
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
    ];
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
  }

  /**
   * Determines whether a point lies inside the quad defined by `corners`.
   * Uses the edge order shared with the debug outline rendering so hit testing stays in sync
   * with the visible polygon even when rotation reorders the logical corner layout.
   * @param {SpriteScreenPoint} point - Point to test.
   * @param {readonly SpriteScreenPoint[]} corners - Quad corners used during rendering.
   * @returns {boolean} `true` when the point lies inside either rendered triangle.
   */
  const pointInRenderedQuad = (
    point: SpriteScreenPoint,
    corners: readonly [
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
    ]
  ): boolean => {
    let hasPositiveCross = false;
    let hasNegativeCross = false;
    for (let i = 0; i < DEBUG_OUTLINE_CORNER_ORDER.length; i++) {
      const currentIndex = DEBUG_OUTLINE_CORNER_ORDER[i]!;
      const nextIndex =
        DEBUG_OUTLINE_CORNER_ORDER[
          (i + 1) % DEBUG_OUTLINE_CORNER_ORDER.length
        ]!;
      const a = corners[currentIndex]!;
      const b = corners[nextIndex]!;
      const edgeX = b.x - a.x;
      const edgeY = b.y - a.y;
      const pointX = point.x - a.x;
      const pointY = point.y - a.y;
      const cross = edgeX * pointY - edgeY * pointX;
      if (Math.abs(cross) <= HIT_TEST_EPSILON) {
        continue;
      }
      if (cross > 0) {
        hasPositiveCross = true;
      } else {
        hasNegativeCross = true;
      }
      if (hasPositiveCross && hasNegativeCross) {
        return false;
      }
    }
    return true;
  };

  /**
   * Performs bounding-box precheck followed by triangle tests to confirm pointer hits.
   * @param {HitTestEntry} entry - Hit-test entry to evaluate.
   * @param {SpriteScreenPoint} point - Point to test.
   * @returns {boolean} `true` when the point hits the sprite image.
   */
  const isPointInsideHitEntry = (
    entry: HitTestEntry,
    point: SpriteScreenPoint
  ): boolean => {
    // Early reject when outside the expanded bounding box to avoid expensive triangle tests.
    if (
      point.x < entry.minX - HIT_TEST_EPSILON ||
      point.x > entry.maxX + HIT_TEST_EPSILON ||
      point.y < entry.minY - HIT_TEST_EPSILON ||
      point.y > entry.maxY + HIT_TEST_EPSILON
    ) {
      return false;
    }
    return pointInRenderedQuad(point, entry.corners);
  };

  /**
   * Groups render entries by sub-layer and returns them sorted by sub-layer index.
   * @param {readonly RenderTargetEntry[]} entries - Entries to bucket.
   * @returns {Array<[number, RenderTargetEntry[]]>} Array of sub-layer id with associated entries.
   */
  const buildSortedSubLayerBuckets = (
    entries: readonly RenderTargetEntry[]
  ): Array<[number, RenderTargetEntry[]]> => {
    const buckets = new Map<number, RenderTargetEntry[]>();
    for (const entry of entries) {
      const subLayer = entry[1].subLayer;
      let bucket = buckets.get(subLayer);
      // Lazily create a bucket per sub-layer.
      if (!bucket) {
        bucket = [];
        buckets.set(subLayer, bucket);
      }
      bucket.push(entry);
    }
    return Array.from(buckets.keys())
      .sort((a, b) => a - b)
      .map((subLayer) => [subLayer, buckets.get(subLayer)!]);
  };

  /**
   * List of sprite/image pairs that need to be rendered.
   * Updated whenever sprites or their images are added or removed, and filtered to visible entries.
   */
  const renderTargetEntries: RenderTargetEntry[] = [];

  const hitTestEntries: HitTestEntry[] = [];
  let hitTestEntryByImage = new WeakMap<
    InternalSpriteImageState,
    HitTestEntry
  >();

  /**
   * Adds a hit-test entry to the cache, computing its axis-aligned bounding box.
   * @param {InternalSpriteCurrentState<T>} spriteEntry - Sprite owning the image.
   * @param {InternalSpriteImageState} imageEntry - Image reference.
   * @param {readonly SpriteScreenPoint[]} screenCorners - Quad corners in screen space.
   */
  const registerHitTestEntry = (
    spriteEntry: Readonly<InternalSpriteCurrentState<T>>,
    imageEntry: Readonly<InternalSpriteImageState>,
    screenCorners: readonly [
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
    ],
    drawIndex: number
  ): void => {
    if (!isHitTestEnabled) {
      return;
    }
    const corners = screenCorners;

    let minX = corners[0].x;
    let maxX = corners[0].x;
    let minY = corners[0].y;
    let maxY = corners[0].y;
    // Walk the remaining corners to calculate the bounding box extrema.
    for (let i = 1; i < corners.length; i++) {
      const corner = corners[i]!;
      // Track extrema to form a quick-reject bounding box.
      if (corner.x < minX) minX = corner.x;
      if (corner.x > maxX) maxX = corner.x;
      if (corner.y < minY) minY = corner.y;
      if (corner.y > maxY) maxY = corner.y;
    }

    const entry: HitTestEntry = {
      sprite: spriteEntry,
      image: imageEntry,
      corners,
      minX,
      maxX,
      minY,
      maxY,
    };
    hitTestEntries.push(entry);
    hitTestEntryByImage.set(imageEntry, entry);

    const handle = hitTestTreeItems.get(imageEntry);
    if (handle) {
      handle.item.state.drawIndex = drawIndex;
    }
  };

  const findTopmostHitEntryLinear = (
    point: SpriteScreenPoint
  ): HitTestEntry | null => {
    // Iterate in reverse so later render entries (visually on top) win.
    for (let i = hitTestEntries.length - 1; i >= 0; i--) {
      const entry = hitTestEntries[i]!;
      if (isPointInsideHitEntry(entry, point)) {
        return entry;
      }
    }
    return null;
  };

  /**
   * Returns the top-most hit-test entry at the given screen point.
   * @param {SpriteScreenPoint} point - Screen coordinate from the pointer event.
   * @returns {HitTestEntry | null} Entry representing the hit or `null` if none.
   */
  const findTopmostHitEntry = (
    point: SpriteScreenPoint
  ): HitTestEntry | null => {
    if (!isHitTestEnabled) {
      return null;
    }
    const mapInstance = map;
    if (!mapInstance) {
      return findTopmostHitEntryLinear(point);
    }

    const centerLngLat = mapInstance.unproject([point.x, point.y] as any);
    if (!centerLngLat) {
      return findTopmostHitEntryLinear(point);
    }

    const searchPoints: SpriteLocation[] = [
      { lng: centerLngLat.lng, lat: centerLngLat.lat },
    ];
    const radius = HIT_TEST_QUERY_RADIUS_PIXELS;
    const offsets: Array<[number, number]> = [
      [point.x - radius, point.y - radius],
      [point.x + radius, point.y - radius],
      [point.x - radius, point.y + radius],
      [point.x + radius, point.y + radius],
    ];
    for (const [x, y] of offsets) {
      const lngLat = mapInstance.unproject([x, y] as any);
      if (lngLat) {
        searchPoints.push({ lng: lngLat.lng, lat: lngLat.lat });
      }
    }

    const searchRect = rectFromLngLatPoints(searchPoints);
    if (!searchRect) {
      return findTopmostHitEntryLinear(point);
    }

    const candidates = hitTestTree.lookup(
      searchRect.x0,
      searchRect.y0,
      searchRect.x1,
      searchRect.y1
    );
    if (candidates.length === 0) {
      return findTopmostHitEntryLinear(point);
    }

    candidates.sort((a, b) => a.state.drawIndex - b.state.drawIndex);

    const seenImages = new Set<InternalSpriteImageState>();
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i]!;
      const image = candidate.state.image;
      if (seenImages.has(image)) {
        continue;
      }
      seenImages.add(image);

      const entry = hitTestEntryByImage.get(image);
      if (!entry) {
        continue;
      }
      if (isPointInsideHitEntry(entry, point)) {
        return entry;
      }
    }

    return findTopmostHitEntryLinear(point);
  };

  // TODO: For debug purpose, DO NOT DELETE
  if (SL_DEBUG) {
    // Expose render pipeline state for developer diagnostics via global window hooks.
    (window as any).__renderTargetEntries = renderTargetEntries;
    (window as any).__spriteHitTestEntries = hitTestEntries;
  }
  // TODO: end

  //////////////////////////////////////////////////////////////////////////

  type SpriteEventKey = keyof SpriteLayerEventMap<T>;
  type GenericSpriteListener = SpriteLayerEventListener<T, SpriteEventKey>;

  /** Event listener registry. */
  const eventListeners = new Map<SpriteEventKey, Set<GenericSpriteListener>>();

  /**
   * Retrieves or lazily creates the listener set for a specific event type.
   * @param {SpriteEventKey} type - Event type identifier.
   * @returns {Set<GenericSpriteListener>} Listener set.
   */
  const getListenerSet = (type: SpriteEventKey): Set<GenericSpriteListener> => {
    let set = eventListeners.get(type);
    if (!set) {
      set = new Set();
      eventListeners.set(type, set);
    }
    return set;
  };

  /**
   * Registers a sprite-layer event listener.
   * @param {K} type - Event type to subscribe to.
   * @param {SpriteLayerEventListener<T, K>} listener - Listener callback.
   */
  const addEventListener = <K extends SpriteEventKey>(
    type: K,
    listener: SpriteLayerEventListener<T, K>
  ): void => {
    getListenerSet(type).add(listener as GenericSpriteListener);
  };

  /**
   * Removes a previously registered event listener.
   * @param {K} type - Event type to unsubscribe from.
   * @param {SpriteLayerEventListener<T, K>} listener - Listener to remove.
   */
  const removeEventListener = <K extends SpriteEventKey>(
    type: K,
    listener: SpriteLayerEventListener<T, K>
  ): void => {
    const listeners = eventListeners.get(type);
    // No listener set mapped to this type, nothing to remove.
    if (!listeners) {
      return;
    }
    listeners.delete(listener as GenericSpriteListener);
    // Drop the set entirely once it becomes empty to free memory.
    if (listeners.size === 0) {
      eventListeners.delete(type);
    }
  };

  let canvasElement: HTMLCanvasElement | null = null;
  const inputListenerDisposers: Array<() => void> = [];

  /**
   * Determines if any listeners are registered for the specified event.
   * @param {SpriteEventKey} type - Event type identifier.
   * @returns {boolean} `true` when at least one listener exists.
   */
  const hasSpriteListeners = (type: SpriteEventKey): boolean =>
    // Treat missing listener sets as zero, otherwise check the registered count.
    (eventListeners.get(type)?.size ?? 0) > 0;

  /**
   * Indicates whether any `spriteclick` listeners are registered.
   * @returns {boolean} `true` when at least one click listener exists.
   */
  const hasSpriteClickListeners = (): boolean =>
    hasSpriteListeners('spriteclick');

  /**
   * Indicates whether any `spritehover` listeners are registered.
   * @returns {boolean} `true` when at least one hover listener exists.
   */
  const hasSpriteHoverListeners = (): boolean =>
    hasSpriteListeners('spritehover');

  /**
   * Converts native pointer/touch events into screen-space coordinates relative to the canvas.
   * @param {MouseEvent | PointerEvent | TouchEvent} nativeEvent - Event to process.
   * @returns {SpriteScreenPoint | null} Screen point or `null` when unavailable.
   */
  const resolveScreenPointFromEvent = (
    nativeEvent: MouseEvent | PointerEvent | TouchEvent
  ): SpriteScreenPoint | null => {
    // Without a canvas element we cannot translate event coordinates.
    if (!canvasElement) {
      return null;
    }
    const rect = canvasElement.getBoundingClientRect();
    const toScreenPoint = (
      clientX: number,
      clientY: number
    ): SpriteScreenPoint => ({
      x: clientX - rect.left,
      y: clientY - rect.top,
    });

    if ('changedTouches' in nativeEvent) {
      const touchEvent = nativeEvent as TouchEvent;
      const touch =
        // Prefer the touch that triggered the event, otherwise fall back to any active touch (or null).
        touchEvent.changedTouches?.[0] ?? touchEvent.touches?.[0] ?? null;
      // Touch events may fire without active touches (e.g., cancellation); ignore when absent.
      if (!touch) {
        return null;
      }
      return toScreenPoint(touch.clientX, touch.clientY);
    }

    const mouseLike = nativeEvent as MouseEvent;
    return toScreenPoint(mouseLike.clientX, mouseLike.clientY);
  };

  /**
   * Resolves sprite and image state for a hit-test entry.
   * @param {HitTestEntry} hitEntry - Hit-test entry returned from the lookup.
   * @returns {{ sprite: SpriteCurrentState<T> | undefined; image: SpriteImageState | undefined }} Sprite/image state pair.
   */
  const resolveSpriteEventPayload = (
    hitEntry: HitTestEntry | null
  ): {
    sprite: SpriteCurrentState<T> | undefined;
    image: SpriteImageState | undefined;
  } => {
    if (!hitEntry) {
      return {
        sprite: undefined,
        image: undefined,
      };
    }
    const spriteState = getSpriteState(hitEntry.sprite.spriteId);
    const imageState =
      spriteState?.images
        .get(hitEntry.image.subLayer)
        ?.get(hitEntry.image.order) ?? undefined;

    return {
      sprite: spriteState,
      image: imageState,
    };
  };

  /**
   * Dispatches a `spriteclick` event to registered listeners.
   * @param {HitTestEntry} hitEntry - Entry that was hit.
   * @param {SpriteScreenPoint} screenPoint - Screen-space location of the click.
   * @param {MouseEvent | PointerEvent | TouchEvent} originalEvent - Native input event.
   */
  const dispatchSpriteClick = (
    hitEntry: HitTestEntry,
    screenPoint: SpriteScreenPoint,
    originalEvent: MouseEvent | PointerEvent | TouchEvent
  ): void => {
    const listeners = eventListeners.get('spriteclick');
    // When no listeners are registered, short-circuit without doing extra work.
    if (!listeners || listeners.size === 0) {
      return;
    }

    const payload = resolveSpriteEventPayload(hitEntry);

    const clickEvent: SpriteLayerClickEvent<T> = {
      type: 'spriteclick',
      sprite: payload.sprite,
      image: payload.image,
      screenPoint,
      originalEvent,
    };

    listeners.forEach((listener) => {
      (listener as SpriteLayerEventListener<T, 'spriteclick'>)(clickEvent);
    });
  };

  /**
   * Dispatches a `spritehover` event to registered listeners.
   * @param {HitTestEntry} hitEntry - Entry that was hit.
   * @param {SpriteScreenPoint} screenPoint - Screen-space location of the hover.
   * @param {MouseEvent | PointerEvent} originalEvent - Native input event.
   */
  const dispatchSpriteHover = (
    hitEntry: HitTestEntry | null,
    screenPoint: SpriteScreenPoint,
    originalEvent: MouseEvent | PointerEvent
  ): void => {
    const listeners = eventListeners.get('spritehover');
    // When no listeners are registered, short-circuit without doing extra work.
    if (!listeners || listeners.size === 0) {
      return;
    }

    const payload = resolveSpriteEventPayload(hitEntry);

    const hoverEvent: SpriteLayerHoverEvent<T> = {
      type: 'spritehover',
      sprite: payload.sprite,
      image: payload.image,
      screenPoint,
      originalEvent,
    };

    listeners.forEach((listener) => {
      (listener as SpriteLayerEventListener<T, 'spritehover'>)(hoverEvent);
    });
  };

  /**
   * Resolves hit-test information for a native event.
   * @param {MouseEvent | PointerEvent | TouchEvent} nativeEvent - Original browser event.
   * @returns {{ hitEntry: HitTestEntry; screenPoint: SpriteScreenPoint } | null} Hit-test result or `null`.
   */
  const resolveHitTestResult = (
    nativeEvent: MouseEvent | PointerEvent | TouchEvent
  ): {
    hitEntry: HitTestEntry | null;
    screenPoint: SpriteScreenPoint;
  } | null => {
    const screenPoint = resolveScreenPointFromEvent(nativeEvent);
    // Input may lack coordinates (e.g., touchend without touches); abort hit-testing in that case.
    if (!screenPoint) {
      return null;
    }

    const hitEntry = findTopmostHitEntry(screenPoint);
    // No sprites intersected the event point; nothing to dispatch.
    return { hitEntry: hitEntry ?? null, screenPoint };
  };

  /**
   * Handles pointer/touch events to trigger sprite click callbacks when matches are found.
   * @param {MouseEvent | PointerEvent | TouchEvent} nativeEvent - Original browser event.
   */
  const processClickEvent = (
    nativeEvent: MouseEvent | PointerEvent | TouchEvent
  ): void => {
    // Skip work entirely when no listeners are interested in click events.
    if (!hasSpriteClickListeners()) {
      return;
    }

    const hitResult = resolveHitTestResult(nativeEvent);
    if (!hitResult || !hitResult.hitEntry) {
      return;
    }

    dispatchSpriteClick(hitResult.hitEntry, hitResult.screenPoint, nativeEvent);
  };

  /**
   * Handles pointer/mouse move events to trigger sprite hover callbacks.
   * @param {MouseEvent | PointerEvent} nativeEvent - Original browser hover event.
   */
  const processHoverEvent = (nativeEvent: MouseEvent | PointerEvent): void => {
    // Skip work entirely when no listeners are interested in hover events.
    if (!hasSpriteHoverListeners()) {
      return;
    }

    const hitResult = resolveHitTestResult(nativeEvent);
    if (!hitResult) {
      return;
    }

    dispatchSpriteHover(hitResult.hitEntry, hitResult.screenPoint, nativeEvent);
  };

  //////////////////////////////////////////////////////////////////////////

  /**
   * Creates or refreshes WebGL textures for registered images.
   * Processes only queued entries to avoid unnecessary work.
   * Intended to run just before drawing; returns immediately if the GL context is unavailable.
   * Ensures registerImage calls outside the render loop sync on the next frame.
   * @returns {void}
   */
  const ensureTextures = (): void => {
    if (!gl) {
      return;
    }
    atlasQueue.flushPending();
    if (!atlasNeedsUpload) {
      return;
    }

    const glContext = gl;
    const pages = atlasManager.getPages();
    const activePageIndices = new Set<number>();
    pages.forEach((page) => activePageIndices.add(page.index));

    atlasPageTextures.forEach((texture, pageIndex) => {
      if (!activePageIndices.has(pageIndex)) {
        glContext.deleteTexture(texture);
        atlasPageTextures.delete(pageIndex);
      }
    });

    pages.forEach((page) => {
      const requiresUpload =
        page.needsUpload || !atlasPageTextures.has(page.index);
      if (!requiresUpload) {
        return;
      }

      let texture = atlasPageTextures.get(page.index);
      let isNewTexture = false;
      if (!texture) {
        texture = glContext.createTexture();
        if (!texture) {
          throw new Error('Failed to create texture.');
        }
        atlasPageTextures.set(page.index, texture);
        isNewTexture = true;
      }
      glContext.bindTexture(glContext.TEXTURE_2D, texture);
      if (isNewTexture) {
        glContext.texParameteri(
          glContext.TEXTURE_2D,
          glContext.TEXTURE_WRAP_S,
          glContext.CLAMP_TO_EDGE
        );
        glContext.texParameteri(
          glContext.TEXTURE_2D,
          glContext.TEXTURE_WRAP_T,
          glContext.CLAMP_TO_EDGE
        );
      }
      glContext.pixelStorei(glContext.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      glContext.texImage2D(
        glContext.TEXTURE_2D,
        0,
        glContext.RGBA,
        glContext.RGBA,
        glContext.UNSIGNED_BYTE,
        page.canvas as TexImageSource
      );

      let minFilterEnum = resolveGlMinFilter(
        glContext,
        resolvedTextureFiltering.minFilter
      );
      const magFilterEnum = resolveGlMagFilter(
        glContext,
        resolvedTextureFiltering.magFilter
      );

      let usedMipmaps = false;
      if (resolvedTextureFiltering.generateMipmaps) {
        const isWebGL2 =
          typeof WebGL2RenderingContext !== 'undefined' &&
          glContext instanceof WebGL2RenderingContext;
        const canUseMipmaps =
          isWebGL2 || (isPowerOfTwo(page.width) && isPowerOfTwo(page.height));
        if (canUseMipmaps) {
          glContext.generateMipmap(glContext.TEXTURE_2D);
          usedMipmaps = true;
        } else {
          minFilterEnum = glContext.LINEAR;
        }
      }

      if (
        !usedMipmaps &&
        filterRequiresMipmaps(resolvedTextureFiltering.minFilter)
      ) {
        minFilterEnum = glContext.LINEAR;
      }

      glContext.texParameteri(
        glContext.TEXTURE_2D,
        glContext.TEXTURE_MIN_FILTER,
        minFilterEnum
      );
      glContext.texParameteri(
        glContext.TEXTURE_2D,
        glContext.TEXTURE_MAG_FILTER,
        magFilterEnum
      );

      if (
        usedMipmaps &&
        anisotropyExtension &&
        resolvedTextureFiltering.maxAnisotropy > 1
      ) {
        const ext = anisotropyExtension;
        const targetAnisotropy = Math.min(
          resolvedTextureFiltering.maxAnisotropy,
          maxSupportedAnisotropy
        );
        if (targetAnisotropy > 1) {
          glContext.texParameterf(
            glContext.TEXTURE_2D,
            ext.TEXTURE_MAX_ANISOTROPY_EXT,
            targetAnisotropy
          );
        }
      }

      atlasManager.markPageClean(page.index);
    });

    images.forEach((image) => {
      if (image.atlasPageIndex !== ATLAS_PAGE_INDEX_NONE) {
        image.texture = atlasPageTextures.get(image.atlasPageIndex);
      } else {
        image.texture = undefined;
      }
    });
    imageHandleBuffersController.markDirty(images);
    atlasNeedsUpload = shouldUploadAtlasPages(pages);
  };

  /**
   * Requests a redraw from MapLibre.
   * Custom layers must call triggerRepaint manually whenever their content changes.
   * Ensure this runs after animations or style updates so the render loop reflects changes.
   * @returns {void}
   */
  let isRenderScheduled = false;

  const scheduleRender = (): void => {
    if (!map || isRenderScheduled) {
      return;
    }
    isRenderScheduled = true;
    map.triggerRepaint();
  };

  handleAtlasQueueChunkProcessed = () => {
    syncAtlasPlacementsFromManager();
    scheduleRender();
  };

  /**
   * Rebuilds the list of renderable images based on visibility.
   * @returns {void}
   */
  const ensureRenderTargetEntries = (): void => {
    renderTargetEntries.length = 0;

    // Traverse every sprite.
    // Iterate over every sprite to update animation state before drawing.
    sprites.forEach((sprite) => {
      // Skip disabled sprites; they should not appear in render output.
      if (!sprite.isEnabled) {
        return;
      }
      if (sprite.images.size === 0) {
        // No images associated with this sprite, so nothing to render.
        return;
      }

      // Collect each image (subLayer -> order -> image).
      // Process all image layers belonging to the sprite.
      sprite.images.forEach((orderMap) => {
        // Inspect each ordered image entry to update rotation/offset animations.
        orderMap.forEach((image) => {
          // Fully transparent images contribute nothing and can be ignored.
          if (image.opacity <= 0) {
            image.originRenderTargetIndex = SPRITE_ORIGIN_REFERENCE_INDEX_NONE;
            image.originReferenceKey = SPRITE_ORIGIN_REFERENCE_KEY_NONE;
            return;
          }
          const imageResource = images.get(image.imageId);
          // Skip images referencing texture IDs that are not registered.
          if (!imageResource) {
            image.imageHandle = 0;
            image.originRenderTargetIndex = SPRITE_ORIGIN_REFERENCE_INDEX_NONE;
            image.originReferenceKey = SPRITE_ORIGIN_REFERENCE_KEY_NONE;
            return;
          }

          if (image.originLocation !== undefined) {
            image.originReferenceKey = originReference.encodeKey(
              image.originLocation.subLayer,
              image.originLocation.order
            );
          } else {
            image.originReferenceKey = SPRITE_ORIGIN_REFERENCE_KEY_NONE;
          }
          image.originRenderTargetIndex = SPRITE_ORIGIN_REFERENCE_INDEX_NONE;

          image.imageHandle = imageResource.handle;
          renderTargetEntries.push([sprite, image]);
        });
      });
    });

    // Pre-sorting (However, camera face depth is not normalized)
    renderTargetEntries.sort((a, b) => {
      const aImage = a[1];
      const bImage = b[1];
      if (aImage.subLayer !== bImage.subLayer) {
        return aImage.subLayer - bImage.subLayer;
      }
      if (aImage.order !== bImage.order) {
        return aImage.order - bImage.order;
      }
      return aImage.imageId.localeCompare(bImage.imageId);
    });

    const originIndexBySprite = new Map<
      string,
      Map<SpriteOriginReferenceKey, number>
    >();

    for (let index = 0; index < renderTargetEntries.length; index++) {
      const [sprite, image] = renderTargetEntries[index]!;
      let indexMap = originIndexBySprite.get(sprite.spriteId);
      if (!indexMap) {
        indexMap = new Map<SpriteOriginReferenceKey, number>();
        originIndexBySprite.set(sprite.spriteId, indexMap);
      }
      const selfKey = originReference.encodeKey(image.subLayer, image.order);
      indexMap.set(selfKey, index);
    }

    for (const [sprite, image] of renderTargetEntries) {
      if (image.originReferenceKey === SPRITE_ORIGIN_REFERENCE_KEY_NONE) {
        image.originRenderTargetIndex = SPRITE_ORIGIN_REFERENCE_INDEX_NONE;
        continue;
      }
      const indexMap = originIndexBySprite.get(sprite.spriteId);
      const targetIndex =
        indexMap?.get(image.originReferenceKey) ??
        SPRITE_ORIGIN_REFERENCE_INDEX_NONE;
      image.originRenderTargetIndex = targetIndex;
    }
  };

  //////////////////////////////////////////////////////////////////////////

  /**
   * Invoked by MapLibre when the layer is added to the map.
   * Initializes WebGL resources, compiles shaders, and enables required attributes.
   *
   * @param {MapLibreMap} mapInstance - MapLibre map instance.
   * @param {WebGLRenderingContext} glContext - Supplied WebGL context.
   */
  const onAdd = (
    mapInstance: MapLibreMap,
    glContext: WebGLRenderingContext
  ): void => {
    map = mapInstance;
    gl = glContext;
    anisotropyExtension = resolveAnisotropyExtension(glContext);
    if (anisotropyExtension) {
      const ext = anisotropyExtension;
      const supported = glContext.getParameter(
        ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT
      ) as number | null;
      if (
        typeof supported === 'number' &&
        Number.isFinite(supported) &&
        supported >= 1
      ) {
        maxSupportedAnisotropy = supported;
      } else {
        maxSupportedAnisotropy = 1;
      }
    } else {
      maxSupportedAnisotropy = 1;
    }

    canvasElement = mapInstance.getCanvas();
    const registerDisposer = (disposer: () => void) => {
      inputListenerDisposers.push(disposer);
    };
    const supportsPointerEvents =
      typeof window !== 'undefined' && 'PointerEvent' in window;
    // Only attach DOM listeners when a canvas is present.
    if (canvasElement) {
      if (supportsPointerEvents) {
        const pointerUpListener = (event: PointerEvent) => {
          if (event.pointerType === 'mouse' && event.button !== 0) {
            // Ignore non-primary mouse buttons to match click semantics.
            return;
          }
          processClickEvent(event);
        };
        canvasElement.addEventListener('pointerup', pointerUpListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement?.removeEventListener('pointerup', pointerUpListener);
        });

        const pointerMoveListener = (event: PointerEvent) => {
          if (!event.isPrimary) {
            // Secondary pointers are ignored to reduce duplicate hover dispatch.
            return;
          }
          if (event.pointerType === 'touch') {
            // Touch pointers do not support hover semantics.
            return;
          }
          processHoverEvent(event);
        };
        canvasElement.addEventListener('pointermove', pointerMoveListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement?.removeEventListener(
            'pointermove',
            pointerMoveListener
          );
        });
      } else {
        const clickListener = (event: MouseEvent) => {
          if (event.button !== 0) {
            // Only respond to primary button clicks when pointer events are unavailable.
            return;
          }
          processClickEvent(event);
        };
        canvasElement.addEventListener('click', clickListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement?.removeEventListener('click', clickListener);
        });

        const touchListener = (event: TouchEvent) => {
          processClickEvent(event);
        };
        canvasElement.addEventListener('touchend', touchListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement?.removeEventListener('touchend', touchListener);
        });

        const mouseMoveListener = (event: MouseEvent) => {
          processHoverEvent(event);
        };
        canvasElement.addEventListener('mousemove', mouseMoveListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement?.removeEventListener('mousemove', mouseMoveListener);
        });
      }
    }

    // Abort immediately if the vertex buffer cannot be created; rendering would be impossible.
    const buffer = glContext.createBuffer();
    if (!buffer) {
      throw new Error('Failed to create vertex buffer.');
    }

    vertexBuffer = buffer;

    // Initialize the quad vertex buffer reused across draws.
    glContext.bindBuffer(glContext.ARRAY_BUFFER, vertexBuffer);
    // Upload unit-quad vertices; they will be scaled later.
    glContext.bufferData(
      glContext.ARRAY_BUFFER,
      INITIAL_QUAD_VERTICES,
      glContext.DYNAMIC_DRAW
    );

    // Compile the shader program required for textured billboard rendering.
    const shaderProgram = createShaderProgram(
      glContext,
      VERTEX_SHADER_SOURCE,
      FRAGMENT_SHADER_SOURCE
    );
    program = shaderProgram;

    // Bind the program so attribute configuration can follow.
    glContext.useProgram(shaderProgram);

    // Resolve attribute locations for positions and UVs; both are required.
    attribPositionLocation = glContext.getAttribLocation(
      shaderProgram,
      'a_position'
    );
    attribUvLocation = glContext.getAttribLocation(shaderProgram, 'a_uv');
    if (attribPositionLocation === -1 || attribUvLocation === -1) {
      throw new Error('Failed to acquire attribute locations.');
    }

    // Fetch uniform locations for the texture sampler and opacity.
    uniformTextureLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_texture'
    );
    uniformOpacityLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_opacity'
    );
    uniformScreenToClipScaleLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_screenToClipScale'
    );
    uniformScreenToClipOffsetLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_screenToClipOffset'
    );
    uniformBillboardModeLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_billboardMode'
    );
    uniformBillboardCenterLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_billboardCenter'
    );
    uniformBillboardHalfSizeLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_billboardHalfSize'
    );
    uniformBillboardAnchorLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_billboardAnchor'
    );
    uniformBillboardSinCosLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_billboardSinCos'
    );
    uniformSurfaceModeLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_surfaceMode'
    );
    uniformSurfaceDepthBiasLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_surfaceDepthBias'
    );
    uniformSurfaceClipEnabledLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_surfaceClipEnabled'
    );
    uniformSurfaceClipCenterLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_surfaceClipCenter'
    );
    uniformSurfaceClipBasisEastLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_surfaceClipBasisEast'
    );
    uniformSurfaceClipBasisNorthLocation = glContext.getUniformLocation(
      shaderProgram,
      'u_surfaceClipBasisNorth'
    );
    if (
      !uniformTextureLocation ||
      !uniformOpacityLocation ||
      !uniformScreenToClipScaleLocation ||
      !uniformScreenToClipOffsetLocation ||
      !uniformBillboardModeLocation ||
      !uniformBillboardCenterLocation ||
      !uniformBillboardHalfSizeLocation ||
      !uniformBillboardAnchorLocation ||
      !uniformBillboardSinCosLocation ||
      !uniformSurfaceModeLocation ||
      !uniformSurfaceDepthBiasLocation ||
      !uniformSurfaceClipEnabledLocation ||
      !uniformSurfaceClipCenterLocation ||
      !uniformSurfaceClipBasisEastLocation ||
      !uniformSurfaceClipBasisNorthLocation
    ) {
      throw new Error('Failed to acquire uniform locations.');
    }

    // Enable vertex position attributes and configure their layer.
    glContext.enableVertexAttribArray(attribPositionLocation);
    glContext.vertexAttribPointer(
      attribPositionLocation,
      POSITION_COMPONENT_COUNT,
      glContext.FLOAT,
      false,
      VERTEX_STRIDE,
      0
    );
    // Enable UV attributes and configure their layer.
    glContext.enableVertexAttribArray(attribUvLocation);
    glContext.vertexAttribPointer(
      attribUvLocation,
      UV_COMPONENT_COUNT,
      glContext.FLOAT,
      false,
      VERTEX_STRIDE,
      UV_OFFSET
    );

    // Use texture unit 0 and set the default opacity to 1.0.
    glContext.uniform1i(uniformTextureLocation, 0);
    glContext.uniform1f(uniformOpacityLocation, 1.0);
    // Default to an identity transform; render() will update these each frame.
    glContext.uniform2f(uniformScreenToClipScaleLocation, 1.0, 1.0);
    glContext.uniform2f(uniformScreenToClipOffsetLocation, 0.0, 0.0);
    glContext.uniform1f(uniformSurfaceClipEnabledLocation, 0.0);
    glContext.uniform4f(uniformSurfaceClipCenterLocation, 0.0, 0.0, 0.0, 1.0);
    glContext.uniform4f(
      uniformSurfaceClipBasisEastLocation,
      0.0,
      0.0,
      0.0,
      0.0
    );
    glContext.uniform4f(
      uniformSurfaceClipBasisNorthLocation,
      0.0,
      0.0,
      0.0,
      0.0
    );
    glContext.uniform1f(uniformBillboardModeLocation, 0);
    glContext.uniform2f(uniformBillboardCenterLocation, 0.0, 0.0);
    glContext.uniform2f(uniformBillboardHalfSizeLocation, 0.0, 0.0);
    glContext.uniform2f(uniformBillboardAnchorLocation, 0.0, 0.0);
    glContext.uniform2f(uniformBillboardSinCosLocation, 0.0, 1.0);
    glContext.uniform1f(uniformSurfaceModeLocation, 0);
    glContext.uniform1f(uniformSurfaceDepthBiasLocation, 0);

    // Unbind the ARRAY_BUFFER once initialization is complete.
    glContext.bindBuffer(glContext.ARRAY_BUFFER, null);

    if (showDebugBounds) {
      const debugShaderProgram = createShaderProgram(
        glContext,
        DEBUG_OUTLINE_VERTEX_SHADER_SOURCE,
        DEBUG_OUTLINE_FRAGMENT_SHADER_SOURCE
      );
      debugProgram = debugShaderProgram;
      debugAttribPositionLocation = glContext.getAttribLocation(
        debugShaderProgram,
        'a_position'
      );
      if (debugAttribPositionLocation === -1) {
        throw new Error('Failed to acquire debug attribute location.');
      }
      const colorLocation = glContext.getUniformLocation(
        debugShaderProgram,
        'u_color'
      );
      if (!colorLocation) {
        throw new Error('Failed to acquire debug color uniform.');
      }
      debugUniformColorLocation = colorLocation;
      debugUniformScreenToClipScaleLocation = glContext.getUniformLocation(
        debugShaderProgram,
        'u_screenToClipScale'
      );
      debugUniformScreenToClipOffsetLocation = glContext.getUniformLocation(
        debugShaderProgram,
        'u_screenToClipOffset'
      );
      if (
        !debugUniformScreenToClipScaleLocation ||
        !debugUniformScreenToClipOffsetLocation
      ) {
        throw new Error('Failed to acquire debug screen-to-clip uniforms.');
      }
      glContext.uniform2f(debugUniformScreenToClipScaleLocation, 1.0, 1.0);
      glContext.uniform2f(debugUniformScreenToClipOffsetLocation, 0.0, 0.0);

      const outlineBuffer = glContext.createBuffer();
      if (!outlineBuffer) {
        throw new Error('Failed to create debug vertex buffer.');
      }
      debugVertexBuffer = outlineBuffer;
      glContext.bindBuffer(glContext.ARRAY_BUFFER, outlineBuffer);
      glContext.bufferData(
        glContext.ARRAY_BUFFER,
        DEBUG_OUTLINE_VERTEX_SCRATCH,
        glContext.DYNAMIC_DRAW
      );
      glContext.bindBuffer(glContext.ARRAY_BUFFER, null);
    }

    // Request a render pass.
    scheduleRender();
  };

  /**
   * Called when the layer is removed from the map to release WebGL resources.
   */
  const onRemove = (): void => {
    inputListenerDisposers.forEach((dispose) => dispose());
    inputListenerDisposers.length = 0;
    canvasElement = null;
    hitTestEntries.length = 0;
    hitTestEntryByImage = new WeakMap<InternalSpriteImageState, HitTestEntry>();
    hitTestTree.clear();
    hitTestTreeItems = new WeakMap<
      InternalSpriteImageState,
      HitTestTreeHandle
    >();

    const glContext = gl;
    if (glContext) {
      atlasPageTextures.forEach((texture) => {
        glContext.deleteTexture(texture);
      });
      atlasPageTextures.clear();
      images.forEach((image) => {
        image.texture = undefined;
      });
      atlasNeedsUpload = true;
      if (vertexBuffer) {
        glContext.deleteBuffer(vertexBuffer);
      }
      if (debugVertexBuffer) {
        glContext.deleteBuffer(debugVertexBuffer);
      }
      if (program) {
        glContext.deleteProgram(program);
      }
      if (debugProgram) {
        glContext.deleteProgram(debugProgram);
      }
    }

    eventListeners.forEach((set) => set.clear());
    eventListeners.clear();

    gl = null;
    map = null;
    program = null;
    vertexBuffer = null;
    debugProgram = null;
    debugVertexBuffer = null;
    attribPositionLocation = -1;
    attribUvLocation = -1;
    debugAttribPositionLocation = -1;
    uniformTextureLocation = null;
    uniformOpacityLocation = null;
    uniformScreenToClipScaleLocation = null;
    uniformScreenToClipOffsetLocation = null;
    uniformBillboardModeLocation = null;
    uniformBillboardCenterLocation = null;
    uniformBillboardHalfSizeLocation = null;
    uniformBillboardAnchorLocation = null;
    uniformBillboardSinCosLocation = null;
    uniformSurfaceModeLocation = null;
    uniformSurfaceDepthBiasLocation = null;
    debugUniformColorLocation = null;
    debugUniformScreenToClipScaleLocation = null;
    debugUniformScreenToClipOffsetLocation = null;
    anisotropyExtension = null;
    maxSupportedAnisotropy = 1;
  };

  /**
   * Per-frame render loop.
   * Draws visible sprites in layer order and assigns textures to each quad.
   *
   * @param {WebGLRenderingContext} glContext - WebGL context used for rendering.
   * @param {CustomRenderMethodInput} options - Render options supplied by MapLibre (timestamp, etc.).
   */
  const render = (
    glContext: WebGLRenderingContext,
    _options: CustomRenderMethodInput
  ): void => {
    isRenderScheduled = false;
    hitTestEntries.length = 0;
    hitTestEntryByImage = new WeakMap<InternalSpriteImageState, HitTestEntry>();

    // Abort early if any critical resource (map, program, vertex buffer) is missing.
    const mapInstance = map;
    if (!mapInstance || !program || !vertexBuffer) {
      return;
    }

    // Uniform locations must be resolved before drawing; skip the frame otherwise.
    if (
      !uniformOpacityLocation ||
      !uniformTextureLocation ||
      !uniformScreenToClipScaleLocation ||
      !uniformScreenToClipOffsetLocation
    ) {
      return;
    }

    const timestamp =
      typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
        ? // Prefer high-resolution timers when available for smoother animation progress.
          performance.now()
        : // Fall back to Date.now() in environments without the Performance API.
          Date.now();

    let hasActiveInterpolation = false;
    sprites.forEach((sprite) => {
      const state = sprite.interpolationState;
      // Advance sprite position interpolation when an active state exists.
      if (state) {
        const evaluation = evaluateInterpolation({
          state,
          timestamp,
        });
        // Initialize start timestamp on first evaluation to align progress.
        if (state.startTimestamp < 0) {
          state.startTimestamp = evaluation.effectiveStartTimestamp;
        }
        sprite.currentLocation = evaluation.location;

        // Once interpolation completes, snap to the destination and clear transient state.
        if (evaluation.completed) {
          sprite.currentLocation = cloneSpriteLocation(state.to);
          sprite.fromLocation = undefined;
          sprite.toLocation = undefined;
          sprite.interpolationState = null;
        } else {
          hasActiveInterpolation = true;
        }
      }

      sprite.images.forEach((orderMap) => {
        orderMap.forEach((image) => {
          if (stepSpriteImageInterpolations(image, timestamp)) {
            hasActiveInterpolation = true;
          }
        });
      });
    });

    // Schedule another frame when any interpolation remains in-flight to keep animations smooth.
    if (hasActiveInterpolation) {
      scheduleRender();
    }

    const canvas = glContext.canvas as HTMLCanvasElement;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;

    // clientWidth/Height are in CSS pixels. devicePixelRatio is handled internally by WebGL.
    // Bail out if cssHeight is zero, as subsequent clip conversion becomes undefined.
    // A zero-sized canvas cannot support render calculations, so skip drawing entirely.
    if (cssWidth === 0 || cssHeight === 0) {
      return;
    }

    // Synchronize GPU uploads for image textures.
    ensureTextures();

    const drawingBufferWidth = glContext.drawingBufferWidth;
    const drawingBufferHeight = glContext.drawingBufferHeight;
    const pixelRatio = drawingBufferWidth / cssWidth;
    if (drawingBufferWidth === 0 || drawingBufferHeight === 0) {
      return;
    }

    const screenToClipScaleX = (2 * pixelRatio) / drawingBufferWidth;
    const screenToClipScaleY = (-2 * pixelRatio) / drawingBufferHeight;
    const screenToClipOffsetX = -1;
    const screenToClipOffsetY = 1;
    const identityScaleX = 1;
    const identityScaleY = 1;
    const identityOffsetX = 0;
    const identityOffsetY = 0;

    const baseMetersPerPixel = resolvedScaling.metersPerPixel;
    const spriteMinPixel = resolvedScaling.spriteMinPixel;
    const spriteMaxPixel = resolvedScaling.spriteMaxPixel;

    // Prepare to create projection host
    const projectionHost = createProjectionHostForMap(mapInstance);
    try {
      const clipContext = projectionHost.getClipContext();
      // Without a clip context we cannot project to clip space; skip rendering.
      if (!clipContext) {
        return;
      }

      const zoom = projectionHost.getZoom();
      const zoomScaleFactor = calculateZoomScaleFactor(zoom, resolvedScaling);

      // Enable blending and avoid depth-buffer interference.
      glContext.enable(glContext.BLEND);
      glContext.blendFunc(glContext.SRC_ALPHA, glContext.ONE_MINUS_SRC_ALPHA);
      glContext.disable(glContext.DEPTH_TEST);
      glContext.depthMask(false);

      glContext.useProgram(program);
      glContext.bindBuffer(glContext.ARRAY_BUFFER, vertexBuffer);
      glContext.enableVertexAttribArray(attribPositionLocation);
      glContext.vertexAttribPointer(
        attribPositionLocation,
        POSITION_COMPONENT_COUNT,
        glContext.FLOAT,
        false,
        VERTEX_STRIDE,
        0
      );
      glContext.enableVertexAttribArray(attribUvLocation);
      glContext.vertexAttribPointer(
        attribUvLocation,
        UV_COMPONENT_COUNT,
        glContext.FLOAT,
        false,
        VERTEX_STRIDE,
        UV_OFFSET
      );
      glContext.uniform1i(uniformTextureLocation, 0);
      const screenToClipScaleLocation = uniformScreenToClipScaleLocation!;
      const screenToClipOffsetLocation = uniformScreenToClipOffsetLocation!;

      let currentScaleX = Number.NaN;
      let currentScaleY = Number.NaN;
      let currentOffsetX = Number.NaN;
      let currentOffsetY = Number.NaN;
      const applyScreenToClipUniforms = (
        scaleX: number,
        scaleY: number,
        offsetX: number,
        offsetY: number
      ): void => {
        if (
          scaleX !== currentScaleX ||
          scaleY !== currentScaleY ||
          offsetX !== currentOffsetX ||
          offsetY !== currentOffsetY
        ) {
          glContext.uniform2f(screenToClipScaleLocation, scaleX, scaleY);
          glContext.uniform2f(screenToClipOffsetLocation, offsetX, offsetY);
          currentScaleX = scaleX;
          currentScaleY = scaleY;
          currentOffsetX = offsetX;
          currentOffsetY = offsetY;
        }
      };

      let currentSurfaceMode = Number.NaN;
      const applySurfaceMode = (enabled: boolean): void => {
        if (!uniformSurfaceModeLocation) {
          return;
        }
        const value = enabled ? 1 : 0;
        if (value !== currentSurfaceMode) {
          glContext.uniform1f(uniformSurfaceModeLocation, value);
          currentSurfaceMode = value;
        }
      };

      let currentSurfaceClipEnabled = Number.NaN;
      const applySurfaceClipUniforms = (
        enabled: boolean,
        inputs: SurfaceShaderInputs | null
      ): void => {
        if (
          !uniformSurfaceClipEnabledLocation ||
          !uniformSurfaceClipCenterLocation ||
          !uniformSurfaceClipBasisEastLocation ||
          !uniformSurfaceClipBasisNorthLocation
        ) {
          return;
        }
        const value = enabled ? 1 : 0;
        if (value !== currentSurfaceClipEnabled) {
          glContext.uniform1f(uniformSurfaceClipEnabledLocation, value);
          currentSurfaceClipEnabled = value;
        }
        const clipCenter =
          enabled && inputs ? inputs.clipCenter : { x: 0, y: 0, z: 0, w: 1 };
        glContext.uniform4f(
          uniformSurfaceClipCenterLocation,
          clipCenter.x,
          clipCenter.y,
          clipCenter.z,
          clipCenter.w
        );
        const clipBasisEast =
          enabled && inputs ? inputs.clipBasisEast : { x: 0, y: 0, z: 0, w: 0 };
        glContext.uniform4f(
          uniformSurfaceClipBasisEastLocation,
          clipBasisEast.x,
          clipBasisEast.y,
          clipBasisEast.z,
          clipBasisEast.w
        );
        const clipBasisNorth =
          enabled && inputs
            ? inputs.clipBasisNorth
            : { x: 0, y: 0, z: 0, w: 0 };
        glContext.uniform4f(
          uniformSurfaceClipBasisNorthLocation,
          clipBasisNorth.x,
          clipBasisNorth.y,
          clipBasisNorth.z,
          clipBasisNorth.w
        );
      };

      let drawOrderCounter = 0;

      const issueSpriteDraw = (
        prepared: PreparedDrawSpriteImageParams<T>
      ): void => {
        const { screenToClip } = prepared;
        applyScreenToClipUniforms(
          screenToClip.scaleX,
          screenToClip.scaleY,
          screenToClip.offsetX,
          screenToClip.offsetY
        );

        applySurfaceMode(prepared.useShaderSurface);

        const surfaceInputs = prepared.surfaceShaderInputs;
        if (prepared.useShaderSurface && surfaceInputs) {
          if (uniformSurfaceDepthBiasLocation) {
            glContext.uniform1f(
              uniformSurfaceDepthBiasLocation,
              surfaceInputs.depthBiasNdc
            );
          }
          applySurfaceClipUniforms(
            prepared.surfaceClipEnabled,
            prepared.surfaceClipEnabled ? surfaceInputs : null
          );
        } else {
          if (uniformSurfaceDepthBiasLocation) {
            glContext.uniform1f(uniformSurfaceDepthBiasLocation, 0);
          }
          applySurfaceClipUniforms(false, null);
        }

        if (uniformBillboardModeLocation) {
          glContext.uniform1f(
            uniformBillboardModeLocation,
            prepared.useShaderBillboard ? 1 : 0
          );
        }
        if (prepared.useShaderBillboard && prepared.billboardUniforms) {
          const uniforms = prepared.billboardUniforms;
          if (uniformBillboardCenterLocation) {
            glContext.uniform2f(
              uniformBillboardCenterLocation,
              uniforms.center.x,
              uniforms.center.y
            );
          }
          if (uniformBillboardHalfSizeLocation) {
            glContext.uniform2f(
              uniformBillboardHalfSizeLocation,
              uniforms.halfWidth,
              uniforms.halfHeight
            );
          }
          if (uniformBillboardAnchorLocation) {
            glContext.uniform2f(
              uniformBillboardAnchorLocation,
              uniforms.anchor.x,
              uniforms.anchor.y
            );
          }
          if (uniformBillboardSinCosLocation) {
            glContext.uniform2f(
              uniformBillboardSinCosLocation,
              uniforms.sin,
              uniforms.cos
            );
          }
        }

        const texture = prepared.imageResource.texture;
        if (!texture) {
          return;
        }

        glContext.bufferSubData(glContext.ARRAY_BUFFER, 0, prepared.vertexData);
        glContext.uniform1f(uniformOpacityLocation, prepared.opacity);
        glContext.activeTexture(glContext.TEXTURE0);
        glContext.bindTexture(glContext.TEXTURE_2D, texture);
        glContext.drawArrays(glContext.TRIANGLES, 0, QUAD_VERTEX_COUNT);

        prepared.imageEntry.surfaceShaderInputs = surfaceInputs ?? undefined;

        if (prepared.hitTestCorners && prepared.hitTestCorners.length === 4) {
          registerHitTestEntry(
            prepared.spriteEntry,
            prepared.imageEntry,
            prepared.hitTestCorners as [
              SpriteScreenPoint,
              SpriteScreenPoint,
              SpriteScreenPoint,
              SpriteScreenPoint,
            ],
            drawOrderCounter
          );
        }

        drawOrderCounter += 1;
      };

      const sortedSubLayerBuckets =
        buildSortedSubLayerBuckets(renderTargetEntries);

      if (renderTargetEntries.length > 0) {
        const calculationHost = createCalculationHostForMap(mapInstance);
        try {
          const imageHandleBuffers = imageHandleBuffersController.ensure();
          const imageResources =
            imageHandleBuffersController.getResourcesByHandle();
          const bucketBuffers = createRenderTargetBucketBuffers(
            renderTargetEntries,
            {
              originReference,
            }
          );
          const preparedItems = calculationHost.prepareDrawSpriteImages({
            bucket: renderTargetEntries,
            bucketBuffers,
            imageResources,
            imageHandleBuffers,
            resolvedScaling,
            clipContext,
            baseMetersPerPixel,
            spriteMinPixel,
            spriteMaxPixel,
            drawingBufferWidth,
            drawingBufferHeight,
            pixelRatio,
            zoomScaleFactor,
            identityScaleX,
            identityScaleY,
            identityOffsetX,
            identityOffsetY,
            screenToClipScaleX,
            screenToClipScaleY,
            screenToClipOffsetX,
            screenToClipOffsetY,
          });

          const preparedBySubLayer = new Map<
            number,
            PreparedDrawSpriteImageParams<T>[]
          >();
          for (const prepared of preparedItems) {
            const subLayer = prepared.imageEntry.subLayer;
            let list = preparedBySubLayer.get(subLayer);
            if (!list) {
              list = [];
              preparedBySubLayer.set(subLayer, list);
            }
            list.push(prepared);
          }

          for (const [subLayer, bucket] of sortedSubLayerBuckets) {
            const preparedBucket = preparedBySubLayer.get(subLayer);
            if (!preparedBucket) {
              continue;
            }
            const bucketImages = new Set<InternalSpriteImageState>();
            for (const [, image] of bucket) {
              bucketImages.add(image);
            }
            for (const prepared of preparedBucket) {
              if (!bucketImages.has(prepared.imageEntry)) {
                continue;
              }
              bucketImages.delete(prepared.imageEntry);
              issueSpriteDraw(prepared);
            }
          }
        } finally {
          calculationHost.release();
        }
      }

      if (
        showDebugBounds &&
        debugProgram &&
        debugVertexBuffer &&
        debugUniformColorLocation &&
        debugAttribPositionLocation !== -1
      ) {
        glContext.useProgram(debugProgram);
        glContext.bindBuffer(glContext.ARRAY_BUFFER, debugVertexBuffer);
        glContext.enableVertexAttribArray(debugAttribPositionLocation);
        glContext.vertexAttribPointer(
          debugAttribPositionLocation,
          DEBUG_OUTLINE_POSITION_COMPONENT_COUNT,
          glContext.FLOAT,
          false,
          DEBUG_OUTLINE_VERTEX_STRIDE,
          0
        );
        glContext.disable(glContext.DEPTH_TEST);
        glContext.depthMask(false);
        glContext.uniform4f(
          debugUniformColorLocation,
          DEBUG_OUTLINE_COLOR[0],
          DEBUG_OUTLINE_COLOR[1],
          DEBUG_OUTLINE_COLOR[2],
          DEBUG_OUTLINE_COLOR[3]
        );
        if (
          debugUniformScreenToClipScaleLocation &&
          debugUniformScreenToClipOffsetLocation
        ) {
          glContext.uniform2f(
            debugUniformScreenToClipScaleLocation,
            screenToClipScaleX,
            screenToClipScaleY
          );
          glContext.uniform2f(
            debugUniformScreenToClipOffsetLocation,
            screenToClipOffsetX,
            screenToClipOffsetY
          );
        }

        for (const entry of hitTestEntries) {
          let writeOffset = 0;
          for (const cornerIndex of DEBUG_OUTLINE_CORNER_ORDER) {
            const corner = entry.corners[cornerIndex]!;
            DEBUG_OUTLINE_VERTEX_SCRATCH[writeOffset++] = corner.x;
            DEBUG_OUTLINE_VERTEX_SCRATCH[writeOffset++] = corner.y;
            DEBUG_OUTLINE_VERTEX_SCRATCH[writeOffset++] = 0;
            DEBUG_OUTLINE_VERTEX_SCRATCH[writeOffset++] = 1;
          }
          glContext.bufferSubData(
            glContext.ARRAY_BUFFER,
            0,
            DEBUG_OUTLINE_VERTEX_SCRATCH
          );
          glContext.drawArrays(
            glContext.LINE_LOOP,
            0,
            DEBUG_OUTLINE_VERTEX_COUNT
          );
        }

        glContext.depthMask(true);
        glContext.enable(glContext.DEPTH_TEST);
        glContext.disableVertexAttribArray(debugAttribPositionLocation);
        glContext.bindBuffer(glContext.ARRAY_BUFFER, null);
      }
    } finally {
      projectionHost.release();
    }

    glContext.depthMask(true);
    glContext.enable(glContext.DEPTH_TEST);
    glContext.disable(glContext.BLEND);
  };

  //////////////////////////////////////////////////////////////////////////

  /**
   * Registers an image URL or existing ImageBitmap with the image registry.
   * @param {string} imageId - Image identifier used by sprites.
   * @param {string | ImageBitmap} imageSource - Image URL or existing ImageBitmap to load.
   * @param {SpriteImageRegisterOptions | undefined} [options] - Optional controls for SVG rasterization.
   * @returns {Promise<boolean>} Resolves to `true` when registered; `false` if the ID already exists.
   * @remarks Sprites must register images before referencing them.
   */
  const registerImage = async (
    imageId: string,
    imageSource: string | ImageBitmap,
    options?: SpriteImageRegisterOptions,
    signal?: AbortSignal
  ): Promise<boolean> => {
    // Load from URL when given a string; otherwise reuse the provided bitmap directly.
    let bitmap: ImageBitmap;
    try {
      bitmap =
        typeof imageSource === 'string'
          ? await loadImageBitmap(imageSource, options)
          : imageSource;
    } catch (error) {
      if (error instanceof SvgSizeResolutionError) {
        console.warn(
          `[SpriteLayer] Unable to register image "${imageId}": ${error.message}`,
          error
        );
        return false;
      }
      throw error;
    }
    // Reject duplicate registrations to keep texture management consistent.
    if (images.has(imageId)) {
      // Avoid overwriting an existing texture registration using the same identifier.
      return false;
    }

    const handle = imageIdHandler.allocate(imageId);
    // Store the image metadata.
    const image: RegisteredImage = {
      id: imageId,
      handle,
      width: bitmap.width,
      height: bitmap.height,
      bitmap,
      texture: undefined,
      atlasPageIndex: ATLAS_PAGE_INDEX_NONE,
      atlasU0: 0,
      atlasV0: 0,
      atlasU1: 1,
      atlasV1: 1,
    };
    images.set(imageId, image);
    imageIdHandler.store(handle, image);
    updateSpriteImageHandles(imageId, handle);
    imageHandleBuffersController.markDirty(images);

    const deferred = createDeferred<boolean>();
    const abortHandle = signal
      ? onAbort(signal, (error) => {
          deferred.reject(error);
        })
      : null;
    atlasQueue.enqueueUpsert({ imageId, bitmap, deferred });

    try {
      return await deferred.promise;
    } catch (e) {
      images.delete(imageId);
      imageIdHandler.release(imageId);
      updateSpriteImageHandles(imageId, 0);
      imageHandleBuffersController.markDirty(images);
      atlasManager.removeImage(imageId);
      bitmap.close?.();
      throw e;
    } finally {
      abortHandle?.release();
    }
  };

  /**
   * Generates a text glyph image and registers it as a sprite resource.
   * @param {string} textGlyphId - Identifier assigned to the generated glyph.
   * @param {string} text - Text content to render.
   * @param {SpriteTextGlyphDimensions} dimensions - Dimension constraints (line height or max width).
   * @param {SpriteTextGlyphOptions} [options] - Additional styling options for the glyph.
   * @returns {Promise<boolean>} Resolves to `true` when registered; `false` if the ID already exists.
   */
  interface TextGlyphRenderResult {
    readonly bitmap: ImageBitmap;
    readonly width: number;
    readonly height: number;
  }

  const renderTextGlyphBitmap = async (
    text: string,
    dimensions: SpriteTextGlyphDimensions,
    options?: SpriteTextGlyphOptions
  ): Promise<TextGlyphRenderResult> => {
    let lineHeight: number | undefined;
    let maxWidth: number | undefined;
    const isLineHeightMode = 'lineHeightPixel' in dimensions;
    if (isLineHeightMode) {
      const { lineHeightPixel } = dimensions as { lineHeightPixel: number };
      lineHeight = clampGlyphDimension(lineHeightPixel);
    } else {
      const { maxWidthPixel } = dimensions as { maxWidthPixel: number };
      maxWidth = clampGlyphDimension(maxWidthPixel);
    }

    const resolved = resolveTextGlyphOptions(options, lineHeight);
    let fontSize = resolved.fontSizePixel;

    const { ctx: measureCtx } = createCanvas2D(1, 1);
    const applyFontSize = (ctx: Canvas2DContext, size: number) => {
      ctx.font = buildFontString({ ...resolved, fontSizePixel: size });
    };
    applyFontSize(measureCtx, fontSize);
    measureCtx.textBaseline = 'alphabetic';

    const letterSpacing = resolved.letterSpacingPixel;
    let measuredWidth = measureTextWidthWithSpacing(
      measureCtx,
      text,
      letterSpacing
    );

    let contentWidthLimit: number | undefined;
    if (!isLineHeightMode && typeof maxWidth === 'number') {
      const padding = resolved.paddingPixel;
      const borderWidth = resolved.borderWidthPixel;
      const glyphCount = Array.from(text).length;
      const letterSpacingTotal = letterSpacing * Math.max(glyphCount - 1, 0);

      contentWidthLimit = Math.max(
        1,
        maxWidth - borderWidth - padding.left - padding.right
      );
      if (contentWidthLimit < letterSpacingTotal) {
        contentWidthLimit = letterSpacingTotal;
      }

      if (text.length > 0 && measuredWidth > contentWidthLimit) {
        const initialRatio = contentWidthLimit / measuredWidth;
        fontSize = Math.max(
          MIN_TEXT_GLYPH_FONT_SIZE,
          Math.floor(fontSize * initialRatio)
        );
        applyFontSize(measureCtx, fontSize);
        measuredWidth = measureTextWidthWithSpacing(
          measureCtx,
          text,
          letterSpacing
        );

        let guard = 0;
        while (
          measuredWidth > contentWidthLimit &&
          fontSize > MIN_TEXT_GLYPH_FONT_SIZE &&
          guard < 12
        ) {
          const ratio = contentWidthLimit / measuredWidth;
          const nextFontSize = Math.max(
            MIN_TEXT_GLYPH_FONT_SIZE,
            Math.floor(fontSize * Math.max(ratio, 0.75))
          );
          if (nextFontSize === fontSize) {
            fontSize = Math.max(MIN_TEXT_GLYPH_FONT_SIZE, fontSize - 1);
          } else {
            fontSize = nextFontSize;
          }
          applyFontSize(measureCtx, fontSize);
          measuredWidth = measureTextWidthWithSpacing(
            measureCtx,
            text,
            letterSpacing
          );
          guard += 1;
        }
      }
    }

    applyFontSize(measureCtx, fontSize);
    measuredWidth = measureTextWidthWithSpacing(
      measureCtx,
      text,
      letterSpacing
    );
    const measuredHeight = measureTextHeight(measureCtx, text, fontSize);

    const paddingPixel = resolved.paddingPixel;
    const borderWidthPixel = resolved.borderWidthPixel;

    const contentHeight = isLineHeightMode
      ? lineHeight!
      : clampGlyphDimension(Math.ceil(measuredHeight));

    const totalWidth = clampGlyphDimension(
      Math.ceil(
        borderWidthPixel +
          paddingPixel.left +
          paddingPixel.right +
          measuredWidth
      )
    );
    const totalHeight = clampGlyphDimension(
      Math.ceil(
        borderWidthPixel +
          paddingPixel.top +
          paddingPixel.bottom +
          contentHeight
      )
    );

    const renderPixelRatio = resolved.renderPixelRatio;
    const renderWidth = Math.max(1, Math.round(totalWidth * renderPixelRatio));
    const renderHeight = Math.max(
      1,
      Math.round(totalHeight * renderPixelRatio)
    );

    const { canvas, ctx } = createCanvas2D(renderWidth, renderHeight);
    ctx.clearRect(0, 0, renderWidth, renderHeight);
    ctx.save();
    if (renderPixelRatio !== 1) {
      ctx.scale(renderPixelRatio, renderPixelRatio);
    }
    ctx.imageSmoothingEnabled = true;

    if (resolved.backgroundColor) {
      fillRoundedRect(
        ctx,
        totalWidth,
        totalHeight,
        resolved.borderRadiusPixel,
        resolved.backgroundColor
      );
    }

    if (resolved.borderColor && borderWidthPixel > 0) {
      const inset = borderWidthPixel / 2;
      const strokeWidth = Math.max(0, totalWidth - borderWidthPixel);
      const strokeHeight = Math.max(0, totalHeight - borderWidthPixel);
      const strokeRadius = Math.max(0, resolved.borderRadiusPixel - inset);
      ctx.save();
      ctx.translate(inset, inset);
      strokeRoundedRect(
        ctx,
        strokeWidth,
        strokeHeight,
        strokeRadius,
        resolved.borderColor,
        borderWidthPixel,
        resolved.borderSides
      );
      ctx.restore();
    }

    const borderInset = borderWidthPixel / 2;
    const contentWidth = Math.max(
      0,
      totalWidth - borderWidthPixel - paddingPixel.left - paddingPixel.right
    );
    const contentHeightInner = Math.max(
      0,
      totalHeight - borderWidthPixel - paddingPixel.top - paddingPixel.bottom
    );
    const contentLeft = borderInset + paddingPixel.left;
    const contentTop = borderInset + paddingPixel.top;
    const textY = contentTop + contentHeightInner / 2;

    const renderOptions = { ...resolved, fontSizePixel: fontSize };
    ctx.font = buildFontString(renderOptions);
    ctx.fillStyle = resolved.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const totalTextWidth = measureTextWidthWithSpacing(
      ctx,
      text,
      letterSpacing
    );

    let textStartX = contentLeft;
    switch (resolved.textAlign) {
      case 'right':
        textStartX = contentLeft + (contentWidth - totalTextWidth);
        break;
      case 'center':
        textStartX = contentLeft + (contentWidth - totalTextWidth) / 2;
        break;
      case 'left':
      default:
        textStartX = contentLeft;
        break;
    }

    drawTextWithLetterSpacing(ctx, text, textStartX, textY, letterSpacing);

    ctx.restore();

    const bitmap = await createImageBitmapFromCanvas(
      canvas,
      renderWidth,
      renderHeight,
      totalWidth,
      totalHeight,
      renderPixelRatio
    );

    return { bitmap, width: totalWidth, height: totalHeight };
  };

  const registerTextGlyph = async (
    textGlyphId: string,
    text: string,
    dimensions: SpriteTextGlyphDimensions,
    options?: SpriteTextGlyphOptions,
    signal?: AbortSignal
  ): Promise<boolean> => {
    if (images.has(textGlyphId) || pendingTextGlyphIds.has(textGlyphId)) {
      return true;
    }

    pendingTextGlyphIds.add(textGlyphId);
    const deferred = createDeferred<boolean>();
    let glyphAbortHandle: Releasable | null = null;
    if (signal) {
      glyphAbortHandle = onAbort(signal, (error) => {
        cancelPendingTextGlyphJob(textGlyphId, error);
      });
    }
    enqueueTextGlyphJob({
      glyphId: textGlyphId,
      text,
      dimensions,
      options,
      deferred,
      signal,
      abortHandle: glyphAbortHandle,
    });

    try {
      return await deferred.promise;
    } finally {
      pendingTextGlyphIds.delete(textGlyphId);
    }
  };
  /**
   * Unregisters an image and releases any associated GPU resources.
   * @param {string} imageId - Unique identifier of the image to remove.
   * @returns {boolean} `true` when the image existed and was removed; `false` otherwise.
   */
  const unregisterImage = (imageId: string): boolean => {
    // Ensure the image exists.
    const image = images.get(imageId);
    if (!image) {
      if (pendingTextGlyphIds.has(imageId)) {
        cancelPendingTextGlyphJob(
          imageId,
          new Error(
            `[SpriteLayer][GlyphQueue] Image "${imageId}" was unregistered before generation.`
          )
        );
        return true;
      }
      return false;
    }

    atlasQueue.cancelForImage(
      imageId,
      new Error(
        `[SpriteLayer][Atlas] Image "${imageId}" was unregistered before placement.`
      )
    );

    // Remove image bounds
    sprites.forEach((sprite) => {
      sprite.images.forEach((orderMap) => {
        orderMap.forEach((imageState) => {
          if (imageState.imageId === imageId) {
            removeImageBoundsFromHitTestTree(imageState);
          }
        });
      });
    });

    if (image.bitmap) {
      image.bitmap.close?.();
    }

    // Remove the image entry.
    images.delete(imageId);
    imageIdHandler.release(imageId);
    updateSpriteImageHandles(imageId, 0);
    imageHandleBuffersController.markDirty(images);
    atlasManager.removeImage(imageId);
    syncAtlasPlacementsFromManager();

    // Rebuild render targets now that the image is gone.
    ensureRenderTargetEntries();
    scheduleRender();

    return true;
  };

  /**
   * Unregisters all images and glyphs, cleaning up associated GPU textures.
   * @returns {void}
   */
  const unregisterAllImages = (): void => {
    rejectAllPendingTextGlyphJobs(
      new Error(
        '[SpriteLayer][GlyphQueue] Pending glyph operations were cleared.'
      )
    );
    pendingTextGlyphIds.clear();
    atlasQueue.rejectAll(
      new Error('[SpriteLayer][Atlas] Pending atlas operations were cleared.')
    );
    const glContext = gl;
    atlasPageTextures.forEach((texture) => {
      if (glContext) {
        glContext.deleteTexture(texture);
      }
    });
    atlasPageTextures.clear();
    images.forEach((image) => {
      if (image.bitmap) {
        image.bitmap.close?.();
      }
    });
    images.clear();
    atlasManager.clear();
    atlasNeedsUpload = false;
    imageIdHandler.reset();
    imageHandleBuffersController.markDirty(images);
    sprites.forEach((sprite) => {
      sprite.images.forEach((orderMap) => {
        orderMap.forEach((imageState) => {
          imageState.imageHandle = 0;
        });
      });
    });
    hitTestTree.clear();
    hitTestTreeItems = new WeakMap<
      InternalSpriteImageState,
      HitTestTreeHandle
    >();
    hitTestEntryByImage = new WeakMap<InternalSpriteImageState, HitTestEntry>();
    ensureRenderTargetEntries();
    scheduleRender();
  };

  /**
   * Returns the identifiers of all registered images and glyphs.
   * @returns {string[]} Array containing every registered imageId.
   */
  const getAllImageIds = (): string[] => Array.from(images.keys());

  //////////////////////////////////////////////////////////////////////////

  /**
   * Internal helper that constructs sprite state without scheduling redraws.
   * @param {ProjectionHost} projectionHost - Projection host.
   * @param {string} spriteId - Sprite identifier.
   * @param {SpriteInit<T>} init - Initial sprite parameters.
   * @returns {boolean} `true` when the sprite is stored; `false` when the ID already exists or is invalid.
   */
  const addSpriteInternal = (
    projectionHost: ProjectionHost,
    spriteId: string,
    init: SpriteInit<T>
  ): boolean => {
    // Reject duplicates.
    if (sprites.get(spriteId)) {
      return false;
    }

    // Build internal image state map.
    const imagesInit = init.images ?? [];
    // Each initial image definition will be normalized into internal state maps below.
    const images = new Map<number, Map<number, InternalSpriteImageState>>();
    for (const imageInit of imagesInit) {
      const state = createImageStateFromInit(
        imageInit,
        imageInit.subLayer,
        imageInit.order,
        originReference
      );
      state.imageHandle = resolveImageHandle(state.imageId);
      let inner = images.get(imageInit.subLayer);
      if (!inner) {
        // First entry for this sub-layer; allocate a map for subsequent inserts.
        inner = new Map<number, InternalSpriteImageState>();
        images.set(imageInit.subLayer, inner);
      }
      if (inner.has(imageInit.order)) {
        // Disallow duplicate orders.
        return false;
      }
      inner.set(imageInit.order, state);
    }

    // Validate origin references (existence and detect cycles).
    type Key = { subLayer: number; order: number };
    const keyToStr = (k: Key) => `${k.subLayer}:${k.order}`;
    const getRef = (k: Key): Key | undefined => {
      const ref = images.get(k.subLayer)?.get(k.order)?.originLocation;
      if (!ref) return undefined;
      return { subLayer: ref.subLayer, order: ref.order };
    };
    const hasCycle = (start: Key): boolean => {
      const visited = new Set<string>();
      let cur = getRef(start);
      while (cur) {
        // Follow originLocation references depth-first, checking for loops.
        const id = keyToStr(cur);
        if (cur.subLayer === start.subLayer && cur.order === start.order) {
          return true;
        }
        if (visited.has(id)) {
          return true;
        }
        visited.add(id);
        cur = getRef(cur);
      }
      return false;
    };

    // Validate each stored image across all sub-layers to guard against invalid references.
    for (const [subLayer, omap] of images) {
      for (const [order, state] of omap) {
        const ref = state.originLocation;
        if (ref !== undefined && !images.get(ref.subLayer)?.has(ref.order)) {
          throw new Error(
            `originLocation refers missing image {${ref.subLayer}, ${ref.order}} in sprite ${spriteId}`
          );
        }
        if (ref !== undefined && hasCycle({ subLayer, order })) {
          throw new Error(
            `originLocation has cyclic reference at image {${subLayer}, ${order}} in sprite ${spriteId}`
          );
        }
      }
    }

    // Construct internal sprite state.
    const currentLocation = cloneSpriteLocation(init.location);
    const initialAltitude = currentLocation.z ?? 0;
    const initialMercator = projectionHost.fromLngLat(currentLocation);
    const spriteHandle = spriteIdHandler.allocate(spriteId);

    const spriteState: InternalSpriteCurrentState<T> = {
      spriteId,
      handle: spriteHandle,
      // Sprites default to enabled unless explicitly disabled in the init payload.
      isEnabled: init.isEnabled ?? true,
      currentLocation,
      fromLocation: undefined,
      toLocation: undefined,
      images,
      // Tags default to null to simplify downstream comparisons.
      tag: init.tag ?? null,
      interpolationState: null,
      pendingInterpolationOptions: null,
      lastCommandLocation: cloneSpriteLocation(currentLocation),
      lastAutoRotationLocation: cloneSpriteLocation(currentLocation),
      lastAutoRotationAngleDeg: 0,
      cachedMercator: initialMercator,
      cachedMercatorLng: currentLocation.lng,
      cachedMercatorLat: currentLocation.lat,
      cachedMercatorZ: initialAltitude,
    };

    // Store the sprite state.
    sprites.set(spriteId, spriteState);
    spriteIdHandler.store(spriteHandle, spriteState);

    refreshSpriteHitTestBounds(projectionHost, spriteState);

    return true;
  };

  /**
   * Expands a batch sprite payload into iterable entries.
   * @param {SpriteInitCollection<T>} collection - Batch payload.
   * @returns {Array<[string, Readonly<SpriteInit<T>>]>} Normalized entries.
   */
  const resolveSpriteInitCollection = (
    collection: SpriteInitCollection<T>
  ): readonly [string, Readonly<SpriteInit<T>>][] => {
    if (Array.isArray(collection)) {
      return collection.map((entry): [string, Readonly<SpriteInit<T>>] => [
        entry.spriteId,
        entry,
      ]);
    }
    return Object.entries(collection);
  };

  /**
   * Creates a new sprite with the provided options and adds it to the layer.
   * @param {string} spriteId - Sprite identifier.
   * @param {SpriteInit<T>} init - Initial sprite parameters supplied by the caller.
   * @returns {boolean} `true` when the sprite is added; `false` when the ID already exists.
   */
  const addSprite = (spriteId: string, init: SpriteInit<T>): boolean => {
    if (!map) {
      return false;
    }

    const projectionHost = createProjectionHostForMap(map);
    try {
      const isAdded = addSpriteInternal(projectionHost, spriteId, init);
      if (isAdded) {
        // Rebuild render target entries.
        ensureRenderTargetEntries();
        // Request a redraw so the new sprite appears immediately.
        scheduleRender();
      }
      return isAdded;
    } finally {
      projectionHost.release();
    }
  };

  /**
   * Adds multiple sprites in a single batch operation.
   * @param {SpriteInitCollection<T>} collection - Sprite payloads keyed by spriteId or as array entries.
   * @returns {number} Number of sprites that were newly added.
   */
  const addSprites = (collection: SpriteInitCollection<T>): number => {
    if (!map) {
      return 0;
    }

    const projectionHost = createProjectionHostForMap(map);
    try {
      let addedCount = 0;
      for (const [spriteId, spriteInit] of resolveSpriteInitCollection(
        collection
      )) {
        if (addSpriteInternal(projectionHost, spriteId, spriteInit)) {
          addedCount++;
        }
      }
      if (addedCount > 0) {
        // Rebuild render target entries.
        ensureRenderTargetEntries();
        // Request a redraw so the new sprite appears immediately.
        scheduleRender();
      }
      return addedCount;
    } finally {
      projectionHost.release();
    }
  };

  /**
   * Removes a sprite without requesting rendering.
   * @param {string} spriteId - Sprite identifier.
   * @returns {boolean} `true` when the sprite existed and was removed.
   */
  const removeSpriteInternal = (spriteId: string): boolean => {
    const sprite = sprites.get(spriteId);
    if (!sprite) {
      return false;
    }
    sprite.images.forEach((orderMap) => {
      orderMap.forEach((image) => {
        removeImageBoundsFromHitTestTree(image);
      });
    });
    sprites.delete(spriteId);
    spriteIdHandler.release(spriteId);
    return true;
  };

  /**
   * Removes a sprite from the layer.
   * @param {string} spriteId - Sprite identifier.
   * @remarks Removing a sprite does not affect registered images.
   * @returns {boolean} `true` if the sprite existed and was removed.
   */
  const removeSprite = (spriteId: string): boolean => {
    // Exit early when the sprite does not exist.
    const removed = removeSpriteInternal(spriteId);
    if (!removed) {
      return false;
    }

    // Rebuild render targets.
    ensureRenderTargetEntries();
    // Request a redraw to remove the sprite immediately.
    scheduleRender();

    return true;
  };

  /**
   * Removes multiple sprites at once.
   * @param {readonly string[]} spriteIds - Sprite identifiers to remove.
   * @returns {number} Number of sprites that were removed.
   */
  const removeSprites = (spriteIds: readonly string[]): number => {
    let removedCount = 0;
    for (const spriteId of spriteIds) {
      if (removeSpriteInternal(spriteId)) {
        removedCount++;
      }
    }
    if (removedCount > 0) {
      // Rebuild render target entries.
      ensureRenderTargetEntries();
      // Request a redraw so the new sprite appears immediately.
      scheduleRender();
    }
    return removedCount;
  };

  /**
   * Removes every sprite managed by the layer.
   * @returns {number} Number of sprites that were cleared.
   */
  const removeAllSprites = (): number => {
    const removedCount = sprites.size;
    if (removedCount === 0) {
      return 0;
    }

    hitTestTree.clear();
    hitTestTreeItems = new WeakMap();
    hitTestEntryByImage = new WeakMap();
    sprites.clear();
    spriteIdHandler.reset();

    // Rebuild render target entries.
    ensureRenderTargetEntries();
    // Request a redraw so the new sprite appears immediately.
    scheduleRender();

    return removedCount;
  };

  /**
   * Deletes all sprite images attached to the specified sprite while keeping the sprite entry intact.
   * @param {string} spriteId - Identifier of the sprite whose images should be removed.
   * @returns {number} Number of images that were removed.
   */
  const removeAllSpriteImages = (spriteId: string): number => {
    const sprite = sprites.get(spriteId);
    if (!sprite) {
      return 0;
    }
    if (sprite.images.size === 0) {
      return 0;
    }

    let removedCount = 0;
    sprite.images.forEach((orderMap) => {
      removedCount += orderMap.size;
      orderMap.forEach((image) => {
        removeImageBoundsFromHitTestTree(image);
      });
    });
    sprite.images.clear();

    // Rebuild render target entries.
    ensureRenderTargetEntries();
    // Request a redraw so the sprite reflects the removal immediately.
    scheduleRender();

    return removedCount;
  };

  /**
   * Retrieves the current state for a sprite.
   * @param {string} spriteId - Sprite identifier.
   * @returns {SpriteCurrentState<T> | undefined} Sprite state, or `undefined` when absent.
   */
  const getSpriteState = (
    spriteId: string
  ): SpriteCurrentState<T> | undefined => {
    return sprites.get(spriteId) as SpriteCurrentState<T> | undefined;
  };

  //////////////////////////////////////////////////////////////////////////

  interface SpriteImageOperationInternalResult {
    isUpdated: boolean;
  }

  /**
   * Adds an image definition to the sprite, validating origin references and initializing rotation state.
   * @param {ProjectionHost} projectionHost - Projection host.
   * @param {InternalSpriteCurrentState<T>} sprite - Sprite receiving the image.
   * @param {number} subLayer - Sub-layer identifier.
   * @param {number} order - Order slot within the sub-layer.
   * @param {SpriteImageDefinitionInit} imageInit - Image definition to insert.
   * @param {SpriteImageOperationInternalResult} resultOut - Output flag indicating whether mutation occurred.
   * @returns {boolean} `true` when the image is added; `false` when the slot already exists.
   */
  const addSpriteImageInternal = (
    projectionHost: ProjectionHost,
    sprite: InternalSpriteCurrentState<T>,
    subLayer: number,
    order: number,
    imageInit: SpriteImageDefinitionInit,
    resultOut: SpriteImageOperationInternalResult
  ): boolean => {
    if (hasImageState(sprite, subLayer, order)) {
      return false;
    }

    // Create and add the internal image state.
    const state = createImageStateFromInit(
      imageInit,
      subLayer,
      order,
      originReference
    );
    state.imageHandle = resolveImageHandle(state.imageId);

    // Verify references: ensure targets exist and no cycles occur.
    if (state.originLocation !== undefined) {
      const ref = state.originLocation;
      if (!hasImageState(sprite, ref.subLayer, ref.order)) {
        throw new Error(
          `originLocation refers missing image {${ref.subLayer}, ${ref.order}} in sprite ${sprite.spriteId}`
        );
      }
      const keyToStr = (k: { subLayer: number; order: number }) =>
        `${k.subLayer}:${k.order}`;
      const getRef = (k: { subLayer: number; order: number }) =>
        getImageState(sprite, k.subLayer, k.order)?.originLocation;
      const visited = new Set<string>();
      let curMaybe: SpriteImageOriginLocation | undefined =
        state.originLocation;
      while (curMaybe) {
        const cur = curMaybe as SpriteImageOriginLocation;
        if (cur.subLayer === subLayer && cur.order === order) {
          throw new Error(
            `originLocation has cyclic reference at image {${subLayer}, ${order}} in sprite ${sprite.spriteId}`
          );
        }
        const id = keyToStr(cur);
        if (visited.has(id)) {
          throw new Error(
            `originLocation has cyclic reference including image {${cur.subLayer}, ${cur.order}} in sprite ${sprite.spriteId}`
          );
        }
        visited.add(id);
        curMaybe = getRef(cur);
      }
    }

    if (state.autoRotation) {
      state.resolvedBaseRotateDeg = sprite.lastAutoRotationAngleDeg;
    }

    syncImageRotationChannel(state);

    setImageState(sprite, state);
    registerImageBoundsInHitTestTree(projectionHost, sprite, state);
    resultOut.isUpdated = true;
    return true;
  };

  /**
   * Adds an image to the sprite identified by the given sub-layer and order.
   * @param {string} spriteId - Target sprite ID.
   * @param {number} subLayer - Target sub-layer index.
   * @param {number} order - Order position within the sub-layer.
   * @param {SpriteImageDefinitionInit} imageInit - Image definition to add.
   * @returns {boolean} `true` when inserted; `false` if an image already exists at that slot.
   */
  const addSpriteImage = (
    spriteId: string,
    subLayer: number,
    order: number,
    imageInit: SpriteImageDefinitionInit
  ): boolean => {
    // Fail if the sprite is missing.
    const sprite = sprites.get(spriteId);
    if (!sprite) {
      return false;
    }

    if (!map) {
      return false;
    }

    const projectionHost = createProjectionHostForMap(map);
    try {
      // Insert the image definition.
      const result: SpriteImageOperationInternalResult = { isUpdated: false };
      addSpriteImageInternal(
        projectionHost,
        sprite,
        subLayer,
        order,
        imageInit,
        result
      );
      if (!result.isUpdated) {
        return false;
      }

      // Refresh render targets.
      ensureRenderTargetEntries();
      // Request a redraw so the new image appears immediately.
      scheduleRender();

      return true;
    } finally {
      projectionHost.release();
    }
  };

  /**
   * Updates an existing image with partial changes, handling interpolation and auto-rotation adjustments.
   * @param {ProjectionHost} projectionHost - Projection host.
   * @param {InternalSpriteCurrentState<T>} sprite - Sprite containing the image.
   * @param {number} subLayer - Sub-layer identifier.
   * @param {number} order - Order slot within the sub-layer.
   * @param {SpriteImageDefinitionUpdate} imageUpdate - Changes to apply.
   * @param {SpriteImageOperationInternalResult} resultOut - Output flag reporting whether anything changed.
   * @returns {boolean} `true` when the image exists and the update succeeded.
   */
  const updateSpriteImageInternal = (
    projectionHost: ProjectionHost,
    sprite: InternalSpriteCurrentState<T>,
    subLayer: number,
    order: number,
    imageUpdate: SpriteImageDefinitionUpdate,
    resultOut: SpriteImageOperationInternalResult
  ): boolean => {
    const state = getImageState(sprite, subLayer, order);
    // Ignore updates targeting image slots that do not exist.
    if (!state) return false;

    // Apply updates for each provided attribute.
    if (imageUpdate.imageId !== undefined) {
      // Swap texture reference when caller points to a new image asset.
      state.imageId = imageUpdate.imageId;
      state.imageHandle = resolveImageHandle(imageUpdate.imageId);
    }
    if (imageUpdate.mode !== undefined) {
      // Mode changes influence how geometry is generated.
      state.mode = imageUpdate.mode;
    }
    if (imageUpdate.opacity !== undefined) {
      // Update opacity; zero values will be filtered out during rendering.
      state.opacity = imageUpdate.opacity;
    }
    if (imageUpdate.scale !== undefined) {
      // Adjust image scaling factor applied to dimensions and offsets.
      state.scale = imageUpdate.scale;
    }
    const prevAutoRotation = state.autoRotation;
    const prevMinDistance = state.autoRotationMinDistanceMeters;

    let shouldReapplyAutoRotation = false;
    let shouldResetResolvedAngle = false;

    if (imageUpdate.anchor !== undefined) {
      state.anchor = cloneAnchor(imageUpdate.anchor);
    }
    const interpolationOptions = imageUpdate.interpolation;
    // Optional interpolation payloads allow independent control over offset and rotation animations.
    const offsetDegInterpolationOption = interpolationOptions?.offsetDeg;
    const offsetMetersInterpolationOption = interpolationOptions?.offsetMeters;
    // Pull out rotateDeg interpolation hints when the payload includes them.
    const rotateInterpolationOption = interpolationOptions?.rotateDeg;
    let rotationOverride: SpriteInterpolationOptions | null | undefined;
    let hasRotationOverride = false;
    if (imageUpdate.offset !== undefined) {
      const clonedOffset = cloneOffset(imageUpdate.offset);
      applyOffsetUpdate(state, clonedOffset, {
        deg: offsetDegInterpolationOption,
        meters: offsetMetersInterpolationOption,
      });
    } else {
      if (offsetDegInterpolationOption === null) {
        // Explicit null clears any running angular interpolation.
        clearOffsetDegInterpolation(state);
      }
      if (offsetMetersInterpolationOption === null) {
        // Explicit null clears any running distance interpolation.
        clearOffsetMetersInterpolation(state);
      }
    }
    if (rotateInterpolationOption !== undefined) {
      // Caller supplied new rotation interpolation preferences.
      if (rotateInterpolationOption === null) {
        state.rotationInterpolationOptions = null;
        rotationOverride = null;
      } else {
        const cloned = cloneInterpolationOptions(rotateInterpolationOption);
        state.rotationInterpolationOptions = cloned;
        rotationOverride = cloned;
      }
      hasRotationOverride = true;
    }
    let requireRotationSync = false;
    if (imageUpdate.rotateDeg !== undefined) {
      state.rotateDeg = imageUpdate.rotateDeg;
      requireRotationSync = true;
    } else if (hasRotationOverride) {
      requireRotationSync = true;
    }
    if (imageUpdate.autoRotation !== undefined) {
      state.autoRotation = imageUpdate.autoRotation;
      if (imageUpdate.autoRotation) {
        if (!prevAutoRotation) {
          state.resolvedBaseRotateDeg = sprite.lastAutoRotationAngleDeg;
          shouldReapplyAutoRotation = true;
        }
      } else if (prevAutoRotation) {
        shouldResetResolvedAngle = true;
      }
    }
    if (imageUpdate.autoRotationMinDistanceMeters !== undefined) {
      state.autoRotationMinDistanceMeters =
        imageUpdate.autoRotationMinDistanceMeters;
      if (
        state.autoRotation &&
        imageUpdate.autoRotationMinDistanceMeters !== prevMinDistance
      ) {
        shouldReapplyAutoRotation = true;
      }
    }

    if (shouldResetResolvedAngle) {
      state.resolvedBaseRotateDeg = 0;
      requireRotationSync = true;
    }

    if (shouldReapplyAutoRotation) {
      const applied = applyAutoRotation(sprite, sprite.currentLocation);
      if (!applied && state.autoRotation) {
        state.resolvedBaseRotateDeg = sprite.lastAutoRotationAngleDeg;
        requireRotationSync = true;
      }
    }

    if (requireRotationSync) {
      // Ensure displayed angle reflects the latest base rotation and overrides.
      syncImageRotationChannel(
        state,
        // When a rotation override has been computed, pass it along (null clears interpolation); otherwise leave undefined.
        hasRotationOverride ? (rotationOverride ?? null) : undefined
      );
    }

    registerImageBoundsInHitTestTree(projectionHost, sprite, state);

    resultOut.isUpdated = true;
    return true;
  };

  /**
   * Updates an image belonging to the specified sprite.
   * @param {string} spriteId - Target sprite ID.
   * @param {number} subLayer - Target sub-layer index.
   * @param {number} order - Order position within the sub-layer.
   * @param {SpriteImageDefinitionUpdate} imageUpdate - Changes to apply.
   * @returns {boolean} `true` when the update succeeds.
   */
  const updateSpriteImage = (
    spriteId: string,
    subLayer: number,
    order: number,
    imageUpdate: SpriteImageDefinitionUpdate
  ): boolean => {
    if (!map) {
      return false;
    }

    const projectionHost = createProjectionHostForMap(map);
    try {
      // Fail if the sprite cannot be found.
      const sprite = sprites.get(spriteId);
      if (!sprite) {
        return false;
      }

      // Apply the image update.
      const result: SpriteImageOperationInternalResult = { isUpdated: false };
      updateSpriteImageInternal(
        projectionHost,
        sprite,
        subLayer,
        order,
        imageUpdate,
        result
      );
      if (!result.isUpdated) {
        return false;
      }

      // Refresh render targets.
      ensureRenderTargetEntries();
      // Request a redraw so the updated image is displayed immediately.
      scheduleRender();

      return true;
    } finally {
      projectionHost.release();
    }
  };

  /**
   * Removes an image from the given sprite.
   * @param {InternalSpriteCurrentState<T>} sprite - Sprite that owns the image.
   * @param {number} subLayer - Sub-layer index housing the image.
   * @param {number} order - Order slot of the image.
   * @param {SpriteImageOperationInternalResult} resultOut - Output flag recording if removal occurred.
   * @returns {boolean} `true` when the entry is removed from the sprite.
   */
  const removeSpriteImageInternal = (
    sprite: InternalSpriteCurrentState<T>,
    subLayer: number,
    order: number,
    resultOut: SpriteImageOperationInternalResult
  ): boolean => {
    const state = getImageState(sprite, subLayer, order);
    if (state) {
      removeImageBoundsFromHitTestTree(state);
    }
    const deleted = deleteImageState(sprite, subLayer, order);
    if (deleted) {
      resultOut.isUpdated = true;
      return true;
    }
    return false;
  };

  /**
   * Removes an image identified by sub-layer and order from the sprite.
   * @param {string} spriteId - Target sprite ID.
   * @param {number} subLayer - Target sub-layer index.
   * @param {number} order - Order slot assigned to the image.
   * @returns {boolean} `true` when the removal succeeds.
   */
  const removeSpriteImage = (
    spriteId: string,
    subLayer: number,
    order: number
  ): boolean => {
    // Abort if the sprite does not exist.
    const sprite = sprites.get(spriteId);
    if (!sprite) {
      return false;
    }

    // Delete the image entry.
    const result: SpriteImageOperationInternalResult = { isUpdated: false };
    removeSpriteImageInternal(sprite, subLayer, order, result);
    if (!result.isUpdated) {
      return false;
    }

    // Refresh render targets.
    ensureRenderTargetEntries();
    // Request a redraw so the removal takes effect immediately.
    scheduleRender();

    return true;
  };

  //////////////////////////////////////////////////////////////////////////

  /**
   * Result flags returned from {@link updateSpriteInternal} describing how the sprite update was handled.
   * - `'notfound'`: Sprite did not exist.
   * - `'ignored'`: Update made no changes.
   * - `'updated'`: State changed but no redraw was necessary.
   * - `'isRequiredRender'`: State changed and a redraw must be scheduled.
   */
  type UpdateSpriteResult =
    | 'notfound'
    | 'ignored'
    | 'updated'
    | 'isRequiredRender';

  const updateSpriteInternal = (
    projectionHost: ProjectionHost,
    spriteId: string,
    update: SpriteUpdateEntry<T>
  ): UpdateSpriteResult => {
    // Bail out if the sprite does not exist.
    const sprite = sprites.get(spriteId);
    if (!sprite) {
      return 'notfound';
    }

    // Track whether the update changed any state or requires rendering.
    let updated = false;
    let isRequiredRender = false;
    let needsHitTestRefresh = false;

    if (update.isEnabled !== undefined) {
      // Only flip the enable flag when the requested value differs to avoid noisy redraws.
      if (sprite.isEnabled !== update.isEnabled) {
        sprite.isEnabled = update.isEnabled;
        updated = true;
        isRequiredRender = true;
        needsHitTestRefresh = true;
      }
    }

    let interpolationOptionsForLocation:
      | SpriteInterpolationOptions
      | null
      | undefined = undefined;
    let interpolationExplicitlySpecified = false;

    if (update.interpolation !== undefined) {
      interpolationExplicitlySpecified = true;
      if (update.interpolation === null) {
        // Explicit null clears any pending animations so the sprite snaps instantly.
        if (
          sprite.pendingInterpolationOptions !== null ||
          sprite.interpolationState !== null ||
          sprite.fromLocation !== undefined ||
          sprite.toLocation !== undefined
        ) {
          sprite.pendingInterpolationOptions = null;
          sprite.interpolationState = null;
          sprite.fromLocation = undefined;
          sprite.toLocation = undefined;
          updated = true;
        }
        interpolationOptionsForLocation = null;
      } else {
        const nextOptions = cloneInterpolationOptions(update.interpolation);
        // Replace the cached interpolation configuration only when a parameter changed.
        if (
          !sprite.pendingInterpolationOptions ||
          sprite.pendingInterpolationOptions.durationMs !==
            nextOptions.durationMs ||
          sprite.pendingInterpolationOptions.mode !== nextOptions.mode ||
          sprite.pendingInterpolationOptions.easing !== nextOptions.easing
        ) {
          sprite.pendingInterpolationOptions = nextOptions;
          updated = true;
        }
        interpolationOptionsForLocation = nextOptions;
      }
    }

    if (update.location !== undefined) {
      const newCommandLocation = cloneSpriteLocation(update.location);
      const locationChanged = !spriteLocationsEqual(
        sprite.lastCommandLocation,
        newCommandLocation
      );

      const optionsForLocation = interpolationExplicitlySpecified
        ? // When new interpolation parameters accompanied the update, prefer them (or null to disable).
          (interpolationOptionsForLocation ?? null)
        : // Otherwise reuse any previously cached interpolation request.
          sprite.pendingInterpolationOptions;

      const effectiveOptions =
        // Treat `undefined` as "no interpolation change" whereas explicit `null` disables interpolation.
        optionsForLocation === undefined ? null : optionsForLocation;

      let handledByInterpolation = false;

      if (effectiveOptions && effectiveOptions.durationMs > 0) {
        // Create a fresh interpolation whenever a timed move is requested.
        const { state, requiresInterpolation } = createInterpolationState({
          currentLocation: sprite.currentLocation,
          lastCommandLocation: sprite.lastCommandLocation,
          nextCommandLocation: newCommandLocation,
          options: effectiveOptions,
        });

        // Clear any stale state before deciding whether to reuse it.
        sprite.interpolationState = null;

        if (requiresInterpolation) {
          // Store the interpolation so the render loop can advance it over time.
          sprite.interpolationState = state;
          sprite.fromLocation = cloneSpriteLocation(state.from);
          sprite.toLocation = cloneSpriteLocation(state.to);
          sprite.currentLocation = cloneSpriteLocation(state.from);
          handledByInterpolation = true;
          updated = true;
          isRequiredRender = true;
        }
      }

      sprite.lastCommandLocation = cloneSpriteLocation(newCommandLocation);

      if (handledByInterpolation) {
        // Interpolation will animate towards the destination; the current location already set to start.
      } else if (locationChanged) {
        // Without interpolation, move immediately to the requested location and mark for redraw.
        sprite.currentLocation = cloneSpriteLocation(newCommandLocation);
        sprite.fromLocation = undefined;
        sprite.toLocation = undefined;
        sprite.interpolationState = null;
        updated = true;
        isRequiredRender = true;
      } else {
        // Location unchanged: clear transient interpolation state so future updates start cleanly.
        sprite.interpolationState = null;
        sprite.fromLocation = undefined;
        sprite.toLocation = undefined;
      }

      sprite.pendingInterpolationOptions = null;

      // Auto-rotation should react immediately to the most recent command location.
      applyAutoRotation(sprite, newCommandLocation);
      needsHitTestRefresh = true;
    }

    if (update.tag !== undefined) {
      const nextTag = update.tag ?? null;
      // Only mutate the tag when the identity actually changes to minimise change detection churn.
      if (sprite.tag !== nextTag) {
        sprite.tag = nextTag;
        updated = true;
      }
    }

    if (needsHitTestRefresh) {
      refreshSpriteHitTestBounds(projectionHost, sprite);
    }

    // Rendering must be scheduled when draw-affecting changes occurred.
    if (isRequiredRender) {
      return 'isRequiredRender';
    }
    // Otherwise report whether any non-rendering state changed.
    if (updated) {
      return 'updated';
    }
    return 'ignored';
  };

  /**
   * Updates a sprite with the provided changes.
   * @param {string} spriteId - Sprite ID to update.
   * @param {SpriteUpdateEntry<T>} update - Changes to apply.
   * @returns {boolean} `true` if the update modified state.
   */
  const updateSprite = (
    spriteId: string,
    update: SpriteUpdateEntry<T>
  ): boolean => {
    if (!map) {
      return false;
    }

    const projectionHost = createProjectionHostForMap(map);
    try {
      // Perform the update.
      const result = updateSpriteInternal(projectionHost, spriteId, update);

      switch (result) {
        case 'notfound':
          // Sprite missing; report no change to the caller.
          return false;
        case 'ignored':
          // Update produced no state difference, so nothing to propagate.
          return false;
        case 'updated':
          // State changed but no redraw is required (e.g., metadata change).
          return true;
        case 'isRequiredRender':
          // State changed in a way that affects rendering; refresh buffers and request repaint.
          ensureRenderTargetEntries();
          scheduleRender();
          return true;
      }
    } finally {
      projectionHost.release();
    }
  };

  /**
   * Adds, updates, or removes sprites based on arbitrary source items.
   * @template TSourceItem Source item type that exposes a sprite identifier.
   * @param {readonly TSourceItem[]} sourceItems - Collection supplying mutation targets.
   * @param {SpriteMutateCallbacks<T, TSourceItem>} mutator - Callbacks for adding or modifying sprites.
   * @returns {number} Number of sprites that changed.
   */
  const mutateSprites = <TSourceItem extends SpriteMutateSourceItem>(
    sourceItems: readonly TSourceItem[],
    mutator: SpriteMutateCallbacks<T, TSourceItem>
  ): number => {
    if (sourceItems.length === 0) {
      return 0;
    }

    if (!map) {
      return 0;
    }

    const projectionHost = createProjectionHostForMap(map);
    try {
      let changedCount = 0;
      let isRequiredRender = false;

      // Reuse mutable helpers for efficiency.
      let currentSprite: InternalSpriteCurrentState<T> = undefined!;
      let didMutateImages = false;
      const operationResult: SpriteImageOperationInternalResult = {
        isUpdated: false,
      };
      const updateObject: SpriteUpdaterEntry<T> = {
        isEnabled: undefined,
        location: undefined,
        interpolation: undefined,
        tag: undefined,
        getImageIndexMap: () => {
          const map = new Map<number, Set<number>>();
          currentSprite.images.forEach((inner, subLayer) => {
            map.set(subLayer, new Set(inner.keys()));
          });
          return map;
        },
        addImage: (subLayer, order, imageInit) => {
          const added = addSpriteImageInternal(
            projectionHost,
            currentSprite,
            subLayer,
            order,
            imageInit,
            operationResult
          );
          if (added) {
            didMutateImages = true;
          }
          return added;
        },
        updateImage: (subLayer, order, imageUpdate) => {
          const updated = updateSpriteImageInternal(
            projectionHost,
            currentSprite,
            subLayer,
            order,
            imageUpdate,
            operationResult
          );
          if (updated) {
            didMutateImages = true;
          }
          return updated;
        },
        removeImage: (subLayer, order) => {
          const removed = removeSpriteImageInternal(
            currentSprite,
            subLayer,
            order,
            operationResult
          );
          if (removed) {
            didMutateImages = true;
          }
          return removed;
        },
      } as SpriteUpdaterEntry<T>;

      for (const sourceItem of sourceItems) {
        const spriteId = sourceItem.spriteId;
        const sprite = sprites.get(spriteId);

        if (!sprite) {
          const init = mutator.add(sourceItem);
          if (!init) {
            continue;
          }
          if (addSpriteInternal(projectionHost, spriteId, init)) {
            changedCount++;
            isRequiredRender = true;
          }
          continue;
        }

        currentSprite = sprite;
        operationResult.isUpdated = false;
        didMutateImages = false;

        const decision = mutator.modify(
          sourceItem,
          sprite as SpriteCurrentState<T>,
          updateObject
        );

        if (decision === 'remove') {
          if (removeSpriteInternal(spriteId)) {
            changedCount++;
            isRequiredRender = true;
          }
        } else {
          const updateResult = updateSpriteInternal(
            projectionHost,
            spriteId,
            updateObject
          );
          let spriteChanged = false;

          switch (updateResult) {
            case 'updated':
              spriteChanged = true;
              break;
            case 'isRequiredRender':
              spriteChanged = true;
              isRequiredRender = true;
              break;
          }

          if (didMutateImages) {
            spriteChanged = true;
            isRequiredRender = true;
          }

          if (spriteChanged) {
            changedCount++;
          }
        }

        // Reset reusable fields on the shared update object.
        updateObject.isEnabled = undefined;
        updateObject.location = undefined;
        updateObject.interpolation = undefined;
        updateObject.tag = undefined;
        operationResult.isUpdated = false;
        didMutateImages = false;
      }

      // Request rendering
      if (isRequiredRender) {
        // Either a sprite changed or an image operation mutated state; refresh buffers and repaint.
        ensureRenderTargetEntries();
        scheduleRender();
      }

      return changedCount;
    } finally {
      projectionHost.release();
    }
  };

  /**
   * Iterates over every sprite and attempts to update it via the provided callback.
   * @param {(sprite: SpriteCurrentState<T>, update: SpriteUpdaterEntry<T>) => boolean} updater - Callback invoked per sprite; return `false` to abort iteration.
   * @returns {number} Number of sprites updated.
   */
  const updateForEach = (
    updater: (
      sprite: SpriteCurrentState<T>,
      update: SpriteUpdaterEntry<T>
    ) => boolean
  ): number => {
    if (!map) {
      return 0;
    }

    const projectionHost = createProjectionHostForMap(map);
    try {
      let updatedCount = 0;
      let isRequiredRender = false;

      // Reuse allocation-heavy objects.
      let currentSprite: InternalSpriteCurrentState<T> = undefined!;
      const operationResult: SpriteImageOperationInternalResult = {
        isUpdated: false,
      };
      const updateObject: SpriteUpdaterEntry<T> = {
        getImageIndexMap: () => {
          const map = new Map<number, Set<number>>();
          currentSprite.images.forEach((inner, subLayer) => {
            map.set(subLayer, new Set(inner.keys()));
          });
          return map;
        },
        addImage: (subLayer, order, imageInit) =>
          addSpriteImageInternal(
            projectionHost,
            currentSprite,
            subLayer,
            order,
            imageInit,
            operationResult
          ),
        updateImage: (subLayer, order, imageUpdate) =>
          updateSpriteImageInternal(
            projectionHost,
            currentSprite,
            subLayer,
            order,
            imageUpdate,
            operationResult
          ),
        removeImage: (subLayer, order) =>
          removeSpriteImageInternal(
            currentSprite,
            subLayer,
            order,
            operationResult
          ),
      } as SpriteUpdaterEntry<T>;

      // Process every sprite.
      sprites.forEach((sprite) => {
        currentSprite = sprite;

        // Invoke the user-supplied updater to populate updateObject.
        updater(sprite as SpriteCurrentState<T>, updateObject);

        // Apply the update.
        const result = updateSpriteInternal(
          projectionHost,
          sprite.spriteId,
          updateObject
        );

        switch (result) {
          case 'notfound':
            // Sprite vanished during iteration; skip it.
            break;
          case 'ignored':
            // Updater made no net changes.
            break;
          case 'updated':
            updatedCount++;
            break;
          case 'isRequiredRender':
            // Changes require a redraw after iteration completes.
            isRequiredRender = true;
            updatedCount++;
            break;
        }

        // Reset reusable fields on the shared update object.
        updateObject.isEnabled = undefined;
        updateObject.location = undefined;
        updateObject.interpolation = undefined;
        updateObject.tag = undefined;
      });

      // Request rendering if any sprite or image changed.
      if (isRequiredRender || operationResult.isUpdated) {
        // Either a sprite changed or an image operation mutated state; refresh buffers and repaint.
        ensureRenderTargetEntries();
        scheduleRender();
      }

      return updatedCount;
    } finally {
      projectionHost.release();
    }
  };

  const setHitTestEnabled = (enabled: boolean) => {
    if (isHitTestEnabled === enabled) {
      return;
    }
    isHitTestEnabled = enabled;
    hitTestTree.clear();
    hitTestTreeItems = new WeakMap<
      InternalSpriteImageState,
      HitTestTreeHandle
    >();
    hitTestEntryByImage = new WeakMap<InternalSpriteImageState, HitTestEntry>();
    if (!enabled) {
      return;
    }

    if (!map) {
      return;
    }

    const projectionHost = createProjectionHostForMap(map);
    try {
      sprites.forEach((sprite) => {
        refreshSpriteHitTestBounds(projectionHost, sprite);
      });
    } finally {
      projectionHost.release();
    }
  };

  /**
   * MapLibre CustomLayerInterface-compatible object exposing sprite management APIs.
   */
  const spriteLayout = {
    id,
    type: 'custom' as const,
    renderingMode: '2d' as const,
    onAdd,
    onRemove,
    render,
    registerImage,
    registerTextGlyph,
    unregisterImage,
    unregisterAllImages,
    getAllImageIds,
    addSprite,
    addSprites,
    removeSprite,
    removeSprites,
    removeAllSprites,
    removeAllSpriteImages,
    getSpriteState,
    addSpriteImage,
    updateSpriteImage,
    removeSpriteImage,
    updateSprite,
    mutateSprites,
    updateForEach,
    setHitTestEnabled,
    on: addEventListener,
    off: removeEventListener,
  };

  return spriteLayout;
};
