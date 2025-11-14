// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';

import type { RegisteredImage } from '../src/internalTypes';
import {
  createImageHandleBufferController,
  createIdHandler,
} from '../src/utils/utils';

describe('createImageIdHandler', () => {
  it('reuses released handles before allocating new ones', () => {
    const handler = createIdHandler();
    const first = handler.allocate('image-a');
    const second = handler.allocate('image-b');

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first + 1);

    handler.release('image-a');

    const reused = handler.allocate('image-c');
    expect(reused).toBe(first);
  });

  it('resets allocation state and tolerates unknown releases', () => {
    const handler = createIdHandler();
    handler.allocate('image-a');
    handler.allocate('image-b');

    handler.reset();

    const handleAfterReset = handler.allocate('image-c');
    expect(handleAfterReset).toBe(1);
    expect(() => handler.release('non-existent')).not.toThrow();
  });
});

describe('createImageHandleBufferController', () => {
  const makeResource = (
    handle: number,
    texture?: WebGLTexture
  ): RegisteredImage => ({
    id: `resource-${handle}`,
    handle,
    width: handle * 10,
    height: handle * 20,
    bitmap: {} as ImageBitmap,
    texture,
    atlasPageIndex: -1,
    atlasU0: 0,
    atlasV0: 0,
    atlasU1: 1,
    atlasV1: 1,
  });

  it('builds metadata arrays sized by highest handle and encodes texture readiness', () => {
    const controller = createImageHandleBufferController();
    const imageA = makeResource(1, {} as WebGLTexture);
    const imageB = makeResource(3);

    controller.markDirty(
      new Map<string, RegisteredImage>([
        [imageA.id, imageA],
        [imageB.id, imageB],
      ])
    );

    const buffers = controller.ensure();
    expect(buffers.widths.length).toBe(4);
    expect(buffers.heights[1]).toBe(imageA.height);
    expect(buffers.widths[3]).toBe(imageB.width);
    expect(buffers.textureReady[1]).toBe(1);
    expect(buffers.textureReady[3]).toBe(0);
  });

  it('provides resources aligned by handle via getResourcesByHandle', () => {
    const controller = createImageHandleBufferController();
    const imageA = makeResource(1, {} as WebGLTexture);
    const imageB = makeResource(2);

    controller.markDirty(
      new Map<string, RegisteredImage>([
        [imageA.id, imageA],
        [imageB.id, imageB],
      ])
    );

    controller.ensure();
    const resources = controller.getResourcesByHandle();
    expect(resources.length).toBeGreaterThanOrEqual(3);
    expect(resources[1]).toBe(imageA);
    expect(resources[2]).toBe(imageB);
    expect(resources[0]).toBeUndefined();
  });

  it('reuses allocated arrays and clears stale metadata on rebuild', () => {
    const controller = createImageHandleBufferController();
    const imageInitial = makeResource(2, {} as WebGLTexture);
    controller.markDirty(new Map([[imageInitial.id, imageInitial]]));
    const firstBuffers = controller.ensure();
    expect(firstBuffers.widths[2]).toBe(imageInitial.width);
    expect(firstBuffers.textureReady[2]).toBe(1);

    const replacement = makeResource(1);
    controller.markDirty(new Map([[replacement.id, replacement]]));
    const secondBuffers = controller.ensure();
    expect(secondBuffers.widths.length).toBe(2);
    expect(secondBuffers.widths[1]).toBe(replacement.width);
    expect(secondBuffers.textureReady[1]).toBe(0);
    expect(secondBuffers.widths[0]).toBe(0);
  });

  it('returns cached buffers when ensure is called without new dirty state', () => {
    const controller = createImageHandleBufferController();
    const imageA = makeResource(1);
    controller.markDirty(new Map([[imageA.id, imageA]]));
    const firstBuffers = controller.ensure();

    const firstResources = controller.getResourcesByHandle();

    const secondBuffers = controller.ensure();
    const secondResources = controller.getResourcesByHandle();

    expect(secondBuffers).toBe(firstBuffers);
    expect(secondResources).toBe(firstResources);
    expect(secondBuffers.widths[1]).toBe(imageA.width);
    expect(secondResources[1]).toBe(imageA);
  });
});
