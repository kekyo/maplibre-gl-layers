// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

/**
 * This file exposes public API definitions only.
 */

import type { CustomLayerInterface } from 'maplibre-gl';

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Base coordinate for the sprite. All images within the sprite are positioned relative to this location.
 */
export interface SpriteLocation {
  /** Longitude in degrees. */
  lng: number;
  /** Latitude in degrees. */
  lat: number;
  /** Elevation or virtual height. Defaults to 0 and is currently unused. */
  z?: number;
}

/**
 * Line attribute.
 */
export interface SpriteImageLineAttribute {
  /** CSS color string. Defaults to red. */
  color?: string;
  /** Line width in meters. Defaults to 1. */
  widthMeters?: number;
}

/**
 * Anchor within the image.
 * The sprite's base coordinate maps to this location; range is -1.0 to 1.0 relative to image size.
 * x: -1.0 at left, 0.0 center, 1.0 right. y: -1.0 bottom, 0.0 center, 1.0 top.
 * Values outside the range are accepted; clamp externally if needed.
 */
export interface SpriteAnchor {
  /** Horizontal offset; -1.0 left edge, 1.0 right edge. */
  x: number;
  /** Vertical offset; -1.0 bottom edge, 1.0 top edge. */
  y: number;
}

/**
 * Reference to another image's anchor for positioning.
 */
export interface SpriteImageOriginLocation {
  /**
   * Sub-layer identifier.
   */
  subLayer: number;
  /**
   * Order within the sub-layer; higher values render in front.
   */
  order: number;
  /**
   * Use the referenced image's anchor-adjusted position when true. Defaults to the pre-anchor base point.
   */
  useResolvedAnchor?: boolean;
}

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Linear easing definition.
 */
export interface SpriteEasingLinear {
  readonly type: 'linear';
}

/**
 * Ease easing definition.
 */
export interface SpriteEasingEase {
  readonly type: 'ease';
  /** Power applied to the easing curve. Defaults to 3. */
  power?: number;
  /** Direction of the easing curve. Defaults to in-out. */
  mode?: 'in' | 'out' | 'in-out';
}

/**
 * Exponential easing definition.
 */
export interface SpriteEasingExponential {
  readonly type: 'exponential';
  /** Growth rate used by the exponential curve. Defaults to 5. */
  exponent?: number;
  /** Direction of the exponential curve. Defaults to in-out. */
  mode?: 'in' | 'out' | 'in-out';
}

/**
 * Quadratic easing definition.
 */
export interface SpriteEasingQuadratic {
  readonly type: 'quadratic';
  /** Direction of the quadratic curve. Defaults to in-out. */
  mode?: 'in' | 'out' | 'in-out';
}

/**
 * Cubic easing definition.
 */
export interface SpriteEasingCubic {
  readonly type: 'cubic';
  /** Direction of the cubic curve. Defaults to in-out. */
  mode?: 'in' | 'out' | 'in-out';
}

/**
 * Sine easing definition.
 */
export interface SpriteEasingSine {
  readonly type: 'sine';
  /** Direction of the sine ease. Defaults to in-out. */
  mode?: 'in' | 'out' | 'in-out';
  /** Multiplier applied to the sine amplitude. Defaults to 1. */
  amplitude?: number;
}

/**
 * Bounce easing definition.
 */
export interface SpriteEasingBounce {
  readonly type: 'bounce';
  /** Number of visible bounces before settling. Defaults to 3. */
  bounces?: number;
  /** Decay factor applied per bounce; range (0, 1]. Defaults to 0.5. */
  decay?: number;
}

/**
 * Back easing definition.
 */
export interface SpriteEasingBack {
  readonly type: 'back';
  /** Overshoot factor controlling how far past the target the curve goes. Defaults to 1.70158. */
  overshoot?: number;
}

/**
 * Union of supported easing parameters.
 */
export type SpriteEasingParam =
  | SpriteEasingLinear
  | SpriteEasingEase
  | SpriteEasingExponential
  | SpriteEasingQuadratic
  | SpriteEasingCubic
  | SpriteEasingSine
  | SpriteEasingBounce
  | SpriteEasingBack;

/**
 * Easing types.
 */
export type SpriteEasingType = SpriteEasingParam['type'];

/**
 * Defines interpolation modes.
 */
export type SpriteInterpolationMode = 'feedback' | 'feedforward';

/**
 * Options for interpolating values.
 */
export interface SpriteInterpolationOptions {
  /** Interpolation mode; defaults to `feedback`. */
  mode?: SpriteInterpolationMode;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Easing definition. Defaults to `linear`. */
  easing?: SpriteEasingParam;
}

