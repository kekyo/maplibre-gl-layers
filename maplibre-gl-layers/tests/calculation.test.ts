// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it, vi } from 'vitest';
import { MercatorCoordinate, type Map as MapLibreMap } from 'maplibre-gl';

import {
  calculatePerspectiveRatio,
  collectDepthSortedItems,
  prepareSpriteEachImageDraw,
  projectLngLatToClipSpace,
  type CollectDepthSortedItemsOptions,
  type DepthSortedItem,
  type ImageCenterCache,
} from '../src/calculation';
import type {
  ClipContext,
  InternalSpriteCurrentState,
  InternalSpriteImageState,
  MutableSpriteScreenPoint,
  RegisteredImage,
} from '../src/internalTypes';
import type {
  SpriteAnchor,
  SpriteImageOffset,
  SpriteLocation,
} from '../src/types';
import { TRIANGLE_INDICES } from '../src/math';
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
) => { x: number; y: number } | null;

type UnprojectOverride = (
  point: readonly [number, number]
) => SpriteLocation | null;

const createFakeMap = (options?: {
  project?: ProjectOverride;
  unproject?: UnprojectOverride;
  cameraDistance?: number;
}): MapLibreMap => {
  const project =
    options?.project ??
    ((location: Readonly<SpriteLocation>) => ({
      x: location.lng * SCALE,
      y: -location.lat * SCALE,
    }));
  const unproject =
    options?.unproject ??
    (([x, y]: readonly [number, number]) => ({
      lng: x / SCALE,
      lat: -y / SCALE,
      z: 0,
    }));
  const cameraToCenterDistance = options?.cameraDistance ?? 8;
  return {
    project,
    unproject,
    transform: {
      mercatorMatrix: IDENTITY_MATRIX,
      _mercatorMatrix: IDENTITY_MATRIX,
      cameraToCenterDistance,
    },
  } as unknown as MapLibreMap;
};

const createImageResource = (id: string): RegisteredImage => ({
  id,
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

const createEnsureHitTestCorners = () => {
  return (
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
};

const createCollectOptions = (
  overrides: Partial<CollectDepthSortedItemsOptions<null>> = {}
): CollectDepthSortedItemsOptions<null> => {
  const mapInstance =
    overrides.mapInstance ?? createFakeMap({ cameraDistance: 8 });
  return {
    bucket: overrides.bucket ?? [],
    mapInstance,
    images: overrides.images ?? new Map(),
    clipContext: overrides.clipContext ?? DEFAULT_CLIP_CONTEXT,
    zoom: overrides.zoom ?? 10,
    zoomScaleFactor: overrides.zoomScaleFactor ?? 1,
    baseMetersPerPixel: overrides.baseMetersPerPixel ?? 1,
    spriteMinPixel: overrides.spriteMinPixel ?? 0,
    spriteMaxPixel: overrides.spriteMaxPixel ?? 4096,
    drawingBufferWidth: overrides.drawingBufferWidth ?? 1024,
    drawingBufferHeight: overrides.drawingBufferHeight ?? 768,
    pixelRatio: overrides.pixelRatio ?? 1,
    originCenterCache:
      overrides.originCenterCache ?? (new Map() as ImageCenterCache),
    resolveSpriteMercator:
      overrides.resolveSpriteMercator ?? ((sprite) => sprite.cachedMercator),
    defaultAnchor: overrides.defaultAnchor ?? DEFAULT_ANCHOR,
    defaultImageOffset: overrides.defaultImageOffset ?? DEFAULT_OFFSET,
    enableNdcBiasSurface: overrides.enableNdcBiasSurface ?? false,
    orderMax: overrides.orderMax ?? 8,
    orderBucket: overrides.orderBucket ?? 4,
    epsNdc: overrides.epsNdc ?? 1e-6,
    minClipZEpsilon: overrides.minClipZEpsilon ?? 1e-6,
  };
};

describe('projectLngLatToClipSpace', () => {
  it('returns homogeneous coordinates when a clip context is available', () => {
    const location: SpriteLocation = { lng: 0, lat: 0, z: 0 };
    const clip = projectLngLatToClipSpace(location, DEFAULT_CLIP_CONTEXT);
    expect(clip).not.toBeNull();
    if (!clip) {
      return;
    }
    expect(clip[0]).toBeCloseTo(0.5, 6);
    expect(clip[1]).toBeCloseTo(0.5, 6);
    expect(clip[2]).toBeCloseTo(0, 6);
    expect(clip[3]).toBeCloseTo(1, 6);
  });

  it('returns null when clip-space W collapses', () => {
    const matrix = new Float64Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
    ]);
    const result = projectLngLatToClipSpace(
      { lng: 0, lat: 0, z: 0 },
      { mercatorMatrix: matrix }
    );
    expect(result).toBeNull();
  });

  it('returns null when clip-space W falls below the minimum threshold', () => {
    const matrix = new Float64Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 5e-7,
    ]);
    const result = projectLngLatToClipSpace(
      { lng: 0, lat: 0, z: 0 },
      { mercatorMatrix: matrix }
    );
    expect(result).toBeNull();
  });

  it('returns null when clip context is missing', () => {
    expect(projectLngLatToClipSpace({ lng: 0, lat: 0, z: 0 }, null)).toBeNull();
  });
});

