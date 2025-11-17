// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { MercatorCoordinate } from 'maplibre-gl';
import type { ProjectionHostParams } from '../../src/host/projectionHost';
import type {
  InternalSpriteCurrentState,
  InternalSpriteImageState,
} from '../../src/internalTypes';
import {
  SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
  SPRITE_ORIGIN_REFERENCE_KEY_NONE,
} from '../../src/internalTypes';

vi.mock('../../src/host/projectionHost', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/host/projectionHost')>();
  const paramsToMap = new WeakMap<ProjectionHostParams, FakeMap>();

  return {
    ...actual,
    createProjectionHostParamsFromMapLibre: (map: FakeMap) => {
      const params: ProjectionHostParams = {
        zoom: map.getZoom?.() ?? 0,
        width: map.getCanvas?.()?.width ?? map.canvas?.width ?? 0,
        height: map.getCanvas?.()?.height ?? map.canvas?.height ?? 0,
        center: map.getCenter?.() ?? { lng: 0, lat: 0 },
      };
      paramsToMap.set(params, map);
      return params;
    },
    createProjectionHost: (params: ProjectionHostParams) => {
      const map = paramsToMap.get(params);
      if (!map) {
        return actual.createProjectionHost(params);
      }
      return {
        getZoom: () => map.getZoom(),
        getClipContext: () => {
          const transform = map.transform;
          if (!transform) {
            return null;
          }
          const mercatorMatrix =
            transform.mercatorMatrix ?? transform._mercatorMatrix;
          return mercatorMatrix ? { mercatorMatrix } : null;
        },
        fromLngLat: (location: { lng: number; lat: number; z?: number }) => {
          const mercator = MercatorCoordinate.fromLngLat(
            { lng: location.lng, lat: location.lat },
            location.z ?? 0
          );
          return {
            x: mercator.x,
            y: mercator.y,
            z: mercator.z ?? 0,
          };
        },
        project: (location: any) => map.project(location),
        unproject: (point: any) => map.unproject(point),
        calculatePerspectiveRatio: () =>
          map.transform?.cameraToCenterDistance ?? 1,
        getCameraLocation: () => ({
          lng: map.getCenter().lng,
          lat: map.getCenter().lat,
          z: map.transform?.cameraToCenterDistance ?? 0,
        }),
        release: () => {},
      };
    },
  };
});

const outlineDrawCalls: Array<{ color: readonly number[]; width: number }> = [];

vi.mock('../../src/gl/shader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/gl/shader')>();
  return {
    ...actual,
    createBorderOutlineRenderer: vi.fn(() => ({
      begin: vi.fn(),
      drawOutline: vi.fn((_, color, lineWidth) => {
        outlineDrawCalls.push({ color, width: lineWidth });
      }),
      end: vi.fn(),
      release: vi.fn(),
    })),
  };
});

import { createSpriteLayer } from '../../src/SpriteLayer';
import type { SpriteLayerClickEvent } from '../../src/types';

class FakeCanvas {
  readonly width: number;
  readonly height: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  private readonly listeners = new Map<
    string,
    Array<(event: unknown) => void>
  >();

  constructor(size = 512) {
    this.width = size;
    this.height = size;
    this.clientWidth = size;
    this.clientHeight = size;
  }

  addEventListener(
    type: string,
    listener: (event: unknown) => void,
    _options?: AddEventListenerOptions
  ): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const bucket = this.listeners.get(type);
    if (!bucket) {
      return;
    }
    const index = bucket.indexOf(listener);
    if (index >= 0) {
      bucket.splice(index, 1);
    }
    if (bucket.length === 0) {
      this.listeners.delete(type);
    }
  }

  getBoundingClientRect(): { left: number; top: number } {
    return { left: 0, top: 0 };
  }

  dispatch(type: string, event: unknown): void {
    const bucket = this.listeners.get(type);
    if (!bucket) {
      return;
    }
    for (const listener of bucket) {
      listener(event);
    }
  }

  getListeners(type: string): Array<(event: unknown) => void> {
    return this.listeners.get(type) ?? [];
  }
}

const identityMatrix = (): number[] => [
  1,
  0,
  0,
  0, //
  0,
  1,
  0,
  0, //
  0,
  0,
  1,
  0, //
  0,
  0,
  0,
  1,
];