/**
 * Interpolation configuration.
 */
export interface SpriteImageInterpolationOptions {
  /** Interpolation settings for finalRotateDeg; `null` will disable interpolation. */
  finalRotateDeg?: SpriteInterpolationOptions | null;
  /** Interpolation settings for offset.offsetDeg; `null` will disable interpolation. */
  offsetDeg?: SpriteInterpolationOptions | null;
  /** Interpolation settings for offset.offsetMeters; `null` will disable interpolation. */
  offsetMeters?: SpriteInterpolationOptions | null;
  /** Interpolation settings for finalOpacity; `null` will disable interpolation. */
  finalOpacity?: SpriteInterpolationOptions | null;
}

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Sprite rendering modes.
 * Billboard: Image always faces the viewport, suited for HUD-style elements.
 * Surface: Image lies parallel to the map surface, suited for dynamic markers on the map.
 */
export type SpriteMode = 'billboard' | 'surface';

/**
 * Initial attributes that define a sprite image.
 */
export interface SpriteImageDefinitionInit {
  /** Image ID to render. */
  imageId: string;
  /** Rendering mode. Defaults to surface. */
  mode?: SpriteMode;
  /** Opacity multiplier. Defaults to 1.0. */
  opacity?: number;
  /** Real-world meters represented by one pixel. Defaults to 1.0. */
  scale?: number;
  /** Anchor within the image. Defaults to [0.0, 0.0]. */
  anchor?: SpriteAnchor;
  /** Offset distance in meters from the sprite coordinate. Defaults to 0. */
  offsetMeters?: number;
  /** Offset angle in degrees. Defaults to 0. */
  offsetDeg?: number;
  /** Optional border rendered around the image. */
  border?: SpriteImageLineAttribute;
  /** Optional leader line rendered toward the origin image. */
  leaderLine?: SpriteImageLineAttribute;
  /**
   * Determines which coordinate to anchor against.
   * - Omitted: use "the sprite" base coordinate.
   * - Provided: use the referenced image's anchor and offset (resolving references recursively).
   */
  originLocation?: SpriteImageOriginLocation;
  /**
   * Additional rotation in degrees. Defaults to 0.
   * Billboard: clockwise degrees relative to the screen with 0 deg up.
   * Surface: clockwise degrees from geographic north.
   */
  rotateDeg?: number;
  /**
   * Enables auto-rotation based on movement. Defaults to true in surface mode and false in billboard mode.
   */
  autoRotation?: boolean;
  /**
   * Minimum distance in meters before auto-rotation updates. Defaults to 20; <= 0 updates immediately.
   */
  autoRotationMinDistanceMeters?: number;
  /**
   * Optional interpolation settings.
   */
  interpolation?: SpriteImageInterpolationOptions;
}

/**
 * Update payload for a sprite image. Properties left undefined are ignored.
 */
export interface SpriteImageDefinitionUpdate {
  /** Image ID to render. */
  imageId?: string;
  /** Rendering mode. */
  mode?: SpriteMode;
  /** Opacity multiplier. */
  opacity?: number;
  /** Real-world meters represented by one pixel. */
  scale?: number;
  /** Anchor within the image. */
  anchor?: SpriteAnchor;
  /** Offset distance in meters from the sprite coordinate. */
  offsetMeters?: number;
  /** Offset angle in degrees. */
  offsetDeg?: number;
  /** Border rendered around the image. Specify null to remove. */
  border?: SpriteImageLineAttribute | null;
  /** Leader line rendered toward the origin image. Specify null to remove. */
  leaderLine?: SpriteImageLineAttribute | null;
  /** Additional rotation in degrees. */
  rotateDeg?: number;
  /** Enables auto-rotation toward the travel direction. */
  autoRotation?: boolean;
  /** Minimum distance in meters before auto-rotation updates. */
  autoRotationMinDistanceMeters?: number;
  /** Optional interpolation settings. */
  interpolation?: SpriteImageInterpolationOptions;
}

/**
 * Helper for bulk initializing sprite images.
 */
export interface SpriteImageDefinitionInitEntry
  extends SpriteImageDefinitionInit {
  /** Sub-layer identifier. */
  subLayer: number;
  /**
   * Order within the sub-layer; higher values render in front.
   */
  order: number;
}

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Parameters required to construct a new sprite.
 *
 * @template TTag Tag type.
 */
