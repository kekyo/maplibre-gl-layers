// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';

import {
  createProjectionHost,
  prepareProjectionState,
  type ProjectionHostParams,
} from '../src/projectionHost';
import {
  createWasmProjectLngLatToClipSpace,
  createWasmCalculateBillboardDepthKey,
  createWasmCalculateSurfaceDepthKey,
} from '../src/wasmCalculationHost';
import { initializeWasmHost } from '../src/wasmHost';
import {
  calculateBillboardDepthKey,
  calculateSurfaceDepthKey,
  multiplyMatrixAndVector,
  type SurfaceCorner,
} from '../src/math';
import { MIN_CLIP_W, MIN_CLIP_Z_EPSILON } from '../src/const';
import type { ClipContext } from '../src/internalTypes';
import type { SpriteLocation, SpriteScreenPoint } from '../src/types';
import { TRIANGLE_INDICES } from '../src/const';

//////////////////////////////////////////////////////////////////////////////////////

const BASE_PARAMS: ProjectionHostParams = {
  zoom: 11,
  width: 800,
  height: 600,
  center: { lng: 139.752, lat: 35.684, z: 30 },
  pitchDeg: 35,
  bearingDeg: 20,
  rollDeg: 5,
  fovDeg: 40,
  centerElevationMeters: 20,
  minElevationMeters: -120,
  cameraToCenterDistance: 550,
  centerOffsetX: 12,
  centerOffsetY: -8,
  tileSize: 512,
  autoCalculateNearFarZ: true,
};

const TEST_LOCATIONS: readonly SpriteLocation[] = [
  { lng: 139.751, lat: 35.683, z: 0 },
  { lng: 139.758, lat: 35.689, z: 45 },
  { lng: 139.745, lat: 35.681, z: -15 },
];

const EPS_CLIP = 1e-9;

const projectLngLatToClipSpaceJS = (
  clipContext: Readonly<ClipContext>,
  mercator: { x: number; y: number; z: number }
): [number, number, number, number] | null => {
  const [clipX, clipY, clipZ, clipW] = multiplyMatrixAndVector(
    clipContext.mercatorMatrix,
    mercator.x,
    mercator.y,
    mercator.z,
    1
  );

  if (
    !Number.isFinite(clipX) ||
    !Number.isFinite(clipY) ||
    !Number.isFinite(clipZ) ||
    !Number.isFinite(clipW) ||
    clipW <= MIN_CLIP_W
  ) {
    return null;
  }

  return [clipX, clipY, clipZ, clipW];
};

//////////////////////////////////////////////////////////////////////////////////////

describe('wasm projectLngLatToClipSpace', () => {
  it('matches JS implementation for representative coordinates', async () => {
    expect.hasAssertions();

    const initialized = await initializeWasmHost();
    expect(initialized).toBe(true);

    const referenceHost = createProjectionHost(BASE_PARAMS);
    const clipContext = referenceHost.getClipContext();
    if (!clipContext) {
      referenceHost.release();
      throw new Error('Clip context is required for test');
    }

    const wasmDelegate = createWasmProjectLngLatToClipSpace();

    try {
      for (const location of TEST_LOCATIONS) {
        const mercator = referenceHost.fromLngLat(location);
        const expected = projectLngLatToClipSpaceJS(clipContext, mercator);

        const actual = wasmDelegate(clipContext, location);

        if (expected === null) {
          expect(actual).toBeNull();
          continue;
        }

        expect(actual).not.toBeNull();
        const [clipX, clipY, clipZ, clipW] = actual!;
        expect(Math.abs(clipX - expected[0]!)).toBeLessThanOrEqual(EPS_CLIP);
        expect(Math.abs(clipY - expected[1]!)).toBeLessThanOrEqual(EPS_CLIP);
        expect(Math.abs(clipZ - expected[2]!)).toBeLessThanOrEqual(EPS_CLIP);
        expect(Math.abs(clipW - expected[3]!)).toBeLessThanOrEqual(EPS_CLIP);
      }

      // Guard: clipContext absent should return null without crashing.
      expect(wasmDelegate(null, TEST_LOCATIONS[0]!)).toBeNull();
    } finally {
      wasmDelegate.release();
      referenceHost.release();
    }
  });
});

