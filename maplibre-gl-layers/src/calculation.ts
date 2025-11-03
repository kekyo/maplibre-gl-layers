// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { Map as MapLibreMap } from 'maplibre-gl';
import { normalizeAngleDeg } from './rotationInterpolation';
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
  type ResolvedSpriteScalingOptions,
} from './math';
import {
  BILLBOARD_BASE_CORNERS,
  SURFACE_BASE_CORNERS,
  QUAD_VERTEX_SCRATCH,
  computeBillboardCornersShaderModel,
} from './shader';
import type {
  InternalSpriteCurrentState,
  InternalSpriteImageState,
  RegisteredImage,
  SurfaceShaderInputs,
  ClipContext,
  ProjectionHost,
  CollectDepthSortedItemsInputs,
  DepthSortedItem,
  PreparedDrawSpriteImageParams,
  PrepareDrawSpriteImageInputs,
  RenderCalculationHost,
  ImageCenterCache,
  ImageCenterCacheEntry,
} from './internalTypes';
import type {
  SpriteAnchor,
  SpriteLocation,
  SpritePoint,
  SpriteScreenPoint,
} from './types';
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
} from './const';
import {
  ENABLE_NDC_BIAS_SURFACE,
  SL_DEBUG,
  USE_SHADER_BILLBOARD_GEOMETRY,
  USE_SHADER_SURFACE_GEOMETRY,
} from './config';
import { createWasmProjectionHost } from './wasmProjectionHost';

//////////////////////////////////////////////////////////////////////////////////////