export interface SpriteInit<TTag> {
  /** Whether the sprite starts enabled. Defaults to true. */
  isEnabled?: boolean;
  /** Initial location. */
  location: SpriteLocation;
  /**
   * Marks the sprite as invalidated initially, causing interpolation parameters to be
   * ignored until the first update drives the value again.
   */
  invalidate?: boolean;
  /**
   * Pseudo LOD threshold for the sprite. When the camera distance exceeds this value,
   * all images attached to the sprite become invisible.
   */
  visibilityDistanceMeters?: number;
  /**
   * Default interpolation settings applied to initial location updates until overridden.
   */
  interpolation?: SpriteInterpolationOptions;
  /**
   * Multiplier applied to every image opacity belonging to the sprite. Defaults to 1.0.
   */
  opacityMultiplier?: number;
  /** Array of zero or more images. */
  images: SpriteImageDefinitionInitEntry[];
  /** Optional tag value; null or omission means no tag. */
  tag?: TTag | null;
}

/**
 * Entry for batch sprite creation, pairing a sprite identifier with its initial settings.
 *
 * @template TTag Tag type.
 */
export interface SpriteInitEntry<TTag> extends SpriteInit<TTag> {
  /** Sprite identifier. */
  spriteId: string;
}

/**
 * Batch payload accepted by addSprites. Supports both record and array inputs.
 *
 * @template TTag Tag type.
 */
export type SpriteInitCollection<TTag> =
  | Record<string, SpriteInit<TTag>>
  | readonly SpriteInitEntry<TTag>[];

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Interpolated values.
 * @param TValue - Value type.
 */
export interface SpriteInterpolatedValues<TValue> {
  /** Current time value. */
  readonly current: TValue;
  /** Requested value. */
  readonly from: TValue | undefined;
  /** Will be reached value. */
  readonly to: TValue | undefined;
  /** Marks whether the value was invalidated due to visibility changes. */
  readonly invalidated: boolean | undefined;
}

/**
 * Offset with interpolation metadata for both distance and heading.
 */
export interface SpriteImageInterpolatedOffset {
  /** Distance from the anchor in meters. */
  readonly offsetMeters: SpriteInterpolatedValues<number>;
  /** Heading describing the offset direction in degrees. */
  readonly offsetDeg: SpriteInterpolatedValues<number>;
}

/**
 * Resolved line attribute state.
 */
export interface SpriteImageLineAttributeState {
  /** CSS color string applied to the line. */
  readonly color: string;
  /** Line width in meters. */
  readonly widthMeters: number;
}

/**
 * Sprite image state evaluated at runtime.
 */
export interface SpriteImageState {
  /** Sub-layer index the image belongs to. */
  readonly subLayer: number;
  /** Ordering slot within the sub-layer. */
  readonly order: number;
  /** Identifier of the registered image or glyph. */
  readonly imageId: string;
  /** Rendering mode applied to the image. */
  readonly mode: SpriteMode;
  /** Scale factor converting pixels to meters. */
  readonly scale: number;
  /** Anchor coordinates resolved for the image. */
  readonly anchor: Readonly<SpriteAnchor>;
  /** User-specified rotation angle. */
  readonly rotateDeg: number;
  /** User-specified opacity. */
  readonly opacity: number;
  /** Offset applied relative to the anchor point. */
  readonly offset: SpriteImageInterpolatedOffset;
  /** Optional border rendered around the image. */
  readonly border: SpriteImageLineAttributeState | undefined;
  /** Optional leader line rendered toward the origin image. */
  readonly leaderLine: SpriteImageLineAttributeState | undefined;
  /** Indicates whether auto-rotation is active. */
  readonly autoRotation: boolean;
  /** Minimum travel distance before auto-rotation updates. */
  readonly autoRotationMinDistanceMeters: number;
  /** Rotation angle applied when rendering (includes auto-rotation). */
  readonly finalRotateDeg: SpriteInterpolatedValues<number>;
  /** Opacity applied when rendering (includes multipliers). */
  readonly finalOpacity: SpriteInterpolatedValues<number>;
  /** Optional reference to another image used for anchoring. */
  readonly originLocation: Readonly<SpriteImageOriginLocation> | undefined;
}

/**
 * Current runtime state of a sprite.
 *
 * @template TTag Tag type.
 */
export interface SpriteCurrentState<TTag> {
  /** Sprite identifier. */
  readonly spriteId: string;
  /** Indicates whether the sprite is enabled. */
  readonly isEnabled: boolean;
  /** Multiplier applied to every image opacity. */
  readonly opacityMultiplier: number;
  /**
   * Pseudo LOD threshold for the sprite. When the camera distance exceeds this value,
   * the sprite's images become invisible.
   */
  readonly visibilityDistanceMeters: number | undefined;
  /**
   * Location information including current, source, and destination coordinates.
   * `from`/`to` are `undefined` when interpolation is inactive.
   */
  readonly location: SpriteInterpolatedValues<Readonly<SpriteLocation>>;
  /** Current image states, grouped by sub-layer and order. */
  readonly images: ReadonlyMap<number, ReadonlyMap<number, SpriteImageState>>;
  /** Optional tag value; null indicates no tag. */
  readonly tag: TTag | null;
}

