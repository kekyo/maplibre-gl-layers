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
 * Sprite rendering modes.
 * Billboard: Image always faces the viewport, suited for HUD-style elements.
 * Surface: Image lies parallel to the map surface, suited for dynamic markers on the map.
 */
export type SpriteMode = 'billboard' | 'surface';

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
 * Offset describing where to place an image relative to its anchor point.
 * Specifies distance and angle from the anchor, not from the sprite's base coordinate.
 */
export interface SpriteImageOffset {
  /**
   * Distance in meters from the image anchor. Zero keeps the image at the anchor point.
   */
  offsetMeters: number;
  /**
   * Angle describing the offset direction. This is not the image rotation.
   * Billboard mode: Clockwise degrees relative to the screen, 0 deg points upward.
   * Surface mode: Clockwise degrees from geographic north.
   */
  offsetDeg: number;
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

/** Defines movement interpolation modes. */
export type SpriteInterpolationMode = 'feedback' | 'feedforward';

/** Easing function signature used to map interpolation progress. */
export type EasingFunction = (progress: number) => number;

/** Options for interpolating values. */
export interface SpriteInterpolationOptions {
  /** Interpolation mode; defaults to feedback. */
  mode?: SpriteInterpolationMode;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Easing function mapping interpolation progress. Defaults to linear. */
  easing?: EasingFunction;
}

/** Interpolation configuration for rotateDeg and offsetDeg. */
export interface SpriteImageInterpolationOptions {
  /** Interpolation settings for rotateDeg; null disables interpolation. */
  rotateDeg?: SpriteInterpolationOptions | null;
  /** Interpolation settings for offset.offsetDeg; null disables interpolation. */
  offsetDeg?: SpriteInterpolationOptions | null;
  /** Interpolation settings for offset.offsetMeters; null disables interpolation. */
  offsetMeters?: SpriteInterpolationOptions | null;
}

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
  /** Offset from the sprite coordinate. Defaults to no offset. */
  offset?: SpriteImageOffset;
  /**
   * Determines which coordinate to anchor against.
   * - Omitted: use the sprite base coordinate.
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
  /** Offset from the sprite coordinate. */
  offset?: SpriteImageOffset;
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

/**
 * Sprite image state evaluated at runtime.
 *
 * @property {number} subLayer - Sub-layer index the image belongs to.
 * @property {number} order - Ordering slot within the sub-layer.
 * @property {string} imageId - Identifier of the registered image or glyph.
 * @property {SpriteMode} mode - Rendering mode applied to the image.
 * @property {number} opacity - Opacity multiplier applied when rendering.
 * @property {number} scale - Scale factor converting pixels to meters.
 * @property {Readonly<SpriteAnchor>} anchor - Anchor coordinates resolved for the image.
 * @property {Readonly<SpriteImageOffset>} offset - Offset applied relative to the anchor point.
 * @property {number} rotateDeg - Additional rotation in degrees.
 * @property {boolean} autoRotation - Indicates whether auto-rotation is active.
 * @property {number} autoRotationMinDistanceMeters - Minimum travel distance before auto-rotation updates.
 * @property {number} resolvedBaseRotateDeg - Internal base rotation resolved for the current frame.
 * @property {number} displayedRotateDeg - Rotation value actually used for rendering.
 * @property {Readonly<SpriteImageOriginLocation> | undefined} originLocation - Optional reference to another image used for anchoring.
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
  /** Opacity multiplier applied when rendering. */
  readonly opacity: number;
  /** Scale factor converting pixels to meters. */
  readonly scale: number;
  /** Anchor coordinates resolved for the image. */
  readonly anchor: Readonly<SpriteAnchor>;
  /** Offset applied relative to the anchor point. */
  readonly offset: Readonly<SpriteImageOffset>;
  /** Additional rotation in degrees. */
  readonly rotateDeg: number;
  /** Indicates whether auto-rotation is active. */
  readonly autoRotation: boolean;
  /** Minimum travel distance before auto-rotation updates. */
  readonly autoRotationMinDistanceMeters: number;
  /** Internal base rotation resolved for the current frame. */
  readonly resolvedBaseRotateDeg: number;
  /** Rotation value actually used for rendering. */
  readonly displayedRotateDeg: number;
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
  /** Current (possibly interpolated) location. */
  readonly currentLocation: Readonly<SpriteLocation>;
  /**
   * Source location during interpolation; undefined when not interpolating.
   * Feedback mode: previous commanded location.
   * Feed-forward mode: current commanded location.
   */
  readonly fromLocation?: Readonly<SpriteLocation>;
  /**
   * Destination location during interpolation; undefined when not interpolating.
   * Feedback mode: current commanded location.
   * Feed-forward mode: predicted location.
   */
  readonly toLocation?: Readonly<SpriteLocation>;
  /** Current image states, grouped by sub-layer and order. */
  readonly images: ReadonlyMap<number, ReadonlyMap<number, SpriteImageState>>;
  /** Optional tag value; null indicates no tag. */
  readonly tag: TTag | null;
}

