// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';

import {
  __wasmCalculationTestInternals,
  type WasmCalculationInteropDependencies,
} from '../../src/host/wasmCalculationHost';
import {
  type BufferHolder,
  type TypedArrayBufferView,
  type TypedArrayConstructor,
  type TypedArrayElement,
  type WasmHost,
} from '../../src/host/wasmHost';
import { createIdHandler } from '../../src/utils/utils';
import type {
  InternalSpriteCurrentState,
  InternalSpriteImageState,
  PrepareDrawSpriteImageParams,
  RegisteredImage,
  RenderTargetEntryLike,
  SpriteInterpolationEvaluationResult,
  SpriteInterpolationState,
} from '../../src/internalTypes';
import { ORDER_BUCKET } from '../../src/const';
import {
  SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
  SPRITE_ORIGIN_REFERENCE_KEY_NONE,
} from '../../src/internalTypes';
import type { SpriteAnchor, SpriteLocation } from '../../src/types';
import type { ResolvedSpriteScalingOptions } from '../../src/utils/math';
import type { ProjectionHostParams } from '../../src/host/projectionHost';

type TestSpriteOffset = { offsetMeters: number; offsetDeg: number };

const RESULT_HEADER_LENGTH = 7;
const RESULT_VERTEX_COMPONENT_LENGTH = 36;
const RESULT_HIT_TEST_COMPONENT_LENGTH = 8;
const RESULT_SURFACE_BLOCK_LENGTH = 68;
const RESULT_COMMON_ITEM_LENGTH = 20;
const RESOURCE_STRIDE = 9;
const RESULT_ITEM_STRIDE =
  RESULT_COMMON_ITEM_LENGTH +
  RESULT_VERTEX_COMPONENT_LENGTH +
  RESULT_HIT_TEST_COMPONENT_LENGTH +
  RESULT_SURFACE_BLOCK_LENGTH;
const DISTANCE_INTERPOLATION_ITEM_LENGTH = 11;
const DEGREE_INTERPOLATION_ITEM_LENGTH = 11;
const SPRITE_INTERPOLATION_ITEM_LENGTH = 14;
const PROCESS_INTERPOLATIONS_HEADER_LENGTH = 3;

interface WasmProcessInterpolationResults {
  distance: (SpriteInterpolationEvaluationResult<number> & {
    finalValue: number;
  })[];
  degree: (SpriteInterpolationEvaluationResult<number> & {
    finalValue: number;
  })[];
  location: SpriteInterpolationEvaluationResult<SpriteLocation>[];
}

class MockWasmHost implements WasmHost {
  readonly memory = new WebAssembly.Memory({ initial: 4 });
  private offset = 8;
  nextProcessResponse: WasmProcessInterpolationResults = {
    distance: [],
    degree: [],
    location: [],
  };
  lastProcessRequestCounts: {
    distance: number;
    degree: number;
    sprite: number;
  } | null = null;

  release(): void {}

  malloc(size: number): number {
    const aligned = (size + 7) & ~7;
    const ptr = this.offset;
    this.offset += aligned;
    const bytesNeeded = this.offset - this.memory.buffer.byteLength;
    if (bytesNeeded > 0) {
      const pages = Math.ceil(bytesNeeded / 65536);
      this.memory.grow(pages);
    }
    return ptr;
  }

  free(_ptr: number): void {}

  allocateTypedBuffer<TArray extends TypedArrayBufferView<TArray>>(
    ArrayType: TypedArrayConstructor<TArray>,
    elements: number | ArrayLike<TypedArrayElement<TArray>>
  ): BufferHolder<TArray> {
    const length = typeof elements === 'number' ? elements : elements.length;
    const bytes = length * ArrayType.BYTES_PER_ELEMENT;
    const ptr = this.malloc(bytes);
    let buffer = new ArrayType(this.memory.buffer, ptr, length);
    let released = false;
    const holder: BufferHolder<TArray> = {
      length,
      prepare: () => {
        if (released) {
          throw new Error('Buffer already released.');
        }
        if (buffer.buffer !== this.memory.buffer) {
          buffer = new ArrayType(this.memory.buffer, ptr, length);
        }
        return { ptr, buffer };
      },
      release: () => {
        if (!released) {
          released = true;
          this.free(ptr);
        }
      },
    };
    if (typeof elements !== 'number') {
      holder.prepare().buffer.set(elements);
    }
    return holder;
  }

  fromLngLat(): boolean {
    return true;
  }

  project(): boolean {
    return true;
  }

  unproject(): boolean {
    return true;
  }

