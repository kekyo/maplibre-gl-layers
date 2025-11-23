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
  SpriteInterpolationOptions,
  SpriteImageOriginLocation,
  SpriteLocation,
  SpriteTextGlyphHorizontalAlign,
  SpriteTextureMagFilter,
  SpriteTextureMinFilter,
  SpriteInterpolationMode,
  SpriteScreenPoint,
  SpritePoint,
  SpriteEasingParam,
  SpriteImageLineAttributeState,
  SpriteImageState,
  SpriteInterpolatedValues,
  SpriteImageInterpolatedOffset,
  SpriteCurrentState,
} from './types';
import type { ResolvedSpriteScalingOptions, SurfaceCorner } from './utils/math';

//////////////////////////////////////////////////////////////////////////////////////////

export interface Releasable {
  readonly release: () => void;
}

export type RgbaColor = readonly [number, number, number, number];

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

/**
 * The handle value that using the instance.
 */
export type IdHandle = number;

/**
 * Id handler interface.
 * @param T Identified instance type
 * @remarks It is used for (wasm) interoperability for identity.
 */
export interface IdHandler<T> {
  /**
   * Allocates a numeric handle for the specified identifier.
   * @param {string} rawId - Raw identifier.
   * @returns {IdHandle} Allocated handle.
   */
  readonly allocate: (rawId: string) => IdHandle;
  /**
   * Stores an instance reference at the given handle index.
   * @param {IdHandle} handle - Numeric handle.
   * @param {T} instance - Registered instance.
   */
  readonly store: (handle: IdHandle, instance: T) => void;
  /**
   * Get instance by handle.
   * @param handle Numeric handle
   * @returns Instance.
   */
  readonly get: (handle: IdHandle) => T;
  /**
   * Releases the handle associated with the provided identifier.
   * @param {string} rawId - Raw identifier.
   */
  readonly release: (rawId: string) => void;
  /**
   * Clears all handle bookkeeping state.
   */
  readonly reset: () => void;
}

/**
 * Buffers exposing image metadata indexed by handle.
 * @remarks It is used for (wasm) interoperability for image identity.
 */
export interface ImageHandleBuffers {
  readonly widths: Float32Array;
  readonly heights: Float32Array;
  readonly textureReady: Uint8Array;
}

/**
 * Registered image references aligned by handle index.
 * @remarks It is used for (wasm) interoperability for image identity.
 */
export type ImageResourceTable = readonly (
  | Readonly<RegisteredImage>
  | undefined
)[];

/**
 * Image handle buffer controller interface.
 * @remarks It is used for (wasm) interoperability for image identity.
 */
export interface ImageHandleBufferController {
  /**
   * Flag metadata buffers for regeneration.
   * @param images Image map.
   */
  readonly markDirty: (images: ReadonlyMap<string, RegisteredImage>) => void;
  /**
   * Rebuilds the metadata buffers when flagged as dirty.
   * @returns {ImageHandleBuffers} Metadata buffers aligned by handle index.
   */
  readonly ensure: () => ImageHandleBuffers;
  /**
   * Returns registered images aligned by handle index. Ensures buffers are up to date.
   */
  readonly getResourcesByHandle: () => ImageResourceTable;
}

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Encoded pointer representing the target of an origin reference.
 * @remarks It is used for (wasm) interoperability for image identity.
 *          The high bits encode the sub-layer while the low bits encode the order slot.
 */
export type SpriteOriginReferenceKey = number;

/** Sentinel used when the image does not reference another sprite image. */
export const SPRITE_ORIGIN_REFERENCE_KEY_NONE = -1;

/**
 * Index into the render target bucket pointing at the resolved origin image.
 * @remarks It is used for (wasm) interoperability for image identity.
 *          When no origin is assigned or the reference could not be resolved,
 *          the value will be {@link SPRITE_ORIGIN_REFERENCE_INDEX_NONE}.
 */
export type SpriteOriginReferenceIndex = number;

