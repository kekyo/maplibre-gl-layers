// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it, vi } from 'vitest';

import {
  initializeWasmHost,
  prepareWasmHost,
  releaseWasmHost,
} from '../src/host/wasmHost';

describe('WasmHost.allocateTypedBuffer', () => {
  it('reuses buffers of the same size without clearing previous contents', async () => {
    expect.hasAssertions();

    const variant = await initializeWasmHost('simd');
    expect(variant).not.toBe('disabled');

    const wasm = prepareWasmHost();

    try {
      const firstHolder = wasm.allocateTypedBuffer(Float64Array, 2);
      const { ptr: firstPtr, buffer: firstBuffer } = firstHolder.prepare();

      firstBuffer[0] = 123.456;
      firstBuffer[1] = -987.654;
      firstHolder.release();

      const secondHolder = wasm.allocateTypedBuffer(Float64Array, 2);
      const { ptr: reusedPtr, buffer: reusedBuffer } = secondHolder.prepare();

      expect(reusedPtr).toBe(firstPtr);
      expect(Array.from(reusedBuffer)).toEqual([123.456, -987.654]);

      secondHolder.release();
    } finally {
      releaseWasmHost();
    }
  });

  it('returns a different buffer when allocating a different size', async () => {
    expect.hasAssertions();

    const variant = await initializeWasmHost('simd');
    expect(variant).not.toBe('disabled');

    const wasm = prepareWasmHost();

    try {
      const smallHolder = wasm.allocateTypedBuffer(Float32Array, 2);
      const { ptr: smallPtr } = smallHolder.prepare();
      smallHolder.release();

      const largeHolder = wasm.allocateTypedBuffer(Float32Array, 3);
      const { ptr: largePtr } = largeHolder.prepare();

      expect(largePtr).not.toBe(smallPtr);

      largeHolder.release();
    } finally {
      releaseWasmHost();
    }
  });

  it('returns a new buffer after the pool evicts released entries', async () => {
    expect.hasAssertions();

    vi.useFakeTimers();
    const performanceNowSpy =
      typeof performance !== 'undefined'
        ? vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
        : undefined;
    try {
      const variant = await initializeWasmHost('simd');
      expect(variant).not.toBe('disabled');

      const wasm = prepareWasmHost();

      try {
        const holder = wasm.allocateTypedBuffer(Float64Array, 2);
        holder.prepare();
        holder.release();

        // Advance beyond the sweep interval and TTL so the pool frees the buffer.
        await vi.advanceTimersByTimeAsync(10_000);

        const nextHolder = wasm.allocateTypedBuffer(Float64Array, 2);
        expect(nextHolder).not.toBe(holder);
        const { buffer: nextBuffer } = nextHolder.prepare();
        expect(nextBuffer.length).toBe(2);

        nextHolder.release();
      } finally {
        releaseWasmHost();
      }
    } finally {
      performanceNowSpy?.mockRestore();
      vi.useRealTimers();
    }
  });
});
