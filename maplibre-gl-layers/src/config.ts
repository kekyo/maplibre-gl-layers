// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

/** Debug flag */
export const SL_DEBUG = false;

/** Enables the upcoming shader-based billboard corner computation when true. */
export const USE_SHADER_BILLBOARD_GEOMETRY = true;

/** Enables the upcoming shader-based surface corner computation when true. */
export const USE_SHADER_SURFACE_GEOMETRY = true;

/** Whether to enable the NDC bias for surface rendering (disabled by default). */
export const ENABLE_NDC_BIAS_SURFACE = true;

/** Maximum number of atlas operations handled per processing pass. */
export const ATLAS_QUEUE_CHUNK_SIZE = 64;

/** Time budget (milliseconds) spent per atlas queue processing pass. */
export const ATLAS_QUEUE_TIME_BUDGET_MS = 20;

/** Maximum number of text glyph jobs handled per processing pass. */
export const TEXT_GLYPH_QUEUE_CHUNK_SIZE = 16;

/** Time budget (milliseconds) spent on text glyph generation per pass. */
export const TEXT_GLYPH_QUEUE_TIME_BUDGET_MS = 20;