/** Sentinel indicating that the origin pointer has not been resolved yet. */
export const SPRITE_ORIGIN_REFERENCE_INDEX_NONE = -1;

/**
 * Encode/Decode interface for a (subLayer, order) pair into a compact numeric key.
 * @remarks It is used for (wasm) interoperability for image identity.
 */
export interface SpriteOriginReference {
  /**
   * Encodes a (subLayer, order) pair into a compact numeric key.
   * @param subLayer Sub-layer identifier within the sprite.
   * @param order Order slot inside the sub-layer.
   * @returns Encoded origin reference key.
   */
  readonly encodeKey: (
    subLayer: number,
    order: number
  ) => SpriteOriginReferenceKey;
  /**
   * Decodes an origin reference key back into the sub-layer and order pair.
   * @param key Encoded origin reference key.
   * @returns `subLayer` and `order` components; when the key is invalid, both values are set to `-1`.
   */
  readonly decodeKey: (key: SpriteOriginReferenceKey) => {
    readonly subLayer: number;
    readonly order: number;
  };
}

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Tuple representing a single entry in a render target bucket.
 * @remarks It is used for (wasm) interoperability for sprite origin.
 *          The first item is the sprite's frame-level state and the second item is
 *          the specific image being rendered,
 *          mirroring how the renderer stores draw calls on the CPU side.
 *          Keeping the pair immutable prevents accidental divergence between cached data
 *          and the GPU buffers derived from it.
 */
export type RenderTargetEntryLike<TTag> = readonly [
  InternalSpriteCurrentState<TTag>, // Sprite-level state shared by all of its images.
  InternalSpriteImageState, // Concrete image variant queued for rendering.
];

/**
 * Parallel typed arrays that expose bucket metadata in a WASM-friendly layout.
 * @remarks It is used for (wasm) interoperability for sprite origin.
 *          Both arrays always share the same length as the bucket, allowing shader-side
 *          code (or WASM helpers) to traverse origin reference metadata without touching
 *          the heavyweight tuple objects.
 */
export interface RenderTargetBucketBuffers {
  /**
   * Encoded origin metadata (sub-layer/order pairs) for each queued image,
   * mirroring `image.originReferenceKey`. A value of
   * `SPRITE_ORIGIN_REFERENCE_KEY_NONE` denotes that the entry is self-originating.
   */
  readonly originReferenceKeys: Int32Array;
  /**
   * Bucket index pointing to the entry that should provide the origin image for
   * the current sprite. Values equal to
   * `SPRITE_ORIGIN_REFERENCE_INDEX_NONE` or outside the bucket range mark the
   * origin as unresolved.
   */
  readonly originTargetIndices: Int32Array;
}

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Mutable interpolation states.
 */
export interface MutableSpriteInterpolation<TValue> {
  state: SpriteInterpolationState<TValue> | null;
  options: Readonly<SpriteInterpolationOptions> | null;
  lastCommandValue: TValue;
  baseValue: TValue | undefined;
  targetValue: TValue | undefined;
}

/**
 * Mutable counterpart to {@link SpriteInterpolatedValues}, used internally so SpriteLayer
 * can reuse object references while still exposing readonly snapshots publicly.
 */
export interface MutableSpriteInterpolatedValues<TValue>
  extends SpriteInterpolatedValues<TValue> {
  current: TValue;
  from: TValue | undefined;
  to: TValue | undefined;
  invalidated: boolean | undefined;
  interpolation: MutableSpriteInterpolation<TValue>;
}

export interface MutableSpriteImageInterpolatedOffset
  extends SpriteImageInterpolatedOffset {
  offsetMeters: MutableSpriteInterpolatedValues<number>;
  offsetDeg: MutableSpriteInterpolatedValues<number>;
}

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Mimimum abstraction that exposes projection-related helpers.
 */
