// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it, vi } from 'vitest';
import { MercatorCoordinate, type Map as MapLibreMap } from 'maplibre-gl';

import { createMapLibreProjectionHost } from '../src/mapLibreProjectionHost';
import {
  collectDepthSortedItemsInternal,
  prepareDrawSpriteImageInternal,
} from '../src/calculationHost';
import { createImageHandleBufferController } from '../src/image';
import {
  calculateZoomScaleFactor,
  resolveScalingOptions,
  type ResolvedSpriteScalingOptions,
} from '../src/math';
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
import { BILLBOARD_BASE_CORNERS, SURFACE_BASE_CORNERS } from '../src/shader';

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
});

const createImageState = (
  overrides: Partial<InternalSpriteImageState> = {}
): InternalSpriteImageState => ({
  subLayer: overrides.subLayer ?? 0,
  order: overrides.order ?? 0,
  imageId: overrides.imageId ?? 'image',
  imageHandle: overrides.imageHandle ?? 0,
  mode: overrides.mode ?? 'billboard',
  opacity: overrides.opacity ?? 1,
  scale: overrides.scale ?? 1,
  anchor: overrides.anchor ?? DEFAULT_ANCHOR,
  offset: overrides.offset ?? DEFAULT_OFFSET,
  rotateDeg: overrides.rotateDeg ?? 0,
  displayedRotateDeg: overrides.displayedRotateDeg ?? overrides.rotateDeg ?? 0,
  autoRotation: overrides.autoRotation ?? false,
  autoRotationMinDistanceMeters: overrides.autoRotationMinDistanceMeters ?? 0,
  resolvedBaseRotateDeg: overrides.resolvedBaseRotateDeg ?? 0,
  originLocation: overrides.originLocation,
  rotationInterpolationState: overrides.rotationInterpolationState ?? null,
  rotationInterpolationOptions: overrides.rotationInterpolationOptions ?? null,
  offsetDegInterpolationState: overrides.offsetDegInterpolationState ?? null,
  offsetMetersInterpolationState:
    overrides.offsetMetersInterpolationState ?? null,
  lastCommandRotateDeg: overrides.lastCommandRotateDeg ?? 0,
  lastCommandOffsetDeg: overrides.lastCommandOffsetDeg ?? 0,
  lastCommandOffsetMeters: overrides.lastCommandOffsetMeters ?? 0,
  surfaceShaderInputs: overrides.surfaceShaderInputs,
  hitTestCorners: overrides.hitTestCorners,
});

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

  bucket.forEach(([, image]) => {
    const resource = images.get(image.imageId);
    image.imageHandle = resource ? resource.handle : image.imageHandle;
  });

  const handleController = createImageHandleBufferController();
  handleController.markDirty(images);
  const imageHandleBuffers = handleController.ensure();
  const imageResources = handleController.getResourcesByHandle();

  const paramsBefore: PrepareDrawSpriteImageParamsBefore<null> = {
    bucket,
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
    expect(items[0].sprite.spriteId).toBe('sprite-1');
    expect(items[1].sprite.spriteId).toBe('sprite-2');
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

    const delta = Math.abs(biased[1].depthKey - biased[0].depthKey);
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
    const [draw] = prepared;
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
    const [draw] = prepared;
    expect(draw.useShaderBillboard).toBe(true);
    expect(draw.billboardUniforms).not.toBeNull();
    expect(draw.surfaceShaderInputs).toBeUndefined();
    for (let i = 0; i < TRIANGLE_INDICES.length; i++) {
      const baseCorner = BILLBOARD_BASE_CORNERS[TRIANGLE_INDICES[i]]!;
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
    const [draw] = prepared;
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
    const [draw] = prepared;

    expect(draw.useShaderSurface).toBe(true);
    expect(draw.surfaceClipEnabled).toBe(true);
    expect(draw.useShaderBillboard).toBe(false);
    expect(draw.billboardUniforms).toBeNull();
    expect(draw.surfaceShaderInputs).toBeDefined();
    expect(draw.surfaceShaderInputs?.clipCorners?.length).toBe(4);
    expect(draw.vertexData.length).toBe(TRIANGLE_INDICES.length * 6);
    expect(draw.vertexData[0]).toBeCloseTo(SURFACE_BASE_CORNERS[0][0], 6);
    expect(draw.vertexData[1]).toBeCloseTo(SURFACE_BASE_CORNERS[0][1], 6);
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

    const firstCorners = firstPrepared[0].hitTestCorners;
    expect(firstCorners).not.toBeNull();

    const secondPrepared = prepareItems(context, items);

    const secondCorners = secondPrepared[0].hitTestCorners;
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
