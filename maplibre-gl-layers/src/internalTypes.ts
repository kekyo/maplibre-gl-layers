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
} from './types';

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Runtime state describing the active interpolation between two sprite locations.
 * Consumers reuse the same state across ticks to avoid re-allocations while animation is running.
 *
 * @property mode - Strategy used to resolve the target location (feedback or feedforward).
 * @property durationMs - Total time allocated for the interpolation in milliseconds.
 * @property easing - Resolved easing function applied to raw progress values.
 * @property startTimestamp - Epoch millisecond when the interpolation started, or -1 when uninitialised.
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
export interface NumericInterpolationState {
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
  id: string;
  width: number;
  height: number;
  bitmap: ImageBitmap;
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
export interface MutableSpriteScreenPoint {
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
export type ClipContext = {
  readonly mercatorMatrix: MatrixInput;
};

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
  anchor: SpriteAnchor;
  offset: SpriteImageOffset;
  rotateDeg: number;
  displayedRotateDeg: number;
  autoRotation: boolean;
  autoRotationMinDistanceMeters: number;
  resolvedBaseRotateDeg: number;
  originLocation?: SpriteImageOriginLocation;
  rotationInterpolationState: NumericInterpolationState | null;
  rotationInterpolationOptions: SpriteInterpolationOptions | null;
  offsetDegInterpolationState: NumericInterpolationState | null;
  offsetMetersInterpolationState: NumericInterpolationState | null;
  lastCommandRotateDeg: number;
  lastCommandOffsetDeg: number;
  lastCommandOffsetMeters: number;
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
  currentLocation: SpriteLocation;
  fromLocation?: SpriteLocation;
  toLocation?: SpriteLocation;
  images: Map<number, Map<number, InternalSpriteImageState>>;
  tag: TTag | null;
  interpolationState: InternalSpriteInterpolationState | null;
  pendingInterpolationOptions: SpriteInterpolationOptions | null;
  lastCommandLocation: SpriteLocation;
  lastAutoRotationLocation: SpriteLocation;
  lastAutoRotationAngleDeg: number;
}
