// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it, vi } from 'vitest';
import { MercatorCoordinate, type Map as MapLibreMap } from 'maplibre-gl';

import { createMapLibreProjectionHost } from '../src/host/mapLibreProjectionHost';
import {
  collectDepthSortedItemsInternal,
  prepareDrawSpriteImageInternal,
  processInterpolationsInternal,
  type ProcessInterpolationsEvaluationHandlers,
  type ProcessInterpolationPresetRequests,
} from '../src/host/calculationHost';
import {
  createImageHandleBufferController,
  createRenderTargetBucketBuffers,
  createSpriteOriginReference,
} from '../src/utils/utils';
import {
  applyOpacityUpdate,
  stepSpriteImageInterpolations,
} from '../src/interpolation/interpolationChannels';
import {
  calculateBillboardAnchorShiftPixels,
  calculateZoomScaleFactor,
  resolveScalingOptions,
  type ResolvedSpriteScalingOptions,
} from '../src/utils/math';
import type {
  ClipContext,
  InternalSpriteCurrentState,
  InternalSpriteImageState,
  ProjectionHost,
  RegisteredImage,
  SpriteMercatorCoordinate,
  PrepareDrawSpriteImageParamsBefore,
  PrepareDrawSpriteImageParamsAfter,
  PreparedDrawSpriteImageParams,
} from '../src/internalTypes';
import {
  SPRITE_ORIGIN_REFERENCE_KEY_NONE,
  SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
} from '../src/internalTypes';
import type {
  SpriteAnchor,
  SpriteImageOffset,
  SpriteLocation,
  SpritePoint,
} from '../src/types';
import {
  EPS_NDC,
  ORDER_BUCKET,
  ORDER_MAX,
  TRIANGLE_INDICES,
} from '../src/const';
import { BILLBOARD_BASE_CORNERS, SURFACE_BASE_CORNERS } from '../src/gl/shader';
import { createDistanceInterpolationState } from '../src/interpolation/distanceInterpolation';
import { createInterpolationState } from '../src/interpolation/interpolation';

const SCALE = 256;
const IDENTITY_MATRIX = new Float64Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

const DEFAULT_ANCHOR: SpriteAnchor = { x: 0, y: 0 };
const DEFAULT_OFFSET: SpriteImageOffset = { offsetMeters: 0, offsetDeg: 0 };
const DEFAULT_CLIP_CONTEXT: ClipContext = { mercatorMatrix: IDENTITY_MATRIX };

type ProjectOverride = (
  location: Readonly<SpriteLocation>
) => SpritePoint | null;

type UnprojectOverride = (
  point: Readonly<SpritePoint>
) => SpriteLocation | null;

type FakeProjectionHostOptions = {
  readonly project?: ProjectOverride;
  readonly unproject?: UnprojectOverride;
  readonly fromLngLat?: (
    location: Readonly<SpriteLocation>
  ) => SpriteMercatorCoordinate;
  readonly clipContext?: ClipContext | null;
  readonly zoom?: number;
  readonly perspectiveRatio?:
    | number
    | ((
        location: Readonly<SpriteLocation>,
        cached?: SpriteMercatorCoordinate
      ) => number);
};

const createFakeProjectionHost = (
  options: FakeProjectionHostOptions = {}
): ProjectionHost => {
  const project =
    options.project ??
    ((location: Readonly<SpriteLocation>) => ({
      x: location.lng * SCALE,
      y: -location.lat * SCALE,
    }));
  const unproject =
    options.unproject ??
    ((point: Readonly<SpritePoint>) => ({
      lng: point.x / SCALE,
      lat: -point.y / SCALE,
    }));
  const fromLngLat =
    options.fromLngLat ??
    ((location: Readonly<SpriteLocation>): SpriteMercatorCoordinate => {
      const mercator = MercatorCoordinate.fromLngLat(
        { lng: location.lng, lat: location.lat },
        location.z ?? 0
      );
      return {
        x: mercator.x,
        y: mercator.y,
        z: mercator.z ?? 0,
      };
    });
  const clipContext =
    options.clipContext === undefined
      ? DEFAULT_CLIP_CONTEXT
      : options.clipContext;
  const zoom = options.zoom ?? 10;
  const perspective = options.perspectiveRatio;
  const defaultRatio = typeof perspective === 'number' ? perspective : 8;

  const calculatePerspectiveRatio: ProjectionHost['calculatePerspectiveRatio'] =
    typeof perspective === 'function' ? perspective : () => defaultRatio;

  const release = () => {};

  return {
    getZoom: () => zoom,
    getClipContext: () => clipContext,
    fromLngLat,
    project,
    unproject,
    calculatePerspectiveRatio,
    release,
  };
};

let nextImageHandle = 1;

const createImageResource = (id: string): RegisteredImage => ({
  id,
  handle: nextImageHandle++,
  width: 32,
  height: 32,
  bitmap: {} as ImageBitmap,
  texture: {} as WebGLTexture,
  atlasPageIndex: -1,
  atlasU0: 0,
  atlasV0: 0,
  atlasU1: 1,
  atlasV1: 1,
});

const originReference = createSpriteOriginReference();

