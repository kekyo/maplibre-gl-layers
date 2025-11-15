// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { MercatorCoordinate, Map as MapLibreMap } from 'maplibre-gl';
import { vec4, type ReadonlyMat4 } from 'gl-matrix';

import type { SpriteLocation, SpritePoint } from '../types';
import type {
  ClipContext,
  ProjectionHost,
  SpriteMercatorCoordinate,
} from '../internalTypes';
import { DEG2RAD, TILE_SIZE } from '../const';

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Create a projection host that delegates to MapLibre.
 * @param map MapLibre map instance
 * @returns Projection host
 */
export const createMapLibreProjectionHost = (
  map: MapLibreMap
): ProjectionHost => {
  let mapLibreMap = map;

  /**
   * Get current zoom level.
   * @returns Zoom level.
   */
  const getZoom = () => mapLibreMap.getZoom();

  // Internal function for get mercator matrix from MapLibre.
  const getMercatorMatrix = (): ReadonlyMat4 | null => {
    const transform = mapLibreMap.transform;
    if (!transform) {
      return null;
    }
    // DIRTY: Refers internal mercator matrix... How to extract with safe method?
    const mercatorMatrix: ReadonlyMat4 | undefined =
      (transform as any).mercatorMatrix ?? (transform as any)._mercatorMatrix;
    if (!mercatorMatrix) {
      return null;
    }
    return mercatorMatrix;
  };

  /**
   * Extracts the current clip-space context if the mercator matrix is available.
   * @returns {ClipContext | null} Clip context or `null` when the transform is not ready.
   */
  const getClipContext = (): ClipContext | null => {
    const mercatorMatrix = getMercatorMatrix();
    if (!mercatorMatrix) {
      return null;
    }
    return { mercatorMatrix };
  };

  const getCameraLocation = (): SpriteLocation | null => {
    const mapInstance = mapLibreMap;
    const transform = mapInstance?.transform;
    if (!mapInstance || !transform) {
      return null;
    }
    const center = mapInstance.getCenter();
    const ensureFiniteNumber = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value)
        ? (value as number)
        : undefined;
    const zoom = ensureFiniteNumber(transform.zoom) ?? mapInstance.getZoom();
    const pitchDeg =
      ensureFiniteNumber(transform.pitch) ?? mapInstance.getPitch();
    const cameraToCenterDistance = ensureFiniteNumber(
      transform.cameraToCenterDistance
    );
    if (!Number.isFinite(cameraToCenterDistance)) {
      return null;
    }
    const tileSize = ensureFiniteNumber(transform.tileSize) ?? TILE_SIZE;
    const worldSize = tileSize * Math.pow(2, Number.isFinite(zoom) ? zoom : 0);
    if (!Number.isFinite(worldSize) || worldSize <= 0) {
      return null;
    }
    const mercator = MercatorCoordinate.fromLngLat(center, 0);
    const pixelPerMeter = mercator.meterInMercatorCoordinateUnits() * worldSize;
    if (!Number.isFinite(pixelPerMeter) || pixelPerMeter <= 0) {
      return null;
    }
    const centerElevation = ensureFiniteNumber(transform.elevation) ?? 0;
    const pitchRad = (Number.isFinite(pitchDeg) ? pitchDeg : 0) * DEG2RAD;
    const altitude =
      (Math.cos(pitchRad) * cameraToCenterDistance!) / pixelPerMeter +
      centerElevation;
    return {
      lng: center.lng,
      lat: center.lat,
      z: altitude,
    };
  };

  /**
   * Get mercator coordinate from the location
   * @param location Location.
   * @returns Mercator coordinate.
   */
  const fromLngLat = (location: SpriteLocation): SpriteMercatorCoordinate =>
    MercatorCoordinate.fromLngLat(location, location.z ?? 0);

  /**
   * Project the location.
   * @param location Location.
   * @returns Projected point if valid location.
   */
  const project = (location: SpriteLocation) => mapLibreMap.project(location);

  /**
   * Unproject the location.
   * @param point Projected point.
   * @returns Location if valid point.
   */
  const unproject = (point: Readonly<SpritePoint>): SpriteLocation | null =>
    mapLibreMap.unproject([point.x, point.y]);

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
    const mercatorMatrix = getMercatorMatrix();
    if (!mercatorMatrix) {
      return 1.0;
    }

    const transform = mapLibreMap.transform;
    if (!transform) {
      return 1.0;
    }

    const cameraToCenterDistance: number | undefined =
      transform.cameraToCenterDistance;
    if (
      typeof cameraToCenterDistance !== 'number' ||
      !Number.isFinite(cameraToCenterDistance)
    ) {
      return 1.0;
    }

    try {
      const mercator = cachedMercator ?? fromLngLat(location);
      const position = vec4.fromValues(
        mercator.x,
        mercator.y,
        mercator.z ?? 0,
        1
      );

      vec4.transformMat4(position, position, mercatorMatrix);
      const w = position[3];
      if (!Number.isFinite(w) || w <= 0) {
        return 1.0;
      }
      const ratio = cameraToCenterDistance / w;
      return Number.isFinite(ratio) && ratio > 0 ? ratio : 1.0;
    } catch {
      return 1.0;
    }
  };

  const release = () => {
    mapLibreMap = undefined!;
  };

  return {
    getZoom,
    getClipContext,
    fromLngLat,
    project,
    unproject,
    calculatePerspectiveRatio,
    getCameraLocation,
    release,
  };
};