  calculatePerspectiveRatio(): boolean {
    return true;
  }

  projectLngLatToClipSpace(): boolean {
    return true;
  }

  calculateBillboardDepthKey(): boolean {
    return true;
  }

  calculateSurfaceDepthKey(): boolean {
    return true;
  }

  prepareDrawSpriteImages(): boolean {
    return true;
  }

  setNextProcessResponse(response: WasmProcessInterpolationResults): void {
    this.nextProcessResponse = response;
  }

  processInterpolations(paramsPtr: number, resultPtr: number): boolean {
    const view = new Float64Array(this.memory.buffer);
    const start = paramsPtr / Float64Array.BYTES_PER_ELEMENT;
    const distanceCount = Number(view[start] ?? 0);
    const degreeCount = Number(view[start + 1] ?? 0);
    const spriteCount = Number(view[start + 2] ?? 0);
    this.lastProcessRequestCounts = {
      distance: distanceCount,
      degree: degreeCount,
      sprite: spriteCount,
    };

    let readCursor = start + PROCESS_INTERPOLATIONS_HEADER_LENGTH;
    readCursor += distanceCount * DISTANCE_INTERPOLATION_ITEM_LENGTH;
    readCursor += degreeCount * DEGREE_INTERPOLATION_ITEM_LENGTH;
    readCursor += spriteCount * SPRITE_INTERPOLATION_ITEM_LENGTH;

    const response = this.nextProcessResponse;
    if (
      response.distance.length !== distanceCount ||
      response.degree.length !== degreeCount ||
      response.location.length !== spriteCount
    ) {
      throw new Error(
        'Unexpected process interpolation response configuration'
      );
    }

    let writeCursor = resultPtr / Float64Array.BYTES_PER_ELEMENT;
    view[writeCursor++] = distanceCount;
    view[writeCursor++] = degreeCount;
    view[writeCursor++] = spriteCount;

    for (const entry of response.distance) {
      view[writeCursor++] = entry.value;
      view[writeCursor++] = entry.finalValue;
      view[writeCursor++] = entry.completed ? 1 : 0;
      view[writeCursor++] = entry.effectiveStartTimestamp;
    }
    for (const entry of response.degree) {
      view[writeCursor++] = entry.value;
      view[writeCursor++] = entry.finalValue;
      view[writeCursor++] = entry.completed ? 1 : 0;
      view[writeCursor++] = entry.effectiveStartTimestamp;
    }
    for (const entry of response.location) {
      view[writeCursor++] = entry.value.lng;
      view[writeCursor++] = entry.value.lat;
      view[writeCursor++] = entry.value.z ?? 0;
      view[writeCursor++] = entry.value.z !== undefined ? 1 : 0;
      view[writeCursor++] = entry.completed ? 1 : 0;
      view[writeCursor++] = entry.effectiveStartTimestamp;
    }

    this.nextProcessResponse = {
      distance: [],
      degree: [],
      location: [],
    };

    return true;
  }
}

const createSprite = (
  spriteId: string,
  spriteHandle: number
): InternalSpriteCurrentState<null> => {
  const location: SpriteLocation = { lng: 1, lat: 2, z: 3 };
  return {
    spriteId,
    handle: spriteHandle,
    isEnabled: true,
    location: {
      current: location,
      from: undefined,
      to: undefined,
      invalidated: false,
      interpolation: {
        state: null,
        options: null,
        lastCommandValue: location,
        baseValue: undefined,
        targetValue: undefined,
      },
    },
    images: new Map(),
    opacityMultiplier: 1,
    tag: null,
    lastAutoRotationLocation: location,
    currentAutoRotateDeg: 0,
    interpolationDirty: false,
    cachedMercator: { x: 10, y: 20, z: 30 },
    cachedMercatorLng: location.lng,
    cachedMercatorLat: location.lat,
    cachedMercatorZ: location.z,
  } as InternalSpriteCurrentState<null>;
};

const DEFAULT_ANCHOR: SpriteAnchor = { x: 0, y: 0 };
const DEFAULT_OFFSET: TestSpriteOffset = { offsetMeters: 0, offsetDeg: 0 };

