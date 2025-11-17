// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { Map as MapLibreMap } from 'maplibre-gl';
import { normalizeAngleDeg } from '../interpolation/rotationInterpolation';
import {
  calculateBillboardCenterPosition,
  calculateBillboardCornerScreenPositions,
  calculateMetersPerPixelAtLatitude,
  calculateEffectivePixelsPerMeter,
  calculateSurfaceCenterPosition,
  calculateSurfaceCornerDisplacements,
  calculateSurfaceOffsetMeters,
  calculateSurfaceWorldDimensions,
  calculateBillboardDepthKey,
  calculateSurfaceDepthKey,
  applySurfaceDisplacement,
  clipToScreen,
  type ProjectToClipSpaceFn,
  type UnprojectPointFn,
  multiplyMatrixAndVector,
  isFiniteNumber,
  computeSurfaceCornerShaderModel,
  type SurfaceCorner,
  type QuadCorner,
  calculateZoomScaleFactor,
  resolveScalingOptions,
  resolveSpriteMercator,
  cloneSpriteLocation,
  calculateCartesianDistanceMeters,
  clampOpacity,
} from '../utils/math';
import {
  BILLBOARD_BASE_CORNERS,
  SURFACE_BASE_CORNERS,
  QUAD_VERTEX_SCRATCH,
  computeBillboardCornersShaderModel,
} from '../gl/shader';
import type {
  DistanceInterpolationEvaluationParams,
  DistanceInterpolationEvaluationResult,
  DegreeInterpolationEvaluationParams,
  DegreeInterpolationEvaluationResult,
  InternalSpriteCurrentState,
  InternalSpriteImageState,
  ImageResourceTable,
  RegisteredImage,
  SurfaceShaderInputs,
  ClipContext,
  ProjectionHost,
  PreparedDrawSpriteImageParams,
  PrepareDrawSpriteImageParams,
  RenderCalculationHost,
  MutableSpriteScreenPoint,
  PrepareDrawSpriteImageParamsBefore,
  PrepareDrawSpriteImageParamsAfter,
  RenderTargetEntryLike,
  RenderInterpolationParams,
  RenderInterpolationResult,
  ProcessDrawSpriteImagesParams,
  ProcessDrawSpriteImagesResult,
  SpriteInterpolationEvaluationParams,
  SpriteInterpolationEvaluationResult,
  SpriteInterpolationState,
} from '../internalTypes';
import { SPRITE_ORIGIN_REFERENCE_INDEX_NONE } from '../internalTypes';
import type {
  SpriteAnchor,
  SpriteLocation,
  SpritePoint,
  SpriteScreenPoint,
  SpriteImageOffset,
} from '../types';
import { createMapLibreProjectionHost } from './mapLibreProjectionHost';
import {
  createProjectionHost,
  type ProjectionHostParams,
} from './projectionHost';
import {
  DEFAULT_ANCHOR,
  DEFAULT_IMAGE_OFFSET,
  DEG2RAD,
  EPS_NDC,
  MIN_CLIP_W,
  MIN_CLIP_Z_EPSILON,
  ORDER_BUCKET,
  ORDER_MAX,
  TRIANGLE_INDICES,
  UV_CORNERS,
} from '../const';
import {
  ENABLE_NDC_BIAS_SURFACE,
  SL_DEBUG,
  USE_SHADER_BILLBOARD_GEOMETRY,
  USE_SHADER_SURFACE_GEOMETRY,
} from '../config';
import { createWasmProjectionHost } from './wasmProjectionHost';
import {
  collectDistanceInterpolationWorkItems,
  applyDistanceInterpolationEvaluations,
  evaluateDistanceInterpolation,
  createDistanceInterpolationState,
  type DistanceInterpolationWorkItem,
} from '../interpolation/distanceInterpolation';
import {
  collectDegreeInterpolationWorkItems,
  applyDegreeInterpolationEvaluations,
  evaluateDegreeInterpolation,
  type DegreeInterpolationWorkItem,
} from '../interpolation/degreeInterpolation';
import { evaluateInterpolation } from '../interpolation/interpolation';
import {
  stepSpriteImageInterpolations,
  type ImageInterpolationStepperId,
} from '../interpolation/interpolationChannels';

const resolveImageOffset = (
  image: Readonly<InternalSpriteImageState>
): SpriteImageOffset => {
  const offset = image.offset;
  if (!offset) {
    return { ...DEFAULT_IMAGE_OFFSET };
  }
  return {
    offsetMeters: offset.offsetMeters.current,
    offsetDeg: offset.offsetDeg.current,
  };
};

