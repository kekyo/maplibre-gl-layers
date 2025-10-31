// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  SpriteScalingOptions,
  SpriteTextureFilteringOptions,
} from './types';

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Unlimited (default) values that fill in missing {@link SpriteScalingOptions} fields supplied by callers.
 * metersPerPixel is 1.
 */
export const UNLIMITED_SPRITE_SCALING_OPTIONS: SpriteScalingOptions = {
  metersPerPixel: 1.0,
  zoomMin: 0,
  zoomMax: 30,
  scaleMin: 1,
  scaleMax: 1,
  spriteMinPixel: 0,
  spriteMaxPixel: 100000,
} as const;

/**
 * Standard values that fill in missing {@link SpriteScalingOptions} fields supplied by callers.
 * metersPerPixel is 1.
 */
export const STANDARD_SPRITE_SCALING_OPTIONS: SpriteScalingOptions = {
  metersPerPixel: 1.0,
  zoomMin: 8.0,
  zoomMax: 20.0,
  scaleMin: 0.1,
  scaleMax: 1.0,
  spriteMinPixel: 24,
  spriteMaxPixel: 100,
} as const;

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Defaulted text filtering options.
 */
export const DEFAULT_TEXTURE_FILTERING_OPTIONS: SpriteTextureFilteringOptions =
  {
    minFilter: 'linear',
    magFilter: 'linear',
    generateMipmaps: false,
    maxAnisotropy: 1,
  } as const;

/**
 * Better text filtering options than default options.
 */
export const BETTER_TEXTURE_FILTERING_OPTIONS: SpriteTextureFilteringOptions = {
  minFilter: 'linear-mipmap-linear',
  magFilter: 'linear',
  generateMipmaps: true,
  maxAnisotropy: 8,
} as const;