const collectDepthSortedItemsInternal = <T>(
  projectionHost: ProjectionHost,
  {
    bucket,
    images,
    resolvedScaling,
    zoomScaleFactor: zoomScaleFactorOverride,
    clipContext,
    baseMetersPerPixel,
    spriteMinPixel,
    spriteMaxPixel,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio,
    originCenterCache,
    resolveSpriteMercator,
  }: CollectDepthSortedItemsInputs<T>
): DepthSortedItem<T>[] => {
  const itemsWithDepth: DepthSortedItem<T>[] = [];

  const projectToClipSpace: ProjectToClipSpaceFn = (location) =>
    projectLngLatToClipSpace(projectionHost, location, clipContext);

  const unprojectPoint: UnprojectPointFn = (point: SpriteScreenPoint) => {
    return projectionHost.unproject(point);
  };

  const zoom = projectionHost.getZoom();
  const zoomScaleFactor =
    zoomScaleFactorOverride ??
    (resolvedScaling ? calculateZoomScaleFactor(zoom, resolvedScaling) : 1);

  for (const [spriteEntry, imageEntry] of bucket) {
    const imageResource = images.get(imageEntry.imageId);
    if (!imageResource || !imageResource.texture) {
      continue;
    }

    const projected = projectionHost.project(spriteEntry.currentLocation);
    if (!projected) {
      continue;
    }

    const spriteMercator = resolveSpriteMercator(projectionHost, spriteEntry);
    const metersPerPixelAtLat = calculateMetersPerPixelAtLatitude(
      zoom,
      spriteEntry.currentLocation.lat
    );
    if (!Number.isFinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0) {
      continue;
    }

    const perspectiveRatio = projectionHost.calculatePerspectiveRatio(
      spriteEntry.currentLocation,
      spriteMercator
    );
    const effectivePixelsPerMeter = calculateEffectivePixelsPerMeter(
      metersPerPixelAtLat,
      perspectiveRatio
    );
    if (effectivePixelsPerMeter <= 0) {
      continue;
    }

    const centerParams: ComputeImageCenterParams = {
      projectionHost,
      images,
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
    };

    const anchorResolved = imageEntry.anchor ?? DEFAULT_ANCHOR;
    const offsetResolved = imageEntry.offset ?? DEFAULT_IMAGE_OFFSET;

    const depthCenter = computeImageCenterXY(
      spriteEntry,
      imageEntry,
      centerParams,
      true
    );

    let depthKey: number;

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
              (imageEntry.rotateDeg ?? 0)
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
          const refImg = spriteEntry.images
            .get(imageEntry.originLocation.subLayer)
            ?.get(imageEntry.originLocation.order);
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
        return spriteEntry.currentLocation;
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

      if (surfaceDepth === null) {
        continue;
      }
      depthKey = surfaceDepth;
    } else {
      const billboardDepth = calculateBillboardDepthKey(
        depthCenter,
        unprojectPoint,
        projectToClipSpace
      );
      if (billboardDepth === null) {
        continue;
      }
      depthKey = billboardDepth;
    }

    itemsWithDepth.push({
      sprite: spriteEntry,
      image: imageEntry,
      resource: imageResource,
      depthKey,
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
 * @param {ClipContext | null} context - Clip-space context; `null` skips projection.
 * @returns {[number, number, number, number] | null} Clip coordinates or `null` when projection fails.
 */
export const projectLngLatToClipSpace = (
  projectionHost: ProjectionHost,
  location: Readonly<SpriteLocation>,
  context: Readonly<ClipContext> | null
): [number, number, number, number] | null => {
  if (!context) {
    return null;
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
    return null;
  }
  return [clipX, clipY, clipZ, clipW];
};

/**
 * Parameters required to determine an image center in screen space.
 */
interface ComputeImageCenterParams {
  readonly projectionHost: ProjectionHost;
  readonly images: ReadonlyMap<string, Readonly<RegisteredImage>>;
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
  readonly clipContext: Readonly<ClipContext> | null;
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
  params: ComputeImageCenterParams,
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
    images,
    projectionHost,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio,
    clipContext,
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
    const ref = sprite.images
      .get(image.originLocation.subLayer)
      ?.get(image.originLocation.order);
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
        (image.resolvedBaseRotateDeg ?? 0) + (image.rotateDeg ?? 0)
      );
  const imageScaleLocal = image.scale ?? 1;
  const imageResourceRef = images.get(image.imageId);

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
      offset: image.offset,
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
        (projectionHost.unproject(base) ?? sprite.currentLocation)
      : // Otherwise use the sprite's own interpolated geographic location.
        sprite.currentLocation;

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
    offset: image.offset,
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
const prepareDrawSpriteImage = <T>(
  projectionHost: ProjectionHost,
  item: DepthSortedItem<T>,
  inputs: PrepareDrawSpriteImageInputs<T>
): PreparedDrawSpriteImageParams<T> | null => {
  const {
    originCenterCache,
    images,
    resolvedScaling,
    zoomScaleFactor: zoomScaleFactorOverride,
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
    ensureHitTestCorners,
    resolveSpriteMercator,
  } = inputs;

  const spriteEntry = item.sprite;
  const imageEntry = item.image;
  const imageResource = item.resource;

  const spriteMercator = resolveSpriteMercator(projectionHost, item.sprite);

  // Reset previous frame state so skipped images do not leak stale uniforms.
  imageEntry.surfaceShaderInputs = undefined;

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
  // Use per-image anchor/offset when provided; otherwise fall back to defaults.
  const anchor = imageEntry.anchor ?? DEFAULT_ANCHOR;
  const offsetDef = imageEntry.offset ?? DEFAULT_IMAGE_OFFSET;
  // Prefer the dynamically interpolated rotation when available; otherwise synthesize it from base + manual rotations.
  const totalRotateDeg = Number.isFinite(imageEntry.displayedRotateDeg)
    ? imageEntry.displayedRotateDeg
    : normalizeAngleDeg(
        (imageEntry.resolvedBaseRotateDeg ?? 0) + (imageEntry.rotateDeg ?? 0)
      );

  const zoom = projectionHost.getZoom();
  const zoomScaleFactor =
    zoomScaleFactorOverride ??
    (resolvedScaling ? calculateZoomScaleFactor(zoom, resolvedScaling) : 1);

  const projected = projectionHost.project(spriteEntry.currentLocation);
  if (!projected) {
    // Projection may fail when the coordinate exits the viewport.
    return null;
  }

  const metersPerPixelAtLat = calculateMetersPerPixelAtLatitude(
    zoom,
    spriteEntry.currentLocation.lat
  );
  if (!Number.isFinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0) {
    return null;
  }

  const perspectiveRatio = projectionHost.calculatePerspectiveRatio(
    spriteEntry.currentLocation,
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

  const centerParams: ComputeImageCenterParams = {
    projectionHost,
    images,
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
  };

  let baseProjected = { x: projected.x, y: projected.y };
  if (imageEntry.originLocation !== undefined) {
    const refImg = spriteEntry.images
      .get(imageEntry.originLocation.subLayer)
      ?.get(imageEntry.originLocation.order);
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

  if (imageEntry.mode === 'surface') {
    screenToClipUniforms = {
      scaleX: identityScaleX,
      scaleY: identityScaleY,
      offsetX: identityOffsetX,
      offsetY: identityOffsetY,
    };
    const baseLngLat =
      imageEntry.originLocation !== undefined
        ? // When an origin reference is set, reproject the cached screen point back to geographic space.
          (projectionHost.unproject(baseProjected) ??
          spriteEntry.currentLocation)
        : // Otherwise base the surface on the sprite's current longitude/latitude.
          spriteEntry.currentLocation;

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
    let clipCornerPositions: Array<[number, number, number, number]> | null =
      null;
    let clipCenterPosition: [number, number, number, number] | null = null;
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
        clipCornerPositions = null;
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

      const [u, v] = UV_CORNERS[index]!;
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
        QUAD_VERTEX_SCRATCH[bufferOffset++] = corner.u;
        QUAD_VERTEX_SCRATCH[bufferOffset++] = corner.v;
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

  const hitTestCorners =
    screenCornerBuffer && screenCornerBuffer.length === 4
      ? screenCornerBuffer
      : null;

  return {
    spriteEntry,
    imageEntry,
    imageResource,
    vertexData: new Float32Array(QUAD_VERTEX_SCRATCH),
    opacity: imageEntry.opacity,
    hitTestCorners,
    screenToClip: screenToClipUniforms,
    useShaderSurface,
    surfaceShaderInputs: resolvedSurfaceShaderInputs,
    surfaceClipEnabled,
    useShaderBillboard,
    billboardUniforms,
  };
};

const prepareDrawSpriteImagesInternal = <T>(
  projectionHost: ProjectionHost,
  items: readonly Readonly<DepthSortedItem<T>>[],
  options: PrepareDrawSpriteImageInputs<T>
): PreparedDrawSpriteImageParams<T>[] => {
  const preparedItems: PreparedDrawSpriteImageParams<T>[] = [];

  for (const item of items) {
    const prepared = prepareDrawSpriteImage(projectionHost, item, options);
    if (prepared) {
      preparedItems.push(prepared);
    } else {
      item.image.surfaceShaderInputs = undefined;
    }
  }

  return preparedItems;
};

//////////////////////////////////////////////////////////////////////////////////////

type CollectDepthSortedItemsParams<T> = Omit<
  CollectDepthSortedItemsInputs<T>,
  'resolvedScaling' | 'zoomScaleFactor'
> & {
  readonly projectionHost: ProjectionHost;
  readonly resolvedScaling?: ResolvedSpriteScalingOptions;
  readonly zoomScaleFactor?: number;
  readonly zoom?: number;
};

/**
 * Backwards-compatible entry point for collecting depth-sorted items without creating a host.
 */
export const collectDepthSortedItems = <T>(
  params: CollectDepthSortedItemsParams<T>
): DepthSortedItem<T>[] => {
  const { projectionHost, resolvedScaling, zoomScaleFactor, zoom, ...rest } =
    params;

  const ensuredScaling =
    resolvedScaling ??
    resolveScalingOptions({
      metersPerPixel: rest.baseMetersPerPixel,
      spriteMinPixel: rest.spriteMinPixel,
      spriteMaxPixel: rest.spriteMaxPixel,
      zoomMin: zoom,
      zoomMax: zoom,
    });

  return collectDepthSortedItemsInternal(projectionHost, {
    ...rest,
    resolvedScaling: ensuredScaling,
    zoomScaleFactor,
  });
};

type PrepareDrawSpriteImagesParams<T> = Omit<
  PrepareDrawSpriteImageInputs<T>,
  'resolvedScaling' | 'zoomScaleFactor'
> & {
  readonly projectionHost: ProjectionHost;
  readonly items: readonly DepthSortedItem<T>[];
  readonly resolvedScaling?: ResolvedSpriteScalingOptions;
  readonly zoomScaleFactor?: number;
};

/**
 * Backwards-compatible entry point for preparing draw parameters without creating a host.
 */
export const prepareDrawSpriteImages = <T>(
  params: PrepareDrawSpriteImagesParams<T>
): PreparedDrawSpriteImageParams<T>[] => {
  const { projectionHost, items, resolvedScaling, zoomScaleFactor, ...rest } =
    params;

  const ensuredScaling =
    resolvedScaling ??
    resolveScalingOptions({
      metersPerPixel: rest.baseMetersPerPixel,
      spriteMinPixel: rest.spriteMinPixel,
      spriteMaxPixel: rest.spriteMaxPixel,
    });

  return prepareDrawSpriteImagesInternal(projectionHost, items, {
    ...rest,
    resolvedScaling: ensuredScaling,
    zoomScaleFactor,
  });
};

//////////////////////////////////////////////////////////////////////////////////////

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
  return {
    collectDepthSortedItems: (inputs) =>
      collectDepthSortedItemsInternal(projectionHost, inputs),
    prepareDrawSpriteImages: (items, inputs) =>
      prepareDrawSpriteImagesInternal(projectionHost, items, inputs),
  };
};

/**
 * Create calculation host that pure implementation.
 * @param TTag Tag type.
 * @param params Projection host params.
 * @returns Calculation host.
 */
export const createCalculationHost = <TTag>(
  params: ProjectionHostParams
): RenderCalculationHost<TTag> => {
  const projectionHost = createProjectionHost(params);
  return {
    collectDepthSortedItems: (inputs) =>
      collectDepthSortedItemsInternal(projectionHost, inputs),
    prepareDrawSpriteImages: (items, inputs) =>
      prepareDrawSpriteImagesInternal(projectionHost, items, inputs),
  };
};

/**
 * Create calculation host that wasm implementation.
 * @param TTag Tag type.
 * @param params Projection host params.
 * @returns Calculation host.
 */
export const createWasmCalculationHost = <TTag>(
  params: ProjectionHostParams
): RenderCalculationHost<TTag> => {
  const projectionHost = createWasmProjectionHost(params);
  return {
    collectDepthSortedItems: (inputs) =>
      collectDepthSortedItemsInternal(projectionHost, inputs),
    prepareDrawSpriteImages: (items, inputs) =>
      prepareDrawSpriteImagesInternal(projectionHost, items, inputs),
  };
};