const calculateBorderWidthPixels = (
  widthMeters: number | undefined,
  imageScale: number,
  zoomScaleFactor: number,
  effectivePixelsPerMeter: number,
  sizeScaleAdjustment: number
): number => {
  if (
    widthMeters === undefined ||
    !Number.isFinite(widthMeters) ||
    widthMeters <= 0
  ) {
    return 0;
  }
  if (
    !Number.isFinite(effectivePixelsPerMeter) ||
    effectivePixelsPerMeter <= 0
  ) {
    return 0;
  }
  const scaledWidthMeters =
    widthMeters * imageScale * zoomScaleFactor * sizeScaleAdjustment;
  if (!Number.isFinite(scaledWidthMeters) || scaledWidthMeters <= 0) {
    return 0;
  }
  return scaledWidthMeters * effectivePixelsPerMeter;
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Cache entry storing anchor-adjusted and raw centers for a sprite image.
 */
interface ImageCenterCacheEntry {
  readonly anchorApplied?: SpritePoint;
  readonly anchorless?: SpritePoint;
}

/**
 * Nested cache keyed by sprite ID and image key to avoid recomputing centers each frame.
 */
type ImageCenterCache = Map<string, Map<string, ImageCenterCacheEntry>>;

/**
 * Resolves the image entry that a sprite should use as its origin reference when
 * another image in the same render bucket needs to inherit that origin.
 * The resolver is always invoked with the current sprite/image pair and can
 * return `null` when the origin is not available (e.g., the reference was
 * culled or stored in another bucket).
 */
type OriginImageResolver<T> = (
  sprite: Readonly<InternalSpriteCurrentState<T>>,
  image: Readonly<InternalSpriteImageState>
) => InternalSpriteImageState | undefined;

export const DEFAULT_RENDER_INTERPOLATION_RESULT: RenderInterpolationResult = {
  handled: false,
  hasActiveInterpolation: false,
};

const OPACITY_TARGET_EPSILON = 1e-4;

interface DepthSortedItem<T> {
  readonly sprite: InternalSpriteCurrentState<T>;
  readonly image: InternalSpriteImageState;
  readonly resource: Readonly<RegisteredImage>;
  readonly depthKey: number;
  readonly resolveOrigin: OriginImageResolver<T>;
}

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Creates a resolver that can look up origin reference images within a specific
 * render bucket. Each sprite image stores the index of the entry whose origin
 * data it depends on, so the resulting resolver simply dereferences that index
 * with additional validation to ensure the bucket still contains the expected
 * sprite/image pair.
 *
 * @param bucket - Ordered list of sprite/image pairs scheduled for rendering.
 * @returns Function that returns the origin image entry or `null` if it cannot
 *   be resolved safely.
 */
const createBucketOriginResolver = <T>(
  bucket: readonly Readonly<RenderTargetEntryLike<T>>[]
): OriginImageResolver<T> => {
  return (sprite, image) => {
    // Data-driven origin references store the bucket index directly on the image entry.
    const index = image.originRenderTargetIndex;
    if (
      index === SPRITE_ORIGIN_REFERENCE_INDEX_NONE ||
      index < 0 ||
      index >= bucket.length
    ) {
      // Missing index or out-of-bounds reference -> origin cannot be resolved.
      return undefined;
    }
    const entry = bucket[index];
    if (!entry) {
      // Bucket holes should not happen, but guard to avoid undefined access.
      return undefined;
    }
    const [resolvedSprite, resolvedImage] = entry;
    if (resolvedSprite !== sprite) {
      // A stale index referencing another sprite is treated as unresolved.
      return undefined;
    }
    return resolvedImage;
  };
};

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

export const collectDepthSortedItemsInternal = <T>(
  projectionHost: ProjectionHost,
  zoom: number,
  zoomScaleFactor: number,
  originCenterCache: ImageCenterCache,
  {
    bucket,
    bucketBuffers,
    imageResources,
    clipContext,
    baseMetersPerPixel,
    spriteMinPixel,
    spriteMaxPixel,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio,
  }: PrepareDrawSpriteImageParamsBefore<T>
): DepthSortedItem<T>[] => {
  const itemsWithDepth: DepthSortedItem<T>[] = [];

  const projectToClipSpace: ProjectToClipSpaceFn = (location) =>
    projectLngLatToClipSpace(projectionHost, location, clipContext);

  const unprojectPoint: UnprojectPointFn = (point: SpriteScreenPoint) => {
    return projectionHost.unproject(point);
  };

  if (
    bucketBuffers &&
    (bucketBuffers.originReferenceKeys.length !== bucket.length ||
      bucketBuffers.originTargetIndices.length !== bucket.length)
  ) {
    throw new Error('bucketBuffers length mismatch');
  }

  const resolveOrigin = createBucketOriginResolver(bucket);

  for (const [spriteEntry, imageEntry] of bucket) {
    const imageResource = imageResources[imageEntry.imageHandle];
    if (!imageResource || !imageResource.texture) {
      continue;
    }

    const projected = projectionHost.project(spriteEntry.location.current);
    if (!projected) {
      continue;
    }

    const spriteMercator = resolveSpriteMercator(projectionHost, spriteEntry);
    const metersPerPixelAtLat = calculateMetersPerPixelAtLatitude(
      zoom,
      spriteEntry.location.current.lat
    );
    if (!Number.isFinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0) {
      continue;
    }

    const perspectiveRatio = projectionHost.calculatePerspectiveRatio(
      spriteEntry.location.current,
      spriteMercator
    );
    const effectivePixelsPerMeter = calculateEffectivePixelsPerMeter(
      metersPerPixelAtLat,
      perspectiveRatio
    );
    if (effectivePixelsPerMeter <= 0) {
      continue;
    }

    const centerParams: ComputeImageCenterParams<T> = {
      projectionHost,
      imageResources,
      originCenterCache,
      projected,
      baseMetersPerPixel,
      spriteMinPixel,
      spriteMaxPixel,
      effectivePixelsPerMeter,
      zoomScaleFactor,
      drawingBufferWidth,
      drawingBufferHeight,
      pixelRatio,
      clipContext,
      resolveOrigin,
    };

    const anchorResolved = imageEntry.anchor ?? DEFAULT_ANCHOR;
    const offsetResolved = resolveImageOffset(imageEntry);

    const depthCenter = computeImageCenterXY(
      spriteEntry,
      imageEntry,
      centerParams,
      true
    );

    let depthKey: number | undefined;

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
        : normalizeAngleDeg(
            (imageEntry.resolvedBaseRotateDeg ?? 0) +
              imageEntry.rotationCommandDeg
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
          const refImg = resolveOrigin(spriteEntry, imageEntry);
          if (refImg) {
            const baseCenter = computeImageCenterXY(
              spriteEntry,
              refImg,
              centerParams,
              imageEntry.originLocation.useResolvedAnchor ?? false
            );
            const baseLngLatLike = projectionHost.unproject(baseCenter);
            if (baseLngLatLike) {
              return baseLngLatLike;
            }
          }
        }
        return spriteEntry.location.current;
      })();

      const surfaceDepth = calculateSurfaceDepthKey(
        baseLngLat,
        cornerDisplacements,
        projectToClipSpace,
        {
          biasFn: ENABLE_NDC_BIAS_SURFACE
            ? ({ clipZ, clipW }) => {
                const orderIndex = Math.min(imageEntry.order, ORDER_MAX - 1);
                const biasIndex =
                  imageEntry.subLayer * ORDER_BUCKET + orderIndex;
                const biasNdc = -(biasIndex * EPS_NDC);
                const biasedClipZ = clipZ + biasNdc * clipW;
                const minClipZ = -clipW + MIN_CLIP_Z_EPSILON;
                return {
                  clipZ: biasedClipZ < minClipZ ? minClipZ : biasedClipZ,
                  clipW,
                };
              }
            : undefined,
        }
      );

      if (surfaceDepth === undefined) {
        continue;
      }
      depthKey = surfaceDepth;
    } else {
      const billboardDepth = calculateBillboardDepthKey(
        depthCenter,
        unprojectPoint,
        projectToClipSpace
      );
      if (billboardDepth === undefined) {
        continue;
      }
      depthKey = billboardDepth;
    }

    itemsWithDepth.push({
      sprite: spriteEntry,
      image: imageEntry,
      resource: imageResource,
      depthKey,
      resolveOrigin,
    });
  }

  itemsWithDepth.sort((a, b) => {
    if (a.depthKey !== b.depthKey) {
      return a.depthKey - b.depthKey;
    }
    if (a.image.order !== b.image.order) {
      return a.image.order - b.image.order;
    }
    const spriteCompare = a.sprite.spriteId.localeCompare(b.sprite.spriteId);
    if (spriteCompare !== 0) {
      return spriteCompare;
    }
    return a.image.imageId.localeCompare(b.image.imageId);
  });

  return itemsWithDepth;
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Projects a longitude/latitude/elevation tuple into clip space using the provided context.
 * @param {number} lng - Longitude in degrees.
 * @param {number} lat - Latitude in degrees.
 * @param {number} elevationMeters - Elevation above the ellipsoid in meters.
 * @param {ClipContext | undefined} context - Clip-space context; `undefined` skips projection.
 * @returns {[number, number, number, number] | undefined} Clip coordinates or `undefined` when projection fails.
 */
const projectLngLatToClipSpace = (
  projectionHost: ProjectionHost,
  location: Readonly<SpriteLocation>,
  context: Readonly<ClipContext> | undefined
): [number, number, number, number] | undefined => {
  if (!context) {
    return undefined;
  }
  const { mercatorMatrix } = context;
  const coord = projectionHost.fromLngLat(location);
  const [clipX, clipY, clipZ, clipW] = multiplyMatrixAndVector(
    mercatorMatrix,
    coord.x,
    coord.y,
    coord.z,
    1
  );
  if (!isFiniteNumber(clipW) || clipW <= MIN_CLIP_W) {
    return undefined;
  }
  return [clipX, clipY, clipZ, clipW];
};

/**
 * Parameters required to determine an image center in screen space.
 */
interface ComputeImageCenterParams<T> {
  readonly projectionHost: ProjectionHost;
  readonly imageResources: ImageResourceTable;
  readonly originCenterCache: ImageCenterCache;
  readonly projected: Readonly<SpriteScreenPoint>;
  readonly baseMetersPerPixel: number;
  readonly spriteMinPixel: number;
  readonly spriteMaxPixel: number;
  readonly effectivePixelsPerMeter: number;
  readonly zoomScaleFactor: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly pixelRatio: number;
  readonly clipContext: Readonly<ClipContext> | undefined;
  readonly resolveOrigin: OriginImageResolver<T>;
}

/**
 * Computes the screen-space center of an image, caching anchor-dependent results.
 * @template T Sprite tag type.
 * @param {InternalSpriteCurrentState<T>} sprite - Sprite that owns the image.
 * @param {InternalSpriteImageState} image - Image state to evaluate.
 * @param {ComputeImageCenterParams} params - Precomputed scaling and projection context.
 * @param {boolean} useResolvedAnchor - When true, returns the anchor-applied center.
 * @returns {SpriteScreenPoint} Screen-space coordinates for the requested center variant.
 */