/**
 * Base structure for sprite updates.
 *
 * @template TTag Tag type stored on the sprite.
 */
export interface SpriteUpdateEntryBase<TTag> {
  /** Optional toggle to enable or disable the sprite. */
  isEnabled?: boolean;
  /** Optional target location for the sprite. */
  location?: SpriteLocation;
  /** Optional interpolation settings; `null` disables interpolation. */
  interpolation?: SpriteInterpolationOptions | null;
  /** Optional tag value to replace the current one; `null` clears the tag. */
  tag?: TTag | null;
  /**
   * Pseudo LOD threshold for the sprite. Specify a positive finite value to enable the check,
   * `null` to clear the current threshold, or leave `undefined` to keep the existing value.
   */
  visibilityDistanceMeters?: number | null;
  /**
   * Optional multiplier applied to every image opacity. When omitted the previous multiplier is preserved.
   */
  opacityMultiplier?: number;
}

/**
 * Update entry describing a sprite image modification.
 */
export interface SpriteImageDefinitionUpdateEntry {
  /** Target sub-layer that contains the image. */
  subLayer: number;
  /** Order slot within the sub-layer. */
  order: number;
  /** Update payload, or `null` to remove the image. */
  image: SpriteImageDefinitionUpdate | null;
}

/**
 * Sprite update entry with optional image list.
 *
 * @template TTag Tag type stored on the sprite.
 */
export interface SpriteUpdateEntry<TTag> extends SpriteUpdateEntryBase<TTag> {
  /** Optional set of image updates. */
  images?: SpriteImageDefinitionUpdateEntry[];
}

/**
 * Callback-based helper for mutating sprite state.
 *
 * @template TTag Tag type stored on the sprite.
 */
export interface SpriteUpdaterEntry<TTag> extends SpriteUpdateEntryBase<TTag> {
  /**
   * Retrieves the current image layout.
   * @returns Structured image index (order sets each sub layers).
   */
  readonly getImageIndexMap: () => ReadonlyMap<number, ReadonlySet<number>>;
  /**
   * Adds an image definition.
   * @param subLayer - Sub layer index.
   * @param order - Order index.
   * @param imageInit - Image initializer.
   * @returns True if added.
   */
  readonly addImage: (
    subLayer: number,
    order: number,
    imageInit: SpriteImageDefinitionInit
  ) => boolean;
  /**
   * Applies image updates.
   * @param subLayer - Sub layer index.
   * @param order - Order index.
   * @param imageUpdate - Image updater.
   * @returns True if updated.
   */
  readonly updateImage: (
    subLayer: number,
    order: number,
    imageUpdate: SpriteImageDefinitionUpdate
  ) => boolean;
  /**
   * Removes an image slot.
   * @param subLayer - Sub layer index.
   * @param order - Order index.
   * @returns True if removed.
   */
  readonly removeImage: (subLayer: number, order: number) => boolean;
}

/**
 * Result flags returned by `mutateSprites` callbacks.
 * - `'notremove'`: Keep the sprite after applying any modifications.
 * - `'remove'`: Remove the sprite from the layer.
 */
export type SpriteModifierResult = 'notremove' | 'remove';

/** Source items supplied to `mutateSprites` must expose the target sprite ID. */
export interface SpriteMutateSourceItem {
  /** Identifier of the sprite targeted by the source item. */
  readonly spriteId: string;
}

/**
 * Callbacks invoked by `mutateSprites` for each source item.
 *
 * @template TTag Sprite tag type stored by the layer.
 * @template TSourceItem Source item type that satisfies {@link SpriteMutateSourceItem}.
 */
export interface SpriteMutateCallbacks<
  TTag,
  TSourceItem extends SpriteMutateSourceItem,
