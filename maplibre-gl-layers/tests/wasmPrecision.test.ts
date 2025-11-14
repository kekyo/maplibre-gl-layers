// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';

import {
  createProjectionHost,
  type ProjectionHostParams,
} from '../src/host/projectionHost';
import { createWasmProjectionHost } from '../src/host/wasmProjectionHost';
import { initializeWasmHost } from '../src/host/wasmHost';

//////////////////////////////////////////////////////////////////////////////////////

const SAMPLE_COUNT = 1_000_000;
const RANDOM_SEED = 0x6d6f7265; // "more" in ASCII.

const BASE_PARAMS: ProjectionHostParams = {
  zoom: 15,
  width: 1024,
  height: 768,
  center: { lng: 139.7514, lat: 35.685, z: 35 },
  pitchDeg: 45,
  bearingDeg: 30,
  rollDeg: 5,
  fovDeg: 50,
  centerElevationMeters: 25,
  minElevationMeters: -200,
  cameraToCenterDistance: 700,
  centerOffsetX: 24,
  centerOffsetY: -12,
  tileSize: 512,
  autoCalculateNearFarZ: true,
};

const createMulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randomInRange = (next: () => number, min: number, max: number): number =>
  min + (max - min) * next();

//////////////////////////////////////////////////////////////////////////////////////

describe('wasm fromLngLat precision', () => {
  it('compares 1M samples between JS and WASM implementations', async () => {
    expect.hasAssertions();

    const initialized = await initializeWasmHost();
    expect(initialized).not.toBe('disabled');

    const referenceHost = createProjectionHost(BASE_PARAMS);
    const wasmHost = createWasmProjectionHost(BASE_PARAMS);

    const random = createMulberry32(RANDOM_SEED);
    let maxDiffX = 0;
    let maxDiffY = 0;
    let maxDiffZ = 0;

    try {
      for (let index = 0; index < SAMPLE_COUNT; index++) {
        const lng = randomInRange(random, -180, 180);
        const lat = randomInRange(random, -85.051129, 85.051129);
        const altitude = randomInRange(random, -1000, 2000);

        const location = { lng, lat, z: altitude };

        const expected = referenceHost.fromLngLat(location);
        const actual = wasmHost.fromLngLat(location);

        const diffX = Math.abs(actual.x - expected.x);
        const diffY = Math.abs(actual.y - expected.y);
        const diffZ = Math.abs(actual.z - expected.z);

        if (diffX > maxDiffX) {
          maxDiffX = diffX;
        }
        if (diffY > maxDiffY) {
          maxDiffY = diffY;
        }
        if (diffZ > maxDiffZ) {
          maxDiffZ = diffZ;
        }
      }
    } finally {
      referenceHost.release();
      wasmHost.release();
    }

    // Allow the observed precision gap while keeping the comparison tight.
    expect(maxDiffX).toBeLessThanOrEqual(1e-12);
    expect(maxDiffY).toBeLessThanOrEqual(1e-12);
    expect(maxDiffZ).toBeLessThanOrEqual(1e-6);

    //console.info(
    //  'maplibre-gl-layers: fromLngLat max abs diff (x, y, z) =',
    //  maxDiffX,
    //  maxDiffY,
    //  maxDiffZ
    //);
  }, 60_000);
});