const computeImageCenterXY = <T>(
  sprite: Readonly<InternalSpriteCurrentState<T>>,
  image: Readonly<InternalSpriteImageState>,
  params: ComputeImageCenterParams<T>,
  useResolvedAnchor: boolean
): SpriteScreenPoint => {
  const {
    originCenterCache,
    projected,
    baseMetersPerPixel,
    spriteMinPixel,
    spriteMaxPixel,
    effectivePixelsPerMeter,
    zoomScaleFactor,
    imageResources,
    projectionHost,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio,
    clipContext,
    resolveOrigin,
  } = params;

  let spriteCache = originCenterCache.get(sprite.spriteId);
  if (!spriteCache) {
    // Initialize a new cache bucket for this sprite when none exists yet.
    spriteCache = new Map<string, ImageCenterCacheEntry>();
    originCenterCache.set(sprite.spriteId, spriteCache);
  }

  const cacheKey = `${image.subLayer}:${image.order}`;
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

  let base: Readonly<SpriteScreenPoint> = projected;
  if (image.originLocation !== undefined) {
    const ref = resolveOrigin(sprite, image);
    if (ref) {
      const refCenter = computeImageCenterXY(
        sprite,
        ref,
        params,
        useResolvedAnchor
      );
      base = refCenter;
    }
  }

  const totalRotDeg = Number.isFinite(image.displayedRotateDeg)
    ? image.displayedRotateDeg
    : normalizeAngleDeg(
        (image.resolvedBaseRotateDeg ?? 0) + image.rotationCommandDeg
      );
  const imageScaleLocal = image.scale ?? 1;
  const imageResourceRef = imageResources[image.imageHandle];

  if (image.mode === 'billboard') {
    const placement = calculateBillboardCenterPosition({
      base,
      imageWidth: imageResourceRef?.width,
      imageHeight: imageResourceRef?.height,
      baseMetersPerPixel,
      imageScale: imageScaleLocal,
      zoomScaleFactor,
      effectivePixelsPerMeter,
      spriteMinPixel,
      spriteMaxPixel,
      totalRotateDeg: totalRotDeg,
      anchor: image.anchor,
      offset: resolveImageOffset(image),
    });
    // Center used when the anchor is resolved to the provided anchor point.
    const anchorApplied: SpritePoint = placement.center;
    // Origin fallback before anchor offsets are applied; used by callers referencing anchorless placement.
    const anchorless: SpritePoint = {
      x: anchorApplied.x + placement.anchorShift.x,
      y: anchorApplied.y - placement.anchorShift.y,
    };
    // Reuse cached entry to avoid repeated allocations.
    const entry = cachedEntry ?? { anchorless, anchorApplied };
    spriteCache.set(cacheKey, entry);
    return useResolvedAnchor ? anchorApplied : anchorless;
  }

  const baseLngLat: SpriteLocation =
    image.originLocation !== undefined
      ? // When anchored to another image, reproject the 2D reference point back to geographic space.
        (projectionHost.unproject(base) ?? sprite.location.current)
      : // Otherwise use the sprite's own interpolated geographic location.
        sprite.location.current;

  const projectToClipSpace: ProjectToClipSpaceFn | undefined = clipContext
    ? (location) =>
        projectLngLatToClipSpace(projectionHost, location, clipContext)
    : undefined;

  const surfacePlacement = calculateSurfaceCenterPosition({
    baseLngLat,
    imageWidth: imageResourceRef?.width,
    imageHeight: imageResourceRef?.height,
    baseMetersPerPixel,
    imageScale: imageScaleLocal,
    zoomScaleFactor,
    totalRotateDeg: totalRotDeg,
    anchor: image.anchor,
    offset: resolveImageOffset(image),
    effectivePixelsPerMeter,
    spriteMinPixel,
    spriteMaxPixel,
    projectToClipSpace,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio,
    resolveAnchorless: true,
    project: projectToClipSpace ? undefined : projectionHost.project,
  });

  // If the anchorless placement could not be projected, fall back to the original screen position.
  const anchorlessCenter = surfacePlacement.anchorlessCenter ?? base;
  // If the anchor-aware placement fails, reuse the anchorless center to keep the sprite visible.
  const anchorAppliedCenter = surfacePlacement.center ?? anchorlessCenter;

  // Cache the computed centers so repeated lookups in this frame avoid recomputation.
  const entry = cachedEntry ?? {
    anchorless: anchorlessCenter,
    anchorApplied: anchorAppliedCenter,
  };
  spriteCache.set(cacheKey, entry);
  // Respect the caller's anchor preference when selecting the cached center.
  return useResolvedAnchor ? anchorAppliedCenter : anchorlessCenter;
};

const CORNER_EAST: SurfaceCorner = { east: 1, north: 0 } as const;
const CORNER_NORTH: SurfaceCorner = { east: 0, north: 1 } as const;

const calculateWorldToMercatorScale = (
  projectionHost: ProjectionHost,
  base: Readonly<SpriteLocation>
): SurfaceCorner => {
  const origin = projectionHost.fromLngLat(base);
  const eastLngLat = applySurfaceDisplacement(base, CORNER_EAST);
  const eastCoord = projectionHost.fromLngLat(eastLngLat);
  const northLngLat = applySurfaceDisplacement(base, CORNER_NORTH);
  const northCoord = projectionHost.fromLngLat(northLngLat);
  return {
    east: eastCoord.x - origin.x,
    north: northCoord.y - origin.y,
  };
};

//////////////////////////////////////////////////////////////////////////////////////

interface PrepareSurfaceShaderInputsParams {
  readonly baseLngLat: Readonly<SpriteLocation>;
  readonly worldWidthMeters: number;
  readonly worldHeightMeters: number;
  readonly anchor: Readonly<SpriteAnchor>;
  readonly totalRotateDeg: number;
  readonly offsetMeters: Readonly<{ east: number; north: number }>;
  readonly displacedCenter: Readonly<SpriteLocation>;
  readonly depthBiasNdc: number;
  readonly scaleAdjustment: number;
  readonly centerDisplacement: Readonly<SurfaceCorner>;
}