type CanvasLike = FakeCanvas & HTMLCanvasElement;

class FakeMap {
  readonly canvas: CanvasLike;
  readonly transform: {
    mercatorMatrix: number[];
    _mercatorMatrix: number[];
    cameraToCenterDistance: number;
  };
  private readonly originX = 256;
  private readonly originY = 256;
  private readonly scale = 10;
  private zoom = 10;
  private center = { lng: 0, lat: 0 };

  constructor(canvas: FakeCanvas) {
    this.canvas = canvas as unknown as CanvasLike;
    this.transform = {
      mercatorMatrix: identityMatrix(),
      _mercatorMatrix: identityMatrix(),
      cameraToCenterDistance: 1,
    };
  }

  getCanvas(): CanvasLike {
    return this.canvas;
  }

  getZoom(): number {
    return this.zoom;
  }

  getCenter(): { lng: number; lat: number } {
    return this.center;
  }

  setCenter(center: { lng: number; lat: number }): void {
    this.center = { lng: center.lng, lat: center.lat };
  }

  setZoom(value: number): void {
    this.zoom = value;
  }

  project(lngLat: { lng: number; lat: number } | [number, number]): {
    x: number;
    y: number;
  } {
    const { lng, lat } = Array.isArray(lngLat)
      ? { lng: lngLat[0] ?? 0, lat: lngLat[1] ?? 0 }
      : { lng: lngLat.lng ?? 0, lat: lngLat.lat ?? 0 };
    return {
      x: this.originX + lng * this.scale,
      y: this.originY - lat * this.scale,
    };
  }

  unproject(point: { x: number; y: number } | [number, number]): {
    lng: number;
    lat: number;
  } {
    const [x, y] = Array.isArray(point)
      ? [point[0] ?? 0, point[1] ?? 0]
      : [point.x ?? 0, point.y ?? 0];
    return {
      lng: (x - this.originX) / this.scale,
      lat: -(y - this.originY) / this.scale,
    };
  }

  triggerRepaint(): void {
    // No-op for tests.
  }
}

class MockGLContext {
  readonly canvas: FakeCanvas;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;

  readonly ARRAY_BUFFER = 0x8892;
  readonly DYNAMIC_DRAW = 0x88e8;
  readonly TRIANGLES = 0x0004;
  readonly FLOAT = 0x1406;
  readonly SRC_ALPHA = 0x0302;
  readonly ONE_MINUS_SRC_ALPHA = 0x0303;
  readonly DEPTH_TEST = 0x0b71;
  readonly TEXTURE0 = 0x84c0;
  readonly TEXTURE_2D = 0x0de1;
  readonly TEXTURE_WRAP_S = 0x2802;
  readonly TEXTURE_WRAP_T = 0x2803;
  readonly CLAMP_TO_EDGE = 0x812f;
  readonly UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;
  readonly RGBA = 0x1908;
  readonly UNSIGNED_BYTE = 0x1401;
  readonly BLEND = 0x0be2;
  readonly LINE_LOOP = 0x0002;
  readonly COMPILE_STATUS = 0x8b81;
  readonly LINK_STATUS = 0x8b82;
  readonly VERTEX_SHADER = 0x8b31;
  readonly FRAGMENT_SHADER = 0x8b30;
  readonly TEXTURE_MIN_FILTER = 0x2801;
  readonly TEXTURE_MAG_FILTER = 0x2800;
  readonly LINEAR = 0x2601;
  readonly NEAREST = 0x2600;
  readonly LINEAR_MIPMAP_LINEAR = 0x2703;
  readonly LINEAR_MIPMAP_NEAREST = 0x2701;
  readonly NEAREST_MIPMAP_LINEAR = 0x2702;
  readonly NEAREST_MIPMAP_NEAREST = 0x2700;

  private nextTextureId = 1;

  constructor(canvas: FakeCanvas) {
    this.canvas = canvas;
    this.drawingBufferWidth = canvas.clientWidth;
    this.drawingBufferHeight = canvas.clientHeight;
  }

  getExtension(): null {
    return null;
  }

  createBuffer(): unknown {
    return {};
  }

  bindBuffer(): void {}
  bufferData(): void {}
  bufferSubData(): void {}

  createShader(): unknown {
    return {};
  }

