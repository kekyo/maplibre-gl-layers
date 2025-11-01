// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createSpriteLayer } from '../src/SpriteLayer';
import type { SpriteLayerClickEvent } from '../src/types';

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

class FakeMap {
  readonly canvas: FakeCanvas;
  readonly transform: {
    mercatorMatrix: number[];
    _mercatorMatrix: number[];
    cameraToCenterDistance: number;
  };
  private readonly originX = 256;
  private readonly originY = 256;
  private readonly scale = 10;
  private zoom = 10;

  constructor(canvas: FakeCanvas) {
    this.canvas = canvas;
    this.transform = {
      mercatorMatrix: identityMatrix(),
      _mercatorMatrix: identityMatrix(),
      cameraToCenterDistance: 1,
    };
  }

  getCanvas(): FakeCanvas {
    return this.canvas;
  }

  getZoom(): number {
    return this.zoom;
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
  vertexAttribPointer(): void {}

  getUniformLocation(): unknown {
    return {};
  }
  uniform1i(): void {}
  uniform1f(): void {}

  createTexture(): unknown {
    return { id: this.nextTextureId++ };
  }
  deleteTexture(): void {}
  bindTexture(): void {}
  activeTexture(): void {}
  texParameteri(): void {}
  pixelStorei(): void {}
  texImage2D(): void {}
  generateMipmap(): void {}

  drawArrays(): void {}

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
});