const prepareSurfaceShaderInputs = (
  projectionHost: ProjectionHost,
  params: PrepareSurfaceShaderInputsParams
): SurfaceShaderInputs => {
  const {
    baseLngLat,
    worldWidthMeters,
    worldHeightMeters,
    anchor,
    totalRotateDeg,
    offsetMeters,
    displacedCenter,
    depthBiasNdc,
    scaleAdjustment,
    centerDisplacement,
  } = params;

  const halfSizeMeters = {
    east: worldWidthMeters / 2,
    north: worldHeightMeters / 2,
  };
  const rotationRad = -totalRotateDeg * DEG2RAD;
  const sinR = Math.sin(rotationRad);
  const cosR = Math.cos(rotationRad);

  const mercatorCenter = projectionHost.fromLngLat(displacedCenter);

  const worldToMercatorScale = calculateWorldToMercatorScale(
    projectionHost,
    displacedCenter
  );

  const cornerModel = computeSurfaceCornerShaderModel({
    baseLngLat,
    worldWidthMeters,
    worldHeightMeters,
    anchor,
    totalRotateDeg,
    offsetMeters,
  });

  return {
    mercatorCenter: {
      x: mercatorCenter.x,
      y: mercatorCenter.y,
      z: mercatorCenter.z ?? 0,
    },
    worldToMercatorScale,
    halfSizeMeters,
    anchor,
    offsetMeters: {
      east: offsetMeters.east,
      north: offsetMeters.north,
    },
    sinCos: { sin: sinR, cos: cosR },
    totalRotateDeg,
    depthBiasNdc,
    centerDisplacement: {
      east: centerDisplacement.east,
      north: centerDisplacement.north,
    },
    baseLngLat,
    displacedCenter,
    scaleAdjustment,
    corners: cornerModel.map(
      (corner: { east: number; north: number; lng: number; lat: number }) => ({
        east: corner.east,
        north: corner.north,
        lng: corner.lng,
        lat: corner.lat,
      })
    ),
    clipCenter: { x: 0, y: 0, z: 0, w: 1 },
    clipBasisEast: { x: 0, y: 0, z: 0, w: 0 },
    clipBasisNorth: { x: 0, y: 0, z: 0, w: 0 },
    clipCorners: [],
  };
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Prepares quad data for a single sprite image before issuing the draw call.
 */
export const prepareDrawSpriteImageInternal = <TTag>(
  projectionHost: ProjectionHost,
  item: DepthSortedItem<TTag>,
  zoom: number,
  zoomScaleFactor: number,
  originCenterCache: ImageCenterCache,
  {
    imageResources,
    baseMetersPerPixel,
    spriteMinPixel,
    spriteMaxPixel,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio,
    clipContext,
    identityScaleX,
    identityScaleY,
    identityOffsetX,
    identityOffsetY,
    screenToClipScaleX,
    screenToClipScaleY,
    screenToClipOffsetX,
    screenToClipOffsetY,
  }: PrepareDrawSpriteImageParamsAfter
): PreparedDrawSpriteImageParams<TTag> | null => {
  const spriteEntry = item.sprite;
  const imageEntry = item.image;
  const imageResource = item.resource;
  const resolveOrigin = item.resolveOrigin;
  const atlasU0 = Number.isFinite(imageResource.atlasU0)
    ? imageResource.atlasU0
    : 0;
  const atlasV0 = Number.isFinite(imageResource.atlasV0)
    ? imageResource.atlasV0
    : 0;
  const atlasU1 = Number.isFinite(imageResource.atlasU1)
    ? imageResource.atlasU1
    : 1;
  const atlasV1 = Number.isFinite(imageResource.atlasV1)
    ? imageResource.atlasV1
    : 1;
  const atlasUSpan = atlasU1 - atlasU0;
  const atlasVSpan = atlasV1 - atlasV0;

  const spriteMercator = resolveSpriteMercator(projectionHost, item.sprite);

  // Reset previous frame state so skipped images do not leak stale uniforms.
  imageEntry.surfaceShaderInputs = undefined;
  imageEntry.borderPixelWidth = 0;

  let screenCornerBuffer:
    | [
        SpriteScreenPoint,
        SpriteScreenPoint,
        SpriteScreenPoint,
        SpriteScreenPoint,
      ]
    | null = null;
  let useShaderSurface = false;
  let surfaceClipEnabled = false;
  let resolvedSurfaceShaderInputs: Readonly<SurfaceShaderInputs> | undefined;
  let useShaderBillboard = false;
  let billboardUniforms: {
    center: SpritePoint;
    halfWidth: number;
    halfHeight: number;
    anchor: SpriteAnchor;
    sin: number;
    cos: number;
  } | null = null;
  let screenToClipUniforms = {
    scaleX: identityScaleX,
    scaleY: identityScaleY,
    offsetX: identityOffsetX,
    offsetY: identityOffsetY,
  };
  let borderSizeScaleAdjustment = 1;

  // Use per-image anchor/offset when provided; otherwise fall back to defaults.
  const anchor = imageEntry.anchor ?? DEFAULT_ANCHOR;
  const offsetDef = resolveImageOffset(imageEntry);

  // Prefer the dynamically interpolated rotation when available; otherwise synthesize it from base + manual rotations.
  const totalRotateDeg = Number.isFinite(imageEntry.displayedRotateDeg)
    ? imageEntry.displayedRotateDeg
    : normalizeAngleDeg(
        (imageEntry.resolvedBaseRotateDeg ?? 0) + imageEntry.rotationCommandDeg
      );

  const projected = projectionHost.project(spriteEntry.location.current);
  if (!projected) {
    // Projection may fail when the coordinate exits the viewport.
    return null;
  }

  const metersPerPixelAtLat = calculateMetersPerPixelAtLatitude(
    zoom,
    spriteEntry.location.current.lat
  );
  if (!Number.isFinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0) {
    return null;
  }

  const perspectiveRatio = projectionHost.calculatePerspectiveRatio(
    spriteEntry.location.current,
    spriteMercator
  );

  // Convert meters-per-pixel into pixels-per-meter when valid so scaling remains intuitive.
  const basePixelsPerMeter =
    metersPerPixelAtLat > 0 ? 1 / metersPerPixelAtLat : 0;
  const effectivePixelsPerMeter = calculateEffectivePixelsPerMeter(
    metersPerPixelAtLat,
    perspectiveRatio
  );
  if (effectivePixelsPerMeter <= 0) {
    return null;
  }

  // Input scale defaults to 1 when callers omit it.
  const imageScale = imageEntry.scale ?? 1;

  const centerParams: ComputeImageCenterParams<TTag> = {
    projectionHost,
    imageResources,
    originCenterCache,
    projected,
    baseMetersPerPixel,
    spriteMinPixel,
    spriteMaxPixel,
    effectivePixelsPerMeter,
    zoomScaleFactor,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio,
    clipContext,
    resolveOrigin,
  };

  let baseProjected = { x: projected.x, y: projected.y };
  if (imageEntry.originLocation !== undefined) {
    const refImg = resolveOrigin(spriteEntry, imageEntry);
    if (refImg) {
      // Align this image's base position with the referenced image when available.
      baseProjected = computeImageCenterXY(
        spriteEntry,
        refImg,
        centerParams,
        imageEntry.originLocation.useResolvedAnchor ?? false
      );
    }
  }

  const resolveBaseLocation = (): SpriteLocation => {
    const fallback = spriteEntry.location.current;
    if (imageEntry.originLocation !== undefined) {
      const unprojected = projectionHost.unproject(baseProjected);
      if (unprojected) {
        return {
          lng: unprojected.lng,
          lat: unprojected.lat,
          z: fallback.z ?? unprojected.z ?? 0,
        };
      }
    }
    return {
      lng: fallback.lng,
      lat: fallback.lat,
      z: fallback.z ?? 0,
    };
  };

  const baseLocation = resolveBaseLocation();
  const cameraLocation = projectionHost.getCameraLocation();
  const spriteBaseLocation = spriteEntry.location.current;
  const spriteDistanceLocation: SpriteLocation = {
    lng: spriteBaseLocation.lng,
    lat: spriteBaseLocation.lat,
    z: spriteBaseLocation.z ?? 0,
  };
  const cameraDistanceMeters =
    cameraLocation !== undefined
      ? calculateCartesianDistanceMeters(cameraLocation, spriteDistanceLocation)
      : Number.POSITIVE_INFINITY;

  if (imageEntry.mode === 'surface') {
    screenToClipUniforms = {
      scaleX: identityScaleX,
      scaleY: identityScaleY,
      offsetX: identityOffsetX,
      offsetY: identityOffsetY,
    };
    const baseLngLat = baseLocation;

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
      projectToClipSpace: (location) =>
        projectLngLatToClipSpace(projectionHost, location, clipContext),
      drawingBufferWidth,
      drawingBufferHeight,
      pixelRatio,
      project: clipContext ? undefined : projectionHost.project,
    });

    borderSizeScaleAdjustment = surfaceCenter.worldDimensions.scaleAdjustment;

    if (!surfaceCenter.center) {
      // Projection failed for at least one corner; skip rendering to avoid NaNs.
      return null;
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

    const orderIndex = Math.min(imageEntry.order, ORDER_MAX - 1);
    const depthBiasNdc = ENABLE_NDC_BIAS_SURFACE
      ? -((imageEntry.subLayer * ORDER_BUCKET + orderIndex) * EPS_NDC)
      : 0;

    const displacedCenter = surfaceCenter.displacedLngLat ?? baseLngLat;

    const surfaceShaderInputs = prepareSurfaceShaderInputs(projectionHost, {
      baseLngLat,
      worldWidthMeters: surfaceCenter.worldDimensions.width,
      worldHeightMeters: surfaceCenter.worldDimensions.height,
      anchor,
      totalRotateDeg,
      offsetMeters,
      displacedCenter,
      depthBiasNdc,
      scaleAdjustment: surfaceCenter.worldDimensions.scaleAdjustment,
      centerDisplacement: surfaceCenter.totalDisplacement,
    });
    imageEntry.surfaceShaderInputs = surfaceShaderInputs;

    useShaderSurface = USE_SHADER_SURFACE_GEOMETRY && !!clipContext;
    let clipCornerPositions:
      | Array<[number, number, number, number]>
      | undefined = undefined;
    let clipCenterPosition: [number, number, number, number] | undefined;
    if (useShaderSurface) {
      clipCornerPositions = new Array(SURFACE_BASE_CORNERS.length) as Array<
        [number, number, number, number]
      >;
      clipCenterPosition = projectLngLatToClipSpace(
        projectionHost,
        displacedCenter,
        clipContext
      );
      if (!clipCenterPosition) {
        useShaderSurface = false;
        clipCornerPositions = undefined;
      }
    }

    const hitTestCorners = ensureHitTestCorners(imageEntry);
    const debugClipCorners: Array<[number, number, number, number]> | null =
      SL_DEBUG ? [] : null;
    let bufferOffset = 0;
    // Iterate through each vertex defined by TRIANGLE_INDICES to populate the vertex buffer.
    for (const index of TRIANGLE_INDICES) {
      const displacement = cornerDisplacements[index]!;
      const displaced = applySurfaceDisplacement(baseLngLat, displacement);

      const clipPosition = projectLngLatToClipSpace(
        projectionHost,
        displaced,
        clipContext
      );
      if (!clipPosition) {
        // A vertex left the clip volume; abort drawing this image to prevent corrupt geometry.
        return null;
      }

      let [clipX, clipY, clipZ, clipW] = clipPosition;
      if (!useShaderSurface) {
        const screenCorner = clipToScreen(
          clipPosition,
          drawingBufferWidth,
          drawingBufferHeight,
          pixelRatio
        );
        if (!screenCorner) {
          return null;
        }
        const targetCorner = hitTestCorners[index]!;
        targetCorner.x = screenCorner.x;
        targetCorner.y = screenCorner.y;
      }

      if (depthBiasNdc !== 0) {
        clipZ += depthBiasNdc * clipW;
        const minClipZ = -clipW + MIN_CLIP_Z_EPSILON;
        if (clipZ < minClipZ) {
          // Avoid crossing the near clip plane after biasing, which would invert winding.
          clipZ = minClipZ;
        }
      }

      if (clipCornerPositions) {
        clipCornerPositions[index] = [clipX, clipY, clipZ, clipW];
      }

      const [baseU, baseV] = UV_CORNERS[index]!;
      const u = atlasU0 + baseU * atlasUSpan;
      const v = atlasV0 + baseV * atlasVSpan;
      if (useShaderSurface) {
        const baseCorner = SURFACE_BASE_CORNERS[index]!;
        QUAD_VERTEX_SCRATCH[bufferOffset++] = baseCorner[0];
        QUAD_VERTEX_SCRATCH[bufferOffset++] = baseCorner[1];
        QUAD_VERTEX_SCRATCH[bufferOffset++] = 0;
        QUAD_VERTEX_SCRATCH[bufferOffset++] = 1;
      } else {
        QUAD_VERTEX_SCRATCH[bufferOffset++] = clipX;
        QUAD_VERTEX_SCRATCH[bufferOffset++] = clipY;
        QUAD_VERTEX_SCRATCH[bufferOffset++] = clipZ;
        QUAD_VERTEX_SCRATCH[bufferOffset++] = clipW;
      }
      QUAD_VERTEX_SCRATCH[bufferOffset++] = u;
      QUAD_VERTEX_SCRATCH[bufferOffset++] = v;

      if (debugClipCorners) {
        debugClipCorners.push([clipX, clipY, clipZ, clipW]);
      }
    }

    let clipUniformEnabled = false;
    if (
      clipCornerPositions &&
      clipCenterPosition &&
      clipCornerPositions.every((corner) => Array.isArray(corner))
    ) {
      const leftTop = clipCornerPositions[0];
      const rightTop = clipCornerPositions[1];
      const leftBottom = clipCornerPositions[2];
      const rightBottom = clipCornerPositions[3];
      if (leftTop && rightTop && leftBottom && rightBottom) {
        const clipBasisEast: [number, number, number, number] = [
          (rightTop[0] - leftTop[0]) * 0.5,
          (rightTop[1] - leftTop[1]) * 0.5,
          (rightTop[2] - leftTop[2]) * 0.5,
          (rightTop[3] - leftTop[3]) * 0.5,
        ];
        const clipBasisNorth: [number, number, number, number] = [
          (leftTop[0] - leftBottom[0]) * 0.5,
          (leftTop[1] - leftBottom[1]) * 0.5,
          (leftTop[2] - leftBottom[2]) * 0.5,
          (leftTop[3] - leftBottom[3]) * 0.5,
        ];
        const [centerX, centerY, centerZ, centerW] = clipCenterPosition;
        surfaceShaderInputs.clipCenter = {
          x: centerX,
          y: centerY,
          z: centerZ,
          w: centerW,
        };
        surfaceShaderInputs.clipBasisEast = {
          x: clipBasisEast[0],
          y: clipBasisEast[1],
          z: clipBasisEast[2],
          w: clipBasisEast[3],
        };
        surfaceShaderInputs.clipBasisNorth = {
          x: clipBasisNorth[0],
          y: clipBasisNorth[1],
          z: clipBasisNorth[2],
          w: clipBasisNorth[3],
        };
        const clipCornersForInputs: Array<{
          readonly x: number;
          readonly y: number;
          readonly z: number;
          readonly w: number;
        }> = [];
        let allCornersResolved = true;
        for (
          let cornerIndex = 0;
          cornerIndex < SURFACE_BASE_CORNERS.length;
          cornerIndex++
        ) {
          const clipCorner = clipCornerPositions[cornerIndex];
          if (!clipCorner) {
            allCornersResolved = false;
            break;
          }
          clipCornersForInputs.push({
            x: clipCorner[0],
            y: clipCorner[1],
            z: clipCorner[2],
            w: clipCorner[3],
          });
          const screenCorner = clipToScreen(
            clipCorner,
            drawingBufferWidth,
            drawingBufferHeight,
            pixelRatio
          );
          if (!screenCorner) {
            return null;
          }
          const targetCorner = hitTestCorners[cornerIndex]!;
          targetCorner.x = screenCorner.x;
          targetCorner.y = screenCorner.y;
        }
        if (allCornersResolved) {
          surfaceShaderInputs.clipCorners = clipCornersForInputs;
          clipUniformEnabled = true;
        } else {
          surfaceShaderInputs.clipCorners = [];
        }
      } else {
        surfaceShaderInputs.clipCorners = [];
      }
    } else {
      surfaceShaderInputs.clipCorners = [];
    }

    if (useShaderSurface) {
      surfaceClipEnabled = clipUniformEnabled;
      if (debugClipCorners) {
        surfaceShaderInputs.clipCorners = debugClipCorners.map(
          ([x, y, z, w]) => ({
            x,
            y,
            z,
            w,
          })
        );
      }
    } else {
      surfaceShaderInputs.clipCorners = [];
      surfaceClipEnabled = false;
    }

    screenCornerBuffer = hitTestCorners;
    resolvedSurfaceShaderInputs = surfaceShaderInputs;

    if (SL_DEBUG) {
      (imageEntry as any).__debugBag = {
        mode: 'surface',
        drawingBufferWidth,
        drawingBufferHeight,
        pixelRatio,
        zoom,
        zoomScaleFactor,
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
        depthBiasNdc,
        useShaderSurface,
        surfaceShaderInputs,
        clipCorners: debugClipCorners ?? undefined,
      };
    }
  } else {
    screenToClipUniforms = {
      scaleX: screenToClipScaleX,
      scaleY: screenToClipScaleY,
      offsetX: screenToClipOffsetX,
      offsetY: screenToClipOffsetY,
    };
    resolvedSurfaceShaderInputs = undefined;
    surfaceClipEnabled = false;
    useShaderSurface = false;
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

    borderSizeScaleAdjustment = placement.scaleAdjustment;

    const billboardShaderInputs = {
      center: placement.center,
      halfWidth: placement.halfWidth,
      halfHeight: placement.halfHeight,
      anchor,
      totalRotateDeg,
    };

    if (SL_DEBUG) {
      (imageEntry as any).__billboardShaderInputs = billboardShaderInputs;
    }

    useShaderBillboard = USE_SHADER_BILLBOARD_GEOMETRY;
    billboardUniforms = useShaderBillboard
      ? {
          center: billboardShaderInputs.center,
          halfWidth: billboardShaderInputs.halfWidth,
          halfHeight: billboardShaderInputs.halfHeight,
          anchor: billboardShaderInputs.anchor,
          sin: Math.sin(-billboardShaderInputs.totalRotateDeg * DEG2RAD),
          cos: Math.cos(-billboardShaderInputs.totalRotateDeg * DEG2RAD),
        }
      : null;

    const writeBillboardCorners = (
      corners: QuadCorner[],
      useShaderGeometry: boolean
    ): void => {
      const hitTestCorners = ensureHitTestCorners(imageEntry);
      let bufferOffset = 0;
      for (const index of TRIANGLE_INDICES) {
        const corner = corners[index]!;
        if (useShaderGeometry) {
          const baseCorner = BILLBOARD_BASE_CORNERS[index]!;
          QUAD_VERTEX_SCRATCH[bufferOffset++] = baseCorner[0];
          QUAD_VERTEX_SCRATCH[bufferOffset++] = baseCorner[1];
        } else {
          QUAD_VERTEX_SCRATCH[bufferOffset++] = corner.x;
          QUAD_VERTEX_SCRATCH[bufferOffset++] = corner.y;
        }
        QUAD_VERTEX_SCRATCH[bufferOffset++] = 0;
        QUAD_VERTEX_SCRATCH[bufferOffset++] = 1;
        const scaledU = atlasU0 + corner.u * atlasUSpan;
        const scaledV = atlasV0 + corner.v * atlasVSpan;
        QUAD_VERTEX_SCRATCH[bufferOffset++] = scaledU;
        QUAD_VERTEX_SCRATCH[bufferOffset++] = scaledV;
      }

      for (let i = 0; i < corners.length; i++) {
        const source = corners[i]!;
        const target = hitTestCorners[i]!;
        target.x = source.x;
        target.y = source.y;
      }

      screenCornerBuffer = hitTestCorners;
    };

    let resolvedCorners: QuadCorner[];
    let shaderModelCorners: QuadCorner[] | undefined;
    if (useShaderBillboard) {
      shaderModelCorners = computeBillboardCornersShaderModel({
        center: billboardShaderInputs.center,
        halfWidth: billboardShaderInputs.halfWidth,
        halfHeight: billboardShaderInputs.halfHeight,
        anchor: billboardShaderInputs.anchor,
        rotationDeg: billboardShaderInputs.totalRotateDeg,
      });
      resolvedCorners = shaderModelCorners;
      if (SL_DEBUG) {
        const cpuCorners = calculateBillboardCornerScreenPositions(
          billboardShaderInputs
        );
        const cornerDelta = cpuCorners.map((corner, index) => {
          const shaderCorner = shaderModelCorners![index]!;
          return {
            index,
            dx: corner.x - shaderCorner.x,
            dy: corner.y - shaderCorner.y,
            du: corner.u - shaderCorner.u,
            dv: corner.v - shaderCorner.v,
          };
        });
        (imageEntry as any).__billboardCornerComparison = {
          cpuCorners,
          shaderModelCorners,
          cornerDelta,
        };
      }
    } else {
      resolvedCorners = calculateBillboardCornerScreenPositions(
        billboardShaderInputs
      );
    }

    writeBillboardCorners(resolvedCorners, useShaderBillboard);

    if (SL_DEBUG) {
      (imageEntry as any).__debugBag = {
        mode: 'billboard',
        drawingBufferWidth,
        drawingBufferHeight,
        pixelRatio,
        zoom,
        zoomScaleFactor,
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
        billboardCornersCpu: useShaderBillboard
          ? ((imageEntry as any).__billboardCornerComparison?.cpuCorners ??
            resolvedCorners)
          : resolvedCorners,
        billboardCornersShaderModel: shaderModelCorners,
        billboardCornersUsed: resolvedCorners,
      };
    }
  }

  const borderWidthMeters = imageEntry.border?.widthMeters;
  imageEntry.borderPixelWidth = calculateBorderWidthPixels(
    borderWidthMeters,
    imageScale,
    zoomScaleFactor,
    effectivePixelsPerMeter,
    borderSizeScaleAdjustment
  );

  const hitTestCorners =
    screenCornerBuffer && screenCornerBuffer.length === 4
      ? screenCornerBuffer
      : null;

  return {
    spriteEntry,
    imageEntry,
    imageResource,
    vertexData: new Float32Array(QUAD_VERTEX_SCRATCH),
    opacity: imageEntry.opacity.current,
    hitTestCorners,
    screenToClip: screenToClipUniforms,
    useShaderSurface,
    surfaceShaderInputs: resolvedSurfaceShaderInputs,
    surfaceClipEnabled,
    useShaderBillboard,
    billboardUniforms,
    cameraDistanceMeters,
  };
};

