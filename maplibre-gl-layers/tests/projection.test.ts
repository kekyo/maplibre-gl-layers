// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';

import {
  createProjectionHost,
  createProjectionHostParamsFromMapLibre,
  type ProjectionHostParams,
} from '../src/projectionHost';
import {
  createWasmProjectionHost,
  initProjectionWasm,
} from '../src/wasmProjectionHost';
import { createMapLibreProjectionHost } from '../src/mapLibreProjectionHost';
import type { ProjectionHost } from '../src/internalTypes';
import type { SpriteLocation } from '../src/types';
import { DEG2RAD, TILE_SIZE } from '../src/const';

//////////////////////////////////////////////////////////////////////////////////////

const BASE_PARAMS: ProjectionHostParams = {
  zoom: 12.5,
  width: 1024,
  height: 768,
  center: { lng: 139.7514, lat: 35.685, z: 45 },
  pitchDeg: 37,
  bearingDeg: 25,
  rollDeg: 3,
  fovDeg: 45,
  centerElevationMeters: 35,
  minElevationMeters: -120,
  cameraToCenterDistance: 600,
  centerOffsetX: 18,
  centerOffsetY: -12,
  tileSize: TILE_SIZE,
  autoCalculateNearFarZ: true,
};

const TEST_LOCATIONS: SpriteLocation[] = [
  { lng: 139.752, lat: 35.684, z: 0 },
  { lng: 139.76, lat: 35.69, z: 25 },
  { lng: 139.743, lat: 35.68, z: -10 },
];

const EPS = 5e-4;

//////////////////////////////////////////////////////////////////////////////////////

const toMercatorMatrix = (host: ProjectionHost): readonly number[] => {
  const clip = host.getClipContext();
  if (!clip) {
    throw new Error('Clip context is required for test');
  }
  return Array.from(clip.mercatorMatrix);
};

const expectClose = (actual: number, expected: number, epsilon = EPS) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(epsilon);
};

const expectPointClose = (
  actual: { x: number; y: number },
  expected: { x: number; y: number },
  epsilon = 1e-4
) => {
  expectClose(actual.x, expected.x, epsilon);
  expectClose(actual.y, expected.y, epsilon);
};

const expectLocationClose = (
  actual: SpriteLocation,
  expected: SpriteLocation,
  epsilon = EPS
) => {
  expectClose(actual.lng, expected.lng, epsilon);
  expectClose(actual.lat, expected.lat, epsilon);
  if (expected.z !== undefined) {
    expectClose(actual.z ?? 0, expected.z, epsilon);
  }
};

it('createWasmProjectionHost produces consistent Mercator coordinates', async () => {
  expect.hasAssertions();
  const initialized = await initProjectionWasm();
  expect(initialized).toBe(true);
  const referenceHost = createProjectionHost(BASE_PARAMS);
  const wasmHost = createWasmProjectionHost(BASE_PARAMS);

  for (const location of TEST_LOCATIONS) {
    const expected = referenceHost.fromLngLat(location);
    const actual = wasmHost.fromLngLat(location);
    expectClose(actual.x, expected.x);
    expectClose(actual.y, expected.y);
    expectClose(actual.z, expected.z);
  }
});

//////////////////////////////////////////////////////////////////////////////////////

type StubMap = {
  readonly getCanvas: () => HTMLCanvasElement;
  readonly getZoom: () => number;
  readonly getCenter: () => { readonly lng: number; readonly lat: number };
  readonly getPitch: () => number;
  readonly getBearing: () => number;
  readonly project: (
    location: Readonly<SpriteLocation> | readonly [number, number, number?]
  ) => {
    readonly x: number;
    readonly y: number;
  };
  readonly unproject: (
    point:
      | { readonly x: number; readonly y: number }
      | readonly [number, number]
  ) => {
    readonly lng: number;
    readonly lat: number;
  };
  readonly transform: {
    readonly mercatorMatrix: readonly number[];
    readonly _mercatorMatrix: readonly number[];
    readonly cameraToCenterDistance: number;
    readonly width: number;
    readonly height: number;
    readonly zoom: number;
    readonly pitch: number;
    readonly bearing: number;
    readonly roll: number;
    readonly fov: number;
    readonly elevation: number;
    readonly minElevationForCurrentTile: number;
    readonly centerOffset: { readonly x: number; readonly y: number };
    readonly tileSize: number;
    readonly autoCalculateNearFarZ: boolean;
    readonly nearZ?: number;
    readonly farZ?: number;
  };
};

