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
  type SpriteAnchor,
  type SpriteLocation,
  type SpriteCurrentState,
  type SpriteUpdateEntry,
  type SpriteUpdaterEntry,
  type SpriteImageDefinitionInit,
  type SpriteImageDefinitionUpdate,
  type SpriteMutateCallbacks,
  type SpriteMutateSourceItem,
  type SpriteImageLineAttribute,
  type SpriteInterpolationOptions,
  type SpriteImageOriginLocation,
  type SpriteScreenPoint,
  type SpriteImageState,
  type SpriteTextGlyphDimensions,
  type SpriteTextGlyphOptions,
  type SpriteImageRegisterOptions,
} from './types';
import type {
  RegisteredImage,
  InternalSpriteImageState,
  InternalSpriteCurrentState,
  MutableSpriteImageInterpolatedOffset,
  ProjectionHost,
  PreparedDrawSpriteImageParams,
  RenderCalculationHost,
  RenderInterpolationParams,
  SpriteOriginReference,
  SpriteOriginReferenceKey,
  ResolvedSpriteImageLineAttribute,
  RgbaColor,
} from './internalTypes';
import {
  SPRITE_ORIGIN_REFERENCE_KEY_NONE,
  SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
} from './internalTypes';
import { loadImageBitmap, SvgSizeResolutionError } from './utils/image';
import { createLocationInterpolationState } from './interpolation/locationInterpolation';
import {
  calculateDistanceAndBearingMeters,
  isFiniteNumber,
  resolveScalingOptions,
  cloneSpriteLocation,
  spriteLocationsEqual,
  clampOpacity,
  normalizeAngleDeg,
} from './utils/math';
import { parseCssColorToRgba } from './utils/color';
import {
  applyOffsetUpdate,
  applyOpacityUpdate,
  clearOffsetDegInterpolation,
  clearOffsetMetersInterpolation,
  clearOpacityInterpolation,
  syncImageRotationChannel,
  hasActiveImageInterpolations,
} from './interpolation/interpolationChannels';
import {
  createSpriteDrawProgram,
  createBorderOutlineRenderer,
  createLeaderLineRenderer,
  type SpriteDrawProgram,
  type BorderOutlineRenderer,
  type LeaderLineRenderer,
  resolveTextureFilteringOptions,
  resolveAnisotropyExtension,
  ensureTextures,
} from './gl/shader';
import { createCalculationHost } from './host/calculationHost';
import {
  createProjectionHost,
  createProjectionHostParamsFromMapLibre,
} from './host/projectionHost';
import { createWasmProjectionHost } from './host/wasmProjectionHost';
import { createWasmCalculationHost } from './host/wasmCalculationHost';
import {
  createSpriteTrackingController,
  type SpriteTrackingController,
} from './gl/tracking';
import {
  createSpriteMouseEventsController,
  type SpriteMouseEventsController,
} from './gl/mouseEvents';
import {
  DEFAULT_ANCHOR,
  DEFAULT_AUTO_ROTATION_MIN_DISTANCE_METERS,
  DEFAULT_BORDER_COLOR,
  DEFAULT_BORDER_COLOR_RGBA,
  DEFAULT_BORDER_WIDTH_METERS,
  DEFAULT_IMAGE_OFFSET,
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
} from './utils/utils';
import {
  createAtlasManager,
  type AtlasPageState,
  createAtlasOperationQueue,
} from './gl/atlas';
import { createHitTestController, type HitTestEntry } from './gl/hitTest';
import {
  createDeferred,
  onAbort,
  type Deferred,
  type Releasable,
} from 'async-primitives';
import { isSpriteLayerHostEnabled } from './host/runtime';
import { renderTextGlyphBitmap } from './gl/text';

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

const OPACITY_VISIBILITY_EPSILON = 1e-4;

// Baseline computation values:
// SpriteScalingOptions parameters are used here.

//////////////////////////////////////////////////////////////////////////////////////

/** Sentinel used when an image has not been placed on any atlas page. */
const ATLAS_PAGE_INDEX_NONE = -1;

const updateImageInterpolationDirtyState = <T>(
  sprite: InternalSpriteCurrentState<T>,
  image: InternalSpriteImageState
): void => {
  const dirty = hasActiveImageInterpolations(image);
  image.interpolationDirty = dirty;
  if (dirty) {
    sprite.interpolationDirty = true;
  }
};

const reapplySpriteOpacityMultiplier = <T>(
  sprite: InternalSpriteCurrentState<T>
): void => {
  const multiplier = sprite.opacityMultiplier ?? 1;
  sprite.images.forEach((orderMap) => {
    orderMap.forEach((image) => {
      const baseOpacity =
        image.finalOpacity.interpolation.baseValue ??
        image.finalOpacity.current;
      const interpolationOption =
        image.finalOpacity.interpolation.options ?? null;
      applyOpacityUpdate(image, baseOpacity, interpolationOption, multiplier);
    });
  });
};

