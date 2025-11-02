// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { MercatorCoordinate, type Map as MapLibreMap } from 'maplibre-gl';
import { vec4, type ReadonlyMat4 } from 'gl-matrix';
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
  TRIANGLE_INDICES,
  UV_CORNERS,
  DEG2RAD,
  computeSurfaceCornerShaderModel,
  type SurfaceCorner,
  type QuadCorner,
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
  MutableSpriteScreenPoint,
} from './internalTypes';
import type {
  SpriteAnchor,
  SpriteImageOffset,
  SpriteLocation,
  SpritePoint,
  SpriteScreenPoint,
} from './types';

//////////////////////////////////////////////////////////////////////////////////////

const MIN_CLIP_W = 1e-6;

//////////////////////////////////////////////////////////////////////////////////////

export type RenderTargetEntryLike<T> = readonly [
  InternalSpriteCurrentState<T>,
  InternalSpriteImageState,
];

export interface DepthSortedItem<T> {
  readonly sprite: InternalSpriteCurrentState<T>;
  readonly image: InternalSpriteImageState;
  readonly resource: Readonly<RegisteredImage>;
  readonly depthKey: number;
}

export interface CollectDepthSortedItemsOptions<T> {
  readonly bucket: readonly Readonly<RenderTargetEntryLike<T>>[];
  readonly mapInstance: MapLibreMap;
  readonly images: ReadonlyMap<string, Readonly<RegisteredImage>>;
  readonly clipContext: Readonly<ClipContext> | null;
  readonly zoom: number;
  readonly zoomScaleFactor: number;
  readonly baseMetersPerPixel: number;
  readonly spriteMinPixel: number;
  readonly spriteMaxPixel: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly pixelRatio: number;
  readonly originCenterCache: ImageCenterCache;
  readonly resolveSpriteMercator: (
    sprite: Readonly<InternalSpriteCurrentState<T>>
  ) => MercatorCoordinate;
  readonly defaultAnchor: SpriteAnchor;
  readonly defaultImageOffset: SpriteImageOffset;
  readonly enableNdcBiasSurface: boolean;
  readonly orderMax: number;
  readonly orderBucket: number;
  readonly epsNdc: number;
  readonly minClipZEpsilon: number;
}

