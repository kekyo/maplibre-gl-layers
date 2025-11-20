// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  initializeWasmHost,
  prepareWasmHost,
  releaseWasmHost,
} from '../../src/host/wasmHost';
import { __wasmCalculationTestInternals } from '../../src/host/wasmCalculationHost';
import type { SpriteInterpolationState } from '../../src/internalTypes';

describe('wasm easing presets', () => {
  beforeAll(async () => {
    const initialized = await initializeWasmHost('nosimd', {
      force: true,
      wasmBaseUrl: undefined,
    });
    if (initialized === 'disabled') {
      throw new Error('WASM host failed to initialize.');
    }
  });

  afterAll(() => {
    releaseWasmHost();
  });

  it('applies ease-out easing with custom power on wasm', () => {
    const wasm = prepareWasmHost();
    const preset = { type: 'ease', mode: 'out', power: 2 } as const;
    const state: SpriteInterpolationState<number> = {
      mode: 'feedback',
      durationMs: 1000,
      easingFunction: (t: number) => t,
      easingAttributes: preset,
      from: 0,
      to: 10,
      startTimestamp: 0,
    };

    const result = __wasmCalculationTestInternals.processInterpolationsViaWasm(
      wasm,
      {
        distance: [{ state, timestamp: 500 }],
        degree: [],
        sprite: [],
      }
    );

    // ease-out (power 2) at 0.5 -> 1 - (1 - 0.5)^2 = 0.75
    expect(result.distance[0]?.value).toBeCloseTo(7.5);
    expect(result.distance[0]?.completed).toBe(false);
  });

  it('applies bounce easing with parameters on wasm', () => {
    const wasm = prepareWasmHost();
    const preset = { type: 'bounce', bounces: 4, decay: 0.8 } as const;
    const state: SpriteInterpolationState<number> = {
      mode: 'feedback',
      durationMs: 1000,
      easingFunction: (t: number) => t,
      easingAttributes: preset,
      from: 0,
      to: 1,
      startTimestamp: 0,
    };

    const result = __wasmCalculationTestInternals.processInterpolationsViaWasm(
      wasm,
      {
        distance: [{ state, timestamp: 500 }],
        degree: [],
        sprite: [],
      }
    );

    const expectedBounce = (() => {
      const bounces = 4;
      const decay = 0.8;
      const t = 0.5;
      const oscillation = Math.cos(Math.PI * (bounces + 0.5) * t);
      const dampening = decay ** (t * bounces);
      return 1 - Math.abs(oscillation) * dampening;
    })();

    expect(result.distance[0]?.value).toBeCloseTo(expectedBounce);
    expect(result.distance[0]?.completed).toBe(false);
  });
});
