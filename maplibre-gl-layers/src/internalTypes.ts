// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

/**
 * Internal-only type definitions shared across SpriteLayer implementation modules.
 */

import type {
  SpriteMode,
  SpriteAnchor,
  SpriteImageOffset,
  SpriteInterpolationOptions,
  SpriteImageOriginLocation,
  SpriteLocation,
  SpriteTextGlyphHorizontalAlign,
  SpriteTextureMagFilter,
  SpriteTextureMinFilter,
  SpriteInterpolationMode,
  EasingFunction,
  SpriteScreenPoint,
  SpritePoint,
} from './types';
import type { ResolvedSpriteScalingOptions, SurfaceCorner } from './math';

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Represents a projected three dimensional position.
 * `MercatorCoordinate` uses the web mercator projection ([EPSG:3857](https://epsg.io/3857)) with slightly different units:
 * - the size of 1 unit is the width of the projected world instead of the "mercator meter"
 * - the origin of the coordinate space is at the north-west corner instead of the middle
 */
export interface SpriteMercatorCoordinate {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Releaseable {
  readonly release: () => void;
}

/**
 * Abstraction that exposes projection-related helpers.
 */
export interface ProjectionHost extends Releaseable {
  /**
   * Get current zoom level.
   * @returns Zoom level.
   */
  readonly getZoom: () => number;
  /**
   * Extracts the current clip-space context if the mercator matrix is available.
   * @returns {ClipContext | null} Clip context or `null` when the transform is not ready.
   */
  readonly getClipContext: () => ClipContext | null;
  /**
   * Get mercator coordinate from the location
   * @param location Location.
   * @returns Mercator coordinate.
   */
  readonly fromLngLat: (
    location: Readonly<SpriteLocation>
  ) => SpriteMercatorCoordinate;
  /**
   * Project the location.
   * @param location Location.
   * @returns Projected point if valid location.
   */
  readonly project: (location: Readonly<SpriteLocation>) => SpritePoint | null;
  /**
   * Unproject the location.
   * @param point Projected point.
   * @returns Location if valid point.
   */
  readonly unproject: (point: Readonly<SpritePoint>) => SpriteLocation | null;
  /**
   * Calculate perspective ratio.
   * @param location Location.
   * @param cachedMercator Mercator coodinate when available earlier calculation.
   * @returns The ratio.
   */
  readonly calculatePerspectiveRatio: (
    location: Readonly<SpriteLocation>,
    cachedMercator?: SpriteMercatorCoordinate
  ) => number;
}

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Cache entry storing anchor-adjusted and raw centers for a sprite image.
 */
export interface ImageCenterCacheEntry {
  readonly anchorApplied?: SpritePoint;
  readonly anchorless?: SpritePoint;
}

/**
 * Nested cache keyed by sprite ID and image key to avoid recomputing centers each frame.
 */
export type ImageCenterCache = Map<string, Map<string, ImageCenterCacheEntry>>;

export type RenderTargetEntryLike<T> = readonly [
  InternalSpriteCurrentState<T>,
  InternalSpriteImageState,
];

export interface DepthSortedItem<T> {
  readonly sprite: InternalSpriteCurrentState<T>;
  readonly image: InternalSpriteImageState;
  readonly resource: Readonly<RegisteredImage>;
  readonly depthKey: number;
}

export interface CollectDepthSortedItemsInputs<T> {
  readonly bucket: readonly Readonly<RenderTargetEntryLike<T>>[];
  readonly images: ReadonlyMap<string, Readonly<RegisteredImage>>;
  readonly resolvedScaling: ResolvedSpriteScalingOptions;
  readonly zoomScaleFactor?: number;
  readonly clipContext: Readonly<ClipContext> | null;
  readonly baseMetersPerPixel: number;
  readonly spriteMinPixel: number;
  readonly spriteMaxPixel: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly pixelRatio: number;
  readonly originCenterCache: ImageCenterCache;
  readonly resolveSpriteMercator: (
    projectionHost: ProjectionHost,
    sprite: Readonly<InternalSpriteCurrentState<T>>
  ) => SpriteMercatorCoordinate;
}

/**
 * Prepares WebGL rendering inputs.
 */
export interface PrepareDrawSpriteImageInputs<T> {
  readonly originCenterCache: ImageCenterCache;
  readonly images: ReadonlyMap<string, Readonly<RegisteredImage>>;
  readonly resolvedScaling: ResolvedSpriteScalingOptions;
  readonly zoomScaleFactor?: number;
  readonly baseMetersPerPixel: number;
  readonly spriteMinPixel: number;
  readonly spriteMaxPixel: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly pixelRatio: number;
  readonly clipContext: Readonly<ClipContext> | null;
  readonly identityScaleX: number;
  readonly identityScaleY: number;
  readonly identityOffsetX: number;
  readonly identityOffsetY: number;
  readonly screenToClipScaleX: number;
  readonly screenToClipScaleY: number;
  readonly screenToClipOffsetX: number;
  readonly screenToClipOffsetY: number;
  readonly ensureHitTestCorners: (
    imageEntry: Readonly<InternalSpriteImageState>
  ) => [
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
  ];
  readonly resolveSpriteMercator: (
    projectionHost: ProjectionHost,
    sprite: Readonly<InternalSpriteCurrentState<T>>
  ) => SpriteMercatorCoordinate;
}

/**
 * Prepared parameters for WebGL rendering.
 */
export interface PreparedDrawSpriteImageParams<T> {
  readonly spriteEntry: InternalSpriteCurrentState<T>;
  readonly imageEntry: InternalSpriteImageState;
  readonly imageResource: RegisteredImage;
  readonly vertexData: Float32Array;
  readonly opacity: number;
  readonly hitTestCorners:
    | readonly [
        Readonly<SpriteScreenPoint>,
        Readonly<SpriteScreenPoint>,
        Readonly<SpriteScreenPoint>,
        Readonly<SpriteScreenPoint>,
      ]
    | null;
  readonly screenToClip: {
    readonly scaleX: number;
    readonly scaleY: number;
    readonly offsetX: number;
    readonly offsetY: number;
  };
  readonly useShaderSurface: boolean;
  readonly surfaceShaderInputs: SurfaceShaderInputs | undefined;
  readonly surfaceClipEnabled: boolean;
  readonly useShaderBillboard: boolean;
  readonly billboardUniforms: {
    readonly center: SpritePoint;
    readonly halfWidth: number;
    readonly halfHeight: number;
    readonly anchor: SpriteAnchor;
    readonly sin: number;
    readonly cos: number;
  } | null;
}

/**
 * The render calculation host.
 * Abstraction that render calculations.
 * @param TTag Tag type.
 */
export interface RenderCalculationHost<TTag> {
  readonly collectDepthSortedItems: (
    inputs: CollectDepthSortedItemsInputs<TTag>
  ) => DepthSortedItem<TTag>[];

  readonly prepareDrawSpriteImages: (
    items: readonly DepthSortedItem<TTag>[],
    inputs: PrepareDrawSpriteImageInputs<TTag>
  ) => PreparedDrawSpriteImageParams<TTag>[];
}

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Corner model describing world displacements and resulting geographic coordinates for shader validation.
 */
export interface SurfaceShaderCornerState
  extends SpriteLocation,
    SurfaceCorner {}

/**
 * Aggregated inputs required to reproduce surface geometry on the GPU.
 */
export interface SurfaceShaderInputs {
  readonly mercatorCenter: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly worldToMercatorScale: Readonly<SurfaceCorner>;
  readonly halfSizeMeters: Readonly<SurfaceCorner>;
  readonly anchor: Readonly<SpriteAnchor>;
  readonly offsetMeters: Readonly<SurfaceCorner>;
  readonly sinCos: { readonly sin: number; readonly cos: number };
  readonly totalRotateDeg: number;
  readonly depthBiasNdc: number;
  readonly centerDisplacement: Readonly<SurfaceCorner>;
  readonly baseLngLat: Readonly<SpriteLocation>;
  readonly displacedCenter: Readonly<SpriteLocation>;
  readonly scaleAdjustment: number;
  readonly corners: readonly Readonly<SurfaceShaderCornerState>[];
  clipCenter: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
  clipBasisEast: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
  clipBasisNorth: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
  clipCorners: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  }>;
}

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Runtime state describing the active interpolation between two sprite locations.
 * Consumers reuse the same state across ticks to avoid re-allocations while animation is running.
 *
 * @property mode - Strategy used to resolve the target location (feedback or feedforward).
 * @property durationMs - Total time allocated for the interpolation in milliseconds.
 * @property easing - Resolved easing function applied to raw progress values.
 * @property startTimestamp - Epoch millisecond when the interpolation started, or -1 when uninitialized.
 * @property from - Origin sprite location cloned from the current render state.
 * @property to - Destination sprite location being interpolated towards.
 */
export interface SpriteInterpolationState {
  readonly mode: SpriteInterpolationMode;
  readonly durationMs: number;
  readonly easing: EasingFunction;
  startTimestamp: number;
  readonly from: SpriteLocation;
  readonly to: SpriteLocation;
}

/**
 * Runtime state tracked for numeric interpolations.
 * @property {number} durationMs - Total duration of the interpolation in milliseconds.
 * @property {EasingFunction} easing - Easing function applied to progress samples.
 * @property {number} from - Start value used for interpolation.
 * @property {number} to - Adjusted target along the shortest rotation path.
 * @property {number} finalValue - Caller-requested final value (used once interpolation completes).
 * @property {number} startTimestamp - Timestamp when interpolation began, `-1` until evaluation starts.
 */
export interface DegreeInterpolationState {
  readonly durationMs: number;
  readonly easing: EasingFunction;
  readonly from: number;
  readonly to: number;
  readonly finalValue: number;
  startTimestamp: number;
}

export interface DistanceInterpolationState {
  readonly durationMs: number;
  readonly easing: EasingFunction;
  readonly from: number;
  readonly to: number;
  readonly finalValue: number;
  startTimestamp: number;
}

/**
 * Alias for the interpolation state used internally by sprites.
 */
export type InternalSpriteInterpolationState = SpriteInterpolationState;

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Texture filtering parameters resolved from the public options structure.
 */
export interface ResolvedTextureFilteringOptions {
  readonly minFilter: SpriteTextureMinFilter;
  readonly magFilter: SpriteTextureMagFilter;
  readonly generateMipmaps: boolean;
  readonly maxAnisotropy: number;
}

/**
 * Image metadata ready for use as a WebGL texture.
 */
export interface RegisteredImage {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly bitmap: ImageBitmap;
  texture: WebGLTexture | undefined;
}

/**
 * Padding resolved for glyph rendering with guaranteed non-negative values.
 */
export interface ResolvedTextGlyphPadding {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * Border sides resolved for glyph rendering.
 */
export interface ResolvedBorderSides {
  readonly top: boolean;
  readonly right: boolean;
  readonly bottom: boolean;
  readonly left: boolean;
}

/**
 * Fully resolved glyph rendering options with defaults applied.
 */
export interface ResolvedTextGlyphOptions {
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

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Mutable point reused when computing hit-test corners.
 */
export interface MutableSpriteScreenPoint extends SpriteScreenPoint {
  x: number;
  y: number;
}

/**
 * Compact representation of an Array-like 4x4 matrix.
 */
export type MatrixInput = ArrayLike<number>;

/**
 * Cached clip-space context containing the mercator matrix required to project coordinates.
 */
export interface ClipContext {
  readonly mercatorMatrix: MatrixInput;
}

/**
 * 2D canvas rendering context accepted by the glyph renderer.
 */
export type Canvas2DContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

/**
 * Canvas sources supported when rendering text glyphs.
 */
export type Canvas2DSource = HTMLCanvasElement | OffscreenCanvas;

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Base attributes for an image that composes a sprite.
 */
export interface InternalSpriteImageState {
  subLayer: number;
  order: number;
  imageId: string;
  mode: SpriteMode;
  opacity: number;
  scale: number;
  anchor: Readonly<SpriteAnchor>;
  offset: SpriteImageOffset;
  rotateDeg: number;
  displayedRotateDeg: number;
  autoRotation: boolean;
  autoRotationMinDistanceMeters: number;
  resolvedBaseRotateDeg: number;
  originLocation?: Readonly<SpriteImageOriginLocation>;
  rotationInterpolationState: Readonly<DegreeInterpolationState> | null;
  rotationInterpolationOptions: Readonly<SpriteInterpolationOptions> | null;
  offsetDegInterpolationState: Readonly<DegreeInterpolationState> | null;
  offsetMetersInterpolationState: Readonly<DistanceInterpolationState> | null;
  lastCommandRotateDeg: number;
  lastCommandOffsetDeg: number;
  lastCommandOffsetMeters: number;
  surfaceShaderInputs?: Readonly<SurfaceShaderInputs>;
  hitTestCorners?: [
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
  ];
}

/**
 * Current sprite state tracked internally by the layer.
 */
export interface InternalSpriteCurrentState<TTag> {
  spriteId: string;
  isEnabled: boolean;
  currentLocation: Readonly<SpriteLocation>;
  fromLocation?: Readonly<SpriteLocation>;
  toLocation?: Readonly<SpriteLocation>;
  images: Map<number, Map<number, InternalSpriteImageState>>;
  tag: TTag | null;
  interpolationState: InternalSpriteInterpolationState | null;
  pendingInterpolationOptions: SpriteInterpolationOptions | null;
  lastCommandLocation: Readonly<SpriteLocation>;
  lastAutoRotationLocation: Readonly<SpriteLocation>;
  lastAutoRotationAngleDeg: number;
  cachedMercator: Readonly<SpriteMercatorCoordinate>;
  cachedMercatorLng: number;
  cachedMercatorLat: number;
  cachedMercatorZ: number | undefined;
}
