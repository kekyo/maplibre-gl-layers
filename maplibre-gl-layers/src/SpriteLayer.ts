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
 * ordering rules, and depth-normalisation helpers for avoiding Z-buffer issues.
 */

import { type Map as MapLibreMap, MercatorCoordinate } from 'maplibre-gl';
import type { CustomRenderMethodInput } from 'maplibre-gl';
import { vec4, type mat4 } from 'gl-matrix';
import {
  type SpriteInit,
  type SpriteInitCollection,
  type SpriteMode,
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
  // @prettier-max-ignore-deprecated
  type SpriteUpdateBulkEntry,
  type SpriteMutateCallbacks,
  type SpriteMutateSourceItem,
  type SpriteImageOffset,
  type SpriteInterpolationOptions,
  type SpriteNumericInterpolationOptions,
  type SpriteImageOriginLocation,
  type SpriteScreenPoint,
  type SpriteLayerClickEvent,
  type SpriteImageState,
  type SpriteTextGlyphDimensions,
  type SpriteTextGlyphOptions,
  type SpriteTextGlyphHorizontalAlign,
  type SpriteTextGlyphPaddingPixel,
  type SpriteTextGlyphBorderSide,
  DEFAULT_TEXTURE_FILTERING_OPTIONS,
} from './types';
import { loadImageBitmap } from './utils';
import { cloneSpriteLocation, spriteLocationsEqual } from './location';
import {
  createInterpolationState,
  evaluateInterpolation,
  type SpriteInterpolationState,
} from './interpolation';
import {
  createNumericInterpolationState,
  evaluateNumericInterpolation,
  type NumericInterpolationState,
} from './numericInterpolation';
import {
  normaliseAngleDeg,
  resolveRotationTarget,
} from './rotationInterpolation';
import {
  calculateDistanceAndBearingMeters,
  calculateMetersPerPixelAtLatitude,
  calculateZoomScaleFactor,
  calculateSurfaceOffsetMeters,
  calculateSurfaceWorldDimensions,
  applySurfaceDisplacement,
  isFiniteNumber,
  clipToScreen,
  screenToClip,
  resolveScalingOptions,
  calculateBillboardCenterPosition,
  calculateBillboardCornerScreenPositions,
  calculateBillboardDepthKey,
  calculateEffectivePixelsPerMeter,
  calculateSurfaceCenterPosition,
  calculateSurfaceCornerDisplacements,
  calculateSurfaceDepthKey,
  type ProjectToClipSpaceFn,
  type UnprojectPointFn,
  TRIANGLE_INDICES,
  UV_CORNERS,
} from './math';

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
// * When movement interpolation (SpriteInterpolationOptions) is enabled, it operates per sprite (not per image),
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

/** Debug flag */
const SL_DEBUG = false;

/** Default sprite anchor centered at the image origin. */
const DEFAULT_ANCHOR: SpriteAnchor = { x: 0.0, y: 0.0 };

/** Default threshold in meters for auto-rotation to treat movement as significant. */
const DEFAULT_AUTO_ROTATION_MIN_DISTANCE_METERS = 20;

/** Default image offset applied when none is provided. */
const DEFAULT_IMAGE_OFFSET: SpriteImageOffset = {
  offsetMeters: 0,
  offsetDeg: 0,
};

// Clamp the clip-space w component to avoid instability near the clip plane.
const MIN_CLIP_W = 1e-6;
const MIN_CLIP_Z_EPSILON = 1e-7;

/** Small depth bias applied in NDC space. */
const EPS_NDC = 1e-6;
/** Whether to enable the NDC bias for surface rendering (disabled by default). */
const ENABLE_NDC_BIAS_SURFACE = true;

/** Maximum number of order slots available within a sub-layer (0..ORDER_MAX-1). */
const ORDER_MAX = 16;
/** Bucket width used to encode sub-layer and order into a single number. */
const ORDER_BUCKET = 16;

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

/** Minification filters that require mipmaps to produce complete textures. */
const MIPMAP_MIN_FILTERS: ReadonlySet<SpriteTextureMinFilter> = new Set([
  'nearest-mipmap-nearest',
  'nearest-mipmap-linear',
  'linear-mipmap-nearest',
  'linear-mipmap-linear',
]);

interface ResolvedTextureFilteringOptions {
  readonly minFilter: SpriteTextureMinFilter;
  readonly magFilter: SpriteTextureMagFilter;
  readonly generateMipmaps: boolean;
  readonly maxAnisotropy: number;
}

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
 * Compact representation of an Array-like 4x4 matrix.
 * Accepts typed arrays sourced from MapLibre internals.
 */
type MatrixInput = ArrayLike<number>;

/**
 * Cached clip-space context containing the mercator matrix required to project coordinates.
 * @property {MatrixInput} mercatorMatrix - Matrix mapping Mercator coordinates to clip space.
 */
type ClipContext = {
  readonly mercatorMatrix: MatrixInput;
};

/**
 * Computes the perspective ratio from MapLibre's internal transform.
 * Used to calculate distance-based scaling that responds to pitch, zoom, and altitude.
 * @param {MapLibreMap} mapInstance - MapLibre map providing the transform and camera distance.
 * @param {SpriteLocation} location - Location used to derive mercator coordinates for scaling.
 * @returns {number} Perspective ratio applied when scaling sprites; defaults to 1 if unavailable.
 */
export const calculatePerspectiveRatio = (
  mapInstance: MapLibreMap,
  location: SpriteLocation
): number => {
  const transform = (mapInstance as unknown as { transform?: any }).transform;
  if (!transform) {
    return 1.0;
  }

  const mercatorMatrix: mat4 | Float32Array | number[] | undefined =
    transform.mercatorMatrix ?? transform._mercatorMatrix;
  const cameraToCenterDistance: number | undefined =
    transform.cameraToCenterDistance;

  if (
    !mercatorMatrix ||
    typeof cameraToCenterDistance !== 'number' ||
    !Number.isFinite(cameraToCenterDistance)
  ) {
    return 1.0;
  }

  try {
    const mercator = MercatorCoordinate.fromLngLat(
      { lng: location.lng, lat: location.lat },
      location.z ?? 0
    );
    const position = vec4.fromValues(
      mercator.x,
      mercator.y,
      mercator.z ?? 0,
      1
    );
    vec4.transformMat4(position, position, mercatorMatrix as mat4);
    const w = position[3];
    if (!Number.isFinite(w) || w <= 0) {
      return 1.0;
    }
    const ratio = cameraToCenterDistance / w;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return 1.0;
    }
    return ratio;
  } catch {
    return 1.0;
  }
};

/**
 * Extracts the current clip-space context from MapLibre if the mercator matrix is available.
 * @param {MapLibreMap} mapInstance - Map instance storing the transform.
 * @returns {ClipContext | null} Clip context or `null` when the transform is not ready.
 */
const getClipContext = (mapInstance: MapLibreMap): ClipContext | null => {
  const transform = (mapInstance as unknown as { transform?: any }).transform;
  if (!transform) {
    return null;
  }
  const mercatorMatrix: MatrixInput | undefined = transform._mercatorMatrix;
  if (!mercatorMatrix) {
    return null;
  }
  return { mercatorMatrix };
};

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
 * Projects a longitude/latitude/elevation tuple into clip space using the provided context.
 * @param {number} lng - Longitude in degrees.
 * @param {number} lat - Latitude in degrees.
 * @param {number} elevationMeters - Elevation above the ellipsoid in meters.
 * @param {ClipContext | null} context - Clip-space context; `null` skips projection.
 * @returns {[number, number, number, number] | null} Clip coordinates or `null` when projection fails.
 */
export const projectLngLatToClipSpace = (
  lng: number,
  lat: number,
  elevationMeters: number,
  context: ClipContext | null
): [number, number, number, number] | null => {
  if (!context) {
    return null;
  }
  const { mercatorMatrix } = context;
  const coord = MercatorCoordinate.fromLngLat({ lng, lat }, elevationMeters);
  const [clipX, clipY, clipZ, clipW] = multiplyMatrixAndVector(
    mercatorMatrix,
    coord.x,
    coord.y,
    coord.z ?? 0,
    1
  );
  if (!isFiniteNumber(clipW) || clipW <= MIN_CLIP_W) {
    return null;
  }
  return [clipX, clipY, clipZ, clipW];
};

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
  const resolvedAngle = normaliseAngleDeg(resolvedAngleRaw);

  sprite.images.forEach((orderMap) => {
    orderMap.forEach((image) => {
      // Only update images participating in auto-rotation; others preserve their manual angles.
      if (!image.autoRotation) {
        return;
      }
      image.resolvedBaseRotateDeg = resolvedAngle;
      updateImageDisplayedRotation(image);
    });
  });

  sprite.lastAutoRotationLocation = cloneSpriteLocation(nextLocation);
  sprite.lastAutoRotationAngleDeg = resolvedAngle;

  return true;
};

/** Number of components per vertex (clipPosition.xyzw + uv.xy). */
const VERTEX_COMPONENT_COUNT = 6;
/** Component count for clip-space position attributes. */
const POSITION_COMPONENT_COUNT = 4;
/** Component count for UV attributes. */
const UV_COMPONENT_COUNT = 2;
/** Byte size of a Float32. */
const FLOAT_SIZE = Float32Array.BYTES_PER_ELEMENT;
/** Stride per vertex in bytes. */
const VERTEX_STRIDE = VERTEX_COMPONENT_COUNT * FLOAT_SIZE;
/** Byte offset for the UV attribute. */
const UV_OFFSET = POSITION_COMPONENT_COUNT * FLOAT_SIZE;
/** Vertex count required to draw one sprite as two triangles. */
const QUAD_VERTEX_COUNT = 6;

/** Shared vertex shader for both billboard and surface modes that accepts clip coordinates. */
const VERTEX_SHADER_SOURCE = `
attribute vec4 a_position;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = a_position;
}
` as const;

