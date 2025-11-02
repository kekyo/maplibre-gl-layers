// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { SpriteLocation, SpritePoint } from './types';
import type {
  ClipContext,
  ProjectionHost,
  SpriteMercatorCoordinate,
} from './internalTypes';

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Required projection parameters.
 */
export interface ProjectionHostParams {
  // TODO: Extract and place required public parameters and hidden (closed) MapLibre parameters.
}

/**
 * Create a pure calculation projection host.
 * @param _params Projection parameters
 * @returns Projection host
 */
export const createProjectionHost = (
  _params: ProjectionHostParams
): ProjectionHost => {
  /**
   * Get current zoom level.
   * @returns Zoom level.
   */
  const getZoom = (): number => {
    // TODO: Pure calculation with params
    return 0;
  };

  /**
   * Extracts the current clip-space context if the mercator matrix is available.
   * @returns {ClipContext | null} Clip context or `null` when the transform is not ready.
   */
  const getClipContext = (): ClipContext | null => {
    // TODO: Pure calculation with params
    return null;
  };

  /**
   * Get mercator coordinate from the location
   * @param _location Location.
   * @returns Mercator coordinate.
   */
  const fromLngLat = (_location: SpriteLocation): SpriteMercatorCoordinate => {
    // TODO: Pure calculation with params
    return null!;
  };

  /**
   * Project the location.
   * @param location Location.
   * @returns Projected point if valid location.
   */
  const project = (_location: Readonly<SpriteLocation>): SpritePoint | null => {
    // TODO: Pure calculation with params
    return null;
  };

  /**
   * Unproject the location.
   * @param point Projected point.
   * @returns Location if valid point.
   */
  const unproject = (_point: Readonly<SpritePoint>): SpriteLocation | null => {
    // TODO: Pure calculation with params
    return null;
  };

  /**
   * Calculate perspective ratio.
   * @param location Location.
   * @param cachedMercator Mercator coodinate when available earlier calculation.
   * @returns The ratio.
   */
  const calculatePerspectiveRatio = (
    _location: Readonly<SpriteLocation>,
    _cachedMercator?: SpriteMercatorCoordinate
  ): number => {
    // TODO: Pure calculation with params
    return 0;
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