export interface ProjectionHost extends Releasable {
  /**
   * Get current zoom level.
   * @returns Zoom level.
   */
  readonly getZoom: () => number;
  /**
   * Get camera location.
   * @returns Camera location when viewport is available.
   */
  readonly getCameraLocation: () => SpriteLocation | undefined;
  /**
   * Extracts the current clip-space context if the mercator matrix is available.
   * @returns {ClipContext | undefined} Clip context or `undefined` when the transform is not ready.
   */
  readonly getClipContext: () => ClipContext | undefined;
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
  readonly project: (
    location: Readonly<SpriteLocation>
  ) => SpritePoint | undefined;
  /**
   * Unproject the location.
   * @param point Projected point.
   * @returns Location if valid point.
   */
  readonly unproject: (
    point: Readonly<SpritePoint>
  ) => SpriteLocation | undefined;
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

export interface PrepareDrawSpriteImageParamsBase {
  readonly imageResources: ImageResourceTable;
  readonly imageHandleBuffers: Readonly<ImageHandleBuffers>;
  readonly baseMetersPerPixel: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly pixelRatio: number;
  readonly clipContext: Readonly<ClipContext> | undefined;
}

export interface PrepareDrawSpriteImageParamsBefore<TTag>
  extends PrepareDrawSpriteImageParamsBase {
  readonly bucket: readonly Readonly<RenderTargetEntryLike<TTag>>[];
  readonly bucketBuffers: Readonly<RenderTargetBucketBuffers>;
  readonly resolvedScaling: ResolvedSpriteScalingOptions;
}

export interface PrepareDrawSpriteImageParamsAfter
  extends PrepareDrawSpriteImageParamsBase {
  readonly identityScaleX: number;
  readonly identityScaleY: number;
  readonly identityOffsetX: number;
  readonly identityOffsetY: number;
  readonly screenToClipScaleX: number;
  readonly screenToClipScaleY: number;
  readonly screenToClipOffsetX: number;
  readonly screenToClipOffsetY: number;
}

export interface PrepareDrawSpriteImageParams<TTag>
  extends PrepareDrawSpriteImageParamsBefore<TTag>,
    PrepareDrawSpriteImageParamsAfter {}

/**
 * Prepared parameters for WebGL rendering.
 */
export interface PreparedDrawSpriteImageParams<T> {
  readonly spriteEntry: InternalSpriteCurrentState<T>;
  readonly imageEntry: InternalSpriteImageState;
  readonly imageResource: RegisteredImage;
  readonly vertexData: Float32Array;
  opacity: number;
  readonly cameraDistanceMeters: number;
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
 * Common frame parameters shared with interpolation processing.
 */
export interface RenderInterpolationFrameContext {
  readonly baseMetersPerPixel: number;
}

/**
 * Parameters consumed when processing sprite interpolations.
 */
export interface RenderInterpolationParams<TTag> {
  readonly sprites: readonly InternalSpriteCurrentState<TTag>[];
  readonly timestamp: number;
  readonly frameContext?: RenderInterpolationFrameContext;
}

/**
 * Result produced by sprite interpolation processing.
 */
export interface RenderInterpolationResult {
  readonly handled: boolean;
  readonly hasActiveInterpolation: boolean;
}

/**
 * Parameters passed into RenderCalculationHost.processDrawSpriteImages.
 */
export interface ProcessDrawSpriteImagesParams<TTag> {
  readonly interpolationParams?: RenderInterpolationParams<TTag>;
  readonly prepareParams?: PrepareDrawSpriteImageParams<TTag>;
}

/**
 * Result returned from RenderCalculationHost.processDrawSpriteImages.
 */
export interface ProcessDrawSpriteImagesResult<TTag> {
  readonly preparedItems: PreparedDrawSpriteImageParams<TTag>[];
  readonly interpolationResult: RenderInterpolationResult;
}

/**
 * The render calculation host.
 * Abstraction that render calculations.
 * @param TTag Tag type.
 */
export interface RenderCalculationHost<TTag> extends Releasable {
  readonly processDrawSpriteImages: (
    params: ProcessDrawSpriteImagesParams<TTag>
  ) => ProcessDrawSpriteImagesResult<TTag>;
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
 * Easing function type.
 */
export type EasingFunction = (progress: number) => number;

/**
 * Runtime state describing the active interpolation between two sprite locations.
 * Consumers reuse the same state across ticks to avoid re-allocations while animation is running.
 */
export interface SpriteInterpolationState<TValue> {
  /** Strategy used to resolve the target location (feedback or feedforward). */
  readonly mode: SpriteInterpolationMode;
  /** Total time allocated for the interpolation in milliseconds. */
  readonly durationMs: number;
  /** Easing attributes */
  readonly easingParam: SpriteEasingParam;
  /** Resolved easing function applied to raw progress values. */
  readonly easingFunc: EasingFunction;
  /** Origin sprite location cloned from the current render state. */
  readonly from: TValue;
  /** Destination sprite location being interpolated towards.  */
  readonly to: TValue;
  /** */
  readonly pathTarget?: TValue;
  /** Epoch millisecond when the interpolation started, or -1 when uninitialized. */
  startTimestamp: number;
}

export interface SpriteInterpolationEvaluationResult<TValue> {
  readonly value: TValue;
  readonly completed: boolean;
  readonly effectiveStartTimestamp: number;
}

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
  /**
   * For use (wasm) interoperability id.
   */
  readonly handle: number;
  readonly width: number;
  readonly height: number;
  readonly bitmap: ImageBitmap;
  texture: WebGLTexture | undefined;
  atlasPageIndex: number;
  atlasU0: number;
  atlasV0: number;
  atlasU1: number;
  atlasV1: number;
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

/** Line definition resolved for rendering. */
export interface ResolvedSpriteImageLineAttribute
  extends SpriteImageLineAttributeState {
  readonly rgba: RgbaColor;
}

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Base mutable attribute view for an image that composes a sprite.
 */
export interface InternalSpriteImageState extends SpriteImageState {
  subLayer: number;
  order: number;
  imageId: string;
  imageHandle: number;
  mode: SpriteMode;
  scale: number;
  anchor: Readonly<SpriteAnchor>;
  border: ResolvedSpriteImageLineAttribute | undefined;
  borderPixelWidth: number;
  leaderLine: ResolvedSpriteImageLineAttribute | undefined;
  leaderLinePixelWidth: number;
  rotateDeg: number;
  opacity: number;
  lodOpacity: number; // For Pseudo LOD
  finalOpacity: MutableSpriteInterpolatedValues<number>;
  offset: MutableSpriteImageInterpolatedOffset;
  finalRotateDeg: MutableSpriteInterpolatedValues<number>;
  autoRotation: boolean;
  autoRotationMinDistanceMeters: number;
  originLocation: Readonly<SpriteImageOriginLocation> | undefined;
  originReferenceKey: SpriteOriginReferenceKey;
  originRenderTargetIndex: SpriteOriginReferenceIndex;
  interpolationDirty: boolean;
  surfaceShaderInputs: Readonly<SurfaceShaderInputs> | undefined;
  hitTestCorners:
    | [
        MutableSpriteScreenPoint,
        MutableSpriteScreenPoint,
        MutableSpriteScreenPoint,
        MutableSpriteScreenPoint,
      ]
    | undefined;
}

/**
 * Current sprite mutable state view tracked internally by the layer.
 */
export interface InternalSpriteCurrentState<TTag>
  extends SpriteCurrentState<TTag> {
  spriteId: string;
  handle: IdHandle;
  isEnabled: boolean;
  visibilityDistanceMeters: number | undefined; // For Pseudo LOD
  opacityMultiplier: number;
  location: MutableSpriteInterpolatedValues<SpriteLocation>;
  images: Map<number, Map<number, InternalSpriteImageState>>;
  tag: TTag | null;
  lastAutoRotationLocation: Readonly<SpriteLocation>;
  currentAutoRotateDeg: number;
  autoRotationInvalidated: boolean;
  interpolationDirty: boolean;
  cachedMercator: Readonly<SpriteMercatorCoordinate>;
  cachedMercatorLng: number;
  cachedMercatorLat: number;
  cachedMercatorZ: number | undefined;
}