const resolveImageAutoRotationDeg = <T>(
  sprite: InternalSpriteCurrentState<T>,
  image: InternalSpriteImageState
): number => {
  return image.autoRotation ? sprite.currentAutoRotateDeg : 0;
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
  nextLocation: SpriteLocation,
  forceAutoRotation: boolean
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
  if (forceAutoRotation) {
    requiredDistance = 0;
  }

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
    : sprite.currentAutoRotateDeg;
  const resolvedAngle = normalizeAngleDeg(resolvedAngleRaw);

  sprite.currentAutoRotateDeg = resolvedAngle;

  sprite.images.forEach((orderMap) => {
    orderMap.forEach((image) => {
      // Only update images participating in auto-rotation; others preserve their manual angles.
      if (!image.autoRotation) {
        return;
      }
      syncImageRotationChannel(image, resolvedAngle);
      updateImageInterpolationDirtyState(sprite, image);
    });
  });

  sprite.lastAutoRotationLocation = cloneSpriteLocation(nextLocation);

  return true;
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Clones an optional origin location descriptor to avoid mutating caller state.
 * @param {SpriteImageOriginLocation} origin - Source origin definition.
 * @returns {SpriteImageOriginLocation | undefined} Deep clone of the origin or `undefined` when absent.
 */
const cloneOriginLocation = (
  origin: SpriteImageOriginLocation | undefined
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
 * @param {SpriteAnchor} anchor - Anchor to clone.
 * @returns {SpriteAnchor} Safe copy for mutation within the layer state.
 */
const cloneAnchor = (anchor: SpriteAnchor | undefined): SpriteAnchor => {
  if (!anchor) {
    return { ...DEFAULT_ANCHOR };
  }
  return { x: anchor.x, y: anchor.y };
};

type OffsetInput = { offsetMeters?: number; offsetDeg?: number } | undefined;

const resolveOffsetInput = (offset: OffsetInput) => ({
  offsetMeters: offset?.offsetMeters ?? DEFAULT_IMAGE_OFFSET.offsetMeters,
  offsetDeg: offset?.offsetDeg ?? DEFAULT_IMAGE_OFFSET.offsetDeg,
});

const createInterpolatedOffsetState = (
  offset: OffsetInput,
  invalidated: boolean
): MutableSpriteImageInterpolatedOffset => {
  const base = resolveOffsetInput(offset);
  return {
    offsetMeters: {
      current: base.offsetMeters,
      from: undefined,
      to: undefined,
      invalidated,
      interpolation: {
        state: null,
        options: null,
        lastCommandValue: base.offsetMeters,
        baseValue: undefined,
        targetValue: undefined,
      },
    },
    offsetDeg: {
      current: base.offsetDeg,
      from: undefined,
      to: undefined,
      invalidated,
      interpolation: {
        state: null,
        options: null,
        lastCommandValue: base.offsetDeg,
        baseValue: undefined,
        targetValue: undefined,
      },
    },
  };
};

const resolveBorderWidthMeters = (width?: number): number => {
  if (typeof width !== 'number') {
    return DEFAULT_BORDER_WIDTH_METERS;
  }
  if (!Number.isFinite(width) || width <= 0) {
    return DEFAULT_BORDER_WIDTH_METERS;
  }
  return width;
};

const resolveSpriteImageLineAttribute = (
  border: SpriteImageLineAttribute | null | undefined
): ResolvedSpriteImageLineAttribute | undefined => {
  if (!border) {
    return undefined;
  }
  const colorString =
    border.color && border.color.trim().length > 0
      ? border.color
      : DEFAULT_BORDER_COLOR;
  const rgba = parseCssColorToRgba(colorString, DEFAULT_BORDER_COLOR_RGBA);
  return {
    color: colorString,
    widthMeters: resolveBorderWidthMeters(border.widthMeters),
    rgba,
  };
};

/**
 * Deep-clones interpolation options to prevent shared references between sprites.
 * @param {SpriteInterpolationOptions} options - Options provided by the user.
 * @returns {SpriteInterpolationOptions} Cloned options object.
 */
const cloneEasing = (easing?: SpriteInterpolationOptions['easing']) =>
  easing ? { ...easing } : easing;

const cloneInterpolationOptions = (
  options: SpriteInterpolationOptions
): SpriteInterpolationOptions => {
  return {
    mode: options.mode,
    durationMs: options.durationMs,
    easing: cloneEasing(options.easing),
  };
};

/**
 * Normalizes visibility distance thresholds, returning `undefined` when the input is not a positive finite number.
 */
const sanitizeVisibilityDistanceMeters = (
  value: number | null | undefined
): number | null | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return value;
};

const sanitizeOpacityMultiplier = (
  value: number | null | undefined
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }
  if (value <= 0) {
    return 0;
  }
  return value;
};

/**
 * Creates internal sprite image state from initialization data and layer bookkeeping fields.
 * @param {SpriteImageDefinitionInit} imageInit - Caller-provided image definition.
 * @param {number} subLayer - Sub-layer index the image belongs to.
 * @param {number} order - Ordering slot within the sub-layer.
 * @param {SpriteOriginReference} originReference - Encode/Decode origin reference.
 * @param {boolean} invalidated - Initially invalidate state.
 * @returns {InternalSpriteImageState} Normalized internal state ready for rendering.
 */