const createImageState = (
  overrides: Partial<InternalSpriteImageState> = {}
): InternalSpriteImageState => {
  const originLocation = overrides.originLocation;
  const originReferenceKey =
    originLocation !== undefined
      ? originReference.encodeKey(originLocation.subLayer, originLocation.order)
      : SPRITE_ORIGIN_REFERENCE_KEY_NONE;
  const initialOpacity = overrides.opacity ?? 1;
  return {
    subLayer: overrides.subLayer ?? 0,
    order: overrides.order ?? 0,
    imageId: overrides.imageId ?? 'image',
    imageHandle: overrides.imageHandle ?? 0,
    mode: overrides.mode ?? 'billboard',
    opacity: initialOpacity,
    scale: overrides.scale ?? 1,
    anchor: overrides.anchor ?? DEFAULT_ANCHOR,
    offset: overrides.offset ?? DEFAULT_OFFSET,
    rotateDeg: overrides.rotateDeg ?? 0,
    displayedRotateDeg:
      overrides.displayedRotateDeg ?? overrides.rotateDeg ?? 0,
    autoRotation: overrides.autoRotation ?? false,
    autoRotationMinDistanceMeters: overrides.autoRotationMinDistanceMeters ?? 0,
    resolvedBaseRotateDeg: overrides.resolvedBaseRotateDeg ?? 0,
    originLocation,
    originReferenceKey: overrides.originReferenceKey ?? originReferenceKey,
    originRenderTargetIndex:
      overrides.originRenderTargetIndex ?? SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
    rotationInterpolationState: overrides.rotationInterpolationState ?? null,
    rotationInterpolationOptions:
      overrides.rotationInterpolationOptions ?? null,
    offsetDegInterpolationState: overrides.offsetDegInterpolationState ?? null,
    offsetMetersInterpolationState:
      overrides.offsetMetersInterpolationState ?? null,
    opacityInterpolationState: overrides.opacityInterpolationState ?? null,
    lastCommandRotateDeg: overrides.lastCommandRotateDeg ?? 0,
    lastCommandOffsetDeg: overrides.lastCommandOffsetDeg ?? 0,
    lastCommandOffsetMeters: overrides.lastCommandOffsetMeters ?? 0,
    lastCommandOpacity: overrides.lastCommandOpacity ?? initialOpacity,
    interpolationDirty: overrides.interpolationDirty ?? false,
    surfaceShaderInputs: overrides.surfaceShaderInputs,
    hitTestCorners: overrides.hitTestCorners,
  };
};

const createSpriteState = (
  spriteId: string,
  images: readonly InternalSpriteImageState[],
  overrides: Partial<InternalSpriteCurrentState<null>> = {}
): InternalSpriteCurrentState<null> => {
  const layers = new Map<number, Map<number, InternalSpriteImageState>>();
  images.forEach((image) => {
    if (!layers.has(image.subLayer)) {
      layers.set(image.subLayer, new Map());
    }
    layers.get(image.subLayer)!.set(image.order, image);
  });

  const currentLocation =
    overrides.currentLocation ?? ({ lng: 0, lat: 0, z: 0 } as SpriteLocation);
  const cachedMercator =
    overrides.cachedMercator ??
    MercatorCoordinate.fromLngLat(currentLocation, currentLocation.z ?? 0);

  return {
    spriteId,
    handle: overrides.handle ?? 0,
    isEnabled: overrides.isEnabled ?? true,
    currentLocation,
    fromLocation: overrides.fromLocation,
    toLocation: overrides.toLocation,
    images: layers,
    tag: overrides.tag ?? null,
    interpolationState: overrides.interpolationState ?? null,
    pendingInterpolationOptions: overrides.pendingInterpolationOptions ?? null,
    lastCommandLocation: overrides.lastCommandLocation ?? currentLocation,
    lastAutoRotationLocation:
      overrides.lastAutoRotationLocation ?? currentLocation,
    lastAutoRotationAngleDeg: overrides.lastAutoRotationAngleDeg ?? 0,
    interpolationDirty: overrides.interpolationDirty ?? false,
    cachedMercator,
    cachedMercatorLng: overrides.cachedMercatorLng ?? cachedMercator.x,
    cachedMercatorLat: overrides.cachedMercatorLat ?? cachedMercator.y,
    cachedMercatorZ: overrides.cachedMercatorZ ?? cachedMercator.z ?? 0,
  };
};

type ImageCenterCacheEntryLike = {
  readonly anchorApplied?: SpritePoint;
  readonly anchorless?: SpritePoint;
};

type ImageCenterCacheLike = Map<string, Map<string, ImageCenterCacheEntryLike>>;

type DepthItem<TTag> = {
  readonly sprite: InternalSpriteCurrentState<TTag>;
  readonly image: InternalSpriteImageState;
  readonly resource: RegisteredImage;
  readonly depthKey: number;
  readonly resolveOrigin: (
    sprite: InternalSpriteCurrentState<TTag>,
    image: InternalSpriteImageState
  ) => InternalSpriteImageState | null;
};

interface CollectContext {
  readonly projectionHost: ProjectionHost;
  readonly paramsBefore: PrepareDrawSpriteImageParamsBefore<null>;
  readonly originCenterCache: ImageCenterCacheLike;
  readonly zoom: number;
  readonly zoomScaleFactor: number;
}

interface CollectContextOverrides {
  readonly bucket?: readonly Readonly<
    [InternalSpriteCurrentState<null>, InternalSpriteImageState]
  >[];
  readonly projectionHost?: ProjectionHost;
  readonly projectionHostOptions?: FakeProjectionHostOptions;
  readonly images?: ReadonlyMap<string, Readonly<RegisteredImage>>;
  readonly clipContext?: Readonly<ClipContext> | null;
  readonly baseMetersPerPixel?: number;
  readonly spriteMinPixel?: number;
  readonly spriteMaxPixel?: number;
  readonly drawingBufferWidth?: number;
  readonly drawingBufferHeight?: number;
  readonly pixelRatio?: number;
  readonly resolvedScaling?: ResolvedSpriteScalingOptions;
  readonly zoom?: number;
  readonly zoomScaleFactor?: number;
  readonly originCenterCache?: ImageCenterCacheLike;
}

