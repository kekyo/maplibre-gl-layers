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
import { createProjectionHostParamsFromMapLibre } from './projectionHost';

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
  const getMercatorMatrix = (): ReadonlyMat4 | undefined => {
    const transform = mapLibreMap.transform;
    if (!transform) {
      return undefined;
    }
    // DIRTY: Refers internal mercator matrix... How to extract with safe method?
    const mercatorMatrix: ReadonlyMat4 | undefined =
      (transform as any).mercatorMatrix ?? (transform as any)._mercatorMatrix;
    if (!mercatorMatrix) {
      return undefined;
    }
    return mercatorMatrix;
  };

  /**
   * Extracts the current clip-space context if the mercator matrix is available.
   * @returns {ClipContext | undefined} Clip context or `null` when the transform is not ready.
   */
  const getClipContext = (): ClipContext | undefined => {
    const mercatorMatrix = getMercatorMatrix();
    if (!mercatorMatrix) {
      return undefined;
    }
    return { mercatorMatrix };
  };

  const getCameraLocation = () => {
    const params = createProjectionHostParamsFromMapLibre(mapLibreMap);
    return params.cameraLocation;

    // TODO: Garbage
    //const mercator = params.cameraLocation;
    //if (!mercator) {
    //  return null;
    //}
    //const coord = new MercatorCoordinate(
    //  mercator.x,
    //  mercator.y,
    //  mercator.z ?? 0
    //);
    //const lngLat = coord.toLngLat();
    //const metersPerUnit = coord.meterInMercatorCoordinateUnits();
    //const altitude = (mercator.z ?? 0) * (metersPerUnit || 1);
    //return {
    //  lng: lngLat.lng,
    //  lat: lngLat.lat,
    //  z: altitude,
    //};
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
  const project = (location: SpriteLocation): SpritePoint =>
    mapLibreMap.project(location);

  /**
   * Unproject the location.
   * @param point Projected point.
   * @returns Location if valid point.
   */
  const unproject = (
    point: Readonly<SpritePoint>
  ): SpriteLocation | undefined => mapLibreMap.unproject([point.x, point.y]);

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
