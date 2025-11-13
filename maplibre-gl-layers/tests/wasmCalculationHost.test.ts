// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';

import {
  __wasmCalculationTestInternals,
  type WasmCalculationInteropDependencies,
} from '../src/wasmCalculationHost';
import {
  type BufferHolder,
  type TypedArrayBufferView,
  type TypedArrayConstructor,
  type TypedArrayElement,
  type WasmHost,
} from '../src/wasmHost';
import { createIdHandler } from '../src/utils';
import type {
  InternalSpriteCurrentState,
  InternalSpriteImageState,
  PrepareDrawSpriteImageParams,
  RegisteredImage,
  RenderTargetEntryLike,
} from '../src/internalTypes';
import { ORDER_BUCKET } from '../src/const';
import {
  SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
  SPRITE_ORIGIN_REFERENCE_KEY_NONE,
} from '../src/internalTypes';
import type {
  SpriteAnchor,
  SpriteImageOffset,
  SpriteLocation,
} from '../src/types';
import { ResolvedSpriteScalingOptions } from '../src/math';
import { ProjectionHostParams } from '../src/projectionHost';

const RESULT_HEADER_LENGTH = 7;
const RESULT_VERTEX_COMPONENT_LENGTH = 36;
const RESULT_HIT_TEST_COMPONENT_LENGTH = 8;
const RESULT_SURFACE_BLOCK_LENGTH = 68;
const RESULT_COMMON_ITEM_LENGTH = 19;
const RESOURCE_STRIDE = 9;
const RESULT_ITEM_STRIDE =
  RESULT_COMMON_ITEM_LENGTH +
  RESULT_VERTEX_COMPONENT_LENGTH +
  RESULT_HIT_TEST_COMPONENT_LENGTH +
  RESULT_SURFACE_BLOCK_LENGTH;

class MockWasmHost implements WasmHost {
  readonly memory = new WebAssembly.Memory({ initial: 4 });
  private offset = 8;

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
    currentLocation: location,
    fromLocation: undefined,
    toLocation: undefined,
    images: new Map(),
    tag: null,
    interpolationState: null,
    pendingInterpolationOptions: null,
    lastCommandLocation: location,
    lastAutoRotationLocation: location,
    lastAutoRotationAngleDeg: 0,
    cachedMercator: { x: 10, y: 20, z: 30 },
    cachedMercatorLng: location.lng,
    cachedMercatorLat: location.lat,
    cachedMercatorZ: location.z,
  } as InternalSpriteCurrentState<null>;
};

const DEFAULT_ANCHOR: SpriteAnchor = { x: 0, y: 0 };
const DEFAULT_OFFSET: SpriteImageOffset = { offsetMeters: 0, offsetDeg: 0 };

const createImage = (): InternalSpriteImageState =>
  ({
    subLayer: 0,
    order: 0,
    imageId: 'image-1',
    imageHandle: 1,
    mode: 'surface',
    opacity: 1,
    scale: 1,
    anchor: DEFAULT_ANCHOR,
    offset: DEFAULT_OFFSET,
    rotateDeg: 0,
    displayedRotateDeg: 0,
    autoRotation: false,
    autoRotationMinDistanceMeters: 0,
    resolvedBaseRotateDeg: 0,
    originReferenceKey: SPRITE_ORIGIN_REFERENCE_KEY_NONE,
    originRenderTargetIndex: SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
    rotationInterpolationState: null,
    rotationInterpolationOptions: null,
    offsetDegInterpolationState: null,
    offsetMetersInterpolationState: null,
    opacityInterpolationState: null,
    lastCommandRotateDeg: 0,
    lastCommandOffsetDeg: 0,
    lastCommandOffsetMeters: 0,
    lastCommandOpacity: 1,
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
  zoomMin: 0,
  zoomMax: 24,
  scaleMin: 1,
  scaleMax: 1,
  spriteMinPixel: 0,
  spriteMaxPixel: 1024,
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
    spriteMinPixel: 1,
    spriteMaxPixel: 512,
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    pixelRatio: 1,
    clipContext: null,
    resolvedScaling: createResolvedScaling(),
    zoomScaleFactor: 1,
    identityScaleX: 1,
    identityScaleY: 1,
    identityOffsetX: 0,
    identityOffsetY: 0,
    screenToClipScaleX: 1,
    screenToClipScaleY: 1,
    screenToClipOffsetX: 0,
    screenToClipOffsetY: 0,
  } as unknown as PrepareDrawSpriteImageParams<null>;
};

const PROJECTION_PARAMS: ProjectionHostParams = {
  zoom: 10,
  width: 800,
  height: 600,
  center: { lng: 0, lat: 0 },
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
      const spriteOffset = buffer[6];
      expect(buffer[spriteOffset]).toBeCloseTo(sprite.currentLocation.lng);
      expect(buffer[spriteOffset + 3]).toBeCloseTo(sprite.cachedMercator.x);
      const resourceOffset = buffer[4];
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
      } finally {
        resultBuffer.release();
      }
    } finally {
      parameterHolder.release();
    }
  });
});