export const collectDepthSortedItems = <T>({
  bucket,
  mapInstance,
  images,
  clipContext,
  zoom,
  zoomScaleFactor,
  baseMetersPerPixel,
  spriteMinPixel,
  spriteMaxPixel,
  drawingBufferWidth,
  drawingBufferHeight,
  pixelRatio,
  originCenterCache,
  resolveSpriteMercator,
  defaultAnchor,
  defaultImageOffset,
  enableNdcBiasSurface,
  orderMax,
  orderBucket,
  epsNdc,
  minClipZEpsilon,
}: CollectDepthSortedItemsOptions<T>): DepthSortedItem<T>[] => {
  const itemsWithDepth: DepthSortedItem<T>[] = [];

  const projectToClipSpace: ProjectToClipSpaceFn = (location) =>
    projectLngLatToClipSpace(location, clipContext);

  const unprojectPoint: UnprojectPointFn = (point: SpriteScreenPoint) => {
    return mapInstance.unproject([point.x, point.y]);
  };

  for (const [spriteEntry, imageEntry] of bucket) {
    const imageResource = images.get(imageEntry.imageId);
    if (!imageResource || !imageResource.texture) {
      continue;
    }

    const projected = mapInstance.project(spriteEntry.currentLocation);
    if (!projected) {
      continue;
    }

    const spriteMercator = resolveSpriteMercator(spriteEntry);
    const metersPerPixelAtLat = calculateMetersPerPixelAtLatitude(
      zoom,
      spriteEntry.currentLocation.lat
    );
    if (!Number.isFinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0) {
      continue;
    }

    const perspectiveRatio = calculatePerspectiveRatio(
      mapInstance,
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
      mapInstance,
      images,
      originCenterCache,
      projected,
      zoomScaleFactor,
      baseMetersPerPixel,
      spriteMinPixel,
      spriteMaxPixel,
      effectivePixelsPerMeter,
      drawingBufferWidth,
      drawingBufferHeight,
      pixelRatio,
      clipContext,
    };

    const anchorResolved = imageEntry.anchor ?? defaultAnchor;
    const offsetResolved = imageEntry.offset ?? defaultImageOffset;

    const depthCenter = computeImageCenterXY(
      spriteEntry,
      imageEntry,
      centerParams,
      { useResolvedAnchor: true }
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
              {
                useResolvedAnchor:
                  imageEntry.originLocation.useResolvedAnchor ?? false,
              }
            );
            const baseLngLatLike = mapInstance.unproject([
              baseCenter.x,
              baseCenter.y,
            ]);
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
          biasFn: enableNdcBiasSurface
            ? ({ clipZ, clipW }) => {
                const orderIndex = Math.min(imageEntry.order, orderMax - 1);
                const biasIndex =
                  imageEntry.subLayer * orderBucket + orderIndex;
                const biasNdc = -(biasIndex * epsNdc);
                const biasedClipZ = clipZ + biasNdc * clipW;
                const minClipZ = -clipW + minClipZEpsilon;
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
 * Cache entry storing anchor-adjusted and raw centers for a sprite image.
 */
export interface ImageCenterCacheEntry {
  readonly anchorApplied?: SpritePoint;
  readonly anchorless?: SpritePoint;
}

/**
 * Nested cache keyed by sprite ID and image key to avoid recomputing centers each frame.
 */
export type ImageCenterCache = Map<string, Map<string, ImageCenterCacheEntry>>;

/**
 * Parameters required to determine an image center in screen space.
 */
export interface ComputeImageCenterParams {
  readonly mapInstance: MapLibreMap;
  readonly images: ReadonlyMap<string, Readonly<RegisteredImage>>;
  readonly originCenterCache: ImageCenterCache;
  readonly projected: Readonly<SpriteScreenPoint>;
  readonly zoomScaleFactor: number;
  readonly baseMetersPerPixel: number;
  readonly spriteMinPixel: number;
  readonly spriteMaxPixel: number;
  readonly effectivePixelsPerMeter: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly pixelRatio: number;
  readonly clipContext: Readonly<ClipContext> | null;
}

export const calculatePerspectiveRatio = (
  mapInstance: MapLibreMap,
  location: Readonly<SpriteLocation>,
  cachedMercator?: Readonly<MercatorCoordinate>
): number => {
  const transform = mapInstance.transform;
  if (!transform) {
    return 1.0;
  }

  // DIRTY: Refers internal mercator matrix... How to extract with safe method?
  const mercatorMatrix: ReadonlyMat4 | undefined =
    (transform as any).mercatorMatrix ?? (transform as any)._mercatorMatrix;
  const cameraToCenterDistance: number | undefined =
    transform.cameraToCenterDistance;

  if (
    !mercatorMatrix ||
    typeof cameraToCenterDistance !== 'number' ||
    !Number.isFinite(cameraToCenterDistance)
  ) {
    return 1.0;
  }

  try {
    const mercator =
      cachedMercator ??
      MercatorCoordinate.fromLngLat(location, location.z ?? 0);
    const position = vec4.fromValues(
      mercator.x,
      mercator.y,
      mercator.z ?? 0,
      1
    );

    vec4.transformMat4(position, position, mercatorMatrix);
    const w = position[3];
    if (!Number.isFinite(w) || w <= 0) {
      return 1.0;
    }
    const ratio = cameraToCenterDistance / w;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1.0;
  } catch {
    return 1.0;
  }
};

/**
 * Projects a longitude/latitude/elevation tuple into clip space using the provided context.
 * @param {number} lng - Longitude in degrees.
 * @param {number} lat - Latitude in degrees.
 * @param {number} elevationMeters - Elevation above the ellipsoid in meters.
 * @param {ClipContext | null} context - Clip-space context; `null` skips projection.
 * @returns {[number, number, number, number] | null} Clip coordinates or `null` when projection fails.
 */
export const projectLngLatToClipSpace = (
  location: Readonly<SpriteLocation>,
  context: Readonly<ClipContext> | null
): [number, number, number, number] | null => {
  if (!context) {
    return null;
  }
  const { mercatorMatrix } = context;
  const coord = MercatorCoordinate.fromLngLat(location, location.z);
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
 * Computes the screen-space center of an image, caching anchor-dependent results.
 * @template T Sprite tag type.
 * @param {InternalSpriteCurrentState<T>} sprite - Sprite that owns the image.
 * @param {InternalSpriteImageState} img - Image state to evaluate.
 * @param {ComputeImageCenterParams} params - Precomputed scaling and projection context.
 * @param {{ useResolvedAnchor?: boolean }} [options] - When true, returns the anchor-applied center.
 * @returns {SpriteScreenPoint} Screen-space coordinates for the requested center variant.
 */
export const computeImageCenterXY = <T>(
  sprite: Readonly<InternalSpriteCurrentState<T>>,
  img: Readonly<InternalSpriteImageState>,
  params: Readonly<ComputeImageCenterParams>,
  options?: { useResolvedAnchor?: boolean }
): SpriteScreenPoint => {
  const {
    originCenterCache,
    projected,
    zoomScaleFactor,
    baseMetersPerPixel,
    spriteMinPixel,
    spriteMaxPixel,
    effectivePixelsPerMeter,
    images,
    mapInstance,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio,
    clipContext,
  } = params;

  // Decide whether to return the anchor-adjusted center or the raw projected location.
  const useResolvedAnchor = options?.useResolvedAnchor ?? false;

  let spriteCache = originCenterCache.get(sprite.spriteId);
  if (!spriteCache) {
    // Initialize a new cache bucket for this sprite when none exists yet.
    spriteCache = new Map<string, ImageCenterCacheEntry>();
    originCenterCache.set(sprite.spriteId, spriteCache);
  }

  const cacheKey = `${img.subLayer}:${img.order}`;
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
  if (img.originLocation !== undefined) {
    const ref = sprite.images
      .get(img.originLocation.subLayer)
      ?.get(img.originLocation.order);
    if (ref) {
      const refCenter = computeImageCenterXY(sprite, ref, params, {
        useResolvedAnchor: img.originLocation.useResolvedAnchor ?? false,
      });
      base = refCenter;
    }
  }

  const totalRotDeg = Number.isFinite(img.displayedRotateDeg)
    ? img.displayedRotateDeg
    : normalizeAngleDeg(
        (img.resolvedBaseRotateDeg ?? 0) + (img.rotateDeg ?? 0)
      );
  const imageScaleLocal = img.scale ?? 1;
  const imageResourceRef = images.get(img.imageId);

  if (img.mode === 'billboard') {
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
      anchor: img.anchor,
      offset: img.offset,
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
    img.originLocation !== undefined
      ? // When anchored to another image, reproject the 2D reference point back to geographic space.
        mapInstance.unproject([base.x, base.y])
      : // Otherwise use the sprite's own interpolated geographic location.
        sprite.currentLocation;

  const projectToClipSpace: ProjectToClipSpaceFn | undefined = clipContext
    ? (location) => projectLngLatToClipSpace(location, clipContext)
    : undefined;

  const surfacePlacement = calculateSurfaceCenterPosition({
    baseLngLat,
    imageWidth: imageResourceRef?.width,
    imageHeight: imageResourceRef?.height,
    baseMetersPerPixel,
    imageScale: imageScaleLocal,
    zoomScaleFactor,
    totalRotateDeg: totalRotDeg,
    anchor: img.anchor,
    offset: img.offset,
    effectivePixelsPerMeter,
    spriteMinPixel,
    spriteMaxPixel,
    projectToClipSpace,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio,
    resolveAnchorless: true,
    project: projectToClipSpace === undefined ? mapInstance.project : undefined,
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

const CORNER_EAST = { east: 1, north: 0 } as const;
const CORNER_NORTH = { east: 0, north: 1 } as const;

const calculateWorldToMercatorScale = (
  base: Readonly<SpriteLocation>
): SurfaceCorner => {
  const origin = MercatorCoordinate.fromLngLat(base, base.z);
  const eastLngLat = applySurfaceDisplacement(base, CORNER_EAST);
  const eastCoord = MercatorCoordinate.fromLngLat(eastLngLat, eastLngLat.z);
  const northLngLat = applySurfaceDisplacement(base, CORNER_NORTH);
  const northCoord = MercatorCoordinate.fromLngLat(northLngLat, northLngLat.z);
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

  const mercatorCenter = MercatorCoordinate.fromLngLat(displacedCenter);

  const worldToMercatorScale = calculateWorldToMercatorScale(displacedCenter);

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

interface PrepareSpriteImageDrawOptions<T> {
  readonly spriteEntry: Readonly<InternalSpriteCurrentState<T>>;
  readonly imageEntry: InternalSpriteImageState;
  readonly imageResource: Readonly<RegisteredImage>;
  readonly originCenterCache: ImageCenterCache;
  readonly mapInstance: MapLibreMap;
  readonly images: ReadonlyMap<string, Readonly<RegisteredImage>>;
  readonly spriteMercator: Readonly<MercatorCoordinate>;
  readonly zoom: number;
  readonly zoomScaleFactor: number;
  readonly baseMetersPerPixel: number;
  readonly spriteMinPixel: number;
  readonly spriteMaxPixel: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly pixelRatio: number;
  readonly clipContext: Readonly<ClipContext> | null;
  readonly identityScaleX: number;
  readonly identityScaleY: number;
  readonly identityOffsetX: number;
  readonly identityOffsetY: number;
  readonly screenToClipScaleX: number;
  readonly screenToClipScaleY: number;
  readonly screenToClipOffsetX: number;
  readonly screenToClipOffsetY: number;
  readonly defaultAnchor: Readonly<SpriteAnchor>;
  readonly defaultImageOffset: Readonly<SpriteImageOffset>;
  readonly useShaderSurfaceGeometry: boolean;
  readonly useShaderBillboardGeometry: boolean;
  readonly enableNdcBiasSurface: boolean;
  readonly orderMax: number;
  readonly orderBucket: number;
  readonly epsNdc: number;
  readonly minClipZEpsilon: number;
  readonly slDebug: boolean;
  readonly ensureHitTestCorners: (
    imageEntry: Readonly<InternalSpriteImageState>
  ) => [
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
  ];
}

export interface PrepareSpriteImageDrawResult<T> {
  readonly spriteEntry: InternalSpriteCurrentState<T>;
  readonly imageEntry: InternalSpriteImageState;
  readonly imageResource: RegisteredImage;
  readonly vertexData: Float32Array;
  readonly opacity: number;
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
 * Prepares quad data for a single sprite image before issuing the draw call.
 * @returns {boolean} `true` when the sprite image is ready to draw; `false` when skipped.
 */
const prepareSpriteImageDraw = <T>(
  options: PrepareSpriteImageDrawOptions<T>
): PrepareSpriteImageDrawResult<T> | null => {
  const {
    spriteEntry,
    imageEntry,
    imageResource,
    originCenterCache,
    mapInstance,
    images,
    spriteMercator,
    zoom,
    zoomScaleFactor,
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
    defaultAnchor,
    defaultImageOffset,
    useShaderSurfaceGeometry,
    useShaderBillboardGeometry,
    enableNdcBiasSurface,
    orderMax,
    orderBucket,
    epsNdc,
    minClipZEpsilon,
    slDebug,
    ensureHitTestCorners,
  } = options;

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
  const anchor = imageEntry.anchor ?? defaultAnchor;
  const offsetDef = imageEntry.offset ?? defaultImageOffset;
  // Prefer the dynamically interpolated rotation when available; otherwise synthesize it from base + manual rotations.
  const totalRotateDeg = Number.isFinite(imageEntry.displayedRotateDeg)
    ? imageEntry.displayedRotateDeg
    : normalizeAngleDeg(
        (imageEntry.resolvedBaseRotateDeg ?? 0) + (imageEntry.rotateDeg ?? 0)
      );

  const projected = mapInstance.project(spriteEntry.currentLocation);
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

  const perspectiveRatio = calculatePerspectiveRatio(
    mapInstance,
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
    mapInstance,
    images,
    originCenterCache,
    projected,
    zoomScaleFactor,
    baseMetersPerPixel,
    spriteMinPixel,
    spriteMaxPixel,
    effectivePixelsPerMeter,
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
      baseProjected = computeImageCenterXY(spriteEntry, refImg, centerParams, {
        useResolvedAnchor: imageEntry.originLocation.useResolvedAnchor ?? false,
      });
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
          mapInstance.unproject([baseProjected.x, baseProjected.y])
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
        projectLngLatToClipSpace(location, clipContext),
      drawingBufferWidth,
      drawingBufferHeight,
      pixelRatio,
      project: !clipContext ? mapInstance.project : undefined,
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

    const orderIndex = Math.min(imageEntry.order, orderMax - 1);
    const depthBiasNdc = enableNdcBiasSurface
      ? -((imageEntry.subLayer * orderBucket + orderIndex) * epsNdc)
      : 0;

    const displacedCenter = surfaceCenter.displacedLngLat ?? baseLngLat;

    const surfaceShaderInputs = prepareSurfaceShaderInputs({
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

    useShaderSurface = useShaderSurfaceGeometry && !!clipContext;
    let clipCornerPositions: Array<[number, number, number, number]> | null =
      null;
    let clipCenterPosition: [number, number, number, number] | null = null;
    if (useShaderSurface) {
      clipCornerPositions = new Array(SURFACE_BASE_CORNERS.length) as Array<
        [number, number, number, number]
      >;
      clipCenterPosition = projectLngLatToClipSpace(
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
      slDebug ? [] : null;
    let bufferOffset = 0;
    // Iterate through each vertex defined by TRIANGLE_INDICES to populate the vertex buffer.
    for (const index of TRIANGLE_INDICES) {
      const displacement = cornerDisplacements[index]!;
      const displaced = applySurfaceDisplacement(baseLngLat, displacement);

      const clipPosition = projectLngLatToClipSpace(displaced, clipContext);
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
        const minClipZ = -clipW + minClipZEpsilon;
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

    if (slDebug) {
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

    if (slDebug) {
      (imageEntry as any).__billboardShaderInputs = billboardShaderInputs;
    }

    useShaderBillboard = useShaderBillboardGeometry;
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
      if (slDebug) {
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

    if (slDebug) {
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

export interface PrepareSpriteEachImageDrawOptions<T> {
  readonly items: readonly Readonly<DepthSortedItem<T>>[];
  readonly originCenterCache: ImageCenterCache;
  readonly mapInstance: MapLibreMap;
  readonly images: ReadonlyMap<string, Readonly<RegisteredImage>>;
  readonly zoom: number;
  readonly zoomScaleFactor: number;
  readonly baseMetersPerPixel: number;
  readonly spriteMinPixel: number;
  readonly spriteMaxPixel: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly pixelRatio: number;
  readonly clipContext: Readonly<ClipContext> | null;
  readonly identityScaleX: number;
  readonly identityScaleY: number;
  readonly identityOffsetX: number;
  readonly identityOffsetY: number;
  readonly screenToClipScaleX: number;
  readonly screenToClipScaleY: number;
  readonly screenToClipOffsetX: number;
  readonly screenToClipOffsetY: number;
  readonly defaultAnchor: Readonly<SpriteAnchor>;
  readonly defaultImageOffset: Readonly<SpriteImageOffset>;
  readonly useShaderSurfaceGeometry: boolean;
  readonly useShaderBillboardGeometry: boolean;
  readonly enableNdcBiasSurface: boolean;
  readonly orderMax: number;
  readonly orderBucket: number;
  readonly epsNdc: number;
  readonly minClipZEpsilon: number;
  readonly slDebug: boolean;
  readonly ensureHitTestCorners: (
    imageEntry: Readonly<InternalSpriteImageState>
  ) => [
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
    MutableSpriteScreenPoint,
  ];
  readonly resolveSpriteMercator: (
    sprite: Readonly<InternalSpriteCurrentState<T>>
  ) => MercatorCoordinate;
}

export const prepareSpriteEachImageDraw = <T>({
  items,
  originCenterCache,
  mapInstance,
  images,
  zoom,
  zoomScaleFactor,
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
  defaultAnchor,
  defaultImageOffset,
  useShaderSurfaceGeometry,
  useShaderBillboardGeometry,
  enableNdcBiasSurface,
  orderMax,
  orderBucket,
  epsNdc,
  minClipZEpsilon,
  slDebug,
  ensureHitTestCorners,
  resolveSpriteMercator,
}: PrepareSpriteEachImageDrawOptions<T>): PrepareSpriteImageDrawResult<T>[] => {
  const preparedItems: PrepareSpriteImageDrawResult<T>[] = [];

  for (const item of items) {
    const prepared = prepareSpriteImageDraw({
      spriteEntry: item.sprite,
      imageEntry: item.image,
      imageResource: item.resource,
      originCenterCache,
      mapInstance,
      images,
      spriteMercator: resolveSpriteMercator(item.sprite),
      zoom,
      zoomScaleFactor,
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
      defaultAnchor,
      defaultImageOffset,
      useShaderSurfaceGeometry,
      useShaderBillboardGeometry,
      enableNdcBiasSurface,
      orderMax,
      orderBucket,
      epsNdc,
      minClipZEpsilon,
      slDebug,
      ensureHitTestCorners,
    });

    if (prepared) {
      preparedItems.push(prepared);
    } else {
      item.image.surfaceShaderInputs = undefined;
    }
  }

  return preparedItems;
};