const createCollectContext = (
  overrides: CollectContextOverrides = {}
): CollectContext => {
  const {
    projectionHost: projectionHostOverride,
    projectionHostOptions,
    bucket = [],
    images = new Map<string, RegisteredImage>(),
    clipContext: clipOverride,
    baseMetersPerPixel = 1,
    spriteMinPixel = 0,
    spriteMaxPixel = 4096,
    drawingBufferWidth = 1024,
    drawingBufferHeight = 768,
    pixelRatio = 1,
    resolvedScaling: resolvedScalingOverride,
    zoom: zoomOverride,
    zoomScaleFactor: zoomScaleFactorOverride,
    originCenterCache: originCacheOverride,
  } = overrides;

  const projectionHost =
    projectionHostOverride ?? createFakeProjectionHost(projectionHostOptions);
  const clipContext =
    clipOverride === undefined ? projectionHost.getClipContext() : clipOverride;

  const zoom = zoomOverride ?? projectionHost.getZoom();
  const resolvedScaling =
    resolvedScalingOverride ??
    resolveScalingOptions({
      metersPerPixel: baseMetersPerPixel,
      spriteMinPixel,
      spriteMaxPixel,
      zoomMin: zoom,
      zoomMax: zoom,
    });
  const zoomScaleFactor =
    zoomScaleFactorOverride ?? calculateZoomScaleFactor(zoom, resolvedScaling);

  const originIndexBySprite = new Map<string, Map<number, number>>();

  bucket.forEach(([sprite, image], index) => {
    const resource = images.get(image.imageId);
    image.imageHandle = resource ? resource.handle : image.imageHandle;
    image.originReferenceKey =
      image.originLocation !== undefined
        ? originReference.encodeKey(
            image.originLocation.subLayer,
            image.originLocation.order
          )
        : SPRITE_ORIGIN_REFERENCE_KEY_NONE;

    let indexMap = originIndexBySprite.get(sprite.spriteId);
    if (!indexMap) {
      indexMap = new Map();
      originIndexBySprite.set(sprite.spriteId, indexMap);
    }
    const selfKey = originReference.encodeKey(image.subLayer, image.order);
    indexMap.set(selfKey, index);
  });

  bucket.forEach(([sprite, image]) => {
    if (image.originReferenceKey === SPRITE_ORIGIN_REFERENCE_KEY_NONE) {
      image.originRenderTargetIndex = SPRITE_ORIGIN_REFERENCE_INDEX_NONE;
      return;
    }
    const indexMap = originIndexBySprite.get(sprite.spriteId);
    image.originRenderTargetIndex =
      indexMap?.get(image.originReferenceKey) ??
      SPRITE_ORIGIN_REFERENCE_INDEX_NONE;
  });

  const bucketBuffers = createRenderTargetBucketBuffers(bucket, {
    originReference,
  });

  const handleController = createImageHandleBufferController();
  handleController.markDirty(images);
  const imageHandleBuffers = handleController.ensure();
  const imageResources = handleController.getResourcesByHandle();

  const paramsBefore: PrepareDrawSpriteImageParamsBefore<null> = {
    bucket,
    bucketBuffers,
    imageResources,
    imageHandleBuffers,
    clipContext,
    baseMetersPerPixel,
    spriteMinPixel,
    spriteMaxPixel,
    drawingBufferWidth,
    drawingBufferHeight,
    pixelRatio,
    resolvedScaling,
    zoomScaleFactor,
  };

  return {
    projectionHost,
    paramsBefore,
    originCenterCache:
      originCacheOverride ?? (new Map() as ImageCenterCacheLike),
    zoom,
    zoomScaleFactor,
  };
};

const createAfterParams = (
  before: PrepareDrawSpriteImageParamsBefore<null>,
  overrides: Partial<
    Omit<
      PrepareDrawSpriteImageParamsAfter,
      | 'images'
      | 'baseMetersPerPixel'
      | 'spriteMinPixel'
      | 'spriteMaxPixel'
      | 'drawingBufferWidth'
      | 'drawingBufferHeight'
      | 'pixelRatio'
    >
  > = {}
): PrepareDrawSpriteImageParamsAfter => {
  return {
    imageResources: before.imageResources,
    imageHandleBuffers: before.imageHandleBuffers,
    baseMetersPerPixel: before.baseMetersPerPixel,
    spriteMinPixel: before.spriteMinPixel,
    spriteMaxPixel: before.spriteMaxPixel,
    drawingBufferWidth: before.drawingBufferWidth,
    drawingBufferHeight: before.drawingBufferHeight,
    pixelRatio: before.pixelRatio,
    clipContext:
      overrides.clipContext === undefined
        ? before.clipContext
        : overrides.clipContext,
    identityScaleX: overrides.identityScaleX ?? 1,
    identityScaleY: overrides.identityScaleY ?? 1,
    identityOffsetX: overrides.identityOffsetX ?? 0,
    identityOffsetY: overrides.identityOffsetY ?? 0,
    screenToClipScaleX:
      overrides.screenToClipScaleX ?? 2 / before.drawingBufferWidth,
    screenToClipScaleY:
      overrides.screenToClipScaleY ?? -2 / before.drawingBufferHeight,
    screenToClipOffsetX: overrides.screenToClipOffsetX ?? -1,
    screenToClipOffsetY: overrides.screenToClipOffsetY ?? 1,
  };
};