//////////////////////////////////////////////////////////////////////////////////////

const prepareDrawSpriteImages = <TTag>(
  projectionHost: ProjectionHost,
  params: PrepareDrawSpriteImageParams<TTag>
) => {
  // Render sprite images. The renderTargetEntries list is already filtered to visible items.
  // Cache of sprite-specific reference origins (center pixel coordinates).
  const originCenterCache: ImageCenterCache = new Map();

  const zoom = projectionHost.getZoom();
  const resolvedScaling =
    params.resolvedScaling ??
    resolveScalingOptions({
      metersPerPixel: params.baseMetersPerPixel,
      spriteMinPixel: params.spriteMinPixel,
      spriteMaxPixel: params.spriteMaxPixel,
      zoomMin: zoom,
      zoomMax: zoom,
    });
  const zoomScaleFactor = calculateZoomScaleFactor(zoom, resolvedScaling);

  // Step 1
  const itemsWithDepth = collectDepthSortedItemsInternal(
    projectionHost,
    zoom,
    zoomScaleFactor,
    originCenterCache,
    params
  );

  // Step 2
  const preparedItems: PreparedDrawSpriteImageParams<TTag>[] = [];
  for (const item of itemsWithDepth) {
    const prepared = prepareDrawSpriteImageInternal(
      projectionHost,
      item,
      zoom,
      zoomScaleFactor,
      originCenterCache,
      params
    );
    if (prepared) {
      preparedItems.push(prepared);
    } else {
      item.image.surfaceShaderInputs = undefined;
    }
  }

  return preparedItems;
};