describe('calculatePerspectiveRatio', () => {
  it('derives the ratio from the mercator matrix and camera distance', () => {
    const mapInstance = createFakeMap({ cameraDistance: 12 });
    const ratio = calculatePerspectiveRatio(mapInstance, {
      lng: 0,
      lat: 0,
      z: 0,
    });
    expect(ratio).toBeCloseTo(12, 6);
  });

  it('falls back to _mercatorMatrix when mercatorMatrix is unavailable', () => {
    const mapInstance = {
      project: (location: SpriteLocation) => ({
        x: location.lng * SCALE,
        y: -location.lat * SCALE,
      }),
      unproject: ([x, y]: [number, number]) => ({
        lng: x / SCALE,
        lat: -y / SCALE,
        z: 0,
      }),
      transform: {
        _mercatorMatrix: IDENTITY_MATRIX,
        cameraToCenterDistance: 5,
      },
    } as unknown as MapLibreMap;
    const ratio = calculatePerspectiveRatio(mapInstance, {
      lng: 0,
      lat: 0,
      z: 0,
    });
    expect(ratio).toBeCloseTo(5, 6);
  });

  it('falls back to 1 when transform is unavailable', () => {
    const mapInstance = {
      project: () => ({ x: 0, y: 0 }),
      unproject: () => ({ lng: 0, lat: 0 }),
    } as unknown as MapLibreMap;
    expect(
      calculatePerspectiveRatio(mapInstance, {
        lng: 0,
        lat: 0,
        z: 0,
      })
    ).toBe(1);
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

    const options = createCollectOptions({
      bucket: [[sprite, imageA] as const, [sprite, imageB] as const],
      images: resources,
    });

    const result = collectDepthSortedItems(options);
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

    const options = createCollectOptions({
      bucket: [
        [spriteSecond, imageSecond] as const,
        [spriteFirst, imageFirst] as const,
      ],
      images,
    });

    const items = collectDepthSortedItems(options);
    expect(items).toHaveLength(2);
    expect(items[0].sprite.spriteId).toBe('sprite-1');
    expect(items[1].sprite.spriteId).toBe('sprite-2');
  });

  it('skips entries when clip context is unavailable for projection', () => {
    const image = createImageState({ imageId: 'noclip', order: 0 });
    const sprite = createSpriteState('sprite-noclip', [image]);
    const resource = createImageResource('noclip');

    const baseOptions = createCollectOptions({
      bucket: [[sprite, image] as const],
      images: new Map([['noclip', resource]]),
    });
    const items = collectDepthSortedItems({
      ...baseOptions,
      clipContext: null,
    });
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

    const sharedOptions = {
      bucket: [[sprite, surfaceBase] as const, [sprite, surfaceFront] as const],
      images: resources,
      clipContext: DEFAULT_CLIP_CONTEXT,
    } as const;

    const biased = collectDepthSortedItems(
      createCollectOptions({
        ...sharedOptions,
        enableNdcBiasSurface: true,
        originCenterCache: new Map(),
      })
    );
    const unbiased = collectDepthSortedItems(
      createCollectOptions({
        ...sharedOptions,
        enableNdcBiasSurface: false,
        originCenterCache: new Map(),
      })
    );

    expect(biased).toHaveLength(2);
    expect(unbiased).toHaveLength(2);

    const biasedDelta = biased[1].depthKey - biased[0].depthKey;
    const unbiasedDelta = Math.abs(unbiased[1].depthKey - unbiased[0].depthKey);

    expect(biasedDelta).toBeGreaterThan(0);
    expect(unbiasedDelta).toBeLessThanOrEqual(1e-6);
    expect(biasedDelta).toBeGreaterThan(unbiasedDelta);
  });

  it('skips entries whose textures are not uploaded', () => {
    const image = createImageState({ imageId: 'icon-c' });
    const sprite = createSpriteState('sprite-b', [image]);

    const resource: RegisteredImage = {
      ...createImageResource('icon-c'),
      texture: undefined,
    };

    const options = createCollectOptions({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-c', resource]]),
    });

    const result = collectDepthSortedItems(options);
    expect(result).toHaveLength(0);
  });
});