> {
  /**
   * Invoked when the sprite ID from the source item does not yet exist.
   * Return a populated {@link SpriteInit} when the sprite should be added; return `undefined`
   * (or `null`) to skip creation.
   *
   * @param sourceItem Source item that produced the sprite ID.
   * @returns Sprite initializer to insert, or `undefined`/`null` to skip.
   */
  add: (sourceItem: TSourceItem) => SpriteInit<TTag> | null | undefined;
  /**
   * Invoked when the sprite ID already exists on the layer.
   * Use `update` to mutate sprite properties or images; return `'remove'` to delete the sprite instead.
   *
   * @param sourceItem Source item that produced the sprite ID.
   * @param sprite Current sprite state snapshot.
   * @param update Helper exposing the same operations as {@link SpriteUpdaterEntry}.
   * @returns `'remove'` to delete the sprite; otherwise `'notremove'`.
   */
  modify: (
    sourceItem: TSourceItem,
    sprite: SpriteCurrentState<TTag>,
    update: SpriteUpdaterEntry<TTag>
  ) => SpriteModifierResult;
}

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Represents a point on anonymous-unit space.
 */
export interface SpritePoint {
  /** Horizontal (X axis) coordinate. */
  readonly x: number;
  /** Vertical (Y axis) coordinate. */
  readonly y: number;
}

/**
 * Represents a point in screen space.
 */
export type SpriteScreenPoint = SpritePoint;

/**
 * Event dispatched when a sprite is clicked or tapped.
 *
 * @template TTag Tag type stored on sprites.
 */
export interface SpriteLayerClickEvent<TTag> {
  /** Discriminated event type. */
  readonly type: 'spriteclick';
  /** Snapshot of the sprite that was hit, or `undefined` when it no longer exists. */
  readonly sprite: SpriteCurrentState<TTag> | undefined;
  /** Sprite image that received the interaction, or `undefined` when missing. */
  readonly image: SpriteImageState | undefined;
  /** Screen position of the interaction. */
  readonly screenPoint: SpriteScreenPoint;
  /** Original DOM event. */
  readonly originalEvent: MouseEvent | PointerEvent | TouchEvent;
}

/**
 * Event dispatched when a sprite is hovered by a pointing device.
 *
 * @template TTag Tag type stored on sprites.
 */
export interface SpriteLayerHoverEvent<TTag> {
  /** Discriminated event type. */
  readonly type: 'spritehover';
  /** Snapshot of the sprite that was hit, or `undefined` when it no longer exists. */
  readonly sprite: SpriteCurrentState<TTag> | undefined;
  /** Sprite image that received the interaction, or `undefined` when missing. */
  readonly image: SpriteImageState | undefined;
  /** Screen position of the interaction. */
  readonly screenPoint: SpriteScreenPoint;
  /** Original hover-capable DOM event. */
  readonly originalEvent: MouseEvent | PointerEvent;
}

/**
 * Map of events emitted by SpriteLayer.
 *
 * @template TTag Tag type stored on sprites.
 */
export interface SpriteLayerEventMap<TTag> {
  /** Event fired when a sprite image is clicked. */
  readonly spriteclick: SpriteLayerClickEvent<TTag>;
  /** Event fired when a sprite image is hovered. */
  readonly spritehover: SpriteLayerHoverEvent<TTag>;
}

/**
 * Event listener callback.
 *
 * @template TTag Tag type stored on sprites.
 * @template K Event key from {@link SpriteLayerEventMap}.
 * @param {SpriteLayerEventMap<TTag>[K]} event - Event payload dispatched by SpriteLayer.
 * @returns {void}
 */
export type SpriteLayerEventListener<
  TTag,
  K extends keyof SpriteLayerEventMap<TTag>,
> = (event: SpriteLayerEventMap<TTag>[K]) => void;

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Options controlling zoom-to-pixel scaling.
 */
export interface SpriteScalingOptions {
  /**
   * Overrides the baseline meters-per-pixel ratio.
   * We strongly recommend specifying the default value of 1, as this value affects all calculations.
   */
  metersPerPixel?: number;
  /** Minimum zoom level before scaling adjustments apply. */
  zoomMin?: number;
  /** Maximum zoom level before scaling adjustments apply. */
  zoomMax?: number;
  /** Lower limit for scale clamping. */
  scaleMin?: number;
  /** Upper limit for scale clamping. */
  scaleMax?: number;
  /** Minimum on-screen pixel size for sprites (0 disables the lower clamp). */
  spriteMinPixel?: number;
  /** Maximum on-screen pixel size for sprites (0 disables the upper clamp). */
  spriteMaxPixel?: number;
}

/**
 * Allowed minification filters for sprite textures.
 */
export type SpriteTextureMinFilter =
  | 'nearest'
  | 'linear'
  | 'nearest-mipmap-nearest'
  | 'nearest-mipmap-linear'
  | 'linear-mipmap-nearest'
  | 'linear-mipmap-linear';

/**
 * Allowed magnification filters for sprite textures.
 */
export type SpriteTextureMagFilter = 'nearest' | 'linear';

/**
 * Texture filtering configuration.
 */