const resolveVisibilityTargetOpacity = <TTag>(
  sprite: InternalSpriteCurrentState<TTag>,
  image: InternalSpriteImageState,
  cameraDistanceMeters: number
): number => {
  const baseOpacity = clampOpacity(image.lastCommandOpacity);
  const threshold = sprite.visibilityDistanceMeters;
  if (
    threshold === undefined ||
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    !Number.isFinite(cameraDistanceMeters)
  ) {
    return baseOpacity;
  }
  return cameraDistanceMeters >= threshold ? 0 : baseOpacity;
};

export const applyVisibilityDistanceLod = <TTag>(
  preparedItems: readonly PreparedDrawSpriteImageParams<TTag>[]
): void => {
  if (!preparedItems.length) {
    return;
  }
  for (const prepared of preparedItems) {
    const image = prepared.imageEntry;
    const sprite = prepared.spriteEntry;
    const targetOpacity = resolveVisibilityTargetOpacity(
      sprite,
      image,
      prepared.cameraDistanceMeters
    );
    if (
      !Number.isFinite(image.opacityTargetValue) ||
      Math.abs(image.opacityTargetValue - targetOpacity) >
        OPACITY_TARGET_EPSILON
    ) {
      image.opacityTargetValue = targetOpacity;
    }
  }
};

export const syncPreparedOpacities = <TTag>(
  preparedItems: readonly PreparedDrawSpriteImageParams<TTag>[]
): void => {
  if (!preparedItems.length) {
    return;
  }
  for (const prepared of preparedItems) {
    prepared.opacity = prepared.imageEntry.opacity.current;
  }
};

export const filterVisiblePreparedItems = <TTag>(
  preparedItems: readonly PreparedDrawSpriteImageParams<TTag>[]
): PreparedDrawSpriteImageParams<TTag>[] => {
  if (!preparedItems.length) {
    return [];
  }
  const visibleItems: PreparedDrawSpriteImageParams<TTag>[] = [];
  for (const prepared of preparedItems) {
    if (prepared.opacity > OPACITY_TARGET_EPSILON) {
      visibleItems.push(prepared);
    }
  }
  return visibleItems;
};

//////////////////////////////////////////////////////////////////////////////////////

const evaluateDistanceInterpolationsBatch = (
  requests: readonly DistanceInterpolationEvaluationParams[]
): DistanceInterpolationEvaluationResult[] => {
  if (!requests.length) {
    return [];
  }
  return requests.map((request) => evaluateDistanceInterpolation(request));
};

const evaluateDegreeInterpolationsBatch = (
  requests: readonly DegreeInterpolationEvaluationParams[]
): DegreeInterpolationEvaluationResult[] => {
  if (!requests.length) {
    return [];
  }
  return requests.map((request) => evaluateDegreeInterpolation(request));
};

const evaluateSpriteInterpolationsBatch = (
  requests: readonly SpriteInterpolationEvaluationParams[]
): SpriteInterpolationEvaluationResult[] => {
  if (!requests.length) {
    return [];
  }
  return requests.map((request) => evaluateInterpolation(request));
};

