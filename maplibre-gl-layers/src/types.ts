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
   * Optional interpolation settings for rotateDeg and offsetDeg.
   */
  rotationInterpolation?: SpriteImageRotationInterpolationOptions;
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
  /** Optional interpolation settings applied to rotateDeg and offsetDeg. */
  rotationInterpolation?: SpriteImageRotationInterpolationOptions;
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
 * @param TTag Tag type.
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

/** Sprite image state evaluated at runtime. */
export interface SpriteImageState {
  readonly subLayer: number;
  readonly order: number;
  readonly imageId: string;
  readonly mode: SpriteMode;
  readonly opacity: number;
  readonly scale: number;
  readonly anchor: Readonly<SpriteAnchor>;
  readonly offset: Readonly<SpriteImageOffset>;
  readonly rotateDeg: number;
  readonly autoRotation: boolean;
  readonly autoRotationMinDistanceMeters: number;
  readonly resolvedBaseRotateDeg: number;
  readonly displayedRotateDeg: number;
  readonly originLocation: Readonly<SpriteImageOriginLocation> | undefined;
}

/**
 * Current runtime state of a sprite.
 * @param TTag Tag type.
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

/** Defines movement interpolation modes. */
export type SpriteInterpolationMode = 'feedback' | 'feedforward';

/** Easing function signature used to map interpolation progress. */
export type EasingFunction = (progress: number) => number;

/** Options controlling position interpolation. */
export interface SpriteInterpolationOptions {
  /** Interpolation mode; defaults to feedback. */
  mode?: SpriteInterpolationMode;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Easing function mapping interpolation progress. Defaults to linear. */
  easing?: EasingFunction;
}

/** Options for interpolating numeric values such as angles. */
export interface SpriteNumericInterpolationOptions {
  /** Duration in milliseconds. */
  durationMs: number;
  /** Easing function mapping interpolation progress. Defaults to linear. */
  easing?: EasingFunction;
}

/** Interpolation configuration for rotateDeg and offsetDeg. */
export interface SpriteImageRotationInterpolationOptions {
  /** Interpolation settings for rotateDeg; null disables interpolation. */
  rotateDeg?: SpriteNumericInterpolationOptions | null;
  /** Interpolation settings for offset.offsetDeg; null disables interpolation. */
  offsetDeg?: SpriteNumericInterpolationOptions | null;
}

/** Base structure for sprite updates. */
export interface SpriteUpdateEntryBase<TTag> {
  isEnabled?: boolean;
  location?: SpriteLocation;
  interpolation?: SpriteInterpolationOptions | null;
  tag?: TTag | null;
}

/** Update entry describing a sprite image modification. */
export interface SpriteImageDefinitionUpdateEntry {
  subLayer: number;
  order: number;
  image: SpriteImageDefinitionUpdate | null;
}

/** Sprite update entry with optional image list. */
export interface SpriteUpdateEntry<TTag> extends SpriteUpdateEntryBase<TTag> {
  images?: SpriteImageDefinitionUpdateEntry[];
}

/** Entry consumed by updateBulk to target a specific sprite. */
export interface SpriteUpdateBulkEntry<T> extends SpriteUpdateEntry<T> {
  spriteId: string;
}

/** Callback-based helper for mutating sprite state. */
export interface SpriteUpdaterEntry<TTag> extends SpriteUpdateEntryBase<TTag> {
  readonly getImageIndexMap: () => ReadonlyMap<number, ReadonlySet<number>>;
  readonly addImage: (
    subLayer: number,
    order: number,
    imageInit: SpriteImageDefinitionInit
  ) => boolean;
  readonly updateImage: (
    subLayer: number,
    order: number,
    imageUpdate: SpriteImageDefinitionUpdate
  ) => boolean;
  readonly removeImage: (subLayer: number, order: number) => boolean;
}

//////////////////////////////////////////////////////////////////////////////////////

/** Represents a point in screen space. */
export interface SpriteScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** Event dispatched when a sprite is clicked or tapped. */
export interface SpriteLayerClickEvent<T> {
  readonly type: 'spriteclick';
  readonly sprite: SpriteCurrentState<T>;
  readonly image: SpriteImageState;
  readonly screenPoint: SpriteScreenPoint;
  readonly originalEvent: MouseEvent | PointerEvent | TouchEvent;
}