export interface SpriteTextureFilteringOptions {
  /** Minification filter to apply (defaults to `linear`). */
  minFilter?: SpriteTextureMinFilter;
  /** Magnification filter to apply (defaults to `linear`). */
  magFilter?: SpriteTextureMagFilter;
  /** Generates mipmaps during upload when true (defaults to `false`). */
  generateMipmaps?: boolean;
  /** Desired anisotropy factor (>= 1) when EXT_texture_filter_anisotropic is available. */
  maxAnisotropy?: number;
}

/**
 * Options accepted when creating a SpriteLayer.
 */
export interface SpriteLayerOptions {
  /** Optional layer identifier supplied to MapLibre. */
  id?: string;
  /** Optional scaling controls. Default is UNLIMITED_SPRITE_SCALING_OPTIONS. */
  spriteScaling?: SpriteScalingOptions;
  /** Optional texture filtering configuration. */
  textureFiltering?: SpriteTextureFilteringOptions;
}

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Options used when registering SVG images.
 */
export interface SpriteImageSvgOptions {
  /** Treat the resource as SVG even when the MIME type is missing or incorrect. */
  readonly assumeSvg?: boolean;
  /** Enables parsing of the SVG markup to detect intrinsic sizing. Defaults to true for SVG images. */
  readonly inspectSize?: boolean;
  /**
   * Uses the SVG viewBox dimensions as the raster size when width/height attributes are missing.
   * When disabled (default), such SVGs fail to load instead of inferring a size.
   */
  readonly useViewBoxDimensions?: boolean;
}

/**
 * Options accepted by {@link SpriteLayerInterface.registerImage}.
 */
export interface SpriteImageRegisterOptions {
  /** Target width in CSS pixels. When only one dimension is supplied, the aspect ratio is preserved if known. */
  readonly width?: number;
  /** Target height in CSS pixels. When only one dimension is supplied, the aspect ratio is preserved if known. */
  readonly height?: number;
  /** Resampling quality used during rasterization. */
  readonly resizeQuality?: ResizeQuality;
  /** SVG-specific configuration. */
  readonly svg?: SpriteImageSvgOptions;
}

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Horizontal alignment options for text glyphs.
 */
export type SpriteTextGlyphHorizontalAlign = 'left' | 'center' | 'right';

/**
 * Padding in pixels applied when rendering text glyphs.
 */
export type SpriteTextGlyphPaddingPixel =
  | number
  | {
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
    };

/**
 * Border sides that can be rendered for a text glyph outline.
 */
export type SpriteTextGlyphBorderSide = 'top' | 'right' | 'bottom' | 'left';

/**
 * Additional size options accepted by registerTextGlyph.
 */
export type SpriteTextGlyphDimensions =
  | { readonly lineHeightPixel: number; readonly maxWidthPixel?: never }
  | { readonly maxWidthPixel: number; readonly lineHeightPixel?: never };

/**
 * Text glyph appearance options.
 */
export interface SpriteTextGlyphOptions {
  /** Font family name. */
  fontFamily?: string;
  /** CSS font-weight value. */
  fontWeight?: string;
  /** CSS font-style value. */
  fontStyle?: 'normal' | 'italic';
  /** Text fill color. */
  color?: string;
  /** Letter spacing in pixels. */
  letterSpacingPixel?: number;
  /** Background color applied behind the text. */
  backgroundColor?: string;
  /** Padding around the glyph. */
  paddingPixel?: SpriteTextGlyphPaddingPixel;
  /** Outline color. */
  borderColor?: string;
  /** Outline width in pixels. */
  borderWidthPixel?: number;
  /** Border sides to draw; defaults to all four sides when omitted. */
  borderSides?: readonly SpriteTextGlyphBorderSide[];
  /** Border radius in pixels. */
  borderRadiusPixel?: number;
  /** Horizontal alignment of multiline text. */
  textAlign?: SpriteTextGlyphHorizontalAlign;
  /** It is not specified normally. Preferred font size in pixels; may shrink automatically to satisfy provided dimensions. */
  fontSizePixelHint?: number;
  /** Pixel ratio used when rendering the glyph; defaults to 1 and values > 1 render at higher resolution before downscaling. */
  renderPixelRatio?: number;
}

//////////////////////////////////////////////////////////////////////////////////////

/**
 * MapLibre layer interface for SpriteLayer.
 * Renders large numbers of sprites and supports high-frequency updates.
 *
 * @template TTag Sprite tag type.
 */