describe('prepareSpriteEachImageDraw', () => {
  it('prepares billboard draw data when inputs are valid', () => {
    const resource = createImageResource('icon-d');
    const image = createImageState({ imageId: 'icon-d', order: 0 });
    const sprite = createSpriteState('sprite-c', [image]);

    const collectOptions = createCollectOptions({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-d', resource]]),
      originCenterCache: new Map(),
    });
    const items = collectDepthSortedItems(collectOptions);

    const prepared = prepareSpriteEachImageDraw({
      items,
      originCenterCache: new Map(),
      mapInstance: collectOptions.mapInstance,
      images: new Map([['icon-d', resource]]),
      zoom: collectOptions.zoom,
      zoomScaleFactor: collectOptions.zoomScaleFactor,
      baseMetersPerPixel: collectOptions.baseMetersPerPixel,
      spriteMinPixel: collectOptions.spriteMinPixel,
      spriteMaxPixel: collectOptions.spriteMaxPixel,
      drawingBufferWidth: collectOptions.drawingBufferWidth,
      drawingBufferHeight: collectOptions.drawingBufferHeight,
      pixelRatio: collectOptions.pixelRatio,
      clipContext: collectOptions.clipContext,
      identityScaleX: 1,
      identityScaleY: 1,
      identityOffsetX: 0,
      identityOffsetY: 0,
      screenToClipScaleX: 2 / collectOptions.drawingBufferWidth,
      screenToClipScaleY: -2 / collectOptions.drawingBufferHeight,
      screenToClipOffsetX: -1,
      screenToClipOffsetY: 1,
      defaultAnchor: DEFAULT_ANCHOR,
      defaultImageOffset: DEFAULT_OFFSET,
      useShaderSurfaceGeometry: false,
      useShaderBillboardGeometry: false,
      enableNdcBiasSurface: false,
      orderMax: collectOptions.orderMax,
      orderBucket: collectOptions.orderBucket,
      epsNdc: collectOptions.epsNdc,
      minClipZEpsilon: collectOptions.minClipZEpsilon,
      slDebug: false,
      ensureHitTestCorners: createEnsureHitTestCorners(),
      resolveSpriteMercator: collectOptions.resolveSpriteMercator,
    });

    expect(prepared).toHaveLength(1);
    const [draw] = prepared;
    expect(draw.spriteEntry).toBe(sprite);
    expect(draw.imageEntry).toBe(image);
    expect(draw.imageResource).toBe(resource);
    expect(draw.vertexData.length).toBe(TRIANGLE_INDICES.length * 6);
    expect(draw.screenToClip).toEqual({
      scaleX: 2 / collectOptions.drawingBufferWidth,
      scaleY: -2 / collectOptions.drawingBufferHeight,
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

    const collectOptions = createCollectOptions({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-billboard', resource]]),
      originCenterCache: new Map(),
    });
    const items = collectDepthSortedItems(collectOptions);

    const prepared = prepareSpriteEachImageDraw({
      items,
      originCenterCache: new Map(),
      mapInstance: collectOptions.mapInstance,
      images: new Map([['icon-billboard', resource]]),
      zoom: collectOptions.zoom,
      zoomScaleFactor: collectOptions.zoomScaleFactor,
      baseMetersPerPixel: collectOptions.baseMetersPerPixel,
      spriteMinPixel: collectOptions.spriteMinPixel,
      spriteMaxPixel: collectOptions.spriteMaxPixel,
      drawingBufferWidth: collectOptions.drawingBufferWidth,
      drawingBufferHeight: collectOptions.drawingBufferHeight,
      pixelRatio: collectOptions.pixelRatio,
      clipContext: collectOptions.clipContext,
      identityScaleX: 1,
      identityScaleY: 1,
      identityOffsetX: 0,
      identityOffsetY: 0,
      screenToClipScaleX: 2 / collectOptions.drawingBufferWidth,
      screenToClipScaleY: -2 / collectOptions.drawingBufferHeight,
      screenToClipOffsetX: -1,
      screenToClipOffsetY: 1,
      defaultAnchor: DEFAULT_ANCHOR,
      defaultImageOffset: DEFAULT_OFFSET,
      useShaderSurfaceGeometry: false,
      useShaderBillboardGeometry: true,
      enableNdcBiasSurface: false,
      orderMax: collectOptions.orderMax,
      orderBucket: collectOptions.orderBucket,
      epsNdc: collectOptions.epsNdc,
      minClipZEpsilon: collectOptions.minClipZEpsilon,
      slDebug: false,
      ensureHitTestCorners: createEnsureHitTestCorners(),
      resolveSpriteMercator: collectOptions.resolveSpriteMercator,
    });

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

  it('falls back to CPU surface path when shader geometry is disabled', () => {
    const resource = createImageResource('icon-surface-cpu');
    const image = createImageState({
      imageId: 'icon-surface-cpu',
      mode: 'surface',
    });
    const sprite = createSpriteState('sprite-surface-cpu', [image]);

    const collectOptions = createCollectOptions({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-surface-cpu', resource]]),
      clipContext: DEFAULT_CLIP_CONTEXT,
      originCenterCache: new Map(),
    });
    const items = collectDepthSortedItems(collectOptions);
    const ensureCorners = createEnsureHitTestCorners();

    const prepared = prepareSpriteEachImageDraw({
      items,
      originCenterCache: new Map(),
      mapInstance: collectOptions.mapInstance,
      images: new Map([['icon-surface-cpu', resource]]),
      zoom: collectOptions.zoom,
      zoomScaleFactor: collectOptions.zoomScaleFactor,
      baseMetersPerPixel: collectOptions.baseMetersPerPixel,
      spriteMinPixel: collectOptions.spriteMinPixel,
      spriteMaxPixel: collectOptions.spriteMaxPixel,
      drawingBufferWidth: collectOptions.drawingBufferWidth,
      drawingBufferHeight: collectOptions.drawingBufferHeight,
      pixelRatio: collectOptions.pixelRatio,
      clipContext: collectOptions.clipContext,
      identityScaleX: 1,
      identityScaleY: 1,
      identityOffsetX: 0,
      identityOffsetY: 0,
      screenToClipScaleX: 2 / collectOptions.drawingBufferWidth,
      screenToClipScaleY: -2 / collectOptions.drawingBufferHeight,
      screenToClipOffsetX: -1,
      screenToClipOffsetY: 1,
      defaultAnchor: DEFAULT_ANCHOR,
      defaultImageOffset: DEFAULT_OFFSET,
      useShaderSurfaceGeometry: false,
      useShaderBillboardGeometry: false,
      enableNdcBiasSurface: false,
      orderMax: collectOptions.orderMax,
      orderBucket: collectOptions.orderBucket,
      epsNdc: collectOptions.epsNdc,
      minClipZEpsilon: collectOptions.minClipZEpsilon,
      slDebug: false,
      ensureHitTestCorners: ensureCorners,
      resolveSpriteMercator: collectOptions.resolveSpriteMercator,
    });

    expect(prepared).toHaveLength(1);
    const [draw] = prepared;
    expect(draw.useShaderSurface).toBe(false);
    expect(draw.surfaceClipEnabled).toBe(false);
    expect(draw.surfaceShaderInputs).toBeDefined();
    expect(draw.hitTestCorners).not.toBeNull();
    const corners = draw.hitTestCorners!;
    corners.forEach((corner) => {
      expect(Number.isFinite(corner.x)).toBe(true);
      expect(Number.isFinite(corner.y)).toBe(true);
    });
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

    const epsNdc = 5e-5;
    const orderMax = 4;
    const orderBucket = 3;

    const collectOptions = createCollectOptions({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-surface-bias', resource]]),
      clipContext: DEFAULT_CLIP_CONTEXT,
      originCenterCache: new Map(),
      orderMax,
      orderBucket,
      epsNdc,
    });
    const items = collectDepthSortedItems(collectOptions);

    const prepared = prepareSpriteEachImageDraw({
      items,
      originCenterCache: new Map(),
      mapInstance: collectOptions.mapInstance,
      images: new Map([['icon-surface-bias', resource]]),
      zoom: collectOptions.zoom,
      zoomScaleFactor: collectOptions.zoomScaleFactor,
      baseMetersPerPixel: collectOptions.baseMetersPerPixel,
      spriteMinPixel: collectOptions.spriteMinPixel,
      spriteMaxPixel: collectOptions.spriteMaxPixel,
      drawingBufferWidth: collectOptions.drawingBufferWidth,
      drawingBufferHeight: collectOptions.drawingBufferHeight,
      pixelRatio: collectOptions.pixelRatio,
      clipContext: collectOptions.clipContext,
      identityScaleX: 1,
      identityScaleY: 1,
      identityOffsetX: 0,
      identityOffsetY: 0,
      screenToClipScaleX: 2 / collectOptions.drawingBufferWidth,
      screenToClipScaleY: -2 / collectOptions.drawingBufferHeight,
      screenToClipOffsetX: -1,
      screenToClipOffsetY: 1,
      defaultAnchor: DEFAULT_ANCHOR,
      defaultImageOffset: DEFAULT_OFFSET,
      useShaderSurfaceGeometry: true,
      useShaderBillboardGeometry: false,
      enableNdcBiasSurface: true,
      orderMax: collectOptions.orderMax,
      orderBucket: collectOptions.orderBucket,
      epsNdc: collectOptions.epsNdc,
      minClipZEpsilon: collectOptions.minClipZEpsilon,
      slDebug: false,
      ensureHitTestCorners: createEnsureHitTestCorners(),
      resolveSpriteMercator: collectOptions.resolveSpriteMercator,
    });

    expect(prepared).toHaveLength(1);
    const [draw] = prepared;
    const surfaceInputs = draw.surfaceShaderInputs;
    expect(surfaceInputs).toBeDefined();
    const expectedOrderIndex = Math.min(image.order, orderMax - 1);
    const expectedBiasIndex = image.subLayer * orderBucket + expectedOrderIndex;
    const expectedDepthBias = -(expectedBiasIndex * epsNdc);
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

    const collectOptions = createCollectOptions({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-surface', resource]]),
      clipContext: DEFAULT_CLIP_CONTEXT,
      originCenterCache: new Map(),
    });
    const items = collectDepthSortedItems(collectOptions);

    const ensureCorners = createEnsureHitTestCorners();
    const prepared = prepareSpriteEachImageDraw({
      items,
      originCenterCache: new Map(),
      mapInstance: collectOptions.mapInstance,
      images: new Map([['icon-surface', resource]]),
      zoom: collectOptions.zoom,
      zoomScaleFactor: collectOptions.zoomScaleFactor,
      baseMetersPerPixel: collectOptions.baseMetersPerPixel,
      spriteMinPixel: collectOptions.spriteMinPixel,
      spriteMaxPixel: collectOptions.spriteMaxPixel,
      drawingBufferWidth: collectOptions.drawingBufferWidth,
      drawingBufferHeight: collectOptions.drawingBufferHeight,
      pixelRatio: collectOptions.pixelRatio,
      clipContext: collectOptions.clipContext,
      identityScaleX: 1,
      identityScaleY: 1,
      identityOffsetX: 0,
      identityOffsetY: 0,
      screenToClipScaleX: 2 / collectOptions.drawingBufferWidth,
      screenToClipScaleY: -2 / collectOptions.drawingBufferHeight,
      screenToClipOffsetX: -1,
      screenToClipOffsetY: 1,
      defaultAnchor: DEFAULT_ANCHOR,
      defaultImageOffset: DEFAULT_OFFSET,
      useShaderSurfaceGeometry: true,
      useShaderBillboardGeometry: false,
      enableNdcBiasSurface: false,
      orderMax: collectOptions.orderMax,
      orderBucket: collectOptions.orderBucket,
      epsNdc: collectOptions.epsNdc,
      minClipZEpsilon: collectOptions.minClipZEpsilon,
      slDebug: false,
      ensureHitTestCorners: ensureCorners,
      resolveSpriteMercator: collectOptions.resolveSpriteMercator,
    });

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
      ([x, y]: readonly [number, number]): SpriteLocation => ({
        lng: x / SCALE,
        lat: -y / SCALE,
        z: 0,
      })
    );
    const mapInstance = createFakeMap({ unproject: unprojectSpy });

    const sprite = createSpriteState('sprite-origin', [baseImage, childImage]);

    const collectOptions = createCollectOptions({
      bucket: [[sprite, baseImage] as const, [sprite, childImage] as const],
      images: new Map([
        ['icon-origin-base', resourceBase],
        ['icon-origin-child', resourceChild],
      ]),
      clipContext: DEFAULT_CLIP_CONTEXT,
      originCenterCache: new Map(),
      mapInstance,
    });

    const items = collectDepthSortedItems(collectOptions);
    const prepared = prepareSpriteEachImageDraw({
      items,
      originCenterCache: new Map(),
      mapInstance,
      images: new Map([
        ['icon-origin-base', resourceBase],
        ['icon-origin-child', resourceChild],
      ]),
      zoom: collectOptions.zoom,
      zoomScaleFactor: collectOptions.zoomScaleFactor,
      baseMetersPerPixel: collectOptions.baseMetersPerPixel,
      spriteMinPixel: collectOptions.spriteMinPixel,
      spriteMaxPixel: collectOptions.spriteMaxPixel,
      drawingBufferWidth: collectOptions.drawingBufferWidth,
      drawingBufferHeight: collectOptions.drawingBufferHeight,
      pixelRatio: collectOptions.pixelRatio,
      clipContext: collectOptions.clipContext,
      identityScaleX: 1,
      identityScaleY: 1,
      identityOffsetX: 0,
      identityOffsetY: 0,
      screenToClipScaleX: 2 / collectOptions.drawingBufferWidth,
      screenToClipScaleY: -2 / collectOptions.drawingBufferHeight,
      screenToClipOffsetX: -1,
      screenToClipOffsetY: 1,
      defaultAnchor: DEFAULT_ANCHOR,
      defaultImageOffset: DEFAULT_OFFSET,
      useShaderSurfaceGeometry: true,
      useShaderBillboardGeometry: false,
      enableNdcBiasSurface: false,
      orderMax: collectOptions.orderMax,
      orderBucket: collectOptions.orderBucket,
      epsNdc: collectOptions.epsNdc,
      minClipZEpsilon: collectOptions.minClipZEpsilon,
      slDebug: false,
      ensureHitTestCorners: createEnsureHitTestCorners(),
      resolveSpriteMercator: collectOptions.resolveSpriteMercator,
    });

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

    const collectOptions = createCollectOptions({
      bucket: [[sprite, image] as const],
      images: new Map([['icon-hitreuse', resource]]),
      originCenterCache: new Map(),
    });
    const items = collectDepthSortedItems(collectOptions);
    const ensureCorners = createEnsureHitTestCorners();

    const firstPrepared = prepareSpriteEachImageDraw({
      items,
      originCenterCache: new Map(),
      mapInstance: collectOptions.mapInstance,
      images: new Map([['icon-hitreuse', resource]]),
      zoom: collectOptions.zoom,
      zoomScaleFactor: collectOptions.zoomScaleFactor,
      baseMetersPerPixel: collectOptions.baseMetersPerPixel,
      spriteMinPixel: collectOptions.spriteMinPixel,
      spriteMaxPixel: collectOptions.spriteMaxPixel,
      drawingBufferWidth: collectOptions.drawingBufferWidth,
      drawingBufferHeight: collectOptions.drawingBufferHeight,
      pixelRatio: collectOptions.pixelRatio,
      clipContext: collectOptions.clipContext,
      identityScaleX: 1,
      identityScaleY: 1,
      identityOffsetX: 0,
      identityOffsetY: 0,
      screenToClipScaleX: 2 / collectOptions.drawingBufferWidth,
      screenToClipScaleY: -2 / collectOptions.drawingBufferHeight,
      screenToClipOffsetX: -1,
      screenToClipOffsetY: 1,
      defaultAnchor: DEFAULT_ANCHOR,
      defaultImageOffset: DEFAULT_OFFSET,
      useShaderSurfaceGeometry: false,
      useShaderBillboardGeometry: false,
      enableNdcBiasSurface: false,
      orderMax: collectOptions.orderMax,
      orderBucket: collectOptions.orderBucket,
      epsNdc: collectOptions.epsNdc,
      minClipZEpsilon: collectOptions.minClipZEpsilon,
      slDebug: false,
      ensureHitTestCorners: ensureCorners,
      resolveSpriteMercator: collectOptions.resolveSpriteMercator,
    });

    const firstCorners = firstPrepared[0].hitTestCorners;
    expect(firstCorners).not.toBeNull();

    const secondPrepared = prepareSpriteEachImageDraw({
      items,
      originCenterCache: new Map(),
      mapInstance: collectOptions.mapInstance,
      images: new Map([['icon-hitreuse', resource]]),
      zoom: collectOptions.zoom,
      zoomScaleFactor: collectOptions.zoomScaleFactor,
      baseMetersPerPixel: collectOptions.baseMetersPerPixel,
      spriteMinPixel: collectOptions.spriteMinPixel,
      spriteMaxPixel: collectOptions.spriteMaxPixel,
      drawingBufferWidth: collectOptions.drawingBufferWidth,
      drawingBufferHeight: collectOptions.drawingBufferHeight,
      pixelRatio: collectOptions.pixelRatio,
      clipContext: collectOptions.clipContext,
      identityScaleX: 1,
      identityScaleY: 1,
      identityOffsetX: 0,
      identityOffsetY: 0,
      screenToClipScaleX: 2 / collectOptions.drawingBufferWidth,
      screenToClipScaleY: -2 / collectOptions.drawingBufferHeight,
      screenToClipOffsetX: -1,
      screenToClipOffsetY: 1,
      defaultAnchor: DEFAULT_ANCHOR,
      defaultImageOffset: DEFAULT_OFFSET,
      useShaderSurfaceGeometry: false,
      useShaderBillboardGeometry: false,
      enableNdcBiasSurface: false,
      orderMax: collectOptions.orderMax,
      orderBucket: collectOptions.orderBucket,
      epsNdc: collectOptions.epsNdc,
      minClipZEpsilon: collectOptions.minClipZEpsilon,
      slDebug: false,
      ensureHitTestCorners: ensureCorners,
      resolveSpriteMercator: collectOptions.resolveSpriteMercator,
    });

    const secondCorners = secondPrepared[0].hitTestCorners;
    expect(secondCorners).not.toBeNull();
    expect(secondCorners![0]).toBe(firstCorners![0]);
    expect(secondCorners![1]).toBe(firstCorners![1]);
    expect(secondCorners![2]).toBe(firstCorners![2]);
    expect(secondCorners![3]).toBe(firstCorners![3]);
  });

  it('returns no entries when projection fails and clears surface data', () => {
    const resource = createImageResource('icon-e');
    const image = createImageState({ imageId: 'icon-e', mode: 'surface' });
    image.surfaceShaderInputs = {} as any;
    const sprite = createSpriteState('sprite-d', [image]);

    const depthItem: DepthSortedItem<null> = {
      sprite,
      image,
      resource,
      depthKey: 0,
    };

    const prepared = prepareSpriteEachImageDraw({
      items: [depthItem],
      originCenterCache: new Map(),
      mapInstance: createFakeMap({
        project: () => null,
      }),
      images: new Map([['icon-e', resource]]),
      zoom: 10,
      zoomScaleFactor: 1,
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
      defaultAnchor: DEFAULT_ANCHOR,
      defaultImageOffset: DEFAULT_OFFSET,
      useShaderSurfaceGeometry: false,
      useShaderBillboardGeometry: false,
      enableNdcBiasSurface: false,
      orderMax: 8,
      orderBucket: 4,
      epsNdc: 1e-6,
      minClipZEpsilon: 1e-6,
      slDebug: false,
      ensureHitTestCorners: createEnsureHitTestCorners(),
      resolveSpriteMercator: (spriteEntry) => spriteEntry.cachedMercator,
    });

    expect(prepared).toHaveLength(0);
    expect(image.surfaceShaderInputs).toBeUndefined();
  });
});