/**
 * Base structure for sprite updates.
 *
 * @template TTag Tag type stored on the sprite.
 * @property {boolean | undefined} isEnabled - Optional toggle to enable or disable the sprite.
 * @property {SpriteLocation | undefined} location - Optional target location for the sprite.
 * @property {SpriteLocationInterpolationOptions | null | undefined} interpolation - Optional location interpolation settings; `null` disables interpolation.
 * @property {TTag | null | undefined} tag - Optional tag value to replace the current one; `null` clears the tag.
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
}

/**
 * Update entry describing a sprite image modification.
 *
 * @property {number} subLayer - Target sub-layer that contains the image.
 * @property {number} order - Order slot within the sub-layer.
 * @property {SpriteImageDefinitionUpdate | null} image - Update payload, or `null` to remove the image.
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
 * @property {SpriteImageDefinitionUpdateEntry[] | undefined} images - Optional set of image updates.
 */
export interface SpriteUpdateEntry<TTag> extends SpriteUpdateEntryBase<TTag> {
  /** Optional set of image updates. */
  images?: SpriteImageDefinitionUpdateEntry[];
}

/**
 * Callback-based helper for mutating sprite state.
 *
 * @template TTag Tag type stored on the sprite.
 * @property {() => ReadonlyMap<number, ReadonlySet<number>>} getImageIndexMap - Retrieves the current image layout.
 * @property {(subLayer: number, order: number, imageInit: SpriteImageDefinitionInit) => boolean} addImage - Adds an image definition.
 * @property {(subLayer: number, order: number, imageUpdate: SpriteImageDefinitionUpdate) => boolean} updateImage - Applies image updates.
 * @property {(subLayer: number, order: number) => boolean} removeImage - Removes an image slot.
 */