const prepareItems = (
  context: CollectContext,
  items: readonly DepthItem<null>[],
  overrides: Parameters<typeof createAfterParams>[1] = {}
): PreparedDrawSpriteImageParams<null>[] => {
  const paramsAfter = createAfterParams(context.paramsBefore, overrides);
  const originCenterCache: ImageCenterCacheLike = new Map();
  const prepared: PreparedDrawSpriteImageParams<null>[] = [];
  for (const item of items) {
    const result = prepareDrawSpriteImageInternal(
      context.projectionHost,
      item,
      context.zoom,
      context.zoomScaleFactor,
      originCenterCache,
      paramsAfter
    );
    if (result) {
      prepared.push(result);
    } else {
      item.image.surfaceShaderInputs = undefined;
    }
  }
  return prepared;
};

describe('calculatePerspectiveRatio', () => {
  const location: SpriteLocation = { lng: 0, lat: 0, z: 0 };

  const createMapStub = (
    params?: {
      readonly mercatorMatrix?: Float64Array | null;
      readonly fallbackMatrix?: Float64Array | null;
      readonly cameraDistance?: number;
    } | null
  ): MapLibreMap => {
    const transform =
      params === undefined
        ? {
            mercatorMatrix: IDENTITY_MATRIX,
            _mercatorMatrix: IDENTITY_MATRIX,
            cameraToCenterDistance: 8,
          }
        : params === null
          ? undefined
          : {
              mercatorMatrix: params.mercatorMatrix ?? undefined,
              _mercatorMatrix: params.fallbackMatrix ?? IDENTITY_MATRIX,
              cameraToCenterDistance: params.cameraDistance ?? 8,
            };
    return {
      getZoom: () => 10,
      project: (lngLat: SpriteLocation | [number, number]) => {
        const { lng, lat } = Array.isArray(lngLat)
          ? { lng: lngLat[0] ?? 0, lat: lngLat[1] ?? 0 }
          : { lng: lngLat.lng, lat: lngLat.lat };
        return {
          x: lng * SCALE,
          y: -lat * SCALE,
        };
      },
      unproject: ([x, y]: [number, number]) => ({
        lng: x / SCALE,
        lat: -y / SCALE,
        z: 0,
      }),
      transform,
    } as unknown as MapLibreMap;
  };

  it('derives the ratio from the mercator matrix and camera distance', () => {
    const map = createMapStub({
      mercatorMatrix: IDENTITY_MATRIX,
      fallbackMatrix: IDENTITY_MATRIX,
      cameraDistance: 12,
    });
    const host = createMapLibreProjectionHost(map);
    expect(host.calculatePerspectiveRatio(location)).toBeCloseTo(12, 6);
  });

  it('falls back to _mercatorMatrix when mercatorMatrix is unavailable', () => {
    const map = createMapStub({
      mercatorMatrix: undefined,
      fallbackMatrix: IDENTITY_MATRIX,
      cameraDistance: 5,
    });
    const host = createMapLibreProjectionHost(map);
    expect(host.calculatePerspectiveRatio(location)).toBeCloseTo(5, 6);
  });

  it('falls back to 1 when transform is unavailable', () => {
    const map = createMapStub(null);
    const host = createMapLibreProjectionHost(map);
    expect(host.calculatePerspectiveRatio(location)).toBe(1);
  });
});

describe('collectDepthSortedItems', () => {
  it('gathers billboard entries and sorts by order when depth ties', () => {
    const imageA = createImageState({ imageId: 'icon-a', order: 2 });
    const imageB = createImageState({ imageId: 'icon-b', order: 1 });
    const sprite = createSpriteState('sprite-a', [imageA, imageB]);

    const resources = new Map<string, RegisteredImage>([
      ['icon-a', createImageResource('icon-a')],
      ['icon-b', createImageResource('icon-b')],
    ]);

    const context = createCollectContext({
      bucket: [[sprite, imageA] as const, [sprite, imageB] as const],
      images: resources,
    });

    const result = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.image.order)).toEqual([1, 2]);
  });

  it('breaks depth ties by sprite identifier', () => {
    const sharedLocation: SpriteLocation = { lng: 139.7, lat: 35.6, z: 0 };

    const imageFirst = createImageState({ imageId: 'lex-a', order: 0 });
    const spriteFirst = createSpriteState('sprite-1', [imageFirst], {
      currentLocation: sharedLocation,
    });

    const imageSecond = createImageState({ imageId: 'lex-b', order: 0 });
    const spriteSecond = createSpriteState('sprite-2', [imageSecond], {
      currentLocation: sharedLocation,
    });

    const images = new Map<string, RegisteredImage>([
      ['lex-a', createImageResource('lex-a')],
      ['lex-b', createImageResource('lex-b')],
    ]);

    const context = createCollectContext({
      bucket: [
        [spriteSecond, imageSecond] as const,
        [spriteFirst, imageFirst] as const,
      ],
      images,
    });

    const items = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];
    expect(items).toHaveLength(2);
    const firstItem = items[0]!;
    const secondItem = items[1]!;
    expect(firstItem.sprite.spriteId).toBe('sprite-1');
    expect(secondItem.sprite.spriteId).toBe('sprite-2');
  });

  it('skips entries when clip context is unavailable for projection', () => {
    const image = createImageState({ imageId: 'noclip', order: 0 });
    const sprite = createSpriteState('sprite-noclip', [image]);
    const resource = createImageResource('noclip');

    const context = createCollectContext({
      bucket: [[sprite, image] as const],
      images: new Map([['noclip', resource]]),
      clipContext: null,
    });

    const items = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];
    expect(items).toHaveLength(0);
  });

  it('applies NDC bias when sorting surface entries', () => {
    const surfaceBase = createImageState({
      imageId: 'surface-base',
      mode: 'surface',
      order: 0,
    });
    const surfaceFront = createImageState({
      imageId: 'surface-front',
      mode: 'surface',
      order: 3,
    });
    const sprite = createSpriteState('sprite-surface', [
      surfaceBase,
      surfaceFront,
    ]);

    const resources = new Map<string, RegisteredImage>([
      ['surface-base', createImageResource('surface-base')],
      ['surface-front', createImageResource('surface-front')],
    ]);

    const context = createCollectContext({
      bucket: [[sprite, surfaceBase] as const, [sprite, surfaceFront] as const],
      images: resources,
      clipContext: DEFAULT_CLIP_CONTEXT,
      originCenterCache: new Map(),
    });

    const biased = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];

    expect(biased).toHaveLength(2);
    const baseItem = biased[0]!;
    const frontItem = biased[1]!;
    const delta = Math.abs(frontItem.depthKey - baseItem.depthKey);
    const expectedDelta =
      (Math.min(surfaceFront.order, ORDER_MAX - 1) -
        Math.min(surfaceBase.order, ORDER_MAX - 1)) *
      EPS_NDC;

    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeCloseTo(expectedDelta, 6);
  });

  it('skips entries whose textures are not uploaded', () => {
    const image = createImageState({ imageId: 'icon-c' });
    const sprite = createSpriteState('sprite-b', [image]);

    const resource: RegisteredImage = {
      ...createImageResource('icon-c'),
      texture: undefined,
    };

    const context = createCollectContext({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-c', resource]]),
    });

    const result = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];
    expect(result).toHaveLength(0);
  });
});

