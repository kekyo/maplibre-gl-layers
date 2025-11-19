// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MercatorCoordinate } from 'maplibre-gl';

import { createCalculationHost } from '../../src/host/calculationHost';
import { createWasmCalculationHost } from '../../src/host/wasmCalculationHost';
import {
  createImageHandleBufferController,
  createIdHandler,
  createRenderTargetBucketBuffers,
  createSpriteOriginReference,
} from '../../src/utils/utils';
import type {
  InternalSpriteCurrentState,
  InternalSpriteImageState,
  PrepareDrawSpriteImageParams,
  PreparedDrawSpriteImageParams,
  RegisteredImage,
  RenderCalculationHost,
  RenderTargetEntryLike,
} from '../../src/internalTypes';
import {
  SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
  SPRITE_ORIGIN_REFERENCE_KEY_NONE,
} from '../../src/internalTypes';
import type {
  SpriteAnchor,
  SpriteImageOffset,
  SpriteLocation,
} from '../../src/types';
import {
  createProjectionHost,
  type ProjectionHostParams,
} from '../../src/host/projectionHost';
import type { WasmCalculationInteropDependencies } from '../../src/host/wasmCalculationHost';
import { DEFAULT_ANCHOR, DEFAULT_IMAGE_OFFSET } from '../../src/const';
import {
  POSITION_COMPONENT_COUNT,
  VERTEX_COMPONENT_COUNT,
} from '../../src/gl/shader';
import { initializeWasmHost, releaseWasmHost } from '../../src/host/wasmHost';

const PROJECTION_PARAMS: ProjectionHostParams = {
  zoom: 12,
  width: 800,
  height: 600,
  center: { lng: 0, lat: 0 },
  cameraLocation: undefined,
};

interface HostFactory {
  readonly name: string;
  readonly create: (
    deps: WasmCalculationInteropDependencies<null>
  ) => RenderCalculationHost<null>;
}

const HOST_FACTORIES: readonly HostFactory[] = [
  {
    name: 'js',
    create: () => createCalculationHost<null>(PROJECTION_PARAMS),
  },
  {
    name: 'wasm',
    create: (deps) => createWasmCalculationHost<null>(PROJECTION_PARAMS, deps),
  },
];

const createSpriteState = (
  spriteId: string,
  handle: number,
  location: SpriteLocation,
  imageState: InternalSpriteImageState
): InternalSpriteCurrentState<null> => {
  const mercator = MercatorCoordinate.fromLngLat(
    { lng: location.lng, lat: location.lat },
    location.z ?? 0
  );
  const spriteImages = new Map<number, Map<number, InternalSpriteImageState>>();
  const orderMap = new Map<number, InternalSpriteImageState>();
  orderMap.set(imageState.order, imageState);
  spriteImages.set(imageState.subLayer, orderMap);

  return {
    spriteId,
    handle,
    isEnabled: true,
    location: {
      current: location,
      from: undefined,
      to: undefined,
      invalidated: false,
      interpolation: {
        state: null,
        options: null,
        pendingOptions: null,
        lastCommandValue: location,
      },
    },
    opacityMultiplier: 1,
    images: spriteImages,
    tag: null,
    lastAutoRotationLocation: location,
    lastAutoRotationAngleDeg: 0,
    interpolationDirty: false,
    cachedMercator: { x: mercator.x, y: mercator.y, z: mercator.z ?? 0 },
    cachedMercatorLng: location.lng,
    cachedMercatorLat: location.lat,
    cachedMercatorZ: location.z,
  } as InternalSpriteCurrentState<null>;
};