const createStubMap = (params: ProjectionHostParams): StubMap => {
  const reference = createProjectionHost(params);
  const clipContext = reference.getClipContext();
  if (!clipContext) {
    throw new Error('Failed to prepare clip context');
  }
  const mercatorMatrix = Array.from(clipContext.mercatorMatrix);

  const cameraDistance =
    params.cameraToCenterDistance ??
    (0.5 /
      Math.tan(
        ((params.fovDeg ?? 36.86989764584402) * DEG2RAD) / 2 || Number.EPSILON
      )) *
      params.height;

  const canvas = {
    width: params.width,
    height: params.height,
    getContext: () => null,
  } as unknown as HTMLCanvasElement;

  const normalizeLocation = (location: unknown): SpriteLocation => {
    if (Array.isArray(location)) {
      const [lng, lat, z] = location;
      return {
        lng: Number(lng ?? 0),
        lat: Number(lat ?? 0),
        z: z === undefined ? undefined : Number(z),
      };
    }
    const record = location as Partial<SpriteLocation>;
    return {
      lng: Number(record?.lng ?? 0),
      lat: Number(record?.lat ?? 0),
      z: record?.z === undefined ? undefined : Number(record.z),
    };
  };

  const map: StubMap = {
    getCanvas: () => canvas,
    getZoom: () => params.zoom,
    getCenter: () => ({ lng: params.center.lng, lat: params.center.lat }),
    getPitch: () => params.pitchDeg ?? 0,
    getBearing: () => params.bearingDeg ?? 0,
    project: (location: unknown) => {
      const normalized = normalizeLocation(location);
      const projected = reference.project(normalized);
      if (!projected) {
        throw new Error('Projection failed in stub map');
      }
      return { x: projected.x, y: projected.y };
    },
    unproject: (point: unknown) => {
      const [x, y] = Array.isArray(point)
        ? [Number(point[0] ?? 0), Number(point[1] ?? 0)]
        : [
            Number((point as { x?: number }).x ?? 0),
            Number((point as { y?: number }).y ?? 0),
          ];
      const location = reference.unproject({ x, y });
      if (!location) {
        throw new Error('Unprojection failed in stub map');
      }
      return { lng: location.lng, lat: location.lat };
    },
    transform: {
      mercatorMatrix,
      _mercatorMatrix: mercatorMatrix,
      cameraToCenterDistance: cameraDistance,
      width: params.width,
      height: params.height,
      zoom: params.zoom,
      pitch: params.pitchDeg ?? 0,
      bearing: params.bearingDeg ?? 0,
      roll: params.rollDeg ?? 0,
      fov: params.fovDeg ?? 36.86989764584402,
      elevation: params.centerElevationMeters ?? 0,
      minElevationForCurrentTile: params.minElevationMeters ?? 0,
      centerOffset: {
        x: params.centerOffsetX ?? 0,
        y: params.centerOffsetY ?? 0,
      },
      tileSize: params.tileSize ?? TILE_SIZE,
      autoCalculateNearFarZ: params.autoCalculateNearFarZ ?? true,
      nearZ:
        params.autoCalculateNearFarZ === false
          ? params.nearZOverride
          : undefined,
      farZ:
        params.autoCalculateNearFarZ === false
          ? params.farZOverride
          : undefined,
    },
  };

  return map;
};

//////////////////////////////////////////////////////////////////////////////////////

const wasmInitialized = await initProjectionWasm();
if (!wasmInitialized) {
  throw new Error('Failed to initialize projection WASM for projection tests.');
}