export interface SpriteLayerInterface<TTag = any> extends CustomLayerInterface {
  /**
   * Registers an image or glyph so it can be referenced by sprite images.
   *
   * @param {string} imageId - Unique image identifier.
   * @param {string | ImageBitmap} image - Image source (URL or ImageBitmap) to upload.
   * @param {SpriteImageRegisterOptions | undefined} options - Optional SVG handling controls.
   * @returns {Promise<boolean>} Resolves to `true` when the image was registered; `false` if the ID already existed.
   */
  readonly registerImage: (
    imageId: string,
    image: string | ImageBitmap,
    options?: SpriteImageRegisterOptions
  ) => Promise<boolean>;
  /**
   * Registers a text glyph texture for later use.
   *
   * @param {string} textGlyphId - Unique identifier for the text glyph.
   * @param {string} text - Text content to render.
   * @param {SpriteTextGlyphDimensions} dimensions - Glyph sizing options.
   * @param {SpriteTextGlyphOptions | undefined} options - Optional styling information.
   * @returns {Promise<boolean>} Resolves to `true` when the glyph was registered; `false` if the ID already existed.
   */
  readonly registerTextGlyph: (
    textGlyphId: string,
    text: string,
    dimensions: SpriteTextGlyphDimensions,
    options?: SpriteTextGlyphOptions
  ) => Promise<boolean>;
  /**
   * Removes a previously registered image or glyph.
   *
   * @param {string} imageId - Identifier of the image to remove.
   * @returns {boolean} `true` when the image existed and was removed.
   */
  readonly unregisterImage: (imageId: string) => boolean;
  /**
   * Removes every registered image and glyph, releasing associated GPU resources.
   *
   * @returns {void}
   */
  readonly unregisterAllImages: () => void;
  /**
   * Returns all currently registered image IDs.
   *
   * @returns {string[]} Array of registered image identifiers.
   */
  readonly getAllImageIds: () => string[];

  ////////////////////////////////////////////////////////////////////////////////

  /**
   * Adds a sprite to the layer.
   *
   * @param {string} spriteId - Unique sprite identifier.
   * @param {SpriteInit<TTag>} init - Initial sprite configuration.
   * @returns {boolean} `true` when the sprite was inserted; `false` if the ID already existed.
   */
  readonly addSprite: (spriteId: string, init: SpriteInit<TTag>) => boolean;
  /**
   * Adds multiple sprites in one call.
   *
   * @param {SpriteInitCollection<TTag>} sprites - Sprite definitions keyed by ID or supplied as entries.
   * @returns {number} Number of sprites that were inserted.
   */
  readonly addSprites: (sprites: SpriteInitCollection<TTag>) => number;
  /**
   * Removes a sprite.
   *
   * @param {string} spriteId - Identifier of the sprite to remove.
   * @returns {void}
   */
  readonly removeSprite: (spriteId: string) => void;
  /**
   * Removes multiple sprites.
   *
   * @param {readonly string[]} spriteIds - Identifiers of the sprites to remove.
   * @returns {number} Number of sprites that were removed.
   */
  readonly removeSprites: (spriteIds: readonly string[]) => number;
  /**
   * Removes all sprites.
   *
   * @returns {number} Number of sprites that were removed.
   */
  readonly removeAllSprites: () => number;
  /**
   * Retrieves the current state for a sprite.
   *
   * @param {string} spriteId - Identifier of the sprite.
   * @returns {SpriteCurrentState<TTag> | undefined} Current state or `undefined` when not found.
   */
  readonly getSpriteState: (
    spriteId: string
  ) => SpriteCurrentState<TTag> | undefined;
  /**
   * Returns all sprite IDs currently managed by the layer.
   *
   * @returns {string[]} Array of sprite identifiers.
   */
  readonly getAllSpriteIds: () => string[];

  ////////////////////////////////////////////////////////////////////////////////