export interface ProcessInterpolationPresetRequests {
  readonly distance: readonly DistanceInterpolationEvaluationParams[];
  readonly degree: readonly DegreeInterpolationEvaluationParams[];
  readonly sprite: readonly SpriteInterpolationEvaluationParams[];
}

export interface ProcessInterpolationsEvaluationHandlers {
  readonly prepare?: (requests: ProcessInterpolationPresetRequests) => void;
  readonly evaluateDistance: (
    requests: readonly DistanceInterpolationEvaluationParams[]
  ) => readonly DistanceInterpolationEvaluationResult[];
  readonly evaluateDegree: (
    requests: readonly DegreeInterpolationEvaluationParams[]
  ) => readonly DegreeInterpolationEvaluationResult[];
  readonly evaluateSprite: (
    requests: readonly SpriteInterpolationEvaluationParams[]
  ) => readonly SpriteInterpolationEvaluationResult[];
}

const defaultInterpolationEvaluationHandlers: ProcessInterpolationsEvaluationHandlers =
  {
    evaluateDistance: (requests) =>
      evaluateDistanceInterpolationsBatch(requests),
    evaluateDegree: (requests) => evaluateDegreeInterpolationsBatch(requests),
    evaluateSprite: (requests) => evaluateSpriteInterpolationsBatch(requests),
  };

//////////////////////////////////////////////////////////////////////////////////////

interface SpriteInterpolationWorkItem<TTag> {
  readonly sprite: InternalSpriteCurrentState<TTag>;
  readonly state: SpriteInterpolationState;
}

const applySpriteInterpolationEvaluations = <TTag>(
  workItems: readonly SpriteInterpolationWorkItem<TTag>[],
  evaluations: readonly SpriteInterpolationEvaluationResult[],
  timestamp: number
): boolean => {
  let active = false;
  for (let index = 0; index < workItems.length; index += 1) {
    const item = workItems[index]!;
    const { sprite, state } = item;
    const evaluation =
      evaluations[index] ??
      evaluateInterpolation({
        state,
        timestamp,
      });

    if (state.startTimestamp < 0) {
      state.startTimestamp = evaluation.effectiveStartTimestamp;
    }

    sprite.location.current = evaluation.location;

    if (evaluation.completed) {
      sprite.location.current = cloneSpriteLocation(state.to);
      sprite.location.from = undefined;
      sprite.location.to = undefined;
      sprite.interpolationState = null;
    } else {
      active = true;
    }
  }
  return active;
};

const ensureOpacityInterpolationTarget = (
  image: InternalSpriteImageState
): void => {
  const target = clampOpacity(
    image.opacityTargetValue ??
      image.lastCommandOpacity ??
      image.opacity.current
  );
  const interpolationState = image.opacityInterpolationState;
  const currentStateTarget = interpolationState
    ? clampOpacity(interpolationState.finalValue)
    : image.opacity.current;
  if (interpolationState) {
    if (Math.abs(currentStateTarget - target) <= OPACITY_TARGET_EPSILON) {
      // Already interpolating toward the desired target.
      return;
    }
  } else if (
    Math.abs(image.opacity.current - target) <= OPACITY_TARGET_EPSILON
  ) {
    // No interpolation state and current opacity already matches the target.
    image.lodLastCommandOpacity = target;
    return;
  }
  const options = image.opacityInterpolationOptions;
  if (options && options.durationMs > 0) {
    const { state, requiresInterpolation } = createDistanceInterpolationState({
      currentValue: clampOpacity(image.opacity.current),
      targetValue: target,
      previousCommandValue: image.lodLastCommandOpacity,
      options,
    });
    image.lodLastCommandOpacity = target;
    if (requiresInterpolation) {
      image.opacityInterpolationState = state;
      image.opacity.from = image.opacity.current;
      image.opacity.to = target;
      return;
    }
  }
  image.opacity.current = target;
  image.opacity.from = undefined;
  image.opacity.to = undefined;
  image.opacityInterpolationState = null;
  image.lodLastCommandOpacity = target;
};

export const processInterpolationsInternal = <TTag>(
  params: RenderInterpolationParams<TTag>,
  handlers: ProcessInterpolationsEvaluationHandlers = defaultInterpolationEvaluationHandlers
): RenderInterpolationResult => {
  const evaluationHandlers = handlers ?? defaultInterpolationEvaluationHandlers;
  const { sprites, timestamp } = params;
  if (!sprites.length) {
    return {
      handled: true,
      hasActiveInterpolation: false,
    };
  }

  const distanceInterpolationWorkItems: DistanceInterpolationWorkItem[] = [];
  const degreeInterpolationWorkItems: DegreeInterpolationWorkItem[] = [];
  const spriteInterpolationWorkItems: SpriteInterpolationWorkItem<TTag>[] = [];

  let hasActiveInterpolation = false;

  for (const sprite of sprites) {
    const state = sprite.interpolationState;
    if (state) {
      if (state.easingPreset) {
        spriteInterpolationWorkItems.push({ sprite, state });
      } else {
        const evaluation = evaluateInterpolation({
          state,
          timestamp,
        });
        if (state.startTimestamp < 0) {
          state.startTimestamp = evaluation.effectiveStartTimestamp;
        }
        sprite.location.current = evaluation.location;
        if (evaluation.completed) {
          sprite.location.current = cloneSpriteLocation(state.to);
          sprite.location.from = undefined;
          sprite.location.to = undefined;
          sprite.interpolationState = null;
        } else {
          hasActiveInterpolation = true;
        }
      }
    }

    sprite.images.forEach((orderMap) => {
      orderMap.forEach((image) => {
        const hasOffsetMetersInterpolation =
          image.offsetMetersInterpolationState !== null;
        if (hasOffsetMetersInterpolation) {
          collectDistanceInterpolationWorkItems(
            image,
            distanceInterpolationWorkItems,
            {
              includeOpacity: false,
            }
          );
        }

        ensureOpacityInterpolationTarget(image);

        const hasOpacityInterpolation =
          image.opacityInterpolationState !== null;

        const hasDegreeInterpolation =
          image.rotationInterpolationState !== null ||
          image.offsetDegInterpolationState !== null;
        if (hasDegreeInterpolation) {
          collectDegreeInterpolationWorkItems(
            image,
            degreeInterpolationWorkItems
          );
        }

        const skipChannels: Partial<
          Record<ImageInterpolationStepperId, boolean>
        > = {};
        let shouldSkipChannels = false;
        if (hasOffsetMetersInterpolation) {
          skipChannels.offsetMeters = true;
          shouldSkipChannels = true;
        }
        if (hasOpacityInterpolation) {
          skipChannels.opacity = true;
          shouldSkipChannels = true;
        }
        if (hasDegreeInterpolation) {
          skipChannels.rotation = true;
          skipChannels.offsetDeg = true;
          shouldSkipChannels = true;
        }

        if (
          stepSpriteImageInterpolations(
            image,
            timestamp,
            shouldSkipChannels ? { skipChannels } : undefined
          )
        ) {
          hasActiveInterpolation = true;
        }
      });
    });
  }

  const presetDistanceWorkItems: DistanceInterpolationWorkItem[] = [];
  const fallbackDistanceWorkItems: DistanceInterpolationWorkItem[] = [];
  if (distanceInterpolationWorkItems.length > 0) {
    for (const item of distanceInterpolationWorkItems) {
      if (item.state.easingPreset) {
        presetDistanceWorkItems.push(item);
      } else {
        fallbackDistanceWorkItems.push(item);
      }
    }
  }

  const presetDegreeWorkItems: DegreeInterpolationWorkItem[] = [];
  const fallbackDegreeWorkItems: DegreeInterpolationWorkItem[] = [];
  if (degreeInterpolationWorkItems.length > 0) {
    for (const item of degreeInterpolationWorkItems) {
      if (item.state.easingPreset) {
        presetDegreeWorkItems.push(item);
      } else {
        fallbackDegreeWorkItems.push(item);
      }
    }
  }

  const presetSpriteWorkItems: SpriteInterpolationWorkItem<TTag>[] = [];
  const fallbackSpriteWorkItems: SpriteInterpolationWorkItem<TTag>[] = [];
  if (spriteInterpolationWorkItems.length > 0) {
    for (const item of spriteInterpolationWorkItems) {
      if (item.state.easingPreset) {
        presetSpriteWorkItems.push(item);
      } else {
        fallbackSpriteWorkItems.push(item);
      }
    }
  }

  const distanceRequests =
    presetDistanceWorkItems.length > 0
      ? presetDistanceWorkItems.map(({ state }) => ({
          state,
          timestamp,
        }))
      : [];
  const degreeRequests =
    presetDegreeWorkItems.length > 0
      ? presetDegreeWorkItems.map(({ state }) => ({
          state,
          timestamp,
        }))
      : [];
  const spriteRequests =
    presetSpriteWorkItems.length > 0
      ? presetSpriteWorkItems.map(({ state }) => ({
          state,
          timestamp,
        }))
      : [];

  const hasPresetRequests =
    distanceRequests.length > 0 ||
    degreeRequests.length > 0 ||
    spriteRequests.length > 0;

  if (hasPresetRequests) {
    evaluationHandlers.prepare?.({
      distance: distanceRequests,
      degree: degreeRequests,
      sprite: spriteRequests,
    });
  }

  if (presetDistanceWorkItems.length > 0) {
    const evaluations = evaluationHandlers.evaluateDistance(distanceRequests);
    if (
      applyDistanceInterpolationEvaluations(
        presetDistanceWorkItems,
        evaluations,
        timestamp
      )
    ) {
      hasActiveInterpolation = true;
    }
  }

  if (
    fallbackDistanceWorkItems.length > 0 &&
    applyDistanceInterpolationEvaluations(
      fallbackDistanceWorkItems,
      [],
      timestamp
    )
  ) {
    hasActiveInterpolation = true;
  }

  if (presetDegreeWorkItems.length > 0) {
    const evaluations = evaluationHandlers.evaluateDegree(degreeRequests);
    if (
      applyDegreeInterpolationEvaluations(
        presetDegreeWorkItems,
        evaluations,
        timestamp
      )
    ) {
      hasActiveInterpolation = true;
    }
  }

  if (
    fallbackDegreeWorkItems.length > 0 &&
    applyDegreeInterpolationEvaluations(fallbackDegreeWorkItems, [], timestamp)
  ) {
    hasActiveInterpolation = true;
  }

  if (presetSpriteWorkItems.length > 0) {
    const evaluations = evaluationHandlers.evaluateSprite(spriteRequests);
    if (
      applySpriteInterpolationEvaluations(
        presetSpriteWorkItems,
        evaluations,
        timestamp
      )
    ) {
      hasActiveInterpolation = true;
    }
  }

  if (
    fallbackSpriteWorkItems.length > 0 &&
    applySpriteInterpolationEvaluations(fallbackSpriteWorkItems, [], timestamp)
  ) {
    hasActiveInterpolation = true;
  }

  return {
    handled: true,
    hasActiveInterpolation,
  };
};