describe('prepareDrawSpriteImages', () => {
  it('prepares billboard draw data when inputs are valid', () => {
    const resource = createImageResource('icon-d');
    const image = createImageState({ imageId: 'icon-d', order: 0 });
    const sprite = createSpriteState('sprite-c', [image]);

    const context = createCollectContext({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-d', resource]]),
    });
    const items = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];

    const prepared = prepareItems(context, items);

    expect(prepared).toHaveLength(1);
    const draw = prepared[0]!;
    expect(draw.spriteEntry).toBe(sprite);
    expect(draw.imageEntry).toBe(image);
    expect(draw.imageResource).toBe(resource);
    expect(draw.vertexData.length).toBe(TRIANGLE_INDICES.length * 6);
    expect(draw.screenToClip).toEqual({
      scaleX: 2 / context.paramsBefore.drawingBufferWidth,
      scaleY: -2 / context.paramsBefore.drawingBufferHeight,
      offsetX: -1,
      offsetY: 1,
    });
    expect(draw.hitTestCorners).not.toBeNull();
    expect(image.surfaceShaderInputs).toBeUndefined();
  });

  it('propagates interpolated opacity into prepared draw params', () => {
    const resource = createImageResource('icon-fade');
    const image = createImageState({ imageId: 'icon-fade', order: 0 });
    applyOpacityUpdate(image, 0, { durationMs: 1000, easing: (t) => t });
    stepSpriteImageInterpolations(image, 0);
    stepSpriteImageInterpolations(image, 500);

    const sprite = createSpriteState('sprite-fade', [image]);

    const context = createCollectContext({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-fade', resource]]),
    });
    const items = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];

    const prepared = prepareItems(context, items);

    expect(prepared).toHaveLength(1);
    const singlePrepared = prepared[0]!;
    expect(singlePrepared.opacity).toBeCloseTo(0.5, 6);
  });

  it('uses billboard shader geometry when enabled', () => {
    const resource = createImageResource('icon-billboard');
    const image = createImageState({ imageId: 'icon-billboard', order: 1 });
    const sprite = createSpriteState('sprite-billboard', [image]);

    const context = createCollectContext({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-billboard', resource]]),
    });
    const items = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];

    const prepared = prepareItems(context, items);

    expect(prepared).toHaveLength(1);
    const draw = prepared[0]!;
    expect(draw.useShaderBillboard).toBe(true);
    expect(draw.billboardUniforms).not.toBeNull();
    expect(draw.surfaceShaderInputs).toBeUndefined();
    for (let i = 0; i < TRIANGLE_INDICES.length; i++) {
      const baseCornerIndex = TRIANGLE_INDICES[i]!;
      const baseCorner = BILLBOARD_BASE_CORNERS[baseCornerIndex]!;
      const dataIndex = i * 6;
      expect(draw.vertexData[dataIndex]).toBeCloseTo(baseCorner[0], 6);
      expect(draw.vertexData[dataIndex + 1]).toBeCloseTo(baseCorner[1], 6);
      expect(draw.vertexData[dataIndex + 2]).toBe(0);
      expect(draw.vertexData[dataIndex + 3]).toBe(1);
    }
  });

  it('falls back to CPU surface path when clip context is unavailable', () => {
    const resource = createImageResource('icon-surface-cpu');
    const image = createImageState({
      imageId: 'icon-surface-cpu',
      mode: 'surface',
    });
    const sprite = createSpriteState('sprite-surface-cpu', [image]);

    const context = createCollectContext({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-surface-cpu', resource]]),
      clipContext: DEFAULT_CLIP_CONTEXT,
    });
    const items = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];

    const prepared = prepareItems(context, items, { clipContext: null });

    expect(prepared).toHaveLength(0);
    expect(image.surfaceShaderInputs).toBeUndefined();
  });

  it('clamps depth bias using orderMax when order exceeds the limit', () => {
    const resource = createImageResource('icon-surface-bias');
    const image = createImageState({
      imageId: 'icon-surface-bias',
      mode: 'surface',
      order: 25,
      subLayer: 2,
    });
    const sprite = createSpriteState('sprite-surface-bias', [image]);

    const context = createCollectContext({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-surface-bias', resource]]),
      clipContext: DEFAULT_CLIP_CONTEXT,
    });
    const items = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];

    const prepared = prepareItems(context, items);

    expect(prepared).toHaveLength(1);
    const draw = prepared[0]!;
    const surfaceInputs = draw.surfaceShaderInputs;
    expect(surfaceInputs).toBeDefined();
    const expectedOrderIndex = Math.min(image.order, ORDER_MAX - 1);
    const expectedBiasIndex =
      image.subLayer * ORDER_BUCKET + expectedOrderIndex;
    const expectedDepthBias = -(expectedBiasIndex * EPS_NDC);
    expect(surfaceInputs!.depthBiasNdc).toBeCloseTo(expectedDepthBias, 6);
  });

  it('enables the surface shader path when clip context is provided', () => {
    const resource = createImageResource('icon-surface');
    const image = createImageState({
      imageId: 'icon-surface',
      mode: 'surface',
      order: 0,
      subLayer: 1,
    });
    const sprite = createSpriteState('sprite-surface-shader', [image]);

    const context = createCollectContext({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-surface', resource]]),
      clipContext: DEFAULT_CLIP_CONTEXT,
    });
    const items = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];

    const prepared = prepareItems(context, items);

    expect(prepared).toHaveLength(1);
    const draw = prepared[0]!;

    expect(draw.useShaderSurface).toBe(true);
    expect(draw.surfaceClipEnabled).toBe(true);
    expect(draw.useShaderBillboard).toBe(false);
    expect(draw.billboardUniforms).toBeNull();
    expect(draw.surfaceShaderInputs).toBeDefined();
    expect(draw.surfaceShaderInputs?.clipCorners?.length).toBe(4);
    expect(draw.vertexData.length).toBe(TRIANGLE_INDICES.length * 6);
    const firstSurfaceCorner = SURFACE_BASE_CORNERS[0]!;
    expect(draw.vertexData[0]).toBeCloseTo(firstSurfaceCorner[0], 6);
    expect(draw.vertexData[1]).toBeCloseTo(firstSurfaceCorner[1], 6);
    expect(draw.hitTestCorners).not.toBeNull();
    const firstCornerX = draw.hitTestCorners?.[0].x ?? Number.NaN;
    expect(Number.isFinite(firstCornerX)).toBe(true);
    expect(image.surfaceShaderInputs).toBe(draw.surfaceShaderInputs);
  });

  it('applies originLocation anchor using map.unproject', () => {
    const resourceBase = createImageResource('icon-origin-base');
    const resourceChild = createImageResource('icon-origin-child');

    const baseImage = createImageState({
      imageId: 'icon-origin-base',
      mode: 'surface',
      order: 0,
      subLayer: 0,
    });
    const childImage = createImageState({
      imageId: 'icon-origin-child',
      mode: 'surface',
      order: 1,
      subLayer: 0,
      originLocation: {
        subLayer: baseImage.subLayer,
        order: baseImage.order,
        useResolvedAnchor: true,
      },
    });

    const unprojectSpy = vi.fn(
      (point: Readonly<SpritePoint>): SpriteLocation => ({
        lng: point.x / SCALE,
        lat: -point.y / SCALE,
      })
    );
    const projectionHost = createFakeProjectionHost({
      unproject: (point) => unprojectSpy(point),
    });

    const sprite = createSpriteState('sprite-origin', [baseImage, childImage]);

    const context = createCollectContext({
      bucket: [[sprite, baseImage] as const, [sprite, childImage] as const],
      images: new Map([
        ['icon-origin-base', resourceBase],
        ['icon-origin-child', resourceChild],
      ]),
      clipContext: DEFAULT_CLIP_CONTEXT,
      projectionHost,
    });
    const items = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];
    const prepared = prepareItems(context, items);

    expect(prepared).not.toHaveLength(0);
    expect(unprojectSpy).toHaveBeenCalled();
    const childResult = prepared.find(
      (entry) => entry.imageEntry === childImage
    );
    expect(childResult).toBeDefined();
    expect(childResult!.surfaceShaderInputs).toBeDefined();
  });

  it('aligns billboard origin with anchorless placement when requested', () => {
    const resourceBase = createImageResource('icon-origin-billboard-base');
    const resourceChild = createImageResource('icon-origin-billboard-child');

    const baseImage = createImageState({
      imageId: 'icon-origin-billboard-base',
      mode: 'billboard',
      order: 0,
      subLayer: 0,
      anchor: { x: 1, y: 1 },
    });
    const childImage = createImageState({
      imageId: 'icon-origin-billboard-child',
      mode: 'billboard',
      order: 1,
      subLayer: 0,
      originLocation: {
        subLayer: baseImage.subLayer,
        order: baseImage.order,
        useResolvedAnchor: false,
      },
    });

    const sprite = createSpriteState('sprite-origin-billboard', [
      baseImage,
      childImage,
    ]);

    const context = createCollectContext({
      bucket: [[sprite, baseImage] as const, [sprite, childImage] as const],
      images: new Map([
        ['icon-origin-billboard-base', resourceBase],
        ['icon-origin-billboard-child', resourceChild],
      ]),
    });

    const items = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];

    const prepared = prepareItems(context, items);

    const baseResult = prepared.find((entry) => entry.imageEntry === baseImage);
    const childResult = prepared.find(
      (entry) => entry.imageEntry === childImage
    );

    expect(baseResult?.billboardUniforms).not.toBeNull();
    expect(childResult?.billboardUniforms).not.toBeNull();

    const baseUniforms = baseResult!.billboardUniforms!;
    const childUniforms = childResult!.billboardUniforms!;

    const minusRotationRad = Math.atan2(baseUniforms.sin, baseUniforms.cos);
    const rotationDeg = -minusRotationRad * (180 / Math.PI);
    const anchorShift = calculateBillboardAnchorShiftPixels(
      baseUniforms.halfWidth,
      baseUniforms.halfHeight,
      baseUniforms.anchor,
      rotationDeg
    );

    expect(Math.abs(anchorShift.x) + Math.abs(anchorShift.y)).toBeGreaterThan(
      0
    );

    const expectedAnchorless = {
      x: baseUniforms.center.x + anchorShift.x,
      y: baseUniforms.center.y - anchorShift.y,
    };

    expect(childUniforms.center.x).toBeCloseTo(expectedAnchorless.x, 6);
    expect(childUniforms.center.y).toBeCloseTo(expectedAnchorless.y, 6);
  });

  it('exposes bucket buffers for origin references', () => {
    const resourceBase = createImageResource('icon-bucket-base');
    const resourceChild = createImageResource('icon-bucket-child');

    const baseImage = createImageState({
      imageId: 'icon-bucket-base',
      order: 0,
      subLayer: 0,
    });
    const childImage = createImageState({
      imageId: 'icon-bucket-child',
      order: 1,
      subLayer: 0,
      originLocation: { subLayer: 0, order: 0 },
    });
    const sprite = createSpriteState('sprite-bucket', [baseImage, childImage]);

    const context = createCollectContext({
      bucket: [[sprite, baseImage] as const, [sprite, childImage] as const],
      images: new Map([
        ['icon-bucket-base', resourceBase],
        ['icon-bucket-child', resourceChild],
      ]),
    });

    const buffers = context.paramsBefore.bucketBuffers;
    expect(buffers).toBeDefined();
    expect(Array.from(buffers?.originReferenceKeys ?? [])).toEqual([
      SPRITE_ORIGIN_REFERENCE_KEY_NONE,
      originReference.encodeKey(0, 0),
    ]);
    expect(Array.from(buffers?.originTargetIndices ?? [])).toEqual([
      SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
      0,
    ]);
  });

  it('propagates originLocation across chained billboard references', () => {
    const resourceBase = createImageResource('icon-chain-base');
    const resourceMid = createImageResource('icon-chain-mid');
    const resourceLeaf = createImageResource('icon-chain-leaf');

    const baseImage = createImageState({
      imageId: 'icon-chain-base',
      mode: 'billboard',
      order: 0,
      subLayer: 0,
    });
    const midImage = createImageState({
      imageId: 'icon-chain-mid',
      mode: 'billboard',
      order: 1,
      subLayer: 0,
      originLocation: {
        subLayer: baseImage.subLayer,
        order: baseImage.order,
        useResolvedAnchor: true,
      },
      offset: { offsetMeters: 10, offsetDeg: 90 },
    });
    const leafImage = createImageState({
      imageId: 'icon-chain-leaf',
      mode: 'billboard',
      order: 2,
      subLayer: 0,
      originLocation: {
        subLayer: midImage.subLayer,
        order: midImage.order,
        useResolvedAnchor: true,
      },
    });

    const sprite = createSpriteState('sprite-origin-chain', [
      baseImage,
      midImage,
      leafImage,
    ]);

    const context = createCollectContext({
      bucket: [
        [sprite, baseImage] as const,
        [sprite, midImage] as const,
        [sprite, leafImage] as const,
      ],
      images: new Map([
        ['icon-chain-base', resourceBase],
        ['icon-chain-mid', resourceMid],
        ['icon-chain-leaf', resourceLeaf],
      ]),
    });

    const items = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];

    const prepared = prepareItems(context, items);

    const baseResult = prepared.find((entry) => entry.imageEntry === baseImage);
    const midResult = prepared.find((entry) => entry.imageEntry === midImage);
    const leafResult = prepared.find((entry) => entry.imageEntry === leafImage);

    expect(baseResult?.billboardUniforms).not.toBeNull();
    expect(midResult?.billboardUniforms).not.toBeNull();
    expect(leafResult?.billboardUniforms).not.toBeNull();

    const baseCenter = baseResult!.billboardUniforms!.center;
    const midCenter = midResult!.billboardUniforms!.center;
    const leafCenter = leafResult!.billboardUniforms!.center;

    expect(
      Math.abs(midCenter.x - baseCenter.x) +
        Math.abs(midCenter.y - baseCenter.y)
    ).toBeGreaterThan(0);

    expect(leafCenter.x).toBeCloseTo(midCenter.x, 6);
    expect(leafCenter.y).toBeCloseTo(midCenter.y, 6);
  });

  it('reuses hit-test corner buffers across sequential preparations', () => {
    const resource = createImageResource('icon-hitreuse');
    const image = createImageState({ imageId: 'icon-hitreuse', order: 0 });
    const sprite = createSpriteState('sprite-hitreuse', [image]);

    const context = createCollectContext({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-hitreuse', resource]]),
    });
    const items = collectDepthSortedItemsInternal(
      context.projectionHost,
      context.zoom,
      context.zoomScaleFactor,
      context.originCenterCache,
      context.paramsBefore
    ) as DepthItem<null>[];

    const firstPrepared = prepareItems(context, items);
    expect(firstPrepared).toHaveLength(1);
    const firstCorners = firstPrepared[0]!.hitTestCorners;
    expect(firstCorners).not.toBeNull();

    const secondPrepared = prepareItems(context, items);
    expect(secondPrepared).toHaveLength(1);
    const secondCorners = secondPrepared[0]!.hitTestCorners;
    expect(secondCorners).not.toBeNull();
    expect(secondCorners![0]).toBe(firstCorners![0]);
    expect(secondCorners![1]).toBe(firstCorners![1]);
    expect(secondCorners![2]).toBe(firstCorners![2]);
    expect(secondCorners![3]).toBe(firstCorners![3]);
  });

  it('returns no entries when projection fails and clears surface data', () => {
    const resource = createImageResource('icon-e');
    const image = createImageState({ imageId: 'icon-e', order: 0 });
    image.imageHandle = resource.handle;
    const sprite = createSpriteState('sprite-d', [image]);

    const depthItem: DepthItem<null> = {
      sprite,
      image,
      resource,
      depthKey: 0,
      resolveOrigin: () => null,
    };

    const projectionHost = createFakeProjectionHost({
      project: () => null,
    });
    const controller = createImageHandleBufferController();
    controller.markDirty(new Map([['icon-e', resource]]));
    const imageHandleBuffers = controller.ensure();
    const imageResources = controller.getResourcesByHandle();

    const paramsAfter: PrepareDrawSpriteImageParamsAfter = {
      imageResources,
      imageHandleBuffers,
      baseMetersPerPixel: 1,
      spriteMinPixel: 0,
      spriteMaxPixel: 4096,
      drawingBufferWidth: 1024,
      drawingBufferHeight: 768,
      pixelRatio: 1,
      clipContext: DEFAULT_CLIP_CONTEXT,
      identityScaleX: 1,
      identityScaleY: 1,
      identityOffsetX: 0,
      identityOffsetY: 0,
      screenToClipScaleX: 0,
      screenToClipScaleY: 0,
      screenToClipOffsetX: 0,
      screenToClipOffsetY: 0,
    };

    const prepared = prepareDrawSpriteImageInternal(
      projectionHost,
      depthItem,
      projectionHost.getZoom(),
      1,
      new Map() as ImageCenterCacheLike,
      paramsAfter
    );

    expect(prepared).toBeNull();
    expect(image.surfaceShaderInputs).toBeUndefined();
  });
});