  shaderSource(): void {}
  compileShader(): void {}
  getShaderParameter(): boolean {
    return true;
  }
  getShaderInfoLog(): string {
    return '';
  }
  deleteShader(): void {}

  createProgram(): unknown {
    return {};
  }

  attachShader(): void {}
  linkProgram(): void {}
  getProgramParameter(): boolean {
    return true;
  }
  getProgramInfoLog(): string {
    return '';
  }
  deleteProgram(): void {}

  useProgram(): void {}

  getAttribLocation(): number {
    return 0;
  }
  enableVertexAttribArray(): void {}
  disableVertexAttribArray(): void {}
  vertexAttribPointer(): void {}

  getUniformLocation(): unknown {
    return {};
  }
  uniform1i(): void {}
  uniform1f(): void {}
  uniform2f(): void {}
  uniform3f(): void {}
  uniform4f(): void {}
  uniformMatrix4fv(): void {}

  createTexture(): unknown {
    return { id: this.nextTextureId++ };
  }
  deleteTexture(): void {}
  bindTexture(): void {}
  activeTexture(): void {}
  texParameteri(): void {}
  texParameterf(): void {}
  pixelStorei(): void {}
  texImage2D(): void {}
  generateMipmap(): void {}

  drawArrays(): void {}
  lineWidth(): void {}

  enable(): void {}
  disable(): void {}
  blendFunc(): void {}
  depthMask(): void {}

  deleteBuffer(): void {}
}

type TestSpriteEvent = SpriteLayerClickEvent<unknown>;

const makeSpriteImage = (
  imageId: string,
  overrides?: Partial<{
    subLayer: number;
    order: number;
    scale: number;
  }>
) => ({
  imageId,
  mode: 'billboard' as const,
  subLayer: overrides?.subLayer ?? 0,
  order: overrides?.order ?? 0,
  opacity: 1,
  scale: overrides?.scale ?? 1,
});