/** Fragment shader that applies texture sampling and opacity. */
const FRAGMENT_SHADER_SOURCE = `
precision mediump float;
uniform sampler2D u_texture;
uniform float u_opacity;
varying vec2 v_uv;
void main() {
  vec4 texel = texture2D(u_texture, v_uv);
  gl_FragColor = vec4(texel.rgb, texel.a) * u_opacity;
}
` as const;

/** Initial vertex data for a unit quad. */
const INITIAL_QUAD_VERTICES = new Float32Array(
  QUAD_VERTEX_COUNT * VERTEX_COMPONENT_COUNT
);

/** Scratch buffer rewritten for each draw call. */
const QUAD_VERTEX_SCRATCH = new Float32Array(
  QUAD_VERTEX_COUNT * VERTEX_COMPONENT_COUNT
);

/**
 * Compiles a shader from source, throwing if compilation fails.
 * @param {WebGLRenderingContext} glContext - Active WebGL context.
 * @param {number} type - Shader type (`VERTEX_SHADER` or `FRAGMENT_SHADER`).
 * @param {string} source - GLSL source code.
 * @returns {WebGLShader} Compiled shader object.
 * @throws When shader creation or compilation fails.
 */
export const compileShader = (
  glContext: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader => {
  const shader = glContext.createShader(type);
  if (!shader) {
    throw new Error('Failed to create shader.');
  }
  glContext.shaderSource(shader, source);
  glContext.compileShader(shader);
  if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
    const info = glContext.getShaderInfoLog(shader) ?? 'unknown error';
    glContext.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info}`);
  }
  return shader;
};

/**
 * Links a vertex and fragment shader into a WebGL program.
 * @param {WebGLRenderingContext} glContext - Active WebGL context.
 * @param {string} vertexSource - Vertex shader GLSL source.
 * @param {string} fragmentSource - Fragment shader GLSL source.
 * @returns {WebGLProgram} Linked shader program ready for use.
 * @throws When linking fails or a program cannot be created.
 */
export const createShaderProgram = (
  glContext: WebGLRenderingContext,
  vertexSource: string,
  fragmentSource: string
): WebGLProgram => {
  const vertexShader = compileShader(
    glContext,
    glContext.VERTEX_SHADER,
    vertexSource
  );
  const fragmentShader = compileShader(
    glContext,
    glContext.FRAGMENT_SHADER,
    fragmentSource
  );
  const program = glContext.createProgram();
  if (!program) {
    glContext.deleteShader(vertexShader);
    glContext.deleteShader(fragmentShader);
    throw new Error('Failed to create WebGL program.');
  }
  glContext.attachShader(program, vertexShader);
  glContext.attachShader(program, fragmentShader);
  glContext.linkProgram(program);
  glContext.deleteShader(vertexShader);
  glContext.deleteShader(fragmentShader);

  if (!glContext.getProgramParameter(program, glContext.LINK_STATUS)) {
    const info = glContext.getProgramInfoLog(program) ?? 'unknown error';
    glContext.deleteProgram(program);
    throw new Error(`Program link failed: ${info}`);
  }

  return program;
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Image metadata ready for use as a WebGL texture.
 * @property {string} id - Unique identifier registered with the MapLibre layer.
 * @property {number} width - Image width in source pixels.
 * @property {number} height - Image height in source pixels.
 * @property {ImageBitmap} bitmap - Backing bitmap used for uploads.
 * @property {WebGLTexture} [texture] - GPU texture bound to the bitmap.
 */
interface RegisteredImage {
  id: string;
  width: number;
  height: number;
  bitmap: ImageBitmap;
  texture: WebGLTexture | undefined;
}

//////////////////////////////////////////////////////////////////////////////////////

const DEFAULT_TEXT_GLYPH_FONT_FAMILY = 'sans-serif';
const DEFAULT_TEXT_GLYPH_FONT_STYLE: 'normal' | 'italic' = 'normal';
const DEFAULT_TEXT_GLYPH_FONT_WEIGHT = 'normal';
const DEFAULT_TEXT_GLYPH_COLOR = '#000000';
const DEFAULT_TEXT_GLYPH_ALIGN: SpriteTextGlyphHorizontalAlign = 'center';
const DEFAULT_TEXT_GLYPH_FONT_SIZE = 32;
const DEFAULT_TEXT_GLYPH_RENDER_PIXEL_RATIO = 1;
const MAX_TEXT_GLYPH_RENDER_PIXEL_RATIO = 4;
const MIN_TEXT_GLYPH_FONT_SIZE = 4;

type ResolvedTextGlyphPadding = {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
};

type ResolvedBorderSides = {
  readonly top: boolean;
  readonly right: boolean;
  readonly bottom: boolean;
  readonly left: boolean;
};

interface ResolvedTextGlyphOptions {
  readonly fontFamily: string;
  readonly fontStyle: 'normal' | 'italic';
  readonly fontWeight: string;
  readonly fontSizePixel: number;
  readonly color: string;
  readonly letterSpacingPixel: number;
  readonly backgroundColor?: string;
  readonly paddingPixel: ResolvedTextGlyphPadding;
  readonly borderColor?: string;
  readonly borderWidthPixel: number;
  readonly borderRadiusPixel: number;
  readonly borderSides: ResolvedBorderSides;
  readonly textAlign: SpriteTextGlyphHorizontalAlign;
  readonly renderPixelRatio: number;
}

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
 * Normalises the border sides definition, defaulting to all sides when unspecified or invalid.
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

type Canvas2DContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

type Canvas2DSource = HTMLCanvasElement | OffscreenCanvas;

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

type MutableSpriteScreenPoint = { x: number; y: number };

/**
 * Base attributes for an image that composes a sprite.
 */
interface InternalSpriteImageState {
  /**
   * Sub-layer identifier.
   */
  subLayer: number;
  /**
   * Ordering value within the sub-layer.
   */
  order: number;
  /**
   * Image ID referenced for rendering.
   */
  imageId: string;
  /**
   * Rendering mode. Defaults to surface.
   */
  mode: SpriteMode;
  /**
   * Opacity applied to the image alpha. Defaults to 1.0.
   */
  opacity: number;
  /**
   * Multiplier for real-world meters corresponding to one image pixel. 1.0 = 1 meter. Defaults to 1.0.
   */
  scale: number;
  /**
   * Anchor position within the sprite. Defaults to [0.0, 0.0].
   */
  anchor: SpriteAnchor;
  /**
   * Offset from the sprite coordinate. Defaults to no offset.
   */
  offset: SpriteImageOffset;
  /**
   * Requested rotation angle in degrees. Defaults to 0.
   * Billboard mode: Clockwise rotation relative to the viewport.
   * Surface mode: Clockwise azimuth from geographic north.
   */
  rotateDeg: number;
  /**
   * Rotation currently applied during rendering.
   */
  displayedRotateDeg: number;
  /**
   * Whether auto-rotation is enabled. Defaults to true in surface mode and false in billboard mode.
   * The sprite orientation is derived from its movement vector when enabled.
   */
  autoRotation: boolean;
  /**
   * Minimum distance in meters required before auto-rotation updates. Defaults to 20 m.
   * Values <= 0 trigger immediate updates.
   */
  autoRotationMinDistanceMeters: number;
  /**
   * Base rotation determined by auto-rotation. Initially 0.
   */
  resolvedBaseRotateDeg: number;
  /**
   * Reference sub-layer used as the origin for offsets. Defaults to sprite coordinates.
   */
  originLocation?: SpriteImageOriginLocation;
  /**
   * Interpolation state for display rotation.
   */
  rotationInterpolationState: NumericInterpolationState | null;
  /**
   * Default interpolation options for display rotation.
   */
  rotationInterpolationOptions: SpriteNumericInterpolationOptions | null;
  /**
   * Interpolation state used for offset.offsetDeg.
   */
  offsetInterpolationState: NumericInterpolationState | null;
  /**
   * Reusable buffer storing screen-space quad corners for hit testing.
   */
  hitTestCorners?: [
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
  ];
}

/**
 * Sprite position interpolation state.
 */
type InternalSpriteInterpolationState = SpriteInterpolationState;

/**
 * Current sprite state.
 * @param TTag Tag type.
 */
interface InternalSpriteCurrentState<TTag> {
  /**
   * Sprite identifier.
   */
  spriteId: string;
  /**
   * Whether the sprite is enabled.
   */
  isEnabled: boolean;
  /**
   * Current location (interpolated position when moving).
   */
  currentLocation: SpriteLocation;
  /**
   * Source location used for movement interpolation.
   * Feedback mode: previous command location.
   * Feed-forward mode: current command location.
   */
  fromLocation?: SpriteLocation;
  /**
   * Destination location used for movement interpolation.
   * Feedback mode: current command location.
   * Feed-forward mode: predicted location.
   */
  toLocation?: SpriteLocation;
  /**
   * Map of image states currently associated with the sprite.
   */
  images: Map<number, Map<number, InternalSpriteImageState>>;
  /**
   * Optional tag (null when not set).
   */
  tag: TTag | null;
  /**
   * Active interpolation state, or null when idle.
   */
  interpolationState: InternalSpriteInterpolationState | null;
  /**
   * Most recently requested interpolation options, or null if none pending.
   */
  pendingInterpolationOptions: SpriteInterpolationOptions | null;
  /**
   * Most recently commanded location, regardless of interpolation.
   */
  lastCommandLocation: SpriteLocation;
  /**
   * Latest location used as the basis for auto-rotation calculation.
   */
  lastAutoRotationLocation: SpriteLocation;
  /**
   * Last resolved base angle from auto-rotation in degrees, reused as the next initial value.
   */
  lastAutoRotationAngleDeg: number;
}

//////////////////////////////////////////////////////////////////////////////////////

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
 * Updates the displayed rotation for an image, optionally using override interpolation options.
 * @param {InternalSpriteImageState} image - Image state to mutate.
 * @param {SpriteNumericInterpolationOptions | null} [optionsOverride] - Temporary interpolation override.
 */
const updateImageDisplayedRotation = (
  image: InternalSpriteImageState,
  optionsOverride?: SpriteNumericInterpolationOptions | null
): void => {
  const targetAngle = normaliseAngleDeg(
    image.resolvedBaseRotateDeg + image.rotateDeg
  );
  const currentAngle = Number.isFinite(image.displayedRotateDeg)
    ? image.displayedRotateDeg
    : targetAngle;

  const options =
    optionsOverride === undefined
      ? image.rotationInterpolationOptions
      : optionsOverride;

  const { nextAngleDeg, interpolationState } = resolveRotationTarget({
    currentAngleDeg: currentAngle,
    targetAngleDeg: targetAngle,
    options: options ?? undefined,
  });

  image.displayedRotateDeg = nextAngleDeg;
  image.rotationInterpolationState = interpolationState;

  if (!interpolationState) {
    image.displayedRotateDeg = targetAngle;
  }
};

/**
 * Deep-clones movement interpolation options to prevent shared references between sprites.
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
 * Deep-clones numeric interpolation options to avoid shared mutable state.
 * @param {SpriteNumericInterpolationOptions} options - Options provided by the user.
 * @returns {SpriteNumericInterpolationOptions} Cloned options object.
 */
const cloneNumericInterpolationOptions = (
  options: SpriteNumericInterpolationOptions
): SpriteNumericInterpolationOptions => {
  return {
    durationMs: options.durationMs,
    easing: options.easing,
  };
};

/**
 * Creates internal sprite image state from initialization data and layer bookkeeping fields.
 * @param {SpriteImageDefinitionInit} imageInit - Caller-provided image definition.
 * @param {number} subLayer - Sub-layer index the image belongs to.
 * @param {number} order - Ordering slot within the sub-layer.
 * @returns {InternalSpriteImageState} Normalized internal state ready for rendering.
 */
export const createImageStateFromInit = (
  imageInit: SpriteImageDefinitionInit,
  subLayer: number,
  order: number
): InternalSpriteImageState => {
  const mode = imageInit.mode ?? 'surface';
  const autoRotationDefault = mode === 'surface';
  const state: InternalSpriteImageState = {
    subLayer,
    order,
    imageId: imageInit.imageId,
    mode,
    opacity: imageInit.opacity ?? 1.0,
    scale: imageInit.scale ?? 1.0,
    anchor: cloneAnchor(imageInit.anchor),
    offset: cloneOffset(imageInit.offset),
    rotateDeg: imageInit.rotateDeg ?? 0,
    displayedRotateDeg: normaliseAngleDeg(imageInit.rotateDeg ?? 0),
    autoRotation: imageInit.autoRotation ?? autoRotationDefault,
    autoRotationMinDistanceMeters:
      imageInit.autoRotationMinDistanceMeters ??
      DEFAULT_AUTO_ROTATION_MIN_DISTANCE_METERS,
    resolvedBaseRotateDeg: 0,
    originLocation: cloneOriginLocation(imageInit.originLocation),
    rotationInterpolationState: null,
    rotationInterpolationOptions: null,
    offsetInterpolationState: null,
  };
  // Preload rotation interpolation defaults when supplied on initialization; otherwise treat as absent.
  const rotateInitOption = imageInit.rotationInterpolation?.rotateDeg ?? null;
  if (rotateInitOption) {
    state.rotationInterpolationOptions =
      cloneNumericInterpolationOptions(rotateInitOption);
  }

  updateImageDisplayedRotation(state);

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
  const resolvedScaling = resolveScalingOptions(options?.spriteScaling);
  const resolvedTextureFiltering = resolveTextureFilteringOptions(
    options?.textureFiltering
  );

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
  /** Cached anisotropic filtering extension instance (when available). */
  let anisotropyExtension: EXT_texture_filter_anisotropic | null = null;
  /** Maximum anisotropy supported by the current context. */
  let maxSupportedAnisotropy = 1;

  //////////////////////////////////////////////////////////////////////////

  /**
   * Registry of loaded images, pairing ImageBitmaps with WebGL textures.
   */
  const images = new Map<string, RegisteredImage>();

  /**
   * Tracks queued image IDs to avoid duplicated uploads.
   */
  const queuedTextureIds = new Set<string>();

  /**
   * Enqueues an image for GPU texture upload.
   * @param {RegisteredImage} image - Registered image awaiting upload.
   * @returns {void}
   */
  const queueTextureUpload = (image: RegisteredImage): void => {
    queuedTextureIds.add(image.id);
  };

  /**
   * Removes an image ID from the upload queue when no longer needed.
   * @param {string} imageId - Identifier of the image to cancel.
   * @returns {void}
   */
  const cancelQueuedTextureUpload = (imageId: string): void => {
    queuedTextureIds.delete(imageId);
  };

  /**
   * Clears all pending texture uploads.
   * @returns {void}
   */
  const clearTextureQueue = (): void => {
    queuedTextureIds.clear();
  };

  /**
   * Collection of sprites currently managed by the layer.
   */
  const sprites = new Map<string, InternalSpriteCurrentState<T>>();

  // Helpers for manipulating image maps.

  /**
   * Looks up an image state for the given sprite, sub-layer, and ordering slot.
   * @param {InternalSpriteCurrentState<T>} sprite - Sprite whose image map is queried.
   * @param {number} subLayer - Sub-layer identifier.
   * @param {number} order - Order position within the sub-layer.
   * @returns {InternalSpriteImageState | undefined} Image state when present.
   */
  const getImageState = (
    sprite: InternalSpriteCurrentState<T>,
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
    sprite: InternalSpriteCurrentState<T>,
    state: InternalSpriteImageState
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
    sprite: InternalSpriteCurrentState<T>,
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
    sprite: InternalSpriteCurrentState<T>,
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

  type HitTestEntry = {
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
  };

  /** Small tolerance used to handle floating-point error during hit testing. */
  const HIT_TEST_EPSILON = 1e-3;

  /**
   * Determines whether a point lies inside the triangle defined by `a`, `b`, and `c`.
   * @param {SpriteScreenPoint} point - Point to test.
   * @param {SpriteScreenPoint} a - First triangle vertex.
   * @param {SpriteScreenPoint} b - Second triangle vertex.
   * @param {SpriteScreenPoint} c - Third triangle vertex.
   * @returns {boolean} `true` when the point falls within or on the edges of the triangle.
   */
  const pointInTriangle = (
    point: SpriteScreenPoint,
    a: SpriteScreenPoint,
    b: SpriteScreenPoint,
    c: SpriteScreenPoint
  ): boolean => {
    const v0x = c.x - a.x;
    const v0y = c.y - a.y;
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = point.x - a.x;
    const v2y = point.y - a.y;

    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;

    const denom = dot00 * dot11 - dot01 * dot01;
    // Degenerate triangles produce near-zero denominators; bail out to avoid amplification.
    if (Math.abs(denom) < HIT_TEST_EPSILON) {
      return false;
    }

    const invDenom = 1 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
    const w = 1 - u - v;

    return (
      u >= -HIT_TEST_EPSILON && v >= -HIT_TEST_EPSILON && w >= -HIT_TEST_EPSILON
    );
  };

  /**
   * Determines whether a point lies inside a convex quad by decomposing into two triangles.
   * @param {SpriteScreenPoint} point - Point to test.
   * @param {readonly SpriteScreenPoint[]} corners - Quad corners ordered as [top-left, top-right, bottom-left, bottom-right].
   * @returns {boolean} `true` when the point lies inside the quad.
   */
  const pointInQuad = (
    point: SpriteScreenPoint,
    corners: readonly [
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
    ]
  ): boolean =>
    pointInTriangle(point, corners[0], corners[1], corners[2]) ||
    pointInTriangle(point, corners[0], corners[2], corners[3]);

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
    return pointInQuad(point, entry.corners);
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
   * Simple XY coordinate tuple representing screen-space positions in pixels.
   */
  type XYPoint = { x: number; y: number };

  /**
   * Cache entry storing anchor-adjusted and raw centers for a sprite image.
   */
  type ImageCenterCacheEntry = {
    anchorApplied?: XYPoint;
    anchorless?: XYPoint;
  };

  /**
   * Nested cache keyed by sprite ID and image key to avoid recomputing centers each frame.
   */
  type ImageCenterCache = Map<string, Map<string, ImageCenterCacheEntry>>;

  /**
   * Parameters required to determine an image center in screen space.
   */
  type ComputeImageCenterParams = {
    readonly mapInstance: MapLibreMap;
    readonly images: Map<string, RegisteredImage>;
    readonly originCenterCache: ImageCenterCache;
    readonly projected: { x: number; y: number };
    readonly zoomScaleFactor: number;
    readonly baseMetersPerPixel: number;
    readonly spriteMinPixel: number;
    readonly spriteMaxPixel: number;
    readonly effectivePixelsPerMeter: number;
    readonly drawingBufferWidth: number;
    readonly drawingBufferHeight: number;
    readonly pixelRatio: number;
    readonly clipContext: ClipContext | null;
    readonly altitudeMeters: number;
  };

  /**
   * Computes the screen-space center of an image, caching anchor-dependent results.
   * @template T Sprite tag type.
   * @param {InternalSpriteCurrentState<T>} sprite - Sprite that owns the image.
   * @param {InternalSpriteImageState} img - Image state to evaluate.
   * @param {ComputeImageCenterParams} params - Precomputed scaling and projection context.
   * @param {{ useResolvedAnchor?: boolean }} [options] - When true, returns the anchor-applied center.
   * @returns {{ x: number; y: number }} Screen-space coordinates for the requested center variant.
   */
  const computeImageCenterXY = <T>(
    sprite: InternalSpriteCurrentState<T>,
    img: InternalSpriteImageState,
    params: ComputeImageCenterParams,
    options?: { useResolvedAnchor?: boolean }
  ): { x: number; y: number } => {
    const {
      originCenterCache,
      projected,
      zoomScaleFactor,
      baseMetersPerPixel,
      spriteMinPixel,
      spriteMaxPixel,
      effectivePixelsPerMeter,
      images,
      mapInstance,
      drawingBufferWidth,
      drawingBufferHeight,
      pixelRatio,
      clipContext,
      altitudeMeters,
    } = params;

    // Decide whether to return the anchor-adjusted center or the raw projected location.
    const useResolvedAnchor = options?.useResolvedAnchor ?? false;

    let spriteCache = originCenterCache.get(sprite.spriteId);
    if (!spriteCache) {
      // Initialize a new cache bucket for this sprite when none exists yet.
      spriteCache = new Map<string, ImageCenterCacheEntry>();
      originCenterCache.set(sprite.spriteId, spriteCache);
    }

    const cacheKey = `${img.subLayer}:${img.order}`;
    const cachedEntry = spriteCache.get(cacheKey);
    if (cachedEntry) {
      // Hit the cache: return whichever variant (anchor vs anchorless) the caller requested.
      const cachedPoint = useResolvedAnchor
        ? cachedEntry.anchorApplied
        : cachedEntry.anchorless;
      if (cachedPoint) {
        return cachedPoint;
      }
    }

    let baseX = projected.x;
    let baseY = projected.y;
    if (img.originLocation !== undefined) {
      const ref = sprite.images
        .get(img.originLocation.subLayer)
        ?.get(img.originLocation.order);
      if (ref) {
        const refCenter = computeImageCenterXY(sprite, ref, params, {
          useResolvedAnchor: img.originLocation.useResolvedAnchor ?? false,
        });
        baseX = refCenter.x;
        baseY = refCenter.y;
      }
    }

    const totalRotDeg = Number.isFinite(img.displayedRotateDeg)
      ? img.displayedRotateDeg
      : normaliseAngleDeg(
          (img.resolvedBaseRotateDeg ?? 0) + (img.rotateDeg ?? 0)
        );
    const imageScaleLocal = img.scale ?? 1;
    const imageResourceRef = images.get(img.imageId);

    if (img.mode === 'billboard') {
      const placement = calculateBillboardCenterPosition({
        base: { x: baseX, y: baseY },
        imageWidth: imageResourceRef?.width,
        imageHeight: imageResourceRef?.height,
        baseMetersPerPixel,
        imageScale: imageScaleLocal,
        zoomScaleFactor,
        effectivePixelsPerMeter,
        spriteMinPixel,
        spriteMaxPixel,
        totalRotateDeg: totalRotDeg,
        anchor: img.anchor,
        offset: img.offset,
      });
      // Center used when the anchor is resolved to the provided anchor point.
      const anchorApplied: XYPoint = {
        x: placement.centerX,
        y: placement.centerY,
      };
      // Origin fallback before anchor offsets are applied; used by callers referencing anchorless placement.
      const anchorless: XYPoint = {
        x: anchorApplied.x + placement.anchorShift.x,
        y: anchorApplied.y - placement.anchorShift.y,
      };
      // Reuse cached entry to avoid repeated allocations.
      // Cache the computed centers so repeated lookups in this frame avoid recomputation.
      const entry = cachedEntry ?? {};
      entry.anchorless = anchorless;
      entry.anchorApplied = anchorApplied;
      spriteCache.set(cacheKey, entry);
      return useResolvedAnchor ? anchorApplied : anchorless;
    }

    const baseLngLat =
      img.originLocation !== undefined
        ? // When anchored to another image, reproject the 2D reference point back to geographic space.
          (mapInstance.unproject([baseX, baseY] as any) as {
            lng: number;
            lat: number;
          })
        : // Otherwise use the sprite's own interpolated geographic location.
          { lng: sprite.currentLocation.lng, lat: sprite.currentLocation.lat };

    const projectToClipSpace: ProjectToClipSpaceFn | undefined = clipContext
      ? (lng, lat, elevation) =>
          projectLngLatToClipSpace(lng, lat, elevation, clipContext)
      : undefined;

    const surfacePlacement = calculateSurfaceCenterPosition({
      baseLngLat,
      imageWidth: imageResourceRef?.width,
      imageHeight: imageResourceRef?.height,
      baseMetersPerPixel,
      imageScale: imageScaleLocal,
      zoomScaleFactor,
      totalRotateDeg: totalRotDeg,
      anchor: img.anchor,
      offset: img.offset,
      effectivePixelsPerMeter,
      spriteMinPixel,
      spriteMaxPixel,
      projectToClipSpace,
      drawingBufferWidth,
      drawingBufferHeight,
      pixelRatio,
      altitudeMeters,
      resolveAnchorless: true,
      project:
        projectToClipSpace === undefined
          ? (lngLat) => {
              const projectedPoint = mapInstance.project(lngLat as any);
              if (!projectedPoint) {
                return null;
              }
              return { x: projectedPoint.x, y: projectedPoint.y };
            }
          : undefined,
    });

    const anchorlessCenter = surfacePlacement.anchorlessCenter ?? {
      // If the anchorless placement could not be projected, fall back to the original screen position.
      x: baseX,
      y: baseY,
    };
    // If the anchor-aware placement fails, reuse the anchorless center to keep the sprite visible.
    const anchorAppliedCenter = surfacePlacement.center ?? anchorlessCenter;

    // Cache the computed centers so repeated lookups in this frame avoid recomputation.
    const entry = cachedEntry ?? {};
    entry.anchorless = anchorlessCenter;
    entry.anchorApplied = anchorAppliedCenter;
    spriteCache.set(cacheKey, entry);
    // Respect the caller's anchor preference when selecting the cached center.
    return useResolvedAnchor ? anchorAppliedCenter : anchorlessCenter;
  };

  /**
   * List of sprite/image pairs that need to be rendered.
   * Updated whenever sprites or their images are added or removed, and filtered to visible entries.
   */
  const renderTargetEntries: RenderTargetEntry[] = [];

  const hitTestEntries: HitTestEntry[] = [];

  /**
   * Ensures an image has a reusable hit-test corner buffer.
   * @param {InternalSpriteImageState} imageEntry - Image requiring a corner buffer.
   * @returns {[SpriteScreenPoint, SpriteScreenPoint, SpriteScreenPoint, SpriteScreenPoint]}
   */
  const ensureHitTestCorners = (
    imageEntry: InternalSpriteImageState
  ): [
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
  ] => {
    if (!imageEntry.hitTestCorners) {
      imageEntry.hitTestCorners = [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ];
    }
    return imageEntry.hitTestCorners;
  };

  /**
   * Adds a hit-test entry to the cache, computing its axis-aligned bounding box.
   * @param {InternalSpriteCurrentState<T>} spriteEntry - Sprite owning the image.
   * @param {InternalSpriteImageState} imageEntry - Image reference.
   * @param {readonly SpriteScreenPoint[]} screenCorners - Quad corners in screen space.
   */
  const registerHitTestEntry = (
    spriteEntry: InternalSpriteCurrentState<T>,
    imageEntry: InternalSpriteImageState,
    screenCorners: readonly [
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
    ]
  ): void => {
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

    hitTestEntries.push({
      sprite: spriteEntry,
      image: imageEntry,
      corners,
      minX,
      maxX,
      minY,
      maxY,
    });
  };

  /**
   * Returns the top-most hit-test entry at the given screen point.
   * @param {SpriteScreenPoint} point - Screen coordinate from the pointer event.
   * @returns {HitTestEntry | null} Entry representing the hit or `null` if none.
   */
  const findTopmostHitEntry = (
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
   * Indicates whether any `spriteclick` listeners are registered.
   * @returns {boolean} `true` when at least one click listener exists.
   */
  const hasSpriteClickListeners = (): boolean =>
    // Treat missing listener sets as zero, otherwise check the registered count.
    (eventListeners.get('spriteclick')?.size ?? 0) > 0;

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

    const spriteState = getSpriteState(hitEntry.sprite.spriteId);
    // Skip dispatch if the sprite was removed between hit-test collection and event handling.
    if (!spriteState) {
      return;
    }

    const imageState = hitEntry.image as unknown as SpriteImageState;

    const clickEvent: SpriteLayerClickEvent<T> = {
      type: 'spriteclick',
      sprite: spriteState,
      image: imageState,
      screenPoint,
      originalEvent,
    };

    listeners.forEach((listener) => {
      (listener as SpriteLayerEventListener<T, 'spriteclick'>)(clickEvent);
    });
  };

  /**
   * Handles pointer/touch events to trigger sprite click callbacks when matches are found.
   * @param {MouseEvent | PointerEvent | TouchEvent} nativeEvent - Original browser event.
   */
  const processInteractionEvent = (
    nativeEvent: MouseEvent | PointerEvent | TouchEvent
  ): void => {
    // Skip work entirely when no listeners are interested in click events.
    if (!hasSpriteClickListeners()) {
      return;
    }
    // No hit-test entries means nothing is interactable during this frame.
    if (hitTestEntries.length === 0) {
      return;
    }

    const screenPoint = resolveScreenPointFromEvent(nativeEvent);
    // Input may lack coordinates (e.g., touchend without touches); abort hit-testing in that case.
    if (!screenPoint) {
      return;
    }

    const hitEntry = findTopmostHitEntry(screenPoint);
    // No sprites intersected the event point; nothing to dispatch.
    if (!hitEntry) {
      return;
    }

    dispatchSpriteClick(hitEntry, screenPoint, nativeEvent);
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
    // Defer texture creation until the WebGL context becomes available.
    if (!gl) {
      return;
    }
    if (queuedTextureIds.size === 0) {
      return;
    }
    const glContext = gl;

    // Iterates all queue item (image id)
    queuedTextureIds.forEach((imageId) => {
      // Extract image object
      const image = images.get(imageId);
      queuedTextureIds.delete(imageId);
      if (!image || !image.bitmap) {
        return;
      }
      if (image.texture) {
        // Delete existing textures to avoid stale GPU data.
        glContext.deleteTexture(image.texture);
        image.texture = undefined;
      }
      const texture = glContext.createTexture();
      if (!texture) {
        // Rendering cannot continue without GPU resources.
        throw new Error('Failed to create texture.');
      }
      glContext.bindTexture(glContext.TEXTURE_2D, texture);
      // Clamp wrapping to avoid sampling outside sprite edges.
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
      // Enable premultiplied alpha for natural blending on the canvas.
      glContext.pixelStorei(glContext.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      glContext.texImage2D(
        glContext.TEXTURE_2D,
        0,
        glContext.RGBA,
        glContext.RGBA,
        glContext.UNSIGNED_BYTE,
        image.bitmap
      );

      // Determine the desired filters up-front.
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
          isWebGL2 || (isPowerOfTwo(image.width) && isPowerOfTwo(image.height));
        if (canUseMipmaps) {
          glContext.generateMipmap(glContext.TEXTURE_2D);
          usedMipmaps = true;
        } else {
          // Fall back to linear filtering when mipmaps are unsupported.
          minFilterEnum = glContext.LINEAR;
        }
      }

      if (
        !usedMipmaps &&
        filterRequiresMipmaps(resolvedTextureFiltering.minFilter)
      ) {
        // Without mipmaps the requested filter would produce incomplete textures.
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

      image.texture = texture;
    });
  };

  /**
   * Requests a redraw from MapLibre.
   * Custom layers must call triggerRepaint manually whenever their content changes.
   * Ensure this runs after animations or style updates so the render loop reflects changes.
   * @returns {void}
   */
  const scheduleRender = (): void => {
    // Only attempt to repaint when the MapLibre instance is available.
    map?.triggerRepaint();
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
            return;
          }
          // Skip images referencing texture IDs that are not registered.
          if (!images.has(image.imageId)) {
            return;
          }
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
        const pointerListener = (event: PointerEvent) => {
          if (event.pointerType === 'mouse' && event.button !== 0) {
            // Ignore non-primary mouse buttons to match click semantics.
            return;
          }
          processInteractionEvent(event);
        };
        canvasElement.addEventListener('pointerup', pointerListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement?.removeEventListener('pointerup', pointerListener);
        });
      } else {
        const clickListener = (event: MouseEvent) => {
          if (event.button !== 0) {
            // Only respond to primary button clicks when pointer events are unavailable.
            return;
          }
          processInteractionEvent(event);
        };
        canvasElement.addEventListener('click', clickListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement?.removeEventListener('click', clickListener);
        });

        const touchListener = (event: TouchEvent) => {
          processInteractionEvent(event);
        };
        canvasElement.addEventListener('touchend', touchListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement?.removeEventListener('touchend', touchListener);
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
    if (!uniformTextureLocation || !uniformOpacityLocation) {
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

    // Unbind the ARRAY_BUFFER once initialization is complete.
    glContext.bindBuffer(glContext.ARRAY_BUFFER, null);

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

    const glContext = gl;
    if (glContext) {
      images.forEach((image) => {
        // Delete textures when present; otherwise there is nothing to reuse.
        if (image.texture) {
          glContext.deleteTexture(image.texture);
        }
        image.texture = undefined;
        queueTextureUpload(image);
      });
      if (vertexBuffer) {
        glContext.deleteBuffer(vertexBuffer);
      }
      if (program) {
        glContext.deleteProgram(program);
      }
    }

    eventListeners.forEach((set) => set.clear());
    eventListeners.clear();

    gl = null;
    map = null;
    program = null;
    vertexBuffer = null;
    attribPositionLocation = -1;
    attribUvLocation = -1;
    uniformTextureLocation = null;
    uniformOpacityLocation = null;
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
    hitTestEntries.length = 0;

    // Abort early if any critical resource (map, program, vertex buffer) is missing.
    const mapInstance = map;
    // Rendering cannot proceed if core resources (map/program/buffer) are missing; bail out early.
    if (!mapInstance || !program || !vertexBuffer) {
      return;
    }
    // Uniform locations must be resolved before drawing; skip the frame otherwise.
    if (!uniformOpacityLocation || !uniformTextureLocation) {
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
          const rotationState = image.rotationInterpolationState;
          // Re-sample rotation interpolation when configured.
          if (rotationState) {
            const evaluation = evaluateNumericInterpolation({
              state: rotationState,
              timestamp,
            });
            // Align rotation interpolation start time on the first frame.
            if (rotationState.startTimestamp < 0) {
              rotationState.startTimestamp = evaluation.effectiveStartTimestamp;
            }
            image.displayedRotateDeg = normaliseAngleDeg(evaluation.value);
            if (evaluation.completed) {
              // Store final rotation and tear down interpolation state once complete.
              image.displayedRotateDeg = normaliseAngleDeg(
                rotationState.finalValue
              );
              image.rotationInterpolationState = null;
            } else {
              hasActiveInterpolation = true;
            }
          }

          const offsetState = image.offsetInterpolationState;
          // Apply offset angular interpolation if declared.
          if (offsetState) {
            const evaluation = evaluateNumericInterpolation({
              state: offsetState,
              timestamp,
            });
            // Same initialization step for offset interpolation timestamps.
            if (offsetState.startTimestamp < 0) {
              offsetState.startTimestamp = evaluation.effectiveStartTimestamp;
            }
            image.offset.offsetDeg = evaluation.value;
            if (evaluation.completed) {
              // When finished, lock in the final offset and clear state.
              image.offset.offsetDeg = offsetState.finalValue;
              image.offsetInterpolationState = null;
            } else {
              hasActiveInterpolation = true;
            }
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
    const zoom = mapInstance.getZoom();
    const zoomScaleFactor = calculateZoomScaleFactor(zoom, resolvedScaling);
    const baseMetersPerPixel = resolvedScaling.metersPerPixel;
    const spriteMinPixel = resolvedScaling.spriteMinPixel;
    const spriteMaxPixel = resolvedScaling.spriteMaxPixel;
    const clipContext = getClipContext(mapInstance);
    // Without a clip context we cannot project to clip space; skip rendering.
    if (!clipContext) {
      return;
    }

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

    /**
     * Uploads quad data and issues the draw call for a single sprite image.
     * @param {InternalSpriteCurrentState<T>} spriteEntry - Sprite owning the image being drawn.
     * @param {InternalSpriteImageState} imageEntry - Image state describing rendering parameters.
     * @param {RegisteredImage} imageResource - GPU-backed image resource.
     * @param {ImageCenterCache} originCenterCache - Cache for resolving origin references quickly.
     * @returns {void}
     */
    const drawSpriteImage = (
      spriteEntry: InternalSpriteCurrentState<T>,
      imageEntry: InternalSpriteImageState,
      imageResource: RegisteredImage,
      originCenterCache: ImageCenterCache
    ): void => {
      let screenCornerBuffer: SpriteScreenPoint[] | null = null;
      // Use per-image anchor/offset when provided; otherwise fall back to defaults.
      const anchor = imageEntry.anchor ?? DEFAULT_ANCHOR;
      const offsetDef = imageEntry.offset ?? DEFAULT_IMAGE_OFFSET;
      // Prefer the dynamically interpolated rotation when available; otherwise synthesize it from base + manual rotations.
      const totalRotateDeg = Number.isFinite(imageEntry.displayedRotateDeg)
        ? imageEntry.displayedRotateDeg
        : normaliseAngleDeg(
            (imageEntry.resolvedBaseRotateDeg ?? 0) +
              (imageEntry.rotateDeg ?? 0)
          );

      const projected = mapInstance.project(spriteEntry.currentLocation);
      if (!projected) {
        // Projection may fail when the coordinate exits the viewport.
        return;
      }

      const metersPerPixelAtLat = calculateMetersPerPixelAtLatitude(
        zoom,
        spriteEntry.currentLocation.lat
      );
      if (!Number.isFinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0) {
        return;
      }

      const perspectiveRatio = calculatePerspectiveRatio(
        mapInstance,
        spriteEntry.currentLocation
      );
      // Convert meters-per-pixel into pixels-per-meter when valid so scaling remains intuitive.
      const basePixelsPerMeter =
        metersPerPixelAtLat > 0 ? 1 / metersPerPixelAtLat : 0;
      const effectivePixelsPerMeter = calculateEffectivePixelsPerMeter(
        metersPerPixelAtLat,
        perspectiveRatio
      );
      if (effectivePixelsPerMeter <= 0) {
        return;
      }

      // Input scale defaults to 1 when callers omit it.
      const imageScale = imageEntry.scale ?? 1;

      const centerParams: ComputeImageCenterParams = {
        mapInstance,
        images,
        originCenterCache,
        projected,
        zoomScaleFactor,
        baseMetersPerPixel,
        spriteMinPixel,
        spriteMaxPixel,
        effectivePixelsPerMeter,
        drawingBufferWidth,
        drawingBufferHeight,
        pixelRatio,
        clipContext,
        altitudeMeters: spriteEntry.currentLocation.z ?? 0,
      };

      let baseProjected = { x: projected.x, y: projected.y };
      if (imageEntry.originLocation !== undefined) {
        const refImg = spriteEntry.images
          .get(imageEntry.originLocation.subLayer)
          ?.get(imageEntry.originLocation.order);
        if (refImg) {
          // Align this image's base position with the referenced image when available.
          baseProjected = computeImageCenterXY(
            spriteEntry,
            refImg,
            centerParams,
            {
              useResolvedAnchor:
                imageEntry.originLocation.useResolvedAnchor ?? false,
            }
          );
        }
      }

      if (imageEntry.mode === 'surface') {
        const baseLngLat =
          imageEntry.originLocation !== undefined
            ? // When an origin reference is set, reproject the cached screen point back to geographic space.
              (mapInstance.unproject([
                baseProjected.x,
                baseProjected.y,
              ] as any) as SpriteLocation)
            : // Otherwise base the surface on the sprite's current longitude/latitude.
              spriteEntry.currentLocation;

        const surfaceCenter = calculateSurfaceCenterPosition({
          baseLngLat,
          imageWidth: imageResource.width,
          imageHeight: imageResource.height,
          baseMetersPerPixel,
          imageScale,
          zoomScaleFactor,
          totalRotateDeg,
          anchor,
          offset: offsetDef,
          effectivePixelsPerMeter,
          spriteMinPixel,
          spriteMaxPixel,
          projectToClipSpace: (lng, lat, elevation) =>
            projectLngLatToClipSpace(lng, lat, elevation, clipContext),
          drawingBufferWidth,
          drawingBufferHeight,
          pixelRatio,
          altitudeMeters: spriteEntry.currentLocation.z ?? 0,
          project: !clipContext
            ? (lngLat) => {
                const result = mapInstance.project(lngLat as any);
                return result ? { x: result.x, y: result.y } : null;
              }
            : undefined,
        });

        if (!surfaceCenter.center) {
          // Projection failed for at least one corner; skip rendering to avoid NaNs.
          return;
        }

        const offsetMeters = calculateSurfaceOffsetMeters(
          offsetDef,
          imageScale,
          zoomScaleFactor,
          surfaceCenter.worldDimensions.scaleAdjustment
        );
        const cornerDisplacements = calculateSurfaceCornerDisplacements({
          worldWidthMeters: surfaceCenter.worldDimensions.width,
          worldHeightMeters: surfaceCenter.worldDimensions.height,
          anchor,
          totalRotateDeg,
          offsetMeters,
        });

        const hitTestCorners = ensureHitTestCorners(imageEntry);
        let bufferOffset = 0;
        // Iterate through each vertex defined by TRIANGLE_INDICES to populate the vertex buffer.
        for (const index of TRIANGLE_INDICES) {
          const displacement = cornerDisplacements[index]!;
          const displaced = applySurfaceDisplacement(
            baseLngLat.lng,
            baseLngLat.lat,
            displacement.east,
            displacement.north
          );

          const clipPosition = projectLngLatToClipSpace(
            displaced.lng,
            displaced.lat,
            // Default altitude to zero when sprites lack explicit elevation.
            spriteEntry.currentLocation.z ?? 0,
            clipContext
          );
          if (!clipPosition) {
            // A vertex left the clip volume; abort drawing this image to prevent corrupt geometry.
            return;
          }

          const screenCorner = clipToScreen(
            clipPosition,
            drawingBufferWidth,
            drawingBufferHeight,
            pixelRatio
          );
          if (!screenCorner) {
            return;
          }

          const targetCorner = hitTestCorners[index]!;
          targetCorner.x = screenCorner.x;
          targetCorner.y = screenCorner.y;

          let [clipX, clipY, clipZ, clipW] = clipPosition;
          if (ENABLE_NDC_BIAS_SURFACE) {
            const orderIndex = Math.min(imageEntry.order, ORDER_MAX - 1);
            const biasIndex = imageEntry.subLayer * ORDER_BUCKET + orderIndex;
            const biasNdc = -(biasIndex * EPS_NDC);
            clipZ += biasNdc * clipW;
            const minClipZ = -clipW + MIN_CLIP_Z_EPSILON;
            if (clipZ < minClipZ) {
              // Avoid crossing the near clip plane after biasing, which would invert winding.
              clipZ = minClipZ;
            }
          }

          const [u, v] = UV_CORNERS[index]!;

          QUAD_VERTEX_SCRATCH[bufferOffset++] = clipX;
          QUAD_VERTEX_SCRATCH[bufferOffset++] = clipY;
          QUAD_VERTEX_SCRATCH[bufferOffset++] = clipZ;
          QUAD_VERTEX_SCRATCH[bufferOffset++] = clipW;
          QUAD_VERTEX_SCRATCH[bufferOffset++] = u;
          QUAD_VERTEX_SCRATCH[bufferOffset++] = v;
        }

        screenCornerBuffer = hitTestCorners;

        if (SL_DEBUG) {
          (imageEntry as any).__debugBag = {
            mode: 'surface',
            drawingBufferWidth,
            drawingBufferHeight,
            pixelRatio,
            zoom,
            zoomScaleFactor,
            resolvedScaling,
            baseMetersPerPixel,
            projected,
            metersPerPixelAtLat,
            perspectiveRatio,
            basePixelsPerMeter,
            effectivePixelsPerMeter,
            imageScale,
            anchor,
            offsetDef,
            baseLngLat,
            surfaceCenter,
            cornerDisplacements,
          };
        }
      } else {
        const placement = calculateBillboardCenterPosition({
          base: baseProjected,
          imageWidth: imageResource.width,
          imageHeight: imageResource.height,
          baseMetersPerPixel,
          imageScale,
          zoomScaleFactor,
          effectivePixelsPerMeter,
          spriteMinPixel,
          spriteMaxPixel,
          totalRotateDeg,
          anchor,
          offset: offsetDef,
        });

        const corners = calculateBillboardCornerScreenPositions({
          centerX: placement.centerX,
          centerY: placement.centerY,
          halfWidth: placement.halfWidth,
          halfHeight: placement.halfHeight,
          anchor,
          totalRotateDeg,
        });
        const hitTestCorners = ensureHitTestCorners(imageEntry);

        let bufferOffset = 0;
        // Populate the billboard quad vertices in TRIANGLE_INDICES order.
        for (const index of TRIANGLE_INDICES) {
          const corner = corners[index]!;
          const [clipX, clipY] = screenToClip(
            corner.x,
            corner.y,
            drawingBufferWidth,
            drawingBufferHeight,
            pixelRatio
          );
          QUAD_VERTEX_SCRATCH[bufferOffset++] = clipX;
          QUAD_VERTEX_SCRATCH[bufferOffset++] = clipY;
          QUAD_VERTEX_SCRATCH[bufferOffset++] = 0;
          QUAD_VERTEX_SCRATCH[bufferOffset++] = 1;
          QUAD_VERTEX_SCRATCH[bufferOffset++] = corner.u;
          QUAD_VERTEX_SCRATCH[bufferOffset++] = corner.v;
        }

        for (let i = 0; i < corners.length; i++) {
          const source = corners[i]!;
          const target = hitTestCorners[i]!;
          target.x = source.x;
          target.y = source.y;
        }

        screenCornerBuffer = hitTestCorners;

        if (SL_DEBUG) {
          (imageEntry as any).__debugBag = {
            mode: 'billboard',
            drawingBufferWidth,
            drawingBufferHeight,
            pixelRatio,
            zoom,
            zoomScaleFactor,
            resolvedScaling,
            baseMetersPerPixel,
            projected,
            metersPerPixelAtLat,
            perspectiveRatio,
            basePixelsPerMeter,
            effectivePixelsPerMeter,
            imageScale,
            anchor,
            offsetDef,
            baseProjected,
            placement,
            corners,
          };
        }
      }

      // Register corners for hit testing only when all four vertices were produced.
      if (screenCornerBuffer && screenCornerBuffer.length === 4) {
        registerHitTestEntry(
          spriteEntry,
          imageEntry,
          screenCornerBuffer as [
            SpriteScreenPoint,
            SpriteScreenPoint,
            SpriteScreenPoint,
            SpriteScreenPoint,
          ]
        );
      }

      glContext.bufferSubData(glContext.ARRAY_BUFFER, 0, QUAD_VERTEX_SCRATCH);
      glContext.uniform1f(uniformOpacityLocation, imageEntry.opacity);
      glContext.activeTexture(glContext.TEXTURE0);
      glContext.bindTexture(glContext.TEXTURE_2D, imageResource.texture!);
      glContext.drawArrays(glContext.TRIANGLES, 0, QUAD_VERTEX_COUNT);
    };

    // Render sprite images. The renderTargetEntries list is already filtered to visible items.
    // Cache of sprite-specific reference origins (center pixel coordinates).
    const originCenterCache: ImageCenterCache = new Map();

    const sortedSubLayerBuckets =
      buildSortedSubLayerBuckets(renderTargetEntries);

    /**
     * Renders every image within the provided sub-layer bucket after calculating depth.
     * @param {RenderTargetEntry[]} bucket - Sprite/image pairs belonging to a single sub-layer.
     */
    const renderSortedBucket = (bucket: RenderTargetEntry[]): void => {
      const itemsWithDepth: Array<{
        sprite: InternalSpriteCurrentState<T>;
        image: InternalSpriteImageState;
        resource: RegisteredImage;
        depthKey: number;
      }> = [];

      const projectToClipSpace: ProjectToClipSpaceFn = (lng, lat, elevation) =>
        projectLngLatToClipSpace(lng, lat, elevation, clipContext);

      const unprojectPoint: UnprojectPointFn = ({ x, y }) => {
        const result = mapInstance.unproject([x, y] as any);
        if (!result) {
          return null;
        }
        // Convert the MapLibre LngLat object into the simplified structure expected downstream.
        return { lng: result.lng, lat: result.lat };
      };

      for (const [spriteEntry, imageEntry] of bucket) {
        const imageResource = images.get(imageEntry.imageId);
        if (!imageResource || !imageResource.texture) {
          // Skip images whose textures have not yet been uploaded to the GPU.
          continue;
        }

        const projected = mapInstance.project(spriteEntry.currentLocation);
        if (!projected) {
          // Sprite center could not be projected (off-screen); depth cannot be evaluated.
          continue;
        }

        const metersPerPixelAtLat = calculateMetersPerPixelAtLatitude(
          zoom,
          spriteEntry.currentLocation.lat
        );
        if (!Number.isFinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0) {
          // Invalid scale would blow up downstream computations.
          continue;
        }

        const perspectiveRatio = calculatePerspectiveRatio(
          mapInstance,
          spriteEntry.currentLocation
        );
        const effectivePixelsPerMeter = calculateEffectivePixelsPerMeter(
          metersPerPixelAtLat,
          perspectiveRatio
        );
        if (effectivePixelsPerMeter <= 0) {
          // Perspective ratio produced an unusable scale for this sprite.
          continue;
        }

        const centerParams: ComputeImageCenterParams = {
          mapInstance,
          images,
          originCenterCache,
          projected,
          zoomScaleFactor,
          baseMetersPerPixel,
          spriteMinPixel,
          spriteMaxPixel,
          effectivePixelsPerMeter,
          drawingBufferWidth,
          drawingBufferHeight,
          pixelRatio,
          clipContext,
          altitudeMeters: spriteEntry.currentLocation.z ?? 0,
        };

        // Resolve anchor/offset defaults for depth computations to stay consistent with draw path.
        const anchorResolved = imageEntry.anchor ?? DEFAULT_ANCHOR;
        const offsetResolved = imageEntry.offset ?? DEFAULT_IMAGE_OFFSET;

        const depthCenter = computeImageCenterXY(
          spriteEntry,
          imageEntry,
          centerParams,
          { useResolvedAnchor: true }
        );

        let depthKey: number;

        // Surface-mode sprites require world-space geometry computation.
        if (imageEntry.mode === 'surface') {
          const imageScale = imageEntry.scale ?? 1;
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
          const totalRotateDeg = Number.isFinite(imageEntry.displayedRotateDeg)
            ? imageEntry.displayedRotateDeg
            : normaliseAngleDeg(
                (imageEntry.resolvedBaseRotateDeg ?? 0) +
                  (imageEntry.rotateDeg ?? 0)
              );
          const offsetMeters = calculateSurfaceOffsetMeters(
            offsetResolved,
            imageScale,
            zoomScaleFactor,
            worldDims.scaleAdjustment
          );
          const cornerDisplacements = calculateSurfaceCornerDisplacements({
            worldWidthMeters: worldDims.width,
            worldHeightMeters: worldDims.height,
            anchor: anchorResolved,
            totalRotateDeg,
            offsetMeters,
          });

          const baseLngLat = (() => {
            if (imageEntry.originLocation !== undefined) {
              const refImg = spriteEntry.images
                .get(imageEntry.originLocation.subLayer)
                ?.get(imageEntry.originLocation.order);
              if (refImg) {
                const baseCenter = computeImageCenterXY(
                  spriteEntry,
                  refImg,
                  centerParams,
                  {
                    // Default to the raw (anchorless) position unless explicit opt-in.
                    useResolvedAnchor:
                      imageEntry.originLocation.useResolvedAnchor ?? false,
                  }
                );
                const baseLngLatLike = mapInstance.unproject([
                  baseCenter.x,
                  baseCenter.y,
                ] as any);
                if (baseLngLatLike) {
                  // Use the referenced image's anchor position when available.
                  return baseLngLatLike;
                }
              }
            }
            return spriteEntry.currentLocation;
          })();

          const surfaceDepth = calculateSurfaceDepthKey(
            baseLngLat,
            cornerDisplacements,
            spriteEntry.currentLocation,
            projectToClipSpace,
            {
              // Enable per-vertex depth biasing to combat z-fighting when requested.
              biasFn: ENABLE_NDC_BIAS_SURFACE
                ? ({ clipZ, clipW }) => {
                    const orderIndex = Math.min(
                      imageEntry.order,
                      ORDER_MAX - 1
                    );
                    const biasIndex =
                      imageEntry.subLayer * ORDER_BUCKET + orderIndex;
                    const biasNdc = -(biasIndex * EPS_NDC);
                    const biasedClipZ = clipZ + biasNdc * clipW;
                    const minClipZ = -clipW + MIN_CLIP_Z_EPSILON;
                    return {
                      // Clamp the biased depth so we never cross the near plane.
                      clipZ: biasedClipZ < minClipZ ? minClipZ : biasedClipZ,
                      clipW,
                    };
                  }
                : undefined,
            }
          );

          if (surfaceDepth === null) {
            // Any missing corner depth indicates the surface fell outside the clip volume.
            continue;
          }
          depthKey = surfaceDepth;
        } else {
          // Billboard mode evaluates depth by sampling the screen-space center only.
          const billboardDepth = calculateBillboardDepthKey(
            depthCenter,
            spriteEntry.currentLocation,
            unprojectPoint,
            projectToClipSpace
          );
          if (billboardDepth === null) {
            // Depth key calculation failed; omit this image to keep ordering stable.
            continue;
          }
          depthKey = billboardDepth;
        }

        itemsWithDepth.push({
          sprite: spriteEntry,
          image: imageEntry,
          resource: imageResource,
          depthKey,
        });
      }

      itemsWithDepth.sort((a, b) => {
        if (a.depthKey !== b.depthKey) {
          return a.depthKey - b.depthKey;
        }
        if (a.image.order !== b.image.order) {
          return a.image.order - b.image.order;
        }
        const spriteCompare = a.sprite.spriteId.localeCompare(
          b.sprite.spriteId
        );
        if (spriteCompare !== 0) {
          return spriteCompare;
        }
        return a.image.imageId.localeCompare(b.image.imageId);
      });

      for (const item of itemsWithDepth) {
        // Draw in sorted order so nearer primitives overwrite farther ones.
        drawSpriteImage(
          item.sprite,
          item.image,
          item.resource,
          originCenterCache
        );
      }
    };

    for (const [, bucket] of sortedSubLayerBuckets) {
      // Process buckets in ascending sub-layer order so draw order respects configuration.
      renderSortedBucket(bucket);
    }

    glContext.depthMask(true);
    glContext.enable(glContext.DEPTH_TEST);
    glContext.disable(glContext.BLEND);

    // Queue another render pass.
    scheduleRender();
  };

  //////////////////////////////////////////////////////////////////////////

  /**
   * Registers an image URL or existing ImageBitmap with the image registry.
   * @param {string} imageId - Image identifier used by sprites.
   * @param {string | ImageBitmap} imageSource - Image URL or existing ImageBitmap to load.
   * @returns {Promise<boolean>} Resolves to `true` when registered; `false` if the ID already exists.
   * @remarks Sprites must register images before referencing them.
   */
  const registerImage = async (
    imageId: string,
    imageSource: string | ImageBitmap
  ): Promise<boolean> => {
    // Load from URL when given a string; otherwise reuse the provided bitmap directly.
    const bitmap =
      typeof imageSource === 'string'
        ? await loadImageBitmap(imageSource)
        : imageSource;
    // Reject duplicate registrations to keep texture management consistent.
    if (images.has(imageId)) {
      // Avoid overwriting an existing texture registration using the same identifier.
      return false;
    }

    // Store the image metadata.
    const image: RegisteredImage = {
      id: imageId,
      width: bitmap.width,
      height: bitmap.height,
      bitmap,
      texture: undefined,
    };
    images.set(imageId, image);

    // Queue the upload so the next draw refreshes the texture.
    queueTextureUpload(image);
    ensureTextures();
    // Request a redraw so sprites using the new image update immediately.
    scheduleRender();

    return true;
  };

  /**
   * Generates a text glyph image and registers it as a sprite resource.
   * @param {string} textGlyphId - Identifier assigned to the generated glyph.
   * @param {string} text - Text content to render.
   * @param {SpriteTextGlyphDimensions} dimensions - Dimension constraints (line height or max width).
   * @param {SpriteTextGlyphOptions} [options] - Additional styling options for the glyph.
   * @returns {Promise<boolean>} Resolves to `true` when registered; `false` if the ID already exists.
   */
  const registerTextGlyph = async (
    textGlyphId: string,
    text: string,
    dimensions: SpriteTextGlyphDimensions,
    options?: SpriteTextGlyphOptions
  ): Promise<boolean> => {
    // Prevent accidental overwrites by refusing duplicate glyph IDs.
    if (images.has(textGlyphId)) {
      return false;
    }

    let lineHeight: number | undefined;
    let maxWidth: number | undefined;
    const isLineHeightMode = 'lineHeightPixel' in dimensions;
    if (isLineHeightMode) {
      // When lineHeightPixel is provided, treat the glyph as a single-line label constrained vertically.
      const { lineHeightPixel } = dimensions as { lineHeightPixel: number };
      lineHeight = clampGlyphDimension(lineHeightPixel);
    } else {
      // Otherwise we clamp against a maximum width constraint when rendering paragraphs.
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
        // Ensure we have enough room to inject spacing between glyphs.
        contentWidthLimit = letterSpacingTotal;
      }

      // Reduce font size proportionally until the measured width fits inside the bounding box.
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
          // Break ties by decrementing one pixel to guarantee progress.
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
        // If we exit due to guard exhaustion, the current size is the best compromise.
      }
    }

    applyFontSize(measureCtx, fontSize);
    measuredWidth = measureTextWidthWithSpacing(
      measureCtx,
      text,
      letterSpacing
    );
    const measuredHeight = measureTextHeight(measureCtx, text, fontSize);

    const padding = resolved.paddingPixel;
    const borderWidth = resolved.borderWidthPixel;

    const contentHeight = isLineHeightMode
      ? // When the caller provided an explicit line height, honour it directly.
        lineHeight!
      : // Otherwise base the height on measured text metrics.
        clampGlyphDimension(Math.ceil(measuredHeight));

    const totalWidth = clampGlyphDimension(
      Math.ceil(borderWidth + padding.left + padding.right + measuredWidth)
    );
    const totalHeight = clampGlyphDimension(
      Math.ceil(borderWidth + padding.top + padding.bottom + contentHeight)
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
      // Scale the canvas so drawing commands operate in CSS pixel space.
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

    if (resolved.borderColor && borderWidth > 0) {
      const inset = borderWidth / 2;
      const strokeWidth = Math.max(0, totalWidth - borderWidth);
      const strokeHeight = Math.max(0, totalHeight - borderWidth);
      const strokeRadius = Math.max(0, resolved.borderRadiusPixel - inset);
      ctx.save();
      ctx.translate(inset, inset);
      strokeRoundedRect(
        ctx,
        strokeWidth,
        strokeHeight,
        strokeRadius,
        resolved.borderColor,
        borderWidth,
        resolved.borderSides
      );
      ctx.restore();
    }

    const borderInset = borderWidth / 2;
    const contentWidth = Math.max(
      0,
      totalWidth - borderWidth - padding.left - padding.right
    );
    const contentHeightInner = Math.max(
      0,
      totalHeight - borderWidth - padding.top - padding.bottom
    );
    const contentLeft = borderInset + padding.left;
    const contentTop = borderInset + padding.top;
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

    const image: RegisteredImage = {
      id: textGlyphId,
      width: totalWidth,
      height: totalHeight,
      bitmap,
      texture: undefined,
    };
    images.set(textGlyphId, image);

    queueTextureUpload(image);
    ensureTextures();
    scheduleRender();

    return true;
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
      return false;
    }

    // Delete the bound texture if present.
    const glContext = gl;
    if (glContext && image.texture) {
      glContext.deleteTexture(image.texture);
    }

    cancelQueuedTextureUpload(imageId);
    // Remove the image entry.
    images.delete(imageId);

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
    const glContext = gl;
    images.forEach((image) => {
      if (glContext && image.texture) {
        glContext.deleteTexture(image.texture);
      }
      if (image.bitmap) {
        image.bitmap.close?.();
      }
    });
    images.clear();
    clearTextureQueue();
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
   * @param {string} spriteId - Sprite identifier.
   * @param {SpriteInit<T>} init - Initial sprite parameters.
   * @returns {boolean} `true` when the sprite is stored; `false` when the ID already exists or is invalid.
   */
  const addSpriteInternal = (
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
        imageInit.order
      );
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
    const spriteState: InternalSpriteCurrentState<T> = {
      spriteId,
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
    };

    // Store the sprite state.
    sprites.set(spriteId, spriteState);

    return true;
  };

  /**
   * Expands a batch sprite payload into iterable entries.
   * @param {SpriteInitCollection<T>} collection - Batch payload.
   * @returns {Array<[string, SpriteInit<T>]>} Normalised entries.
   */
  const resolveSpriteInitCollection = (
    collection: SpriteInitCollection<T>
  ): Array<[string, SpriteInit<T>]> => {
    if (Array.isArray(collection)) {
      return collection.map((entry): [string, SpriteInit<T>] => [
        entry.spriteId,
        entry,
      ]);
    }
    return Object.entries(collection) as Array<[string, SpriteInit<T>]>;
  };

  /**
   * Creates a new sprite with the provided options and adds it to the layer.
   * @param {string} spriteId - Sprite identifier.
   * @param {SpriteInit<T>} init - Initial sprite parameters supplied by the caller.
   * @returns {boolean} `true` when the sprite is added; `false` when the ID already exists.
   */
  const addSprite = (spriteId: string, init: SpriteInit<T>): boolean => {
    const isAdded = addSpriteInternal(spriteId, init);
    if (isAdded) {
      // Rebuild render target entries.
      ensureRenderTargetEntries();
      // Request a redraw so the new sprite appears immediately.
      scheduleRender();
    }
    return isAdded;
  };

  /**
   * Adds multiple sprites in a single batch operation.
   * @param {SpriteInitCollection<T>} collection - Sprite payloads keyed by spriteId or as array entries.
   * @returns {number} Number of sprites that were newly added.
   */
  const addSprites = (collection: SpriteInitCollection<T>): number => {
    let addedCount = 0;
    for (const [spriteId, spriteInit] of resolveSpriteInitCollection(
      collection
    )) {
      if (addSpriteInternal(spriteId, spriteInit)) {
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
  };

  /**
   * Removes a sprite without requesting rendering.
   * @param {string} spriteId - Sprite identifier.
   * @returns {boolean} `true` when the sprite existed and was removed.
   */
  const removeSpriteInternal = (spriteId: string): boolean =>
    sprites.delete(spriteId);

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

    sprites.clear();

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
   * @param {InternalSpriteCurrentState<T>} sprite - Sprite receiving the image.
   * @param {number} subLayer - Sub-layer identifier.
   * @param {number} order - Order slot within the sub-layer.
   * @param {SpriteImageDefinitionInit} imageInit - Image definition to insert.
   * @param {SpriteImageOperationInternalResult} resultOut - Output flag indicating whether mutation occurred.
   * @returns {boolean} `true` when the image is added; `false` when the slot already exists.
   */
  const addSpriteImageInternal = (
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
    const state = createImageStateFromInit(imageInit, subLayer, order);

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

    updateImageDisplayedRotation(state);

    setImageState(sprite, state);
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

    // Insert the image definition.
    const result: SpriteImageOperationInternalResult = { isUpdated: false };
    addSpriteImageInternal(sprite, subLayer, order, imageInit, result);
    if (!result.isUpdated) {
      return false;
    }

    // Refresh render targets.
    ensureRenderTargetEntries();
    // Request a redraw so the new image appears immediately.
    scheduleRender();

    return true;
  };

  /**
   * Updates an existing image with partial changes, handling interpolation and auto-rotation adjustments.
   * @param {InternalSpriteCurrentState<T>} sprite - Sprite containing the image.
   * @param {number} subLayer - Sub-layer identifier.
   * @param {number} order - Order slot within the sub-layer.
   * @param {SpriteImageDefinitionUpdate} imageUpdate - Changes to apply.
   * @param {SpriteImageOperationInternalResult} resultOut - Output flag reporting whether anything changed.
   * @returns {boolean} `true` when the image exists and the update succeeded.
   */
  const updateSpriteImageInternal = (
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
    const rotationInterpolation = imageUpdate.rotationInterpolation;
    // Optional interpolation payloads allow independent control over offset and rotation animations.
    const offsetInterpolationOption = rotationInterpolation?.offsetDeg;
    // Pull out rotateDeg interpolation hints when the payload includes them.
    const rotateInterpolationOption = rotationInterpolation?.rotateDeg;
    let rotationOverride: SpriteNumericInterpolationOptions | null | undefined;
    let hasRotationOverride = false;
    if (imageUpdate.offset !== undefined) {
      const newOffset = cloneOffset(imageUpdate.offset);
      if (
        offsetInterpolationOption &&
        offsetInterpolationOption.durationMs > 0
      ) {
        const { state: interpolationState, requiresInterpolation } =
          createNumericInterpolationState({
            currentValue: state.offset.offsetDeg,
            targetValue: newOffset.offsetDeg,
            options: offsetInterpolationOption,
          });
        if (requiresInterpolation) {
          state.offset.offsetMeters = newOffset.offsetMeters;
          state.offsetInterpolationState = interpolationState;
        } else {
          state.offset = newOffset;
          state.offsetInterpolationState = null;
        }
      } else {
        // No animation requested: adopt the new offset immediately.
        state.offset = newOffset;
        state.offsetInterpolationState = null;
      }
    } else if (offsetInterpolationOption === null) {
      // Explicit null clears any running offset interpolation.
      state.offsetInterpolationState = null;
    }
    if (rotateInterpolationOption !== undefined) {
      // Caller supplied new rotation interpolation preferences.
      if (rotateInterpolationOption === null) {
        state.rotationInterpolationOptions = null;
        rotationOverride = null;
      } else {
        const cloned = cloneNumericInterpolationOptions(
          rotateInterpolationOption
        );
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
      updateImageDisplayedRotation(
        state,
        // When a rotation override has been computed, pass it along (null clears interpolation); otherwise leave undefined.
        hasRotationOverride ? (rotationOverride ?? null) : undefined
      );
    }

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
    // Fail if the sprite cannot be found.
    const sprite = sprites.get(spriteId);
    if (!sprite) {
      return false;
    }

    // Apply the image update.
    const result: SpriteImageOperationInternalResult = { isUpdated: false };
    updateSpriteImageInternal(sprite, subLayer, order, imageUpdate, result);
    if (!result.isUpdated) {
      return false;
    }

    // Refresh render targets.
    ensureRenderTargetEntries();
    // Request a redraw so the updated image is displayed immediately.
    scheduleRender();

    return true;
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

    if (update.isEnabled !== undefined) {
      // Only flip the enable flag when the requested value differs to avoid noisy redraws.
      if (sprite.isEnabled !== update.isEnabled) {
        sprite.isEnabled = update.isEnabled;
        updated = true;
        isRequiredRender = true;
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
    }

    if (update.tag !== undefined) {
      const nextTag = update.tag ?? null;
      // Only mutate the tag when the identity actually changes to minimise change detection churn.
      if (sprite.tag !== nextTag) {
        sprite.tag = nextTag;
        updated = true;
      }
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
    // Perform the update.
    const result = updateSpriteInternal(spriteId, update);

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
  };

  /**
   * Applies multiple sprite updates in bulk.
   * @param {SpriteUpdateBulkEntry<T>[]} updateBulkList - Array of updates to apply sequentially.
   * @returns {number} Number of sprites that changed.
   * @deprecated Use {@link SpriteLayerInterface.mutateSprites} for clearer mutation flows.
   */
  const updateBulk = (updateBulkList: SpriteUpdateBulkEntry<T>[]): number => {
    let updatedCount = 0;
    let isRequiredRender = false;

    // Apply updates in sequence.
    updateBulkList.forEach((update) => {
      const result = updateSpriteInternal(update.spriteId, update);

      switch (result) {
        case 'notfound':
        // Sprite missing; nothing to do for this entry.
        case 'ignored':
          break;
        case 'updated':
          // State changed without requiring an immediate redraw.
          updatedCount++;
          break;
        // When rendering must occur because of this update
        case 'isRequiredRender':
          // Refresh render targets.
          ensureRenderTargetEntries();
          // Request a redraw so changes appear immediately.
          scheduleRender();
          updatedCount++;
          isRequiredRender = true;
          break;
      }
    });

    // If any update required rendering,
    if (isRequiredRender) {
      // At least one update demanded a redraw; refresh buffers once more after the batch.
      ensureRenderTargetEntries();
      scheduleRender();
    }

    return updatedCount;
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

    let changedCount = 0;
    let isRequiredRender = false;

    // Reuse mutable helpers for efficiency.
    let currentSprite: InternalSpriteCurrentState<T> = undefined!;
    let didMutateImages = false;
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
      addImage: (subLayer, order, imageInit) => {
        const added = addSpriteImageInternal(
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
        if (addSpriteInternal(spriteId, init)) {
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
        const updateResult = updateSpriteInternal(spriteId, updateObject);
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
          currentSprite,
          subLayer,
          order,
          imageInit,
          operationResult
        ),
      updateImage: (subLayer, order, imageUpdate) =>
        updateSpriteImageInternal(
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
      const result = updateSpriteInternal(sprite.spriteId, updateObject);

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
    updateBulk,
    mutateSprites,
    updateForEach,
    on: addEventListener,
    off: removeEventListener,
  };

  return spriteLayout;
};