export const processOpacityInterpolationsAfterPreparation = <TTag>(
  params: RenderInterpolationParams<TTag>,
  preparedItems: readonly PreparedDrawSpriteImageParams<TTag>[],
  handlers: ProcessInterpolationsEvaluationHandlers = defaultInterpolationEvaluationHandlers
): RenderInterpolationResult => {
  void preparedItems;
  const evaluationHandlers = handlers ?? defaultInterpolationEvaluationHandlers;
  const { sprites, timestamp } = params;
  if (!sprites.length) {
    return {
      handled: true,
      hasActiveInterpolation: false,
    };
  }

  const opacityWorkItems: DistanceInterpolationWorkItem[] = [];

  for (const sprite of sprites) {
    sprite.images.forEach((orderMap) => {
      orderMap.forEach((image) => {
        ensureOpacityInterpolationTarget(image);
        if (image.opacityInterpolationState !== null) {
          collectDistanceInterpolationWorkItems(image, opacityWorkItems, {
            includeOffsetMeters: false,
          });
        }
      });
    });
  }

  if (opacityWorkItems.length === 0) {
    return {
      handled: true,
      hasActiveInterpolation: false,
    };
  }

  const presetOpacityWorkItems: DistanceInterpolationWorkItem[] = [];
  const fallbackOpacityWorkItems: DistanceInterpolationWorkItem[] = [];
  for (const item of opacityWorkItems) {
    if (item.state.easingPreset) {
      presetOpacityWorkItems.push(item);
    } else {
      fallbackOpacityWorkItems.push(item);
    }
  }

  const opacityRequests =
    presetOpacityWorkItems.length > 0
      ? presetOpacityWorkItems.map(({ state }) => ({
          state,
          timestamp,
        }))
      : [];

  if (opacityRequests.length > 0) {
    evaluationHandlers.prepare?.({
      distance: opacityRequests,
      degree: [],
      sprite: [],
    });
  }

  let hasActiveInterpolation = false;

  if (presetOpacityWorkItems.length > 0) {
    const evaluations = evaluationHandlers.evaluateDistance(opacityRequests);
    if (
      applyDistanceInterpolationEvaluations(
        presetOpacityWorkItems,
        evaluations,
        timestamp
      )
    ) {
      hasActiveInterpolation = true;
    }
  }

  if (
    fallbackOpacityWorkItems.length > 0 &&
    applyDistanceInterpolationEvaluations(
      fallbackOpacityWorkItems,
      [],
      timestamp
    )
  ) {
    hasActiveInterpolation = true;
  }

  return {
    handled: true,
    hasActiveInterpolation,
  };
};

//////////////////////////////////////////////////////////////////////////////////////

const createProjectionBoundCalculationHost = <TTag>(
  projectionHost: ProjectionHost
): RenderCalculationHost<TTag> => {
  const processDrawSpriteImagesInternalWithInterpolations = (
    params: ProcessDrawSpriteImagesParams<TTag>
  ): ProcessDrawSpriteImagesResult<TTag> => {
    let interpolationResult = params.interpolationParams
      ? processInterpolationsInternal(params.interpolationParams)
      : DEFAULT_RENDER_INTERPOLATION_RESULT;
    const preparedItems = params.prepareParams
      ? prepareDrawSpriteImages(projectionHost, params.prepareParams)
      : [];
    if (preparedItems.length > 0) {
      applyVisibilityDistanceLod(preparedItems);
    }
    if (params.interpolationParams) {
      const opacityResult = processOpacityInterpolationsAfterPreparation(
        params.interpolationParams,
        preparedItems
      );
      interpolationResult = {
        handled: interpolationResult.handled || opacityResult.handled,
        hasActiveInterpolation:
          interpolationResult.hasActiveInterpolation ||
          opacityResult.hasActiveInterpolation,
      };
    }
    syncPreparedOpacities(preparedItems);
    const visiblePreparedItems = filterVisiblePreparedItems(preparedItems);
    return {
      interpolationResult,
      preparedItems: visiblePreparedItems,
    };
  };

  return {
    processDrawSpriteImages: (params) =>
      processDrawSpriteImagesInternalWithInterpolations(params),
    release: projectionHost.release,
  };
};

/**
 * Create calculation host that binding MapLibre.
 * @param TTag Tag type.
 * @param map MapLibre Map.
 * @returns Calculation host.
 */
export const createMapLibreCalculationHost = <TTag>(
  map: MapLibreMap
): RenderCalculationHost<TTag> => {
  const projectionHost = createMapLibreProjectionHost(map);
  return createProjectionBoundCalculationHost<TTag>(projectionHost);
};

/**
 * Create calculation host that pure implementation.
 * @param TTag Tag type.
 * @param params Projection host PrepareDrawSpriteImageInputsparams.
 * @returns Calculation host.
 */
export const createCalculationHost = <TTag>(
  params: ProjectionHostParams
): RenderCalculationHost<TTag> => {
  const projectionHost = createProjectionHost(params);
  return createProjectionBoundCalculationHost<TTag>(projectionHost);
};

const __createWasmProjectionCalculationTestHost = <TTag>(
  params: ProjectionHostParams
): RenderCalculationHost<TTag> => {
  const projectionHost = createWasmProjectionHost(params);
  return createProjectionBoundCalculationHost<TTag>(projectionHost);
};

// Only testing purpose, DO NOT USE in production code.
export const __wasmProjectionCalculationTestInternals = {
  __createWasmProjectionCalculationTestHost,
};

export const __calculationHostTestInternals = {
  applyVisibilityDistanceLod,
  syncPreparedOpacities,
  processOpacityInterpolationsAfterPreparation,
};
