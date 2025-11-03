// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { mat4 } from 'gl-matrix';
import type { mat4 as Mat4 } from 'gl-matrix';
import type { Map as MapLibreMap } from 'maplibre-gl';

import type { SpriteLocation, SpritePoint } from './types';
import type {
  ClipContext,
  ProjectionHost,
  SpriteMercatorCoordinate,
} from './internalTypes';
import { DEG2RAD, EARTH_RADIUS_METERS, TILE_SIZE } from './const';
import { multiplyMatrixAndVector } from './math';

//////////////////////////////////////////////////////////////////////////////////////

const DEFAULT_FOV_DEG = 36.86989764584402; // MapLibre default vertical FOV.
const MAX_MERCATOR_LATITUDE = 85.051129;
const MAX_MERCATOR_HORIZON_ANGLE = 89.25;
const MIN_RENDER_DISTANCE_BELOW_CAMERA = 100;
const NEAR_CLIP_DIVISOR = 50;
const SIN_DENOMINATOR_EPSILON = 0.01;

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Required projection parameters. These correspond to the MapLibre transform state.
 */
export interface ProjectionHostParams {
  readonly zoom: number;
  readonly width: number;
  readonly height: number;
  readonly center: Readonly<SpriteLocation>;
  readonly pitchDeg?: number;
  readonly bearingDeg?: number;
  readonly rollDeg?: number;
  readonly fovDeg?: number;
  readonly centerElevationMeters?: number;
  readonly minElevationMeters?: number;
  readonly cameraToCenterDistance?: number;
  readonly centerOffsetX?: number;
  readonly centerOffsetY?: number;
  readonly tileSize?: number;
  readonly autoCalculateNearFarZ?: boolean;
  readonly nearZOverride?: number;
  readonly farZOverride?: number;
}

interface PreparedProjectionState {
  readonly zoom: number;
  readonly mercatorMatrix: Mat4 | null;
  readonly pixelMatrix: Mat4 | null;
  readonly pixelMatrixInverse: Mat4 | null;
  readonly worldSize: number;
  readonly pixelPerMeter: number;
  readonly cameraToCenterDistance: number;
  readonly clipContext: ClipContext | null;
}

//////////////////////////////////////////////////////////////////////////////////////

const toFiniteOr = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) ? (value as number) : fallback;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const circumferenceAtLatitude = (latitudeDeg: number): number =>
  2 * Math.PI * EARTH_RADIUS_METERS * Math.cos(latitudeDeg * DEG2RAD);

const mercatorXfromLng = (lng: number): number => (180 + lng) / 360;

const mercatorYfromLat = (lat: number): number => {
  const constrained = clamp(lat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const radians = constrained * DEG2RAD;
  return (
    (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + radians / 2))) /
    360
  );
};

const mercatorZfromAltitude = (altitude: number, latDeg: number): number =>
  altitude / circumferenceAtLatitude(latDeg);

const lngFromMercatorX = (x: number): number => x * 360 - 180;