export const createImageStateFromInit = (
  imageInit: SpriteImageDefinitionInit,
  subLayer: number,
  order: number,
  originReference: SpriteOriginReference,
  invalidated: boolean,
  spriteAutoRotationDeg = 0
): InternalSpriteImageState => {
  const mode = imageInit.mode ?? 'surface';
  const autoRotationDefault = mode === 'surface';
  const initialOffset = resolveOffsetInput({
    offsetMeters: imageInit.offsetMeters,
    offsetDeg: imageInit.offsetDeg,
  });
  const initialOpacity = clampOpacity(imageInit.opacity ?? 1.0);
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
    rotateDeg: initialRotateDeg,
    opacity: initialOpacity,
    finalOpacity: {
      current: initialOpacity,
      from: undefined,
      to: undefined,
      invalidated,
      interpolation: {
        state: null,
        options: null,
        targetValue: initialOpacity,
        baseValue: initialOpacity,
        lastCommandValue: initialOpacity,
      },
    },
    lodOpacity: 1,
    scale: imageInit.scale ?? 1.0,
    anchor: cloneAnchor(imageInit.anchor),
    border: resolveSpriteImageLineAttribute(imageInit.border),
    borderPixelWidth: 0,
    leaderLine: resolveSpriteImageLineAttribute(imageInit.leaderLine),
    leaderLinePixelWidth: 0,
    offset: createInterpolatedOffsetState(initialOffset, invalidated),
    finalRotateDeg: {
      current: initialRotateDeg,
      from: undefined,
      to: undefined,
      invalidated,
      interpolation: {
        state: null,
        options: null,
        lastCommandValue: initialRotateDeg,
        baseValue: undefined,
        targetValue: undefined,
      },
    },
    autoRotation: imageInit.autoRotation ?? autoRotationDefault,
    autoRotationMinDistanceMeters:
      imageInit.autoRotationMinDistanceMeters ??
      DEFAULT_AUTO_ROTATION_MIN_DISTANCE_METERS,
    originLocation,
    originReferenceKey,
    originRenderTargetIndex: SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
    interpolationDirty: false,
    surfaceShaderInputs: undefined,
    hitTestCorners: undefined,
  };

  // Preload rotation interpolation defaults when supplied on initialization; otherwise treat as absent.
  const rotateInitOption = imageInit.interpolation?.finalRotateDeg ?? null;
  if (rotateInitOption) {
    state.finalRotateDeg.interpolation.options =
      cloneInterpolationOptions(rotateInitOption);
  }

  const opacityInitOption = imageInit.interpolation?.finalOpacity ?? null;
  if (opacityInitOption) {
    state.finalOpacity.interpolation.options =
      cloneInterpolationOptions(opacityInitOption);
  }

  syncImageRotationChannel(
    state,
    spriteAutoRotationDeg,
    state.finalRotateDeg.interpolation.options ?? undefined
  );

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
  let gl: WebGLRenderingContext | undefined;
  /** MapLibre map instance provided to the custom layer. */
  let map: MapLibreMap | undefined;
  /** Sprite drawing helper encapsulating shader state. */
  let spriteDrawProgram: SpriteDrawProgram<T> | undefined;
  /** Cached anisotropic filtering extension instance (when available). */
  let anisotropyExtension: EXT_texture_filter_anisotropic | undefined;
  /** Maximum anisotropy supported by the current context. */
  let maxSupportedAnisotropy = 1;
  /** Helper used to render sprite border outlines. */
  let borderOutlineRenderer: BorderOutlineRenderer | undefined;
  /** Helper used to render leader lines. */
  let leaderLineRenderer: LeaderLineRenderer | undefined;

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

  // Tracks interpolation clock so it can be paused without losing progress.
  let interpolationCalculationEnabled = true;
  let interpolationTimestamp: number | undefined;
  let interpolationTimestampAnchor: number | undefined;

  const resolveInterpolationTimestamp = (realTimestamp: number): number => {
    const effectiveReal = Number.isFinite(realTimestamp)
      ? realTimestamp
      : now();
    if (interpolationTimestamp === undefined) {
      interpolationTimestamp = effectiveReal;
    }
    if (interpolationTimestampAnchor === undefined) {
      interpolationTimestampAnchor = effectiveReal;
      return interpolationTimestamp;
    }
    if (interpolationCalculationEnabled) {
      interpolationTimestamp += effectiveReal - interpolationTimestampAnchor;
    }
    interpolationTimestampAnchor = effectiveReal;
    return interpolationTimestamp;
  };

  const resetInterpolationTimestampAnchor = (realTimestamp?: number): void => {
    const effectiveReal = Number.isFinite(realTimestamp)
      ? realTimestamp
      : now();
    if (interpolationTimestamp === undefined) {
      interpolationTimestamp = effectiveReal;
    }
    interpolationTimestampAnchor = effectiveReal;
  };

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
   * Create hit-test controller.
   */
  const hitTestController = createHitTestController<T>({
    images,
    getResolvedScaling: () => resolvedScaling,
  });

  /**
   * Sprite tracking controller.
   */
  let trackingController: SpriteTrackingController<T> | undefined;

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

  const invalidateImageInterpolationState = <TTag>(
    sprite: InternalSpriteCurrentState<TTag>,
    image: InternalSpriteImageState
  ): void => {
    image.finalRotateDeg.interpolation.state = null;
    image.offset.offsetDeg.interpolation.state = null;
    image.offset.offsetMeters.interpolation.state = null;
    image.finalOpacity.interpolation.state = null;

    image.finalRotateDeg.from = undefined;
    image.finalRotateDeg.to = undefined;
    image.finalRotateDeg.invalidated = true;
    image.finalRotateDeg.interpolation.lastCommandValue =
      image.finalRotateDeg.current;

    image.offset.offsetDeg.from = undefined;
    image.offset.offsetDeg.to = undefined;
    image.offset.offsetDeg.invalidated = true;
    image.offset.offsetDeg.interpolation.lastCommandValue =
      image.offset.offsetDeg.current;

    image.offset.offsetMeters.from = undefined;
    image.offset.offsetMeters.to = undefined;
    image.offset.offsetMeters.invalidated = true;
    image.offset.offsetMeters.interpolation.lastCommandValue =
      image.offset.offsetMeters.current;

    image.finalOpacity.from = undefined;
    image.finalOpacity.to = undefined;
    image.finalOpacity.invalidated = true;
    image.finalOpacity.interpolation.targetValue = image.finalOpacity.current;
    image.finalOpacity.interpolation.lastCommandValue =
      image.finalOpacity.current;
    const spriteOpacityMultiplier = sprite.opacityMultiplier ?? 1;
    const lodMultiplier = image.lodOpacity || 1;
    if (spriteOpacityMultiplier > 0 && lodMultiplier > 0) {
      image.finalOpacity.interpolation.baseValue = clampOpacity(
        image.finalOpacity.current / (spriteOpacityMultiplier * lodMultiplier)
      );
    }

    updateImageInterpolationDirtyState(sprite, image);
  };

  const invalidateSpriteInterpolationState = <TTag>(
    sprite: InternalSpriteCurrentState<TTag>
  ): void => {
    const currentSnapshot = cloneSpriteLocation(sprite.location.current);
    sprite.location.from = undefined;
    sprite.location.to = undefined;
    sprite.location.invalidated = true;
    sprite.location.interpolation.state = null;
    sprite.location.interpolation.options = null;
    sprite.location.interpolation.lastCommandValue =
      cloneSpriteLocation(currentSnapshot);
    sprite.lastAutoRotationLocation = cloneSpriteLocation(currentSnapshot);
    sprite.autoRotationInvalidated = true;
    sprite.interpolationDirty = false;

    sprite.images.forEach((orderMap) => {
      orderMap.forEach((image) => {
        invalidateImageInterpolationState(sprite, image);
        // Preserve the prior displayed rotation so manual angles
        // aren't overwritten during visibility transitions.
        const autoRotationDeg = resolveImageAutoRotationDeg(sprite, image);
        image.finalRotateDeg.current = autoRotationDeg + image.rotateDeg;
      });
    });
  };

  const invalidateAllInterpolations = (): void => {
    sprites.forEach((sprite) => invalidateSpriteInterpolationState(sprite));
  };

  const updateVisibilityState = (): void => {
    const visible = resolveDocumentVisibility();
    if (visible === mapVisible) {
      return;
    }
    mapVisible = visible;
    if (!visible) {
      invalidateAllInterpolations();
    }
  };

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

  // TODO: For debug purpose, DO NOT DELETE
  if (SL_DEBUG) {
    // Expose render pipeline state for developer diagnostics via global window hooks.
    (window as any).__renderTargetEntries = renderTargetEntries;
    (window as any).__spriteHitTestEntries =
      hitTestController.getHitTestEntries();
  }
  // TODO: end

  //////////////////////////////////////////////////////////////////////////

  let canvasElement: HTMLCanvasElement | undefined;
  let mapVisible =
    typeof document !== 'undefined'
      ? document.visibilityState !== 'hidden'
      : true;

  const resolveDocumentVisibility = (): boolean => {
    const doc =
      canvasElement?.ownerDocument ??
      (typeof document !== 'undefined' ? document : undefined);
    return doc ? doc.visibilityState !== 'hidden' : true;
  };

  const isLayerVisible = (): boolean => mapVisible;

  /**
   * Resolves sprite and image state for a hit-test entry.
   * @param {HitTestEntry} hitEntry - Hit-test entry returned from the lookup.
   * @returns {{ sprite: SpriteCurrentState<T> | undefined; image: SpriteImageState | undefined }} Sprite/image state pair.
   */
  const resolveSpriteEventPayload = (
    hitEntry: HitTestEntry<T> | undefined
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
   * Resolves hit-test information for a native event.
   * @param {MouseEvent | PointerEvent | TouchEvent} nativeEvent - Original browser event.
   * @returns {{ hitEntry: HitTestEntry; screenPoint: SpriteScreenPoint } | undefined} Hit-test result or `undefined`.
   */
  const resolveHitTestResult = (
    nativeEvent: MouseEvent | PointerEvent | TouchEvent
  ):
    | {
        hitEntry: HitTestEntry<T> | undefined;
        screenPoint: SpriteScreenPoint;
      }
    | undefined => {
    return hitTestController.resolveHitTestResult(
      nativeEvent,
      canvasElement,
      map
    );
  };

  const mouseEventsController: SpriteMouseEventsController<T> =
    createSpriteMouseEventsController<T>({
      resolveHitTestResult,
      resolveSpriteEventPayload,
      updateVisibilityState,
    });

  //////////////////////////////////////////////////////////////////////////

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
          const isOpacityInterpolating =
            image.finalOpacity.interpolation.state !== null;
          const baseOpacity =
            image.finalOpacity.interpolation.baseValue ??
            image.finalOpacity.interpolation.lastCommandValue;
          const shouldForceVisibilityCheck =
            sprite.visibilityDistanceMeters !== undefined &&
            (baseOpacity ?? 0) > OPACITY_VISIBILITY_EPSILON;
          // Fully transparent images contribute nothing and can be ignored unless pseudo LOD controls their visibility.
          if (
            image.finalOpacity.current <= 0 &&
            !isOpacityInterpolating &&
            !shouldForceVisibilityCheck
          ) {
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

  // Tracking controller hooks into sprite layout API.
  const trackSprite = (
    spriteId: string,
    trackRotation: boolean | undefined
  ): void => {
    const sprite = sprites.get(spriteId);
    if (!sprite) {
      trackingController?.untrackSprite();
      return;
    }
    trackingController?.trackSprite(sprite, trackRotation ?? true);
  };
  const untrackSprite = (): void => {
    trackingController?.untrackSprite();
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
    trackingController = createSpriteTrackingController(mapInstance);
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
    mouseEventsController.bindCanvas(canvasElement);
    canvasElement = mouseEventsController.canvasElement;

    spriteDrawProgram = createSpriteDrawProgram<T>(glContext);

    // Request a render pass.
    scheduleRender();
  };

  /**
   * Called when the layer is removed from the map to release WebGL resources.
   */
  const onRemove = (): void => {
    trackingController?.release();
    trackingController = undefined;
    mouseEventsController.release();
    canvasElement = undefined;
    hitTestController.clearAll();

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
      if (spriteDrawProgram) {
        spriteDrawProgram.release();
        spriteDrawProgram = undefined;
      }
      if (borderOutlineRenderer) {
        borderOutlineRenderer.release();
        borderOutlineRenderer = undefined;
      }
      if (leaderLineRenderer) {
        leaderLineRenderer.release();
        leaderLineRenderer = undefined;
      }
    }

    gl = undefined;
    map = undefined;
    borderOutlineRenderer = undefined;
    leaderLineRenderer = undefined;
    anisotropyExtension = undefined;
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
    hitTestController.beginFrame();

    // Abort early if any critical resource (map or shader program) is missing.
    const mapInstance = map;
    if (!mapInstance || !spriteDrawProgram) {
      return;
    }

    const realTimestamp = now();
    const interpolationTimestamp = resolveInterpolationTimestamp(realTimestamp);

    const spriteStateArray = Array.from(sprites.values());
    const shouldProcessInterpolation =
      interpolationCalculationEnabled && spriteStateArray.length > 0;
    let frameCalculationHost: RenderCalculationHost<T> | null = null;
    const ensureCalculationHost = (): RenderCalculationHost<T> => {
      if (!frameCalculationHost) {
        frameCalculationHost = createCalculationHostForMap(mapInstance);
      }
      return frameCalculationHost;
    };
    const releaseCalculationHost = (): void => {
      if (!frameCalculationHost) {
        return;
      }
      frameCalculationHost.release();
      frameCalculationHost = null;
    };

    const interpolationParams: RenderInterpolationParams<T> | null =
      shouldProcessInterpolation
        ? {
            sprites: spriteStateArray,
            timestamp: interpolationTimestamp,
            frameContext: {
              baseMetersPerPixel: resolvedScaling.metersPerPixel,
            },
          }
        : null;
    let hasActiveInterpolation = false;

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
    atlasNeedsUpload = ensureTextures({
      glContext: gl,
      atlasQueue,
      atlasManager,
      atlasPageTextures,
      atlasNeedsUpload,
      resolvedTextureFiltering,
      anisotropyExtension,
      maxSupportedAnisotropy,
      images,
      imageHandleBuffersController,
      atlasPageIndexNone: ATLAS_PAGE_INDEX_NONE,
      shouldUploadAtlasPages,
    });

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

    // Prepare to create projection host
    const projectionHost = createProjectionHostForMap(mapInstance);
    try {
      const clipContext = projectionHost.getClipContext();
      // Without a clip context we cannot project to clip space; skip rendering.
      if (!clipContext) {
        return;
      }

      // Enable blending and avoid depth-buffer interference.
      glContext.enable(glContext.BLEND);
      glContext.blendFunc(glContext.SRC_ALPHA, glContext.ONE_MINUS_SRC_ALPHA);
      glContext.disable(glContext.DEPTH_TEST);
      glContext.depthMask(false);

      const drawProgram = spriteDrawProgram;

      let drawOrderCounter = 0;
      const drawPreparedSprite = (
        prepared: PreparedDrawSpriteImageParams<T>
      ): void => {
        const didDraw = drawProgram.draw(prepared);
        if (!didDraw) {
          return;
        }

        prepared.imageEntry.surfaceShaderInputs =
          prepared.surfaceShaderInputs ?? undefined;

        if (prepared.hitTestCorners && prepared.hitTestCorners.length === 4) {
          hitTestController.registerHitTestEntry(
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
        const calculationHost = ensureCalculationHost();
        const imageHandleBuffers = imageHandleBuffersController.ensure();
        const imageResources =
          imageHandleBuffersController.getResourcesByHandle();
        const bucketBuffers = createRenderTargetBucketBuffers(
          renderTargetEntries,
          {
            originReference,
          }
        );
        const processResult = calculationHost.processDrawSpriteImages({
          interpolationParams: interpolationParams ?? undefined,
          prepareParams: {
            bucket: renderTargetEntries,
            bucketBuffers,
            imageResources,
            imageHandleBuffers,
            resolvedScaling,
            clipContext,
            baseMetersPerPixel,
            drawingBufferWidth,
            drawingBufferHeight,
            pixelRatio,
            identityScaleX,
            identityScaleY,
            identityOffsetX,
            identityOffsetY,
            screenToClipScaleX,
            screenToClipScaleY,
            screenToClipOffsetX,
            screenToClipOffsetY,
          },
        });
        hasActiveInterpolation =
          processResult.interpolationResult.hasActiveInterpolation;
        const preparedItems = processResult.preparedItems;

        const preparedByImage = new Map<
          InternalSpriteImageState,
          PreparedDrawSpriteImageParams<T>
        >();
        for (const prepared of preparedItems) {
          preparedByImage.set(prepared.imageEntry, prepared);
        }

        const resolveLineAnchorCenter = (
          prepared: PreparedDrawSpriteImageParams<T>
        ): SpriteScreenPoint | null => {
          const corners = prepared.hitTestCorners;
          if (corners && corners.length === 4) {
            let x = 0;
            let y = 0;
            for (const corner of corners) {
              x += corner.x;
              y += corner.y;
            }
            return { x: x / 4, y: y / 4 };
          }
          const billboard = prepared.billboardUniforms;
          if (billboard) {
            return { x: billboard.center.x, y: billboard.center.y };
          }
          return null;
        };

        const leaderLineEntries: Array<{
          from: SpriteScreenPoint;
          to: SpriteScreenPoint;
          color: RgbaColor;
          width: number;
        }> = [];

        for (const prepared of preparedItems) {
          const leader = prepared.imageEntry.leaderLine;
          if (!leader) {
            continue;
          }
          const originIndex = prepared.imageEntry.originRenderTargetIndex;
          if (
            originIndex === SPRITE_ORIGIN_REFERENCE_INDEX_NONE ||
            originIndex < 0 ||
            originIndex >= renderTargetEntries.length
          ) {
            continue;
          }
          const originEntry = renderTargetEntries[originIndex];
          if (!originEntry) {
            continue;
          }
          const [, originImage] = originEntry;
          const originPrepared = preparedByImage.get(originImage);
          if (!originPrepared) {
            continue;
          }
          const from = resolveLineAnchorCenter(prepared);
          const to = resolveLineAnchorCenter(originPrepared);
          if (!from || !to) {
            continue;
          }
          const width = prepared.imageEntry.leaderLinePixelWidth;
          if (!Number.isFinite(width) || width <= 0) {
            continue;
          }
          const alpha = clampOpacity(leader.rgba[3] * prepared.opacity);
          if (alpha <= 0) {
            continue;
          }
          const color: RgbaColor = [
            leader.rgba[0],
            leader.rgba[1],
            leader.rgba[2],
            alpha,
          ];
          leaderLineEntries.push({ from, to, color, width });
        }

        if (leaderLineEntries.length > 0) {
          if (!leaderLineRenderer) {
            leaderLineRenderer = createLeaderLineRenderer(glContext);
          }
          if (leaderLineRenderer) {
            leaderLineRenderer.begin(
              screenToClipScaleX,
              screenToClipScaleY,
              screenToClipOffsetX,
              screenToClipOffsetY
            );
            for (const entry of leaderLineEntries) {
              leaderLineRenderer.drawLine(
                entry.from,
                entry.to,
                entry.color,
                entry.width
              );
            }
            leaderLineRenderer.end();
          }
        }

        drawProgram.beginFrame();
        drawProgram.uploadVertexBatch(preparedItems);

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
            drawPreparedSprite(prepared);
          }
        }
      } else if (interpolationParams) {
        const calculationHost = ensureCalculationHost();
        const processResult = calculationHost.processDrawSpriteImages({
          interpolationParams,
        });
        hasActiveInterpolation =
          processResult.interpolationResult.hasActiveInterpolation;
      }

      if (hasActiveInterpolation && interpolationCalculationEnabled) {
        scheduleRender();
      }

      const borderEntries = hitTestController
        .getHitTestEntries()
        .filter((entry) => entry.image.border);
      if (borderEntries.length > 0) {
        if (!borderOutlineRenderer) {
          borderOutlineRenderer = createBorderOutlineRenderer(glContext);
        }
        if (borderOutlineRenderer) {
          borderOutlineRenderer.begin(
            screenToClipScaleX,
            screenToClipScaleY,
            screenToClipOffsetX,
            screenToClipOffsetY
          );
          for (const entry of borderEntries) {
            const border = entry.image.border;
            if (!border) {
              continue;
            }
            const effectiveAlpha = clampOpacity(
              border.rgba[3] * entry.image.finalOpacity.current
            );
            if (effectiveAlpha <= 0) {
              continue;
            }
            const borderColor: RgbaColor = [
              border.rgba[0],
              border.rgba[1],
              border.rgba[2],
              effectiveAlpha,
            ];
            const width = entry.image.borderPixelWidth;
            if (!Number.isFinite(width) || width <= 0) {
              continue;
            }
            borderOutlineRenderer.drawOutline(
              entry.corners,
              borderColor,
              width
            );
          }
          borderOutlineRenderer.end();
        }
      }
    } finally {
      releaseCalculationHost();
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
            hitTestController.removeImageBounds(imageState);
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
    hitTestController.clearAll();
    ensureRenderTargetEntries();
    scheduleRender();
  };

  /**
   * Returns the identifiers of all registered images and glyphs.
   * @returns {string[]} Array containing every registered imageId.
   */
  const getAllImageIds = (): string[] => Array.from(images.keys());

  /**
   * Returns the identifiers of every sprite registered in the layer.
   * @returns {string[]} Array containing all spriteIds.
   */
  const getAllSpriteIds = (): string[] => Array.from(sprites.keys());

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

    const initialInvalidated = (init.invalidate ?? false) || !isLayerVisible();

    // Build internal image state map.
    const imagesInit = init.images ?? [];
    // Each initial image definition will be normalized into internal state maps below.
    const images = new Map<number, Map<number, InternalSpriteImageState>>();
    for (const imageInit of imagesInit) {
      const state = createImageStateFromInit(
        imageInit,
        imageInit.subLayer,
        imageInit.order,
        originReference,
        initialInvalidated
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

    const spriteVisibilityDistanceMeters = sanitizeVisibilityDistanceMeters(
      init.visibilityDistanceMeters
    );
    const initialInterpolationOptions = init.interpolation
      ? cloneInterpolationOptions(init.interpolation)
      : null;

    const spriteState: InternalSpriteCurrentState<T> = {
      spriteId,
      handle: spriteHandle,
      // Sprites default to enabled unless explicitly disabled in the init payload.
      isEnabled: init.isEnabled ?? true,
      visibilityDistanceMeters: spriteVisibilityDistanceMeters ?? undefined,
      opacityMultiplier: sanitizeOpacityMultiplier(init.opacityMultiplier),
      location: {
        current: currentLocation,
        from: undefined,
        to: undefined,
        invalidated: initialInvalidated,
        interpolation: {
          state: null,
          options: initialInterpolationOptions,
          lastCommandValue: cloneSpriteLocation(currentLocation),
          baseValue: undefined,
          targetValue: undefined,
        },
      },
      images,
      // Tags default to null to simplify downstream comparisons.
      tag: init.tag ?? null,
      lastAutoRotationLocation: cloneSpriteLocation(currentLocation),
      currentAutoRotateDeg: 0,
      autoRotationInvalidated: false,
      interpolationDirty: false,
      cachedMercator: initialMercator,
      cachedMercatorLng: currentLocation.lng,
      cachedMercatorLat: currentLocation.lat,
      cachedMercatorZ: initialAltitude,
    };

    // Store the sprite state.
    sprites.set(spriteId, spriteState);
    spriteIdHandler.store(spriteHandle, spriteState);

    hitTestController.refreshSpriteHitTestBounds(projectionHost, spriteState);

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
        hitTestController.removeImageBounds(image);
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

    hitTestController.clearAll();
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
        hitTestController.removeImageBounds(image);
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
      originReference,
      !isLayerVisible() || sprite.location.invalidated === true,
      sprite.currentAutoRotateDeg
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

    const autoRotationDeg = resolveImageAutoRotationDeg(sprite, state);
    syncImageRotationChannel(state, autoRotationDeg);
    updateImageInterpolationDirtyState(sprite, state);

    setImageState(sprite, state);
    hitTestController.refreshSpriteHitTestBounds(projectionHost, sprite);
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
    const mapCurrentlyVisible = isLayerVisible();
    const interpolationAllowed =
      interpolationCalculationEnabled && mapCurrentlyVisible;
    const resolveAutoRotationDeg = () =>
      resolveImageAutoRotationDeg(sprite, state);

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
    const interpolationOptions = imageUpdate.interpolation;
    const opacityInterpolationOption = interpolationOptions?.finalOpacity;
    if (opacityInterpolationOption !== undefined) {
      state.finalOpacity.interpolation.options =
        opacityInterpolationOption === null
          ? null
          : cloneInterpolationOptions(opacityInterpolationOption);
    }
    const allowOpacityInterpolation =
      interpolationAllowed && !state.finalOpacity.invalidated;
    const resolvedOpacityInterpolationOption = allowOpacityInterpolation
      ? opacityInterpolationOption === undefined
        ? (state.finalOpacity.interpolation.options ?? null)
        : opacityInterpolationOption
      : null;
    if (imageUpdate.opacity !== undefined) {
      // Update opacity; zero values will be filtered out during rendering.
      applyOpacityUpdate(
        state,
        imageUpdate.opacity,
        resolvedOpacityInterpolationOption,
        sprite.opacityMultiplier
      );
      if (mapCurrentlyVisible && state.finalOpacity.invalidated) {
        state.finalOpacity.invalidated = false;
      }
    } else if (opacityInterpolationOption === null) {
      clearOpacityInterpolation(state);
    }
    if (imageUpdate.scale !== undefined) {
      // Adjust image scaling factor applied to dimensions and offsets.
      state.scale = imageUpdate.scale;
    }
    if (imageUpdate.border !== undefined) {
      state.border = resolveSpriteImageLineAttribute(imageUpdate.border);
      state.borderPixelWidth = 0;
    }
    if (imageUpdate.leaderLine !== undefined) {
      state.leaderLine = resolveSpriteImageLineAttribute(
        imageUpdate.leaderLine
      );
      state.leaderLinePixelWidth = 0;
    }
    const prevAutoRotation = state.autoRotation;
    const prevMinDistance = state.autoRotationMinDistanceMeters;

    let shouldReapplyAutoRotation = false;
    let shouldResetResolvedAngle = false;

    if (imageUpdate.anchor !== undefined) {
      state.anchor = cloneAnchor(imageUpdate.anchor);
    }
    // Optional interpolation payloads allow independent control over offset and rotation animations.
    const allowOffsetDegInterpolation =
      interpolationAllowed && !state.offset.offsetDeg.invalidated;
    const allowOffsetMetersInterpolation =
      interpolationAllowed && !state.offset.offsetMeters.invalidated;
    const offsetDegInterpolationOption = allowOffsetDegInterpolation
      ? interpolationOptions?.offsetDeg
      : null;
    const offsetMetersInterpolationOption = allowOffsetMetersInterpolation
      ? interpolationOptions?.offsetMeters
      : null;
    // Pull out finalRotateDeg interpolation hints when the payload includes them.
    const allowRotateInterpolation =
      interpolationAllowed && !state.finalRotateDeg.invalidated;
    const rotateInterpolationOption = allowRotateInterpolation
      ? interpolationOptions?.finalRotateDeg
      : null;
    let rotationOverride: SpriteInterpolationOptions | null | undefined;
    let hasRotationOverride = false;
    const hasOffsetMetersUpdate = imageUpdate.offsetMeters !== undefined;
    const hasOffsetDegUpdate = imageUpdate.offsetDeg !== undefined;
    if (hasOffsetMetersUpdate || hasOffsetDegUpdate) {
      const nextOffset = {
        offsetMeters:
          imageUpdate.offsetMeters ?? state.offset.offsetMeters.current,
        offsetDeg: imageUpdate.offsetDeg ?? state.offset.offsetDeg.current,
      };
      applyOffsetUpdate(state, nextOffset, {
        deg: allowOffsetDegInterpolation ? offsetDegInterpolationOption : null,
        meters: allowOffsetMetersInterpolation
          ? offsetMetersInterpolationOption
          : null,
      });
      if (mapCurrentlyVisible) {
        if (state.offset.offsetDeg.invalidated) {
          state.offset.offsetDeg.invalidated = false;
        }
        if (state.offset.offsetMeters.invalidated) {
          state.offset.offsetMeters.invalidated = false;
        }
      }
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
        state.finalRotateDeg.interpolation.options = null;
        rotationOverride = null;
      } else {
        const cloned = cloneInterpolationOptions(rotateInterpolationOption);
        state.finalRotateDeg.interpolation.options = cloned;
        rotationOverride = cloned;
      }
      hasRotationOverride = true;
    }
    let requireRotationSync = false;
    if (imageUpdate.rotateDeg !== undefined) {
      const nextRotation = normalizeAngleDeg(imageUpdate.rotateDeg);
      const targetDisplayed = normalizeAngleDeg(
        resolveAutoRotationDeg() + nextRotation
      );
      state.finalRotateDeg.from = state.finalRotateDeg.current;
      state.finalRotateDeg.to = targetDisplayed;
      state.rotateDeg = nextRotation;
      requireRotationSync = true;
    } else if (hasRotationOverride) {
      requireRotationSync = true;
    }
    if (imageUpdate.autoRotation !== undefined) {
      state.autoRotation = imageUpdate.autoRotation;
      if (imageUpdate.autoRotation) {
        if (!prevAutoRotation) {
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
      requireRotationSync = true;
    }

    if (shouldReapplyAutoRotation) {
      const applied = applyAutoRotation(sprite, sprite.location.current, true);
      if (!applied && state.autoRotation) {
        requireRotationSync = true;
      }
    }

    if (requireRotationSync) {
      const autoRotationDeg = resolveAutoRotationDeg();
      // Ensure displayed angle reflects the latest base rotation and overrides.
      syncImageRotationChannel(
        state,
        autoRotationDeg,
        // When a rotation override has been computed, pass it along (null clears interpolation); otherwise leave undefined.
        interpolationAllowed
          ? hasRotationOverride
            ? (rotationOverride ?? null)
            : undefined
          : null
      );
      if (mapCurrentlyVisible && state.finalRotateDeg.invalidated) {
        state.finalRotateDeg.invalidated = false;
      }
    }

    updateImageInterpolationDirtyState(sprite, state);

    hitTestController.refreshSpriteHitTestBounds(projectionHost, sprite);

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
      hitTestController.removeImageBounds(state);
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

    if (update.visibilityDistanceMeters !== undefined) {
      const resolved = sanitizeVisibilityDistanceMeters(
        update.visibilityDistanceMeters
      );
      const previousVisibilityDistance = sprite.visibilityDistanceMeters;
      if (previousVisibilityDistance !== resolved) {
        sprite.visibilityDistanceMeters = resolved ?? undefined;
        updated = true;
        isRequiredRender = true;
        if (
          previousVisibilityDistance !== undefined &&
          (resolved === undefined || resolved === null)
        ) {
          sprite.images.forEach((orderMap) => {
            orderMap.forEach((image) => {
              const baseOpacity =
                image.finalOpacity.interpolation.baseValue ??
                image.finalOpacity.current;
              if (!(Number.isFinite(baseOpacity) && baseOpacity > 0)) {
                return;
              }
              if (image.finalOpacity.current > 0) {
                return;
              }
              image.lodOpacity = 1;
              applyOpacityUpdate(
                image,
                baseOpacity,
                image.finalOpacity.interpolation.options,
                sprite.opacityMultiplier
              );
            });
          });
        }
      }
    }

    if (update.opacityMultiplier !== undefined) {
      const nextMultiplier = sanitizeOpacityMultiplier(
        update.opacityMultiplier
      );
      if (nextMultiplier !== sprite.opacityMultiplier) {
        sprite.opacityMultiplier = nextMultiplier;
        reapplySpriteOpacityMultiplier(sprite);
        updated = true;
        isRequiredRender = true;
      }
    }

    const locationState = sprite.location;
    const locationInterpolation = locationState.interpolation;

    let interpolationOptionsForLocation:
      | SpriteInterpolationOptions
      | null
      | undefined = undefined;
    let interpolationExplicitlySpecified = false;
    const mapCurrentlyVisible = isLayerVisible();
    const interpolationAllowed =
      interpolationCalculationEnabled &&
      mapCurrentlyVisible &&
      !locationState.invalidated;

    if (update.interpolation !== undefined) {
      interpolationExplicitlySpecified = true;
      if (update.interpolation === null) {
        // Explicit null clears any pending animations so the sprite snaps instantly.
        if (
          locationInterpolation.state !== null ||
          locationState.from !== undefined ||
          locationState.to !== undefined
        ) {
          locationInterpolation.state = null;
          locationInterpolation.options = null;
          locationState.from = undefined;
          locationState.to = undefined;
          updated = true;
        }
        interpolationOptionsForLocation = null;
      } else {
        const nextOptions = cloneInterpolationOptions(update.interpolation);
        // Replace the cached interpolation configuration only when a parameter changed.
        if (
          !locationInterpolation.options ||
          locationInterpolation.options.durationMs !== nextOptions.durationMs ||
          locationInterpolation.options.mode !== nextOptions.mode ||
          locationInterpolation.options.easing !== nextOptions.easing
        ) {
          locationInterpolation.options = nextOptions;
          updated = true;
        }
        interpolationOptionsForLocation = nextOptions;
      }
    }

    if (update.location !== undefined) {
      const newCommandLocation = cloneSpriteLocation(update.location);
      const locationChanged = !spriteLocationsEqual(
        locationInterpolation.lastCommandValue,
        newCommandLocation
      );

      const optionsForLocation = interpolationExplicitlySpecified
        ? // When new interpolation parameters accompanied the update, prefer them (or null to disable).
          (interpolationOptionsForLocation ?? null)
        : // Otherwise reuse any previously interpolation request.
          locationInterpolation.options;

      const effectiveOptions =
        // Treat `undefined` as "no interpolation change" whereas explicit `null` disables interpolation.
        !interpolationAllowed || optionsForLocation === undefined
          ? null
          : optionsForLocation;

      let handledByInterpolation = false;

      if (effectiveOptions && effectiveOptions.durationMs > 0) {
        // Create a fresh interpolation whenever a timed move is requested.
        const { state, requiresInterpolation } =
          createLocationInterpolationState({
            currentLocation: locationState.current,
            lastCommandLocation: locationInterpolation.lastCommandValue,
            nextCommandLocation: newCommandLocation,
            options: effectiveOptions,
          });

        // Clear any stale state before deciding whether to reuse it.
        locationInterpolation.state = null;

        if (requiresInterpolation) {
          // Store the interpolation so the render loop can advance it over time.
          locationInterpolation.state = state;
          locationInterpolation.options = effectiveOptions;
          locationState.from = cloneSpriteLocation(state.from);
          locationState.to = cloneSpriteLocation(state.to);
          locationState.current = cloneSpriteLocation(state.from);
          handledByInterpolation = true;
          updated = true;
          isRequiredRender = true;
        }
      }

      locationInterpolation.lastCommandValue =
        cloneSpriteLocation(newCommandLocation);

      if (handledByInterpolation) {
        // Interpolation will animate towards the destination; the current location already set to start.
      } else if (locationChanged) {
        // Without interpolation, move immediately to the requested location and mark for redraw.
        locationState.current = cloneSpriteLocation(newCommandLocation);
        locationState.from = undefined;
        locationState.to = undefined;
        locationInterpolation.state = null;
        updated = true;
        isRequiredRender = true;
      } else {
        // Location unchanged: clear transient interpolation state so future updates start cleanly.
        locationInterpolation.state = null;
        locationState.from = undefined;
        locationState.to = undefined;
      }

      if (mapCurrentlyVisible && locationState.invalidated) {
        locationState.invalidated = false;
      }

      if (!mapCurrentlyVisible) {
        sprite.autoRotationInvalidated = true;
        sprite.lastAutoRotationLocation =
          cloneSpriteLocation(newCommandLocation);
      } else {
        const forceAutoRotation = sprite.autoRotationInvalidated;
        sprite.autoRotationInvalidated = false;
        // Auto-rotation should react immediately to the most recent command location.
        applyAutoRotation(sprite, newCommandLocation, forceAutoRotation);
      }
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
      hitTestController.refreshSpriteHitTestBounds(projectionHost, sprite);
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
        visibilityDistanceMeters: undefined,
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
        updateObject.visibilityDistanceMeters = undefined;
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
        updateObject.visibilityDistanceMeters = undefined;
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

  const setInterpolationCalculation = (moveable: boolean): void => {
    const realTimestamp = now();
    // Advance the interpolation clock to the moment of the toggle so progress up to
    // this call is preserved.
    resolveInterpolationTimestamp(realTimestamp);
    interpolationCalculationEnabled = moveable;
    resetInterpolationTimestampAnchor(realTimestamp);
    if (moveable) {
      scheduleRender();
    }
  };

  const setHitTestDetection = (detect: boolean): void => {
    const changed = hitTestController.setHitTestDetection(detect);
    if (!changed || !detect || !map) {
      return;
    }

    const projectionHost = createProjectionHostForMap(map);
    try {
      sprites.forEach((sprite) => {
        hitTestController.refreshSpriteHitTestBounds(projectionHost, sprite);
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
    getAllSpriteIds,
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
    setInterpolationCalculation,
    setHitTestDetection,
    trackSprite,
    untrackSprite,
    on: mouseEventsController.addEventListener,
    off: mouseEventsController.removeEventListener,
  };

  return spriteLayout;
};