const createImage = (): InternalSpriteImageState =>
  ({
    subLayer: 0,
    order: 0,
    imageId: 'image-1',
    imageHandle: 1,
    mode: 'surface',
    rotateDeg: 0,
    opacity: 1,
    finalOpacity: {
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
    anchor: DEFAULT_ANCHOR,
    offset: {
      offsetMeters: {
        current: DEFAULT_OFFSET.offsetMeters,
        from: undefined,
        to: undefined,
        invalidated: false,
        interpolation: {
          state: null,
          options: null,
          lastCommandValue: DEFAULT_OFFSET.offsetMeters,
        },
      },
      offsetDeg: {
        current: DEFAULT_OFFSET.offsetDeg,
        from: undefined,
        to: undefined,
        invalidated: false,
        interpolation: {
          state: null,
          options: null,
          lastCommandValue: DEFAULT_OFFSET.offsetDeg,
        },
      },
    },
    finalRotateDeg: {
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
    autoRotation: false,
    autoRotationMinDistanceMeters: 0,
    originLocation: undefined,
    originReferenceKey: SPRITE_ORIGIN_REFERENCE_KEY_NONE,
    originRenderTargetIndex: SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
    interpolationDirty: false,
    surfaceShaderInputs: undefined,
    hitTestCorners: undefined,
  }) as InternalSpriteImageState;

const createRegisteredImage = (): RegisteredImage => ({
  id: 'image-1',
  handle: 1,
  width: 64,
  height: 32,
  bitmap: {} as ImageBitmap,
  texture: undefined,
  atlasPageIndex: 0,
  atlasU0: 0,
  atlasV0: 0,
  atlasU1: 1,
  atlasV1: 1,
});

const createResolvedScaling = (): ResolvedSpriteScalingOptions => ({
  metersPerPixel: 1,
  minScaleDistanceMeters: 0,
  maxScaleDistanceMeters: Number.POSITIVE_INFINITY,
});

const createPrepareParams = (
  sprite: InternalSpriteCurrentState<null>,
  image: InternalSpriteImageState,
  imageResource: RegisteredImage
): PrepareDrawSpriteImageParams<null> => {
  const entry: RenderTargetEntryLike<null> = [sprite, image];
  return {
    bucket: [entry],
    bucketBuffers: {
      originReferenceKeys: new Int32Array([SPRITE_ORIGIN_REFERENCE_KEY_NONE]),
      originTargetIndices: new Int32Array([SPRITE_ORIGIN_REFERENCE_INDEX_NONE]),
    },
    imageResources: [imageResource],
    imageHandleBuffers: {
      widths: new Float32Array([imageResource.width]),
      heights: new Float32Array([imageResource.height]),
      textureReady: new Uint8Array([1]),
    },
    baseMetersPerPixel: 1,
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    pixelRatio: 1,
    clipContext: undefined,
    resolvedScaling: createResolvedScaling(),
    identityScaleX: 1,
    identityScaleY: 1,
    identityOffsetX: 0,
    identityOffsetY: 0,
    screenToClipScaleX: 1,
    screenToClipScaleY: 1,
    screenToClipOffsetX: 0,
    screenToClipOffsetY: 0,
  };
};

const PROJECTION_PARAMS: ProjectionHostParams = {
  zoom: 10,
  width: 800,
  height: 600,
  center: { lng: 0, lat: 0 },
  cameraLocation: undefined,
};

const createMockDependencies = () => {
  const resourcesByHandle: (RegisteredImage | undefined)[] = [undefined];
  const imageIdHandler = createIdHandler<RegisteredImage>();
  const spriteIdHandler = createIdHandler<InternalSpriteCurrentState<null>>();
  const deps: WasmCalculationInteropDependencies<null> = {
    imageIdHandler,
    imageHandleBuffersController: {
      markDirty: () => {},
      ensure: () => ({
        widths: new Float32Array(resourcesByHandle.length),
        heights: new Float32Array(resourcesByHandle.length),
        textureReady: new Uint8Array(resourcesByHandle.length),
      }),
      getResourcesByHandle: () => resourcesByHandle,
    },
    originReference: {
      encodeKey: (subLayer: number, order: number) =>
        subLayer * ORDER_BUCKET + order,
      decodeKey: (key: number) => ({
        subLayer:
          key === SPRITE_ORIGIN_REFERENCE_KEY_NONE
            ? -1
            : Math.trunc(key / ORDER_BUCKET),
        order:
          key === SPRITE_ORIGIN_REFERENCE_KEY_NONE ? -1 : key % ORDER_BUCKET,
      }),
    },
    spriteIdHandler,
  };
  return { deps, resourcesByHandle, spriteIdHandler };
};

describe('convertToWasmProjectionState', () => {
  it('writes header and table metadata', () => {
    const wasm = new MockWasmHost();
    const { deps, resourcesByHandle, spriteIdHandler } =
      createMockDependencies();
    const spriteHandle = spriteIdHandler.allocate('sprite-1');
    const sprite = createSprite('sprite-1', spriteHandle);
    spriteIdHandler.store(spriteHandle, sprite);
    const image = createImage();
    const resource = createRegisteredImage();
    const params = createPrepareParams(sprite, image, resource);
    resourcesByHandle[resource.handle] = resource;

    const state =
      __wasmCalculationTestInternals.convertToWasmProjectionState<null>(
        wasm,
        PROJECTION_PARAMS,
        deps
      );
    const result = state.prepareInputBuffer(params);
    try {
      expect(result.resultItemCount).toBe(1);
      const { buffer } = result.parameterHolder.prepare();
      expect(buffer[0]).toBeGreaterThan(0); // total length
      expect(buffer[3]).toBe(2); // resource count (handles 0..1)
      expect(buffer[5]).toBe(1); // sprite count
      expect(buffer[7]).toBe(1); // item count
      const spriteOffset = buffer[6] ?? 0;
      expect(buffer[spriteOffset]).toBeCloseTo(sprite.location.current.lng);
      expect(buffer[spriteOffset + 3]).toBeCloseTo(sprite.cachedMercator.x);
      const resourceOffset = buffer[4] ?? 0;
      const handleOffset = resourceOffset + resource.handle * RESOURCE_STRIDE;
      expect(buffer[handleOffset]).toBe(resource.handle);
      expect(buffer[handleOffset + 1]).toBe(resource.width);
    } finally {
      result.release();
    }
  });
});

describe('converToDrawImageParams', () => {
  it('reconstructs prepared items from wasm buffer', () => {
    const wasm = new MockWasmHost();
    const { deps, resourcesByHandle, spriteIdHandler } =
      createMockDependencies();
    const spriteHandle = spriteIdHandler.allocate('sprite-1');
    const sprite = createSprite('sprite-1', spriteHandle);
    spriteIdHandler.store(spriteHandle, sprite);
    const image = createImage();
    const resource = createRegisteredImage();
    const params = createPrepareParams(sprite, image, resource);
    resourcesByHandle[resource.handle] = resource;

    const state =
      __wasmCalculationTestInternals.convertToWasmProjectionState<null>(
        wasm,
        PROJECTION_PARAMS,
        deps
      );
    const { parameterHolder } = state.prepareInputBuffer(params);
    expect(state.getImageRefs().length).toBe(1);
    try {
      const resultBuffer = wasm.allocateTypedBuffer(
        Float64Array,
        RESULT_HEADER_LENGTH + RESULT_ITEM_STRIDE
      );
      try {
        const { buffer } = resultBuffer.prepare();
        buffer[0] = 1; // prepared count
        buffer[1] = RESULT_ITEM_STRIDE;
        buffer[2] = RESULT_VERTEX_COMPONENT_LENGTH;
        buffer[3] = 4;
        buffer[4] = 0b11; // hit test + surface inputs

        let cursor = RESULT_HEADER_LENGTH;
        buffer[cursor++] = spriteHandle; // sprite handle
        buffer[cursor++] = 0; // image index
        buffer[cursor++] = 1; // resource index
        buffer[cursor++] = 0.5; // opacity
        buffer[cursor++] = 1; // scaleX
        buffer[cursor++] = 1; // scaleY
        buffer[cursor++] = 0; // offsetX
        buffer[cursor++] = 0; // offsetY
        buffer[cursor++] = 1; // use shader surface
        buffer[cursor++] = 1; // surface clip
        buffer[cursor++] = 1; // use shader billboard
        buffer[cursor++] = 10; // center.x
        buffer[cursor++] = 20; // center.y
        buffer[cursor++] = 2; // half width
        buffer[cursor++] = 3; // half height
        buffer[cursor++] = 0; // anchor.x
        buffer[cursor++] = 0; // anchor.y
        buffer[cursor++] = 0.5; // sin
        buffer[cursor++] = 0.5; // cos
        buffer[cursor++] = 1234; // camera distance

        const vertexStart = cursor;
        for (let i = 0; i < RESULT_VERTEX_COMPONENT_LENGTH; i++) {
          buffer[vertexStart + i] = i;
        }
        cursor = vertexStart + RESULT_VERTEX_COMPONENT_LENGTH;

        for (let i = 0; i < RESULT_HIT_TEST_COMPONENT_LENGTH; i++) {
          buffer[cursor + i] = i + 1;
        }
        cursor += RESULT_HIT_TEST_COMPONENT_LENGTH;

        // Surface block
        const fillValue = (value: number) => {
          buffer[cursor++] = value;
        };
        // mercator center
        fillValue(30);
        fillValue(40);
        fillValue(50);
        // worldToMercator
        fillValue(0.1);
        fillValue(0.2);
        // half size
        fillValue(10);
        fillValue(5);
        // anchor
        fillValue(0.1);
        fillValue(0.2);
        // offset meters
        fillValue(1);
        fillValue(2);
        // sin/cos
        fillValue(0.5);
        fillValue(0.8660254038);
        // rotate/ bias
        fillValue(15);
        fillValue(-0.0001);
        // center displacement
        fillValue(0.3);
        fillValue(0.4);
        // clip center
        fillValue(5);
        fillValue(6);
        fillValue(7);
        fillValue(1);
        // clip basis east
        fillValue(1);
        fillValue(0);
        fillValue(0);
        fillValue(0);
        // clip basis north
        fillValue(0);
        fillValue(1);
        fillValue(0);
        fillValue(0);
        // clip corners (4 * 4)
        for (let i = 0; i < 16; i++) {
          fillValue(i + 0.1);
        }
        // base lnglat
        fillValue(1);
        fillValue(2);
        fillValue(3);
        // displaced
        fillValue(4);
        fillValue(5);
        fillValue(6);
        // scale adjustment
        fillValue(1.5);
        // corner model (4 * 4)
        for (let i = 0; i < 16; i++) {
          fillValue(i * 0.1);
        }

        const prepared =
          __wasmCalculationTestInternals.converToPreparedDrawImageParams(
            state,
            deps,
            resultBuffer
          );
        expect(prepared).toHaveLength(1);
        const item = prepared[0]!;
        expect(item.spriteEntry).toBe(sprite);
        expect(item.imageEntry).toBe(image);
        expect(item.imageResource).toBe(resource);
        expect(item.vertexData.length).toBe(RESULT_VERTEX_COMPONENT_LENGTH);
        expect(item.vertexData[0]).toBe(0);
        expect(item.hitTestCorners).not.toBeNull();
        expect(item.surfaceShaderInputs).toBeDefined();
        expect(item.surfaceShaderInputs!.mercatorCenter.x).toBe(30);
        expect(item.useShaderBillboard).toBe(true);
        expect(item.billboardUniforms?.center.x).toBe(10);
        expect(item.cameraDistanceMeters).toBe(1234);
      } finally {
        resultBuffer.release();
      }
    } finally {
      parameterHolder.release();
    }
  });
});

describe('internalProcessInterpolationsCore', () => {
  it('encodes requests and decodes wasm responses', () => {
    const wasm = new MockWasmHost();
    const linear = (value: number): number => value;
    const distanceState: SpriteInterpolationState<number> = {
      mode: 'feedback',
      durationMs: 1000,
      easingFunc: linear,
      easingParam: { type: 'linear' },
      from: 0,
      to: 10,
      startTimestamp: -1,
    };
    const degreeState: SpriteInterpolationState<number> = {
      mode: 'feedback',
      durationMs: 1000,
      easingFunc: linear,
      easingParam: { type: 'linear' },
      from: 0,
      to: 90,
      startTimestamp: -1,
    };
    const spriteState: SpriteInterpolationState<SpriteLocation> = {
      mode: 'feedback',
      durationMs: 1000,
      easingFunc: linear,
      easingParam: { type: 'linear' },
      from: { lng: 0, lat: 0 },
      to: { lng: 5, lat: 0 },
      startTimestamp: -1,
    };

    const requests = {
      distance: [distanceState],
      degree: [degreeState],
      location: [spriteState],
    };

    wasm.setNextProcessResponse({
      distance: [
        {
          value: 3,
          finalValue: 10,
          completed: false,
          effectiveStartTimestamp: 10,
        },
      ],
      degree: [
        {
          value: 30,
          finalValue: 90,
          completed: true,
          effectiveStartTimestamp: 20,
        },
      ],
      location: [
        {
          value: { lng: 1, lat: 2 },
          completed: false,
          effectiveStartTimestamp: 30,
        },
      ],
    });

    const result =
      __wasmCalculationTestInternals.internalProcessInterpolationsCore(
        wasm,
        requests,
        50
      );

    expect(result.distance).toHaveLength(1);
    expect(result.distance[0]?.value).toBe(3);
    expect(result.distance[0]?.finalValue).toBe(10);
    expect(result.degree[0]?.completed).toBe(true);
    expect(result.degree[0]?.finalValue).toBe(90);
    expect(result.location[0]?.value.lng).toBeCloseTo(1);
    expect(wasm.lastProcessRequestCounts).toEqual({
      distance: 1,
      degree: 1,
      sprite: 1,
    });
  });
});
