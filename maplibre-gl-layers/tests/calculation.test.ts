// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';
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
import { SURFACE_BASE_CORNERS } from '../src/shader';

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

const createFakeMap = (options?: {
  project?: ProjectOverride;
  cameraDistance?: number;
}): MapLibreMap => {
  const project =
    options?.project ??
    ((location: Readonly<SpriteLocation>) => ({
      x: location.lng * SCALE,
      y: -location.lat * SCALE,
    }));
  const cameraToCenterDistance = options?.cameraDistance ?? 8;
  return {
    project,
    unproject: ([x, y]: [number, number]) => ({
      lng: x / SCALE,
      lat: -y / SCALE,
      z: 0,
    }),
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