const createImageState = (
  imageId: string,
  imageHandle: number
): InternalSpriteImageState => {
  const anchor: SpriteAnchor = DEFAULT_ANCHOR;
  const offset: SpriteImageOffset = DEFAULT_IMAGE_OFFSET;
  return {
    subLayer: 0,
    order: 0,
    imageId,
    imageHandle,
    mode: 'billboard',
    opacity: {
      current: 1,
      from: undefined,
      to: undefined,
      invalidated: false,
      interpolation: {
        state: null,
        options: null,
        targetValue: 1,
        baseValue: 1,
        lastCommandValue: 1,
      },
    },
    lodOpacity: 1,
    scale: 1,
    anchor,
    border: undefined,
    borderPixelWidth: 0,
    offset: {
      offsetMeters: {
        current: offset.offsetMeters,
        from: undefined,
        to: undefined,
        invalidated: false,
        interpolation: {
          state: null,
          options: null,
          lastCommandValue: offset.offsetMeters,
        },
      },
      offsetDeg: {
        current: offset.offsetDeg,
        from: undefined,
        to: undefined,
        invalidated: false,
        interpolation: {
          state: null,
          options: null,
          lastCommandValue: offset.offsetDeg,
        },
      },
    },
    rotateDeg: {
      current: 0,
      from: undefined,
      to: undefined,
      invalidated: false,
      interpolation: {
        state: null,
        options: null,
        lastCommandValue: 0,
      },
    },
    rotationCommandDeg: 0,
    displayedRotateDeg: 0,
    autoRotation: false,
    autoRotationMinDistanceMeters: 0,
    resolvedBaseRotateDeg: 0,
    originLocation: undefined,
    originReferenceKey: SPRITE_ORIGIN_REFERENCE_KEY_NONE,
    originRenderTargetIndex: SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
    interpolationDirty: false,
    surfaceShaderInputs: undefined,
    hitTestCorners: undefined,
  } as InternalSpriteImageState;
};

const createAtlasResource = (
  id: string,
  handle: number,
  pageIndex: number,
  atlas: { u0: number; v0: number; u1: number; v1: number }
): RegisteredImage => ({
  id,
  handle,
  width: 64,
  height: 32,
  bitmap: {} as ImageBitmap,
  texture: {} as WebGLTexture,
  atlasPageIndex: pageIndex,
  atlasU0: atlas.u0,
  atlasV0: atlas.v0,
  atlasU1: atlas.u1,
  atlasV1: atlas.v1,
});