describe('SpriteLayer hit testing with LooseQuadTree', () => {
  const fakeBitmap = { width: 32, height: 32 } as unknown as ImageBitmap;
  let originalPointerEvent: PointerEvent | undefined;

  beforeEach(() => {
    originalPointerEvent = (
      globalThis as unknown as { PointerEvent?: PointerEvent }
    ).PointerEvent;
    (globalThis as unknown as { PointerEvent?: PointerEvent }).PointerEvent =
      undefined;
    outlineDrawCalls.length = 0;
  });

  afterEach(() => {
    (globalThis as unknown as { PointerEvent?: PointerEvent }).PointerEvent =
      originalPointerEvent;
  });

  const setupLayer = async () => {
    const canvas = new FakeCanvas();
    const map = new FakeMap(canvas);
    const gl = new MockGLContext(canvas) as unknown as WebGLRenderingContext;

    const layer = createSpriteLayer({ id: 'test-layer' });
    await layer.onAdd?.(map as unknown as any, gl);
    await layer.registerImage('marker', fakeBitmap);

    return { layer, map, canvas, gl };
  };

  const simulateClick = (
    canvas: FakeCanvas,
    clientX: number,
    clientY: number
  ): void => {
    canvas.dispatch('click', {
      button: 0,
      clientX,
      clientY,
    } as MouseEvent);
  };

  it('dispatches spriteclick for the top-most sprite using quad-tree lookup', async () => {
    const { layer, map, canvas, gl } = await setupLayer();
    const location = { lng: 5, lat: 5 };

    layer.addSprite('bottom', {
      location,
      images: [makeSpriteImage('marker', { order: 0 })],
    });
    layer.addSprite('top', {
      location,
      images: [makeSpriteImage('marker', { order: 1 })],
    });

    const events: TestSpriteEvent[] = [];
    const clickHandler = (event: SpriteLayerClickEvent<unknown>) => {
      events.push(event as TestSpriteEvent);
    };
    layer.on('spriteclick', clickHandler);

    layer.render?.(gl, {} as any);

    const projected = map.project(location);
    simulateClick(canvas, projected.x, projected.y);

    expect(events).toHaveLength(1);
    expect(events[0]?.sprite?.spriteId).toBe('top');

    layer.off('spriteclick', clickHandler);
    layer.onRemove?.(map as unknown as any, gl);
  });

  it('updates hit testing when sprites are removed or disabled', async () => {
    const { layer, map, canvas, gl } = await setupLayer();
    const location = { lng: 3, lat: 4 };

    layer.addSprite('base', {
      location,
      images: [makeSpriteImage('marker', { order: 0 })],
    });
    layer.addSprite('overlay', {
      location,
      images: [makeSpriteImage('marker', { order: 1 })],
    });

    const recorded: string[] = [];
    const handler = (event: SpriteLayerClickEvent<unknown>) => {
      if (event.sprite) {
        recorded.push(event.sprite.spriteId);
      }
    };

    layer.on('spriteclick', handler);

    const projected = map.project(location);

    const clickAndRender = () => {
      layer.render?.(gl, {} as any);
      simulateClick(canvas, projected.x, projected.y);
    };

    clickAndRender();
    expect(recorded).toEqual(['overlay']);

    recorded.length = 0;
    layer.removeSprite('overlay');
    clickAndRender();
    expect(recorded).toEqual(['base']);

    recorded.length = 0;
    layer.updateSprite('base', { isEnabled: false });
    clickAndRender();
    expect(recorded).toHaveLength(0);

    layer.off('spriteclick', handler);
    layer.onRemove?.(map as unknown as any, gl);
  });

  it('throws when a sprite references a missing origin image', async () => {
    const { layer, map, gl } = await setupLayer();

    expect(() =>
      layer.addSprite('invalid-origin', {
        location: { lng: 0, lat: 0 },
        images: [
          {
            imageId: 'marker',
            mode: 'billboard',
            subLayer: 0,
            order: 1,
            opacity: 1,
            scale: 1,
            originLocation: { subLayer: 0, order: 0 },
          },
        ],
      })
    ).toThrowError(/originLocation refers missing image/);

    layer.onRemove?.(map as unknown as any, gl);
  });

  it('detects cyclic originLocation references within a sprite', async () => {
    const { layer, map, gl } = await setupLayer();

    expect(() =>
      layer.addSprite('cyclic-origin', {
        location: { lng: 0, lat: 0 },
        images: [
          {
            imageId: 'marker',
            mode: 'billboard',
            subLayer: 0,
            order: 0,
            opacity: 1,
            scale: 1,
            originLocation: { subLayer: 0, order: 1 },
          },
          {
            imageId: 'marker',
            mode: 'billboard',
            subLayer: 0,
            order: 1,
            opacity: 1,
            scale: 1,
            originLocation: { subLayer: 0, order: 0 },
          },
        ],
      })
    ).toThrowError(/originLocation has cyclic reference/);

    layer.onRemove?.(map as unknown as any, gl);
  });

  it('assigns origin render target index for referenced images', async () => {
    const { layer, map, gl } = await setupLayer();
    const spriteId = 'sprite-origin-index';

    const added = layer.addSprite(spriteId, {
      location: { lng: 0, lat: 0 },
      images: [
        { imageId: 'marker', mode: 'billboard', subLayer: 0, order: 0 },
        {
          imageId: 'marker',
          mode: 'billboard',
          subLayer: 0,
          order: 1,
          originLocation: { subLayer: 0, order: 0 },
        },
      ],
    });
    expect(added).toBe(true);

    const state = layer.getSpriteState(spriteId) as
      | InternalSpriteCurrentState<unknown>
      | undefined;
    expect(state).toBeDefined();

    const base = state?.images.get(0)?.get(0) as
      | InternalSpriteImageState
      | undefined;
    const child = state?.images.get(0)?.get(1) as
      | InternalSpriteImageState
      | undefined;

    expect(base).toBeDefined();
    expect(child).toBeDefined();
    expect(base?.originReferenceKey).toBe(SPRITE_ORIGIN_REFERENCE_KEY_NONE);
    expect(base?.originRenderTargetIndex).toBe(
      SPRITE_ORIGIN_REFERENCE_INDEX_NONE
    );
    expect(child?.originReferenceKey).not.toBe(
      SPRITE_ORIGIN_REFERENCE_KEY_NONE
    );
    expect(child?.originRenderTargetIndex).toBe(0);

    layer.onRemove?.(map as unknown as any, gl);
  });

  it('clears origin render target index when the referenced image is skipped', async () => {
    const { layer, map, gl } = await setupLayer();
    const spriteId = 'sprite-origin-update';

    layer.addSprite(spriteId, {
      location: { lng: 0, lat: 0 },
      images: [
        { imageId: 'marker', mode: 'billboard', subLayer: 0, order: 0 },
        {
          imageId: 'marker',
          mode: 'billboard',
          subLayer: 0,
          order: 1,
          originLocation: { subLayer: 0, order: 0 },
        },
      ],
    });

    const updated = layer.updateSpriteImage(spriteId, 0, 0, {
      opacity: 0,
    });
    expect(updated).toBe(true);

    const state = layer.getSpriteState(spriteId) as
      | InternalSpriteCurrentState<unknown>
      | undefined;
    expect(state).toBeDefined();

    const child = state?.images.get(0)?.get(1) as
      | InternalSpriteImageState
      | undefined;
    expect(child).toBeDefined();
    expect(child?.originRenderTargetIndex).toBe(
      SPRITE_ORIGIN_REFERENCE_INDEX_NONE
    );

    layer.onRemove?.(map as unknown as any, gl);
  });

  const expectSpriteOpacity = (
    layer: ReturnType<typeof createSpriteLayer>,
    spriteId: string
  ): number => {
    const state = layer.getSpriteState(spriteId);
    const image = state?.images.get(0)?.get(0);
    expect(image).toBeDefined();
    return image?.opacity.current ?? -1;
  };

  const hideSpriteViaPseudoLod = (
    layer: ReturnType<typeof createSpriteLayer>,
    map: FakeMap,
    gl: WebGLRenderingContext,
    spriteId: string,
    threshold: number
  ): void => {
    layer.updateSprite(spriteId, { visibilityDistanceMeters: threshold });
    map.transform.cameraToCenterDistance = threshold * 10;
    layer.render?.(gl, {} as any);
  };

  it('draws per-image borders using the sprite opacity', async () => {
    const { layer, map, gl } = await setupLayer();
    const location = { lng: 1, lat: 1 };

    layer.addSprite('bordered', {
      location,
      images: [
        {
          ...makeSpriteImage('marker'),
          opacity: 0.5,
          border: { color: 'rgba(0, 255, 0, 0.5)', widthPixel: 3 },
        },
      ],
    });

    layer.render?.(gl, {} as any);

    expect(outlineDrawCalls.length).toBeGreaterThan(0);
    const [{ color, width }] = outlineDrawCalls;
    expect(width).toBe(3);
    expect(color[1]).toBeCloseTo(1);
    expect(color[3]).toBeCloseTo(0.25);

    layer.onRemove?.(map as unknown as any, gl);
  });

  it('restores opacity when pseudo LOD is disabled after sprites were hidden', async () => {
    const { layer, map, gl } = await setupLayer();
    const spriteId = 'pseudo-lod-restore';
    layer.addSprite(spriteId, {
      location: { lng: 0, lat: 0 },
      images: [makeSpriteImage('marker')],
    });

    hideSpriteViaPseudoLod(layer, map, gl, spriteId, 100);
    expect(expectSpriteOpacity(layer, spriteId)).toBeCloseTo(0);

    layer.updateSprite(spriteId, { visibilityDistanceMeters: null });

    expect(expectSpriteOpacity(layer, spriteId)).toBeCloseTo(1);

    layer.onRemove?.(map as unknown as any, gl);
  });

  it('restores custom opacities when pseudo LOD is disabled', async () => {
    const { layer, map, gl } = await setupLayer();
    const spriteId = 'pseudo-lod-custom-opacity';
    layer.addSprite(spriteId, {
      location: { lng: 2, lat: 3 },
      images: [makeSpriteImage('marker')],
    });

    const customOpacity = 0.42;
    layer.updateSpriteImage(spriteId, 0, 0, { opacity: customOpacity });
    layer.render?.(gl, {} as any);

    hideSpriteViaPseudoLod(layer, map, gl, spriteId, 50);
    expect(expectSpriteOpacity(layer, spriteId)).toBeCloseTo(0);

    layer.updateSprite(spriteId, { visibilityDistanceMeters: null });

    expect(expectSpriteOpacity(layer, spriteId)).toBeCloseTo(customOpacity);

    layer.onRemove?.(map as unknown as any, gl);
  });
});