describe('wasm calculateBillboardDepthKey', () => {
  it('matches JS implementation for projected centers', async () => {
    expect.hasAssertions();

    const initialized = await initializeWasmHost();
    expect(initialized).toBe(true);

    const referenceHost = createProjectionHost(BASE_PARAMS);
    const clipContext = referenceHost.getClipContext();
    if (!clipContext) {
      referenceHost.release();
      throw new Error('Clip context is required for test');
    }

    const preparedState = prepareProjectionState(BASE_PARAMS);
    const wasmDelegate = createWasmCalculateBillboardDepthKey(preparedState);

    try {
      const unproject = referenceHost.unproject.bind(referenceHost);
      const projectToClipSpace = (location: SpriteLocation) =>
        projectLngLatToClipSpaceJS(
          clipContext,
          referenceHost.fromLngLat(location)
        );

      for (const location of TEST_LOCATIONS) {
        const center = referenceHost.project(
          location
        ) as SpriteScreenPoint | null;
        expect(center).not.toBeNull();
        if (!center) {
          continue;
        }

        const expected = calculateBillboardDepthKey(
          center,
          unproject,
          projectToClipSpace
        );

        const actual = wasmDelegate(center);

        if (expected === null) {
          expect(actual).toBeNull();
        } else {
          expect(actual).not.toBeNull();
          expect(Math.abs((actual ?? 0) - expected)).toBeLessThanOrEqual(1e-9);
        }
      }
    } finally {
      wasmDelegate.release();
      referenceHost.release();
    }
  });
});

describe('wasm calculateSurfaceDepthKey', () => {
  it('matches JS implementation with and without bias', async () => {
    expect.hasAssertions();

    const initialized = await initializeWasmHost();
    expect(initialized).toBe(true);

    const referenceHost = createProjectionHost(BASE_PARAMS);
    const clipContext = referenceHost.getClipContext();
    if (!clipContext) {
      referenceHost.release();
      throw new Error('Clip context is required for test');
    }

    const preparedState = prepareProjectionState(BASE_PARAMS);
    const wasmDelegate = createWasmCalculateSurfaceDepthKey(preparedState);

    const surfaceDisplacements: SurfaceCorner[] = [
      { east: -12, north: -8 },
      { east: 14, north: -6 },
      { east: -10, north: 9 },
      { east: 16, north: 11 },
    ];

    const projectToClipSpace = (location: SpriteLocation) =>
      projectLngLatToClipSpaceJS(
        clipContext,
        referenceHost.fromLngLat(location)
      );

    const base = BASE_PARAMS.center;

    const expectedNoBias = calculateSurfaceDepthKey(
      base,
      surfaceDisplacements,
      projectToClipSpace
    );

    const biasNdc = -2.5e-5;
    const minClipZEpsilon = MIN_CLIP_Z_EPSILON;

    const expectedWithBias = calculateSurfaceDepthKey(
      base,
      surfaceDisplacements,
      projectToClipSpace,
      {
        biasFn: ({ clipZ, clipW }) => {
          const biasedClipZ = clipZ + biasNdc * clipW;
          const minClipZ = -clipW + minClipZEpsilon;
          return {
            clipZ: biasedClipZ < minClipZ ? minClipZ : biasedClipZ,
            clipW,
          };
        },
      }
    );

    const customIndices = TRIANGLE_INDICES.slice(0, 3);
    const expectedCustom = calculateSurfaceDepthKey(
      base,
      surfaceDisplacements,
      projectToClipSpace,
      { indices: customIndices }
    );

    try {
      const actualNoBias = wasmDelegate(base, surfaceDisplacements);
      expect(actualNoBias).toBeCloseTo(expectedNoBias ?? NaN, 12);

      const actualWithBias = wasmDelegate(base, surfaceDisplacements, {
        bias: { ndc: biasNdc, minClipZEpsilon },
      });
      expect(actualWithBias).toBeCloseTo(expectedWithBias ?? NaN, 12);

      const actualCustom = wasmDelegate(base, surfaceDisplacements, {
        indices: customIndices,
      });
      expect(actualCustom).toBeCloseTo(expectedCustom ?? NaN, 12);
    } finally {
      wasmDelegate.release();
      referenceHost.release();
    }
  });
});