const latFromMercatorY = (y: number): number => {
  const y2 = 180 - y * 360;
  return (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
};

const projectToWorldCoordinates = (
  worldSize: number,
  lng: number,
  lat: number
): { readonly x: number; readonly y: number } => ({
  x: mercatorXfromLng(lng) * worldSize,
  y: mercatorYfromLat(lat) * worldSize,
});

//////////////////////////////////////////////////////////////////////////////////////

const getMercatorHorizon = (
  cameraToCenterDistance: number,
  pitchDeg: number
): number => {
  const pitch = pitchDeg ?? 0;
  const termA = Math.tan((90 - pitch) * DEG2RAD) * 0.85;
  const termB = Math.tan((MAX_MERCATOR_HORIZON_ANGLE - pitch) * DEG2RAD);
  const factor = Math.min(termA, termB);
  return cameraToCenterDistance * (Number.isFinite(factor) ? factor : 0);
};

const calculateNearFarZ = (
  params: ProjectionHostParams,
  cameraToCenterDistance: number,
  cameraToSeaLevelDistance: number,
  pixelPerMeter: number,
  pitchRad: number,
  limitedPitchRad: number,
  rollRad: number
): { nearZ: number; farZ: number } => {
  const width = Math.max(0, params.width);
  const height = Math.max(0, params.height);
  const pitchDeg = toFiniteOr(params.pitchDeg, 0);
  const offsetY = toFiniteOr(params.centerOffsetY, 0);
  const fovDeg = toFiniteOr(params.fovDeg, DEFAULT_FOV_DEG);
  const centerElevation = toFiniteOr(params.centerElevationMeters, 0);
  const minElevation = toFiniteOr(params.minElevationMeters, centerElevation);
  const cameraAltitude =
    (Math.cos(pitchRad) * (cameraToCenterDistance || 1)) /
      (pixelPerMeter || 1) +
    centerElevation;

  const nearZOverride = params.nearZOverride;
  const farZOverride = params.farZOverride;
  const autoCalculate = params.autoCalculateNearFarZ !== false;

  const effectiveNear =
    Number.isFinite(nearZOverride) && (nearZOverride as number) > 0
      ? (nearZOverride as number)
      : Math.max(height / NEAR_CLIP_DIVISOR, 1e-3);

  const effectiveFarOverride =
    Number.isFinite(farZOverride) && (farZOverride as number) > 0
      ? (farZOverride as number)
      : undefined;

  if (!autoCalculate && effectiveFarOverride !== undefined) {
    return {
      nearZ: effectiveNear,
      farZ: Math.max(effectiveFarOverride, effectiveNear * 1.5),
    };
  }

  const minElevationForScene = Math.min(
    centerElevation,
    minElevation,
    cameraAltitude - MIN_RENDER_DISTANCE_BELOW_CAMERA
  );

  const lowestPlane =
    minElevationForScene < 0
      ? cameraToSeaLevelDistance -
        (minElevationForScene * pixelPerMeter) / Math.cos(limitedPitchRad)
      : cameraToSeaLevelDistance;

  const groundAngle = Math.PI / 2 + pitchRad;
  const fovRad = fovDeg * DEG2RAD;
  const rollCos = Math.cos(rollRad);
  const rollSin = Math.sin(rollRad);
  const horizon = getMercatorHorizon(cameraToCenterDistance, pitchDeg);
  const horizonAngle = Math.atan(
    horizon / (cameraToCenterDistance || Number.EPSILON)
  );
  const minFovCenterToHorizonRadians =
    (90 - MAX_MERCATOR_HORIZON_ANGLE) * DEG2RAD;

  const zfov =
    fovRad *
    ((Math.abs(rollCos) * height + Math.abs(rollSin) * width) / height);
  const fovAboveCenter = zfov * (0.5 + offsetY / height);

  const clampDenominator = clamp(
    Math.PI - groundAngle - fovAboveCenter,
    SIN_DENOMINATOR_EPSILON,
    Math.PI - SIN_DENOMINATOR_EPSILON
  );
  const topHalfSurfaceDistance =
    (Math.sin(fovAboveCenter) * lowestPlane) / Math.sin(clampDenominator);

  const offsetFactorHorizon =
    horizon === 0 ? 0.5 : 0.5 + offsetY / (Math.abs(horizon) * 2);
  const fovCenterToHorizon =
    Number.isFinite(horizonAngle) && horizonAngle > minFovCenterToHorizonRadians
      ? 2 * horizonAngle * offsetFactorHorizon
      : minFovCenterToHorizonRadians;

  const clampDenominatorHorizon = clamp(
    Math.PI - groundAngle - fovCenterToHorizon,
    SIN_DENOMINATOR_EPSILON,
    Math.PI - SIN_DENOMINATOR_EPSILON
  );
  const topHalfSurfaceDistanceHorizon =
    (Math.sin(fovCenterToHorizon) * lowestPlane) /
    Math.sin(clampDenominatorHorizon);

  const validSurface = Number.isFinite(topHalfSurfaceDistance)
    ? topHalfSurfaceDistance
    : Number.POSITIVE_INFINITY;
  const validHorizon = Number.isFinite(topHalfSurfaceDistanceHorizon)
    ? topHalfSurfaceDistanceHorizon
    : Number.POSITIVE_INFINITY;
  const topHalfMinDistance = Math.min(validSurface, validHorizon);

  const farCandidate =
    (Math.cos(Math.PI / 2 - limitedPitchRad) * topHalfMinDistance +
      lowestPlane) *
    1.01;

  const farZ =
    effectiveFarOverride ??
    (Number.isFinite(farCandidate) && farCandidate > effectiveNear
      ? farCandidate
      : Math.max(cameraToSeaLevelDistance * 1.5, effectiveNear * 2));

  return {
    nearZ: effectiveNear,
    farZ,
  };
};

const prepareProjectionState = (
  params: ProjectionHostParams
): PreparedProjectionState => {
  const width = Math.max(0, params.width);
  const height = Math.max(0, params.height);
  const zoom = toFiniteOr(params.zoom, 0);

  if (width <= 0 || height <= 0) {
    return {
      zoom,
      mercatorMatrix: null,
      pixelMatrix: null,
      pixelMatrixInverse: null,
      worldSize: 0,
      pixelPerMeter: 0,
      cameraToCenterDistance: 0,
      clipContext: null,
    };
  }

  const tileSize = Math.max(toFiniteOr(params.tileSize, TILE_SIZE), 1);
  const scale = 2 ** zoom;
  const worldSize = tileSize * scale;

  const centerLng = toFiniteOr(params.center.lng, 0);
  const centerLat = clamp(
    toFiniteOr(params.center.lat, 0),
    -MAX_MERCATOR_LATITUDE,
    MAX_MERCATOR_LATITUDE
  );
  const centerElevation = toFiniteOr(params.centerElevationMeters, 0);
  const minElevation = toFiniteOr(params.minElevationMeters, centerElevation);

  const pitchDeg = toFiniteOr(params.pitchDeg, 0);
  const bearingDeg = toFiniteOr(params.bearingDeg, 0);
  const rollDeg = toFiniteOr(params.rollDeg, 0);
  const fovDeg = toFiniteOr(params.fovDeg, DEFAULT_FOV_DEG);

  const pitchRad = pitchDeg * DEG2RAD;
  const bearingRad = bearingDeg * DEG2RAD;
  const rollRad = rollDeg * DEG2RAD;
  const fovRad = fovDeg * DEG2RAD;

  const limitedPitchRad =
    Math.min(Math.max(pitchDeg, 0), MAX_MERCATOR_HORIZON_ANGLE) * DEG2RAD;

  const pixelPerMeter =
    mercatorZfromAltitude(1, centerLat || 0) * worldSize || 1;

  const cameraToCenterDistance =
    toFiniteOr(
      params.cameraToCenterDistance,
      (0.5 / Math.tan(Math.max(fovRad / 2, 1e-6))) * height
    ) || 1;

  const offsetX = toFiniteOr(params.centerOffsetX, 0);
  const offsetY = toFiniteOr(params.centerOffsetY, 0);

  const centerWorld = projectToWorldCoordinates(
    worldSize,
    centerLng,
    centerLat
  );

  const cameraToSeaLevelDistance = Math.max(
    cameraToCenterDistance / 2,
    cameraToCenterDistance +
      (centerElevation * pixelPerMeter) / Math.cos(limitedPitchRad)
  );

  const { nearZ, farZ } = calculateNearFarZ(
    {
      ...params,
      centerElevationMeters: centerElevation,
      minElevationMeters: minElevation,
    },
    cameraToCenterDistance,
    cameraToSeaLevelDistance,
    pixelPerMeter,
    pitchRad,
    limitedPitchRad,
    rollRad
  );

  const perspective = mat4.perspective(
    mat4.create(),
    fovRad,
    width / height,
    Math.max(nearZ, 1e-6),
    Math.max(farZ, nearZ + 1e-3)
  );

  perspective[8] = (-offsetX * 2) / width;
  perspective[9] = (offsetY * 2) / height;

  const worldMatrix = mat4.clone(perspective);
  mat4.scale(worldMatrix, worldMatrix, [1, -1, 1]);
  mat4.translate(worldMatrix, worldMatrix, [0, 0, -cameraToCenterDistance]);
  mat4.rotateZ(worldMatrix, worldMatrix, -rollRad);
  mat4.rotateX(worldMatrix, worldMatrix, pitchRad);
  mat4.rotateZ(worldMatrix, worldMatrix, -bearingRad);
  mat4.translate(worldMatrix, worldMatrix, [-centerWorld.x, -centerWorld.y, 0]);

  const mercatorMatrix = mat4.scale(mat4.create(), worldMatrix, [
    worldSize,
    worldSize,
    worldSize,
  ]);

  mat4.scale(worldMatrix, worldMatrix, [1, 1, pixelPerMeter]);

  const clipSpaceToPixelsMatrix = mat4.create();
  mat4.scale(clipSpaceToPixelsMatrix, clipSpaceToPixelsMatrix, [
    width / 2,
    -height / 2,
    1,
  ]);
  mat4.translate(clipSpaceToPixelsMatrix, clipSpaceToPixelsMatrix, [1, -1, 0]);

  const pixelMatrix = mat4.multiply(
    mat4.create(),
    clipSpaceToPixelsMatrix,
    worldMatrix
  );

  const pixelMatrixInverse = mat4.invert(mat4.create(), pixelMatrix) ?? null;

  const clipContext: ClipContext | null = mercatorMatrix
    ? { mercatorMatrix }
    : null;

  return {
    zoom,
    mercatorMatrix,
    pixelMatrix,
    pixelMatrixInverse,
    worldSize,
    pixelPerMeter,
    cameraToCenterDistance,
    clipContext,
  };
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Create a pure calculation projection host.
 * @param params Projection parameters
 * @returns Projection host
 */
export const createProjectionHost = (
  params: ProjectionHostParams
): ProjectionHost => {
  const state = prepareProjectionState(params);

  /**
   * Get current zoom level.
   * @returns Zoom level.
   */
  const getZoom = (): number => state.zoom;

  /**
   * Extracts the current clip-space context if the mercator matrix is available.
   * @returns {ClipContext | null} Clip context or `null` when the transform is not ready.
   */
  const getClipContext = (): ClipContext | null => state.clipContext;

  /**
   * Get mercator coordinate from the location
   * @param location Location.
   * @returns Mercator coordinate.
   */
  const fromLngLat = (
    location: Readonly<SpriteLocation>
  ): SpriteMercatorCoordinate => {
    const lng = toFiniteOr(location.lng, 0);
    const lat = clamp(
      toFiniteOr(location.lat, 0),
      -MAX_MERCATOR_LATITUDE,
      MAX_MERCATOR_LATITUDE
    );
    const altitude = toFiniteOr(location.z, 0);
    return {
      x: mercatorXfromLng(lng),
      y: mercatorYfromLat(lat),
      z: mercatorZfromAltitude(altitude, lat),
    };
  };

  /**
   * Project the location.
   * @param location Location.
   * @returns Projected point if valid location.
   */
  const project = (location: Readonly<SpriteLocation>): SpritePoint | null => {
    if (!state.pixelMatrix) {
      return null;
    }
    const mercator = fromLngLat(location);
    const worldX = mercator.x * state.worldSize;
    const worldY = mercator.y * state.worldSize;
    const elevation = toFiniteOr(location.z, 0);

    const [x, y, , w] = multiplyMatrixAndVector(
      state.pixelMatrix,
      worldX,
      worldY,
      elevation,
      1
    );

    if (!Number.isFinite(w) || w <= 0) {
      return null;
    }

    const projectedX = x / w;
    const projectedY = y / w;

    if (!Number.isFinite(projectedX) || !Number.isFinite(projectedY)) {
      return null;
    }

    return { x: projectedX, y: projectedY };
  };

  /**
   * Unproject the location.
   * @param point Projected point.
   * @returns Location if valid point.
   */
  const unproject = (point: Readonly<SpritePoint>): SpriteLocation | null => {
    if (!state.pixelMatrixInverse) {
      return null;
    }

    const coord0 = multiplyMatrixAndVector(
      state.pixelMatrixInverse,
      toFiniteOr(point.x, 0),
      toFiniteOr(point.y, 0),
      0,
      1
    );
    const coord1 = multiplyMatrixAndVector(
      state.pixelMatrixInverse,
      toFiniteOr(point.x, 0),
      toFiniteOr(point.y, 0),
      1,
      1
    );

    const w0 = coord0[3];
    const w1 = coord1[3];

    if (!Number.isFinite(w0) || !Number.isFinite(w1) || w0 === 0 || w1 === 0) {
      return null;
    }

    const x0 = coord0[0] / w0;
    const x1 = coord1[0] / w1;
    const y0 = coord0[1] / w0;
    const y1 = coord1[1] / w1;
    const z0 = coord0[2] / w0;
    const z1 = coord1[2] / w1;

    const targetZ = 0;
    const t = z0 === z1 ? 0 : (targetZ - z0) / (z1 - z0);

    const worldX = x0 + (x1 - x0) * t;
    const worldY = y0 + (y1 - y0) * t;

    const mercatorX = worldX / (state.worldSize || 1);
    const mercatorY = worldY / (state.worldSize || 1);

    if (!Number.isFinite(mercatorX) || !Number.isFinite(mercatorY)) {
      return null;
    }

    return {
      lng: lngFromMercatorX(mercatorX),
      lat: clamp(
        latFromMercatorY(mercatorY),
        -MAX_MERCATOR_LATITUDE,
        MAX_MERCATOR_LATITUDE
      ),
    };
  };

  /**
   * Calculate perspective ratio.
   * @param location Location.
   * @param cachedMercator Mercator coodinate when available earlier calculation.
   * @returns The ratio.
   */
  const calculatePerspectiveRatio = (
    location: Readonly<SpriteLocation>,
    cachedMercator?: SpriteMercatorCoordinate
  ): number => {
    if (!state.mercatorMatrix || state.cameraToCenterDistance <= 0) {
      return 1;
    }

    try {
      const mercator = cachedMercator ?? fromLngLat(location as SpriteLocation);
      const [, , , w] = multiplyMatrixAndVector(
        state.mercatorMatrix,
        mercator.x,
        mercator.y,
        mercator.z ?? 0,
        1
      );
      if (!Number.isFinite(w) || w <= 0) {
        return 1;
      }
      const ratio = state.cameraToCenterDistance / w;
      return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    } catch {
      return 1;
    }
  };

  return {
    getZoom,
    getClipContext,
    fromLngLat,
    project,
    unproject,
    calculatePerspectiveRatio,
  };
};

/**
 * Extract current MapLibre transform parameters into {@link ProjectionHostParams}.
 * Falls back to safe defaults when certain transform fields are unavailable.
 * @param map MapLibre map instance.
 * @returns Projection parameters usable by {@link createProjectionHost}.
 */
export const createProjectionHostParamsFromMapLibre = (
  map: MapLibreMap
): ProjectionHostParams => {
  const ensureFinite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value)
      ? (value as number)
      : undefined;

  const centerLngLat = map.getCenter();
  const transform: any = (map as unknown as { transform?: unknown }).transform;
  const canvas =
    typeof map.getCanvas === 'function' ? (map.getCanvas() ?? null) : null;

  // Provide minimal fallback when the transform is not ready yet.
  if (!transform) {
    return {
      zoom: ensureFinite(map.getZoom()) ?? 0,
      width: ensureFinite(canvas?.width) ?? 0,
      height: ensureFinite(canvas?.height) ?? 0,
      center: { lng: centerLngLat.lng, lat: centerLngLat.lat },
    };
  }

  const width =
    ensureFinite(transform.width) ?? ensureFinite(canvas?.width) ?? 0;
  const height =
    ensureFinite(transform.height) ?? ensureFinite(canvas?.height) ?? 0;
  const zoom = ensureFinite(transform.zoom) ?? ensureFinite(map.getZoom()) ?? 0;
  const pitchDeg =
    ensureFinite(transform.pitch) ?? ensureFinite(map.getPitch());
  const bearingDeg =
    ensureFinite(transform.bearing) ?? ensureFinite(map.getBearing());
  const rollDeg = ensureFinite(transform.roll);
  const fovDeg = ensureFinite(transform.fov);
  const centerElevation = ensureFinite(transform.elevation);
  const minElevation = ensureFinite(transform.minElevationForCurrentTile);
  const cameraToCenterDistance = ensureFinite(transform.cameraToCenterDistance);
  const centerOffset = transform.centerOffset;
  const centerOffsetX = ensureFinite(centerOffset?.x);
  const centerOffsetY = ensureFinite(centerOffset?.y);
  const tileSize = ensureFinite(transform.tileSize);
  const autoCalculateNearFarZ =
    typeof transform.autoCalculateNearFarZ === 'boolean'
      ? (transform.autoCalculateNearFarZ as boolean)
      : undefined;
  const nearZOverride =
    autoCalculateNearFarZ === false ? ensureFinite(transform.nearZ) : undefined;
  const farZOverride =
    autoCalculateNearFarZ === false ? ensureFinite(transform.farZ) : undefined;

  return {
    zoom,
    width,
    height,
    center: {
      lng: centerLngLat.lng,
      lat: centerLngLat.lat,
    },
    ...(pitchDeg !== undefined ? { pitchDeg } : {}),
    ...(bearingDeg !== undefined ? { bearingDeg } : {}),
    ...(rollDeg !== undefined ? { rollDeg } : {}),
    ...(fovDeg !== undefined ? { fovDeg } : {}),
    ...(centerElevation !== undefined
      ? { centerElevationMeters: centerElevation }
      : {}),
    ...(minElevation !== undefined ? { minElevationMeters: minElevation } : {}),
    ...(cameraToCenterDistance !== undefined ? { cameraToCenterDistance } : {}),
    ...(centerOffsetX !== undefined ? { centerOffsetX } : {}),
    ...(centerOffsetY !== undefined ? { centerOffsetY } : {}),
    ...(tileSize !== undefined ? { tileSize } : {}),
    ...(autoCalculateNearFarZ !== undefined ? { autoCalculateNearFarZ } : {}),
    ...(nearZOverride !== undefined ? { nearZOverride } : {}),
    ...(farZOverride !== undefined ? { farZOverride } : {}),
  };
};