  /**
   * Attaches an image definition to a sprite.
   *
   * @param {string} spriteId - Target sprite identifier.
   * @param {number} subLayer - Sub-layer index.
   * @param {number} order - Order slot within the sub-layer.
   * @param {SpriteImageDefinitionInit} imageInit - Image definition to insert.
   * @returns {boolean} `true` when the image slot was empty and the definition applied.
   */
  readonly addSpriteImage: (
    spriteId: string,
    subLayer: number,
    order: number,
    imageInit: SpriteImageDefinitionInit
  ) => boolean;
  /**
   * Updates an image assigned to a sprite.
   *
   * @param {string} spriteId - Target sprite identifier.
   * @param {number} subLayer - Sub-layer index containing the image.
   * @param {number} order - Order slot within the sub-layer.
   * @param {SpriteImageDefinitionUpdate} imageUpdate - Update payload.
   * @returns {boolean} `true` when the image existed and was updated.
   */
  readonly updateSpriteImage: (
    spriteId: string,
    subLayer: number,
    order: number,
    imageUpdate: SpriteImageDefinitionUpdate
  ) => boolean;
  /**
   * Removes an image from a sprite.
   *
   * @param {string} spriteId - Target sprite identifier.
   * @param {number} subLayer - Sub-layer index containing the image.
   * @param {number} order - Order slot within the sub-layer.
   * @returns {boolean} `true` when the image existed and was removed.
   */
  readonly removeSpriteImage: (
    spriteId: string,
    subLayer: number,
    order: number
  ) => boolean;
  /**
   * Removes all images attached to the specified sprite.
   *
   * @param {string} spriteId - Identifier of the sprite whose images should be removed.
   * @returns {number} Number of images that were removed.
   */
  readonly removeAllSpriteImages: (spriteId: string) => number;

  ////////////////////////////////////////////////////////////////////////////////

  /**
   * Updates a sprite with the provided payload.
   *
   * @param {string} spriteId - Target sprite identifier.
   * @param {SpriteUpdateEntry<TTag>} update - Update payload describing property changes.
   * @returns {boolean} `true` when the sprite was found and updated.
   */
  readonly updateSprite: (
    spriteId: string,
    update: SpriteUpdateEntry<TTag>
  ) => boolean;
  /**
   * Adds, updates, or removes sprites based on an arbitrary collection of source items.
   *
   * @param {readonly TSourceItem[]} sourceItems - Source items that describe desired sprite state.
   * @param {SpriteMutateCallbacks<TTag, TSourceItem>} mutator - Callbacks responsible for creation and modification.
   * @returns {number} Number of sprites that changed. Counts each `add` that returns a non-null
   * initializer and each `modify` that either invoked the updater helper or returned `'remove'`.
   */
  readonly mutateSprites: <TSourceItem extends SpriteMutateSourceItem>(
    sourceItems: readonly TSourceItem[],
    mutator: SpriteMutateCallbacks<TTag, TSourceItem>
  ) => number;
  /**
   * Iterates over each sprite and allows modifications through a callback.
   *
   * @param {(sprite: SpriteCurrentState<TTag>, update: SpriteUpdaterEntry<TTag>) => boolean} updater - Callback invoked for each sprite. Return `false` to stop iteration early.
   * @returns {number} Number of sprites that were updated.
   */
  readonly updateForEach: (
    updater: (
      sprite: SpriteCurrentState<TTag>,
      update: SpriteUpdaterEntry<TTag>
    ) => boolean
  ) => number;

  ////////////////////////////////////////////////////////////////////////////////

  /**
   * Controls entire interpolation Calculation.
   * When `false`, interpolation halts immediately and resumes smoothly from the paused state when re-enabled.
   * @param moveable - Continuous calculation for movement interpolation when value is true.
   */
  readonly setInterpolationCalculation: (moveable: boolean) => void;

  /**
   * Enables or disables hit-test.
   *
   * @param {boolean} detect - When false, hit testing is skipped.
   */
  readonly setHitTestDetection: (detect: boolean) => void;
  /**
   * Adds an event listener.
   *
   * @param {K} type - Event name.
   * @param {SpriteLayerEventListener<TTag, K>} listener - Listener callback.
   * @returns {void}
   */
  readonly on: <K extends keyof SpriteLayerEventMap<TTag>>(
    type: K,
    listener: SpriteLayerEventListener<TTag, K>
  ) => void;
  /**
   * Removes a previously registered event listener.
   *
   * @param {K} type - Event name.
   * @param {SpriteLayerEventListener<TTag, K>} listener - Listener callback to remove.
   * @returns {void}
   */
  readonly off: <K extends keyof SpriteLayerEventMap<TTag>>(
    type: K,
    listener: SpriteLayerEventListener<TTag, K>
  ) => void;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * Calculation variant. It is internal calculation methods.
 */
export type SpriteLayerCalculationVariant =
  | 'simd-mt'
  | 'simd'
  | 'nosimd'
  | 'disabled';

/**
 * SpriteLayer host options.
 */
export interface SpriteLayerHostOptions {
  /**
   * Calculation variant. Default is `simd`.
   * Use `simd-mt` to enable pthread/SIMD wasm when `SharedArrayBuffer` is available
   * (i.e. cross-origin isolated contexts) and fall back to the other variants otherwise.
   */
  readonly variant?: SpriteLayerCalculationVariant;
  /**
   * Wasm runtime module base URL path. Default is `/wasm`
   */
  readonly wasmBaseUrl?: string;
}