const stubMap = createStubMap(BASE_PARAMS);
const referenceHost = createProjectionHost(BASE_PARAMS);
const params = createProjectionHostParamsFromMapLibre(
  stubMap as unknown as MapLibreMap
);

const hostVariants: {
  readonly name: string;
  readonly host: ProjectionHost;
}[] = [
  {
    name: 'MapLibreProjectionHost',
    host: createMapLibreProjectionHost(stubMap as unknown as MapLibreMap),
  },
  {
    name: 'PureProjectionHostFromMap',
    host: createProjectionHost(params),
  },
  {
    name: 'WasmProjectionHost',
    host: createWasmProjectionHost(params),
  },
];

//////////////////////////////////////////////////////////////////////////////////////

describe('createProjectionHostParamsFromMapLibre', () => {
  it('extracts consistent params from map', () => {
    const extracted = createProjectionHostParamsFromMapLibre(
      stubMap as unknown as MapLibreMap
    );
    expectClose(extracted.zoom, BASE_PARAMS.zoom);
    expectClose(extracted.width, BASE_PARAMS.width);
    expectClose(extracted.height, BASE_PARAMS.height);
    expectClose(extracted.center.lng, BASE_PARAMS.center.lng);
    expectClose(extracted.center.lat, BASE_PARAMS.center.lat);
    expectClose(extracted.pitchDeg ?? 0, BASE_PARAMS.pitchDeg ?? 0);
    expectClose(extracted.bearingDeg ?? 0, BASE_PARAMS.bearingDeg ?? 0);
    expectClose(extracted.rollDeg ?? 0, BASE_PARAMS.rollDeg ?? 0);
    expectClose(extracted.fovDeg ?? 0, BASE_PARAMS.fovDeg ?? 0);
    expectClose(
      extracted.cameraToCenterDistance ?? 0,
      BASE_PARAMS.cameraToCenterDistance ?? 0
    );
    expectClose(extracted.centerOffsetX ?? 0, BASE_PARAMS.centerOffsetX ?? 0);
    expectClose(extracted.centerOffsetY ?? 0, BASE_PARAMS.centerOffsetY ?? 0);
  });
});

describe.each(hostVariants)('ProjectionHost via %s', ({ name, host }) => {
  describe(name, () => {
    it('returns zoom level', () => {
      expectClose(host.getZoom(), BASE_PARAMS.zoom);
    });

    it('provides clip context matching reference host', () => {
      const actual = toMercatorMatrix(host);
      const expected = toMercatorMatrix(referenceHost);
      actual.forEach((value, index) => {
        expectClose(value, expected[index] ?? 0, 1e-5);
      });
    });

    it('converts locations to mercator coordinates', () => {
      for (const location of TEST_LOCATIONS) {
        const actual = host.fromLngLat(location);
        const expected = referenceHost.fromLngLat(location);
        expectClose(actual.x, expected.x, 1e-6);
        expectClose(actual.y, expected.y, 1e-6);
        expectClose(actual.z ?? 0, expected.z ?? 0, 1e-6);
      }
    });

    it('projects and unprojects consistently', () => {
      for (const location of TEST_LOCATIONS) {
        const projected = host.project(location);
        expect(projected).not.toBeNull();
        const point = projected as { x: number; y: number };
        const expectedPoint = referenceHost.project(location);
        expect(expectedPoint).not.toBeNull();
        expectPointClose(
          point,
          expectedPoint as { x: number; y: number },
          1e-5
        );

        const unprojected = host.unproject(point);
        expect(unprojected).not.toBeNull();
        expectLocationClose(unprojected as SpriteLocation, {
          lng: location.lng,
          lat: location.lat,
        });
      }
    });

    it('calculates perspective ratio similar to reference', () => {
      for (const location of TEST_LOCATIONS) {
        const actual = host.calculatePerspectiveRatio(location);
        const expected = referenceHost.calculatePerspectiveRatio(location);
        expectClose(actual, expected, 5e-5);
      }
    });
  });
});