/** Map of events emitted by SpriteLayer. */
export interface SpriteLayerEventMap<T> {
  readonly spriteclick: SpriteLayerClickEvent<T>;
}

/** Event listener callback. */
export type SpriteLayerEventListener<
  T,
  K extends keyof SpriteLayerEventMap<T>,
> = (event: SpriteLayerEventMap<T>[K]) => void;

//////////////////////////////////////////////////////////////////////////////////////

/** Options controlling zoom-to-pixel scaling. */
export interface SpriteScalingOptions {
  metersPerPixel?: number;
  zoomMin?: number;
  zoomMax?: number;
  scaleMin?: number;
  scaleMax?: number;
  spriteMinPixel?: number;
  spriteMaxPixel?: number;
}

/** Options accepted when creating a SpriteLayer. */
export interface SpriteLayerOptions {
  id?: string;
  spriteScaling?: SpriteScalingOptions;
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

/** Additional size options accepted by registerTextGlyph. */
export type SpriteTextGlyphDimensions =
  | { readonly lineHeightPixel: number; readonly maxWidthPixel?: never }
  | { readonly maxWidthPixel: number; readonly lineHeightPixel?: never };

export interface SpriteTextGlyphOptions {
  fontFamily?: string;
  fontSizePixel?: number;
  fontWeight?: string;
  fontStyle?: 'normal' | 'italic';
  color?: string;
  letterSpacingPixel?: number;
  backgroundColor?: string;
  paddingPixel?: SpriteTextGlyphPaddingPixel;
  borderColor?: string;
  borderWidthPixel?: number;
  borderRadiusPixel?: number;
  textAlign?: SpriteTextGlyphHorizontalAlign;
  renderPixelRatio?: number;
}

//////////////////////////////////////////////////////////////////////////////////////

/**
 * MapLibre layer interface for SpriteLayer.
 * Renders large numbers of sprites and supports high-frequency updates.
 * @param T Sprite tag type.
 */
export interface SpriteLayerInterface<T = any> extends CustomLayerInterface {
  readonly registerImage: (
    imageId: string,
    image: string | ImageBitmap
  ) => Promise<boolean>;
  readonly registerTextGlyph: (
    textGlyphId: string,
    text: string,
    dimensions: SpriteTextGlyphDimensions,
    options?: SpriteTextGlyphOptions
  ) => Promise<boolean>;
  readonly unregisterImage: (imageId: string) => boolean;

  ////////////////////////////////////////////////////////////////////////////////

  readonly addSprite: (spriteId: string, init: SpriteInit<T>) => boolean;
  readonly removeSprite: (spriteId: string) => void;
  readonly getSpriteState: (
    spriteId: string
  ) => SpriteCurrentState<T> | undefined;

  ////////////////////////////////////////////////////////////////////////////////

  readonly addSpriteImage: (
    spriteId: string,
    subLayer: number,
    order: number,
    imageInit: SpriteImageDefinitionInit
  ) => boolean;
  readonly updateSpriteImage: (
    spriteId: string,
    subLayer: number,
    order: number,
    imageUpdate: SpriteImageDefinitionUpdate
  ) => boolean;
  readonly removeSpriteImage: (
    spriteId: string,
    subLayer: number,
    order: number
  ) => boolean;

  ////////////////////////////////////////////////////////////////////////////////

  readonly updateSprite: (
    spriteId: string,
    update: SpriteUpdateEntry<T>
  ) => boolean;
  readonly updateBulk: (updateBulkList: SpriteUpdateBulkEntry<T>[]) => number;
  readonly updateForEach: (
    updater: (
      sprite: SpriteCurrentState<T>,
      update: SpriteUpdaterEntry<T>
    ) => boolean
  ) => number;

  ////////////////////////////////////////////////////////////////////////////////

  readonly on: <K extends keyof SpriteLayerEventMap<T>>(
    type: K,
    listener: SpriteLayerEventListener<T, K>
  ) => void;
  readonly off: <K extends keyof SpriteLayerEventMap<T>>(
    type: K,
    listener: SpriteLayerEventListener<T, K>
  ) => void;
}