interface AtlasRegion {
  readonly id: string;
  readonly pageIndex: number;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

const buildParams = (regions: readonly AtlasRegion[]) => {
  const originReference = createSpriteOriginReference();
  const imageIdHandler = createIdHandler<RegisteredImage>();
  const spriteIdHandler = createIdHandler<InternalSpriteCurrentState<null>>();
  const imageHandleBuffersController = createImageHandleBufferController();

  const images = new Map<string, RegisteredImage>();
  const bucket: RenderTargetEntryLike<null>[] = [];

  regions.forEach((region, index) => {
    const imageHandle = imageIdHandler.allocate(region.id);
    const resource = createAtlasResource(
      region.id,
      imageHandle,
      region.pageIndex,
      {
        u0: region.u0,
        v0: region.v0,
        u1: region.u1,
        v1: region.v1,
      }
    );
    imageIdHandler.store(imageHandle, resource);
    images.set(resource.id, resource);

    const imageState = createImageState(resource.id, resource.handle);
    const spriteHandle = spriteIdHandler.allocate(`sprite-${index}`);
    const sprite = createSpriteState(
      `sprite-${index}`,
      spriteHandle,
      {
        lng: 139.767 + index * 0.001,
        lat: 35.681 + index * 0.001,
        z: 0,
      },
      imageState
    );
    spriteIdHandler.store(spriteHandle, sprite);
    bucket.push([sprite, imageState]);
  });

  imageHandleBuffersController.markDirty(images);
  const imageHandleBuffers = imageHandleBuffersController.ensure();
  const imageResources = imageHandleBuffersController.getResourcesByHandle();

  images.forEach((resource) => {
    if (imageResources[resource.handle] !== resource) {
      throw new Error('Failed to align atlas resource handle.');
    }
    if (imageHandleBuffers.textureReady[resource.handle] !== 1) {
      throw new Error('Atlas resource is not marked texture-ready.');
    }
  });

  const bucketBuffers = createRenderTargetBucketBuffers(bucket, {
    originReference,
  });

  const projectionHost = createProjectionHost(PROJECTION_PARAMS);
  const clipContext = projectionHost.getClipContext();
  projectionHost.release();

  const params: PrepareDrawSpriteImageParams<null> = {
    bucket,
    bucketBuffers,
    imageResources,
    imageHandleBuffers,
    baseMetersPerPixel: 1,
    spriteMinPixel: 0,
    spriteMaxPixel: 2048,
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    pixelRatio: 1,
    clipContext,
    resolvedScaling: {
      metersPerPixel: 1,
      zoomMin: 0,
      zoomMax: 24,
      scaleMin: 1,
      scaleMax: 1,
      spriteMinPixel: 0,
      spriteMaxPixel: 2048,
    },
    zoomScaleFactor: 1,
    identityScaleX: 1,
    identityScaleY: 1,
    identityOffsetX: 0,
    identityOffsetY: 0,
    screenToClipScaleX: 1,
    screenToClipScaleY: 1,
    screenToClipOffsetX: 0,
    screenToClipOffsetY: 0,
  };

  const deps: WasmCalculationInteropDependencies<null> = {
    imageIdHandler,
    imageHandleBuffersController,
    originReference,
    spriteIdHandler,
  };

  return { params, deps };
};

const extractUvs = (vertexData: Float32Array): Array<[number, number]> => {
  const components = VERTEX_COMPONENT_COUNT;
  const uvOffset = POSITION_COMPONENT_COUNT;
  const uvs: Array<[number, number]> = [];
  for (let i = 0; i < vertexData.length; i += components) {
    const u = vertexData[i + uvOffset] ?? 0;
    const v = vertexData[i + uvOffset + 1] ?? 0;
    uvs.push([u, v]);
  }
  return uvs;
};

const SINGLE_REGION: AtlasRegion = {
  id: 'atlas-image-1',
  pageIndex: 0,
  u0: 0.25,
  v0: 0.5,
  u1: 0.5,
  v1: 0.75,
};

const MULTI_REGION_SET: readonly AtlasRegion[] = [
  SINGLE_REGION,
  {
    id: 'atlas-image-2',
    pageIndex: 1,
    u0: 0.1,
    v0: 0.2,
    u1: 0.3,
    v1: 0.4,
  },
];

const assertPreparedUvs = (
  preparedItems: PreparedDrawSpriteImageParams<null>[],
  regions: readonly AtlasRegion[]
): void => {
  expect(preparedItems).toHaveLength(regions.length);
  const uvsById = new Map<string, Array<[number, number]>>();
  preparedItems.forEach((item) => {
    uvsById.set(item.imageResource.id, extractUvs(item.vertexData));
  });
  regions.forEach((region) => {
    const uvs = uvsById.get(region.id);
    if (!uvs) {
      throw new Error(`Prepared item missing for ${region.id}`);
    }
    const expected: Array<readonly [number, number]> = [
      [region.u0, region.v0],
      [region.u1, region.v0],
      [region.u0, region.v1],
      [region.u0, region.v1],
      [region.u1, region.v0],
      [region.u1, region.v1],
    ];
    expect(uvs).toHaveLength(expected.length);
    uvs.forEach(([u, v], idx) => {
      const [expectedU, expectedV] = expected[idx]!;
      expect(u).toBeCloseTo(expectedU, 6);
      expect(v).toBeCloseTo(expectedV, 6);
    });
  });
};

describe.each(HOST_FACTORIES)('calculation hosts atlas UVs (%s)', (factory) => {
  beforeAll(async () => {
    await initializeWasmHost();
  });
  afterAll(() => {
    releaseWasmHost();
  });

  it('applies atlas UV ranges to prepared vertex data (single page)', () => {
    const { params, deps } = buildParams([SINGLE_REGION]);
    const host = factory.create(deps);
    try {
      const { preparedItems: prepared } = host.processDrawSpriteImages({
        prepareParams: params,
      });
      assertPreparedUvs(prepared, [SINGLE_REGION]);
    } finally {
      host.release();
    }
  });

  it('applies atlas UV ranges across multiple pages', () => {
    const { params, deps } = buildParams(MULTI_REGION_SET);
    const host = factory.create(deps);
    try {
      const { preparedItems: prepared } = host.processDrawSpriteImages({
        prepareParams: params,
      });
      assertPreparedUvs(prepared, MULTI_REGION_SET);
    } finally {
      host.release();
    }
  });
});