export interface SpriteUpdaterEntry<TTag> extends SpriteUpdateEntryBase<TTag> {
  /** Retrieves the current image layout. */
  readonly getImageIndexMap: () => ReadonlyMap<number, ReadonlySet<number>>;
  /** Adds an image definition. */
  readonly addImage: (
    subLayer: number,
    order: number,
    imageInit: SpriteImageDefinitionInit
  ) => boolean;
  /** Applies image updates. */
  readonly updateImage: (
    subLayer: number,
    order: number,
    imageUpdate: SpriteImageDefinitionUpdate
  ) => boolean;
  /** Removes an image slot. */
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
   * @returns Sprite initialiser to insert, or `undefined`/`null` to skip.
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
 * Represents a point in screen space.
 *
 * @property {number} x - Horizontal screen coordinate in pixels.
 * @property {number} y - Vertical screen coordinate in pixels.
 */
export interface SpriteScreenPoint {
  /** Horizontal screen coordinate in pixels. */
  readonly x: number;
  /** Vertical screen coordinate in pixels. */
  readonly y: number;
}

/**
 * Event dispatched when a sprite is clicked or tapped.
 *
 * @template T Tag type stored on sprites.
 * @property {'spriteclick'} type - Discriminated event type.
 * @property {SpriteCurrentState<T>} sprite - Snapshot of the sprite that was hit.
 * @property {SpriteImageState} image - Sprite image that received the interaction.
 * @property {SpriteScreenPoint} screenPoint - Screen position of the interaction.
 * @property {MouseEvent | PointerEvent | TouchEvent} originalEvent - Original DOM event.
 */
export interface SpriteLayerClickEvent<T> {
  /** Discriminated event type. */
  readonly type: 'spriteclick';
  /** Snapshot of the sprite that was hit. */
  readonly sprite: SpriteCurrentState<T>;
  /** Sprite image that received the interaction. */
  readonly image: SpriteImageState;
  /** Screen position of the interaction. */
  readonly screenPoint: SpriteScreenPoint;
  /** Original DOM event. */
  readonly originalEvent: MouseEvent | PointerEvent | TouchEvent;
}

/**
 * Map of events emitted by SpriteLayer.
 *
 * @template T Tag type stored on sprites.
 * @property {SpriteLayerClickEvent<T>} spriteclick - Event fired when a sprite image is clicked.
 */
export interface SpriteLayerEventMap<T> {
  /** Event fired when a sprite image is clicked. */
  readonly spriteclick: SpriteLayerClickEvent<T>;
}

/**
 * Event listener callback.
 *
 * @template T Tag type stored on sprites.
 * @template K Event key from {@link SpriteLayerEventMap}.
 * @param {SpriteLayerEventMap<T>[K]} event - Event payload dispatched by SpriteLayer.
 * @returns {void}
 */
export type SpriteLayerEventListener<
  T,
  K extends keyof SpriteLayerEventMap<T>,
> = (event: SpriteLayerEventMap<T>[K]) => void;

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Options controlling zoom-to-pixel scaling.
 *
 * @property {number | undefined} metersPerPixel - Overrides the baseline meters-per-pixel ratio.
 * @property {number | undefined} zoomMin - Minimum zoom level before scaling adjustments apply.
 * @property {number | undefined} zoomMax - Maximum zoom level before scaling adjustments apply.
 * @property {number | undefined} scaleMin - Lower limit for scale clamping.
 * @property {number | undefined} scaleMax - Upper limit for scale clamping.
 * @property {number | undefined} spriteMinPixel - Minimum on-screen pixel size for sprites (0 disables the lower clamp).
 * @property {number | undefined} spriteMaxPixel - Maximum on-screen pixel size for sprites (0 disables the upper clamp).
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
 *
 * @property {SpriteTextureMinFilter | undefined} minFilter - Minification filter to apply (defaults to `linear`).
 * @property {SpriteTextureMagFilter | undefined} magFilter - Magnification filter to apply (defaults to `linear`).
 * @property {boolean | undefined} generateMipmaps - Generates mipmaps during upload when true (defaults to `false`).
 * @property {number | undefined} maxAnisotropy - Desired anisotropy factor (>= 1) when EXT_texture_filter_anisotropic is available.
 */
export interface SpriteTextureFilteringOptions {
  minFilter?: SpriteTextureMinFilter;
  magFilter?: SpriteTextureMagFilter;
  generateMipmaps?: boolean;
  maxAnisotropy?: number;
}

/**
 * Options accepted when creating a SpriteLayer.
 *
 * @property {string | undefined} id - Optional layer identifier supplied to MapLibre.
 * @property {SpriteScalingOptions | undefined} spriteScaling - Optional scaling controls. Default is UNLIMITED_SPRITE_SCALING_OPTIONS.
 * @property {SpriteTextureFilteringOptions | undefined} textureFiltering - Optional texture filtering overrides.
 */
export interface SpriteLayerOptions {
  /** Optional layer identifier supplied to MapLibre. */
  id?: string;
  /** Optional scaling controls. */
  spriteScaling?: SpriteScalingOptions;
  /** Optional texture filtering configuration. */
  textureFiltering?: SpriteTextureFilteringOptions;
}

//////////////////////////////////////////////////////////////////////////////////////

/** Horizontal alignment options for text glyphs. */
export type SpriteTextGlyphHorizontalAlign = 'left' | 'center' | 'right';

/** Padding in pixels applied when rendering text glyphs. */
export type SpriteTextGlyphPaddingPixel =
  | number
  | {
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
    };

/** Border sides that can be rendered for a text glyph outline. */
export type SpriteTextGlyphBorderSide = 'top' | 'right' | 'bottom' | 'left';

/** Additional size options accepted by registerTextGlyph. */
export type SpriteTextGlyphDimensions =
  | { readonly lineHeightPixel: number; readonly maxWidthPixel?: never }
  | { readonly maxWidthPixel: number; readonly lineHeightPixel?: never };

/**
 * Text glyph appearance options.
 *
 * @property {string | undefined} fontFamily - Font family name.
 * @property {string | undefined} fontWeight - CSS font-weight value.
 * @property {'normal' | 'italic' | undefined} fontStyle - CSS font-style value.
 * @property {string | undefined} color - Text fill color.
 * @property {number | undefined} letterSpacingPixel - Letter spacing in pixels.
 * @property {string | undefined} backgroundColor - Background color applied behind the text.
 * @property {SpriteTextGlyphPaddingPixel | undefined} paddingPixel - Padding around the glyph.
 * @property {string | undefined} borderColor - Outline color.
 * @property {number | undefined} borderWidthPixel - Outline width in pixels.
 * @property {SpriteTextGlyphBorderSide[] | undefined} borderSides - Border sides to draw (defaults to all four).
 * @property {number | undefined} borderRadiusPixel - Border radius in pixels.
 * @property {SpriteTextGlyphHorizontalAlign | undefined} textAlign - Horizontal alignment of multiline text.
 * @property {number | undefined} fontSizePixelHint - It is not specified normally. Preferred font size in pixels before dimension constraints are enforced.
 * @property {number | undefined} renderPixelRatio - Canvas pixel ratio multiplier (defaults to 1) applied before the glyph is resampled to its logical size.
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
   * @returns {Promise<boolean>} Resolves to `true` when the image was registered; `false` if the ID already existed.
   */
  readonly registerImage: (
    imageId: string,
    image: string | ImageBitmap
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
   * initialiser and each `modify` that either invoked the updater helper or returned `'remove'`.
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