describe('processInterpolationsInternal', () => {
  it('delegates preset easing to evaluation handlers', () => {
    const timestamp = 500;
    const image = createImageState({
      imageHandle: 1,
      offset: { offsetMeters: 0, offsetDeg: 0 },
    });
    const { state: distanceState } = createDistanceInterpolationState({
      currentValue: 0,
      targetValue: 10,
      options: { durationMs: 1000, easing: 'linear' },
    });
    image.offsetMetersInterpolationState = distanceState;

    const currentLocation: SpriteLocation = { lng: 0, lat: 0 };
    const { state: spriteState } = createInterpolationState({
      currentLocation,
      lastCommandLocation: currentLocation,
      nextCommandLocation: { lng: 10, lat: 0 },
      options: { durationMs: 1000, easing: 'linear' },
    });
    const sprite = createSpriteState('sprite-1', [image], {
      currentLocation,
      interpolationState: spriteState,
    });

    const recorded: ProcessInterpolationPresetRequests[] = [];
    const handlers: ProcessInterpolationsEvaluationHandlers = {
      prepare: (requests) => recorded.push(requests),
      evaluateDistance: vi.fn((requests) =>
        requests.map(() => ({
          value: 4,
          completed: false,
          effectiveStartTimestamp: timestamp - 100,
        }))
      ),
      evaluateDegree: vi.fn(() => []),
      evaluateSprite: vi.fn((requests) =>
        requests.map(() => ({
          location: { lng: 3, lat: 1 },
          completed: false,
          effectiveStartTimestamp: timestamp - 100,
        }))
      ),
    };

    const result = processInterpolationsInternal(
      {
        sprites: [sprite],
        timestamp,
      },
      handlers
    );

    expect(result.hasActiveInterpolation).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.distance).toHaveLength(1);
    expect(handlers.evaluateDistance).toHaveBeenCalledTimes(1);
    expect(handlers.evaluateSprite).toHaveBeenCalledTimes(1);
    expect(image.offset.offsetMeters).toBeCloseTo(4);
    expect(sprite.currentLocation.lng).toBeCloseTo(3);
    expect(sprite.interpolationState).not.toBeNull();
  });

  it('falls back to local evaluation when no preset easing is available', () => {
    const image = createImageState({
      imageHandle: 1,
      offset: { offsetMeters: 2, offsetDeg: 0 },
    });
    const customEasing = (value: number): number => value;
    const { state: distanceState } = createDistanceInterpolationState({
      currentValue: 2,
      targetValue: 6,
      options: { durationMs: 0, easing: customEasing },
    });
    expect(distanceState.easingPreset).toBeNull();
    image.offsetMetersInterpolationState = distanceState;

    const sprite = createSpriteState('sprite-2', [image]);

    const handlers: ProcessInterpolationsEvaluationHandlers = {
      prepare: vi.fn(),
      evaluateDistance: vi.fn(() => []),
      evaluateDegree: vi.fn(() => []),
      evaluateSprite: vi.fn(() => []),
    };

    const result = processInterpolationsInternal(
      {
        sprites: [sprite],
        timestamp: 0,
      },
      handlers
    );

    expect(result.hasActiveInterpolation).toBe(false);
    expect(handlers.prepare).not.toHaveBeenCalled();
    expect(handlers.evaluateDistance).not.toHaveBeenCalled();
    expect(image.offset.offsetMeters).toBe(6);
    expect(image.offsetMetersInterpolationState).toBeNull();
  });
});
