// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it, vi } from 'vitest';

import {
  calculateBillboardAnchorShiftPixels,
  calculateBillboardOffsetPixels,
  calculateBillboardPixelDimensions,
  calculateDistanceAndBearingMeters,
  calculateMetersPerPixelAtLatitude,
  calculateSurfaceAnchorShiftMeters,
  calculateSurfaceOffsetMeters,
  calculateSurfaceWorldDimensions,
  calculateEffectivePixelsPerMeter,
  calculateBillboardDepthKey,
  calculateSurfaceDepthKey,
  applySurfaceDisplacement,
  screenToClip,
  calculateZoomScaleFactor,
  resolveScalingOptions,
  calculateBillboardCenterPosition,
  calculateBillboardCornerScreenPositions,
  calculateSurfaceCenterPosition,
  calculateSurfaceCornerDisplacements,
  computeSurfaceCornerShaderModel,
  type SurfaceDepthBiasFn,
  clampOpacity,
} from '../src/math';
import type { SpriteAnchor, SpriteScreenPoint } from '../src/types';
import { EARTH_RADIUS_METERS, UV_CORNERS } from '../src/const';

const deg = (value: number) => (value * Math.PI) / 180;

describe('resolveScalingOptions / calculateZoomScaleFactor', () => {
  it('fills missing scaling fields with defaults', () => {
    const base = resolveScalingOptions();
    const resolved = resolveScalingOptions({ metersPerPixel: 2 });
    expect(resolved).toEqual({
      ...base,
      metersPerPixel: 2,
    });
  });

  it('interpolates zoom scale factor between min/max', () => {
    const resolved = resolveScalingOptions({
      zoomMin: 0,
      zoomMax: 10,
      scaleMin: 1,
      scaleMax: 3,
    });
    expect(calculateZoomScaleFactor(-5, resolved)).toBe(1);
    expect(calculateZoomScaleFactor(15, resolved)).toBe(3);
    expect(calculateZoomScaleFactor(5, resolved)).toBeCloseTo(2, 6);
  });

  it('normalizes descending ranges and emits warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolveScalingOptions({
      zoomMin: 10,
      zoomMax: 5,
      scaleMin: 3,
      scaleMax: 1,
      spriteMinPixel: 400,
      spriteMaxPixel: 200,
    });
    expect(resolved.zoomMin).toBe(5);
    expect(resolved.zoomMax).toBe(10);
    expect(resolved.scaleMin).toBe(1);
    expect(resolved.scaleMax).toBe(3);
    expect(resolved.spriteMinPixel).toBe(200);
    expect(resolved.spriteMaxPixel).toBe(400);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('SpriteScalingOptions');
    warnSpy.mockRestore();
  });

  it('clips invalid numeric inputs to safe defaults', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = resolveScalingOptions();
    const resolved = resolveScalingOptions({
      metersPerPixel: -5,
      scaleMin: -2,
      scaleMax: Number.NaN,
      spriteMinPixel: -10,
      spriteMaxPixel: -20,
    });
    expect(resolved.metersPerPixel).toBe(base.metersPerPixel);
    expect(resolved.scaleMin).toBe(0);
    expect(resolved.scaleMax).toBe(base.scaleMax);
    expect(resolved.spriteMinPixel).toBe(0);
    expect(resolved.spriteMaxPixel).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe('calculateMetersPerPixelAtLatitude', () => {
  it('shrinks with latitude cosine', () => {
    const equator = calculateMetersPerPixelAtLatitude(0, 0);
    const midLat = calculateMetersPerPixelAtLatitude(0, 45);
    expect(midLat).toBeLessThan(equator);
    expect(midLat).toBeCloseTo(equator * Math.cos(deg(45)), 6);
  });
});

describe('calculateDistanceAndBearingMeters', () => {
  it('returns zero for identical points', () => {
    const result = calculateDistanceAndBearingMeters(
      { lat: 35, lng: 139 },
      { lat: 35, lng: 139 }
    );
    expect(result).toEqual({ distanceMeters: 0, bearingDeg: 0 });
  });

  it('computes distance and bearing between two points', () => {
    const from = { lat: 35.681236, lng: 139.767125 }; // Tokyo Station
    const to = { lat: 35.689592, lng: 139.692861 }; // Shinjuku
    const { distanceMeters, bearingDeg } = calculateDistanceAndBearingMeters(
      from,
      to
    );
    expect(distanceMeters).toBeGreaterThan(6000);
    expect(distanceMeters).toBeLessThan(8000);
    expect(bearingDeg).toBeGreaterThan(270);
    expect(bearingDeg).toBeLessThan(310);
  });
});

describe('billboard helpers', () => {
  it('clamps pixel size to min/max range', () => {
    const base = calculateBillboardPixelDimensions(
      100,
      80,
      1,
      1,
      1,
      1,
      200,
      400
    );
    expect(base.width).toBeCloseTo(200, 6);
    expect(base.height).toBeCloseTo(160, 6);
    expect(base.scaleAdjustment).toBeCloseTo(2, 6);
  });

  it('returns zero when resource size invalid', () => {
    const dims = calculateBillboardPixelDimensions(
      undefined,
      80,
      1,
      1,
      1,
      1,
      0,
      0
    );
    expect(dims).toEqual({ width: 0, height: 0, scaleAdjustment: 1 });
  });

  it('computes offset pixels', () => {
    const offset = calculateBillboardOffsetPixels(
      { offsetDeg: 90, offsetMeters: 10 },
      1,
      2,
      3
    );
    expect(offset.x).toBeCloseTo(60, 6);
    expect(offset.y).toBeCloseTo(0, 6);
  });

  it('locks offset distance once spriteMaxPixel clamps size', () => {
    const offsetDef = { offsetDeg: 0, offsetMeters: 5 } as const;
    const dimsAtClamp = calculateBillboardPixelDimensions(
      128,
      128,
      1,
      1,
      1,
      1,
      0,
      128
    );
    const offsetAtClamp = calculateBillboardOffsetPixels(
      offsetDef,
      1,
      1,
      1,
      dimsAtClamp.scaleAdjustment
    );
    const dimsBeyondClamp = calculateBillboardPixelDimensions(
      128,
      128,
      1,
      1,
      2,
      1,
      0,
      128
    );
    const offsetBeyondClamp = calculateBillboardOffsetPixels(
      offsetDef,
      1,
      2,
      1,
      dimsBeyondClamp.scaleAdjustment
    );
    expect(offsetAtClamp.y).toBeCloseTo(offsetBeyondClamp.y, 6);
  });

  it('locks offset distance when spriteMinPixel inflates size', () => {
    const offsetDef = { offsetDeg: 0, offsetMeters: 5 } as const;
    const dimsAtMin = calculateBillboardPixelDimensions(
      128,
      128,
      1,
      1,
      1,
      1,
      128,
      0
    );
    const offsetAtMin = calculateBillboardOffsetPixels(
      offsetDef,
      1,
      1,
      1,
      dimsAtMin.scaleAdjustment
    );
    const dimsBelowMin = calculateBillboardPixelDimensions(
      128,
      128,
      1,
      1,
      0.5,
      1,
      128,
      0
    );
    const offsetBelowMin = calculateBillboardOffsetPixels(
      offsetDef,
      1,
      0.5,
      1,
      dimsBelowMin.scaleAdjustment
    );
    expect(offsetAtMin.y).toBeCloseTo(offsetBelowMin.y, 6);
  });

  const expectBillboardAnchorDisplacement = (
    anchor: { x: number; y: number },
    halfWidth: number,
    halfHeight: number,
    rotateDeg: number
  ) => {
    const shift = calculateBillboardAnchorShiftPixels(
      halfWidth,
      halfHeight,
      anchor,
      rotateDeg
    );
    const rad = -rotateDeg * (Math.PI / 180);
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);
    const anchorX = anchor.x * halfWidth;
    const anchorY = anchor.y * halfHeight;
    const rotatedX = anchorX * cosR - anchorY * sinR;
    const rotatedY = anchorX * sinR + anchorY * cosR;
    expect(shift.x + rotatedX).toBeCloseTo(0, 6);
    expect(shift.y + rotatedY).toBeCloseTo(0, 6);
  };

  const billboardCases = [
    { anchor: { x: 1, y: 0 }, halfWidth: 50, halfHeight: 40, rotate: 90 },
    { anchor: { x: -1, y: 0 }, halfWidth: 30, halfHeight: 60, rotate: 90 },
    { anchor: { x: 0, y: 1 }, halfWidth: 25, halfHeight: 25, rotate: 45 },
    { anchor: { x: 0, y: -1 }, halfWidth: 40, halfHeight: 20, rotate: 180 },
    { anchor: { x: 1, y: 1 }, halfWidth: 35, halfHeight: 45, rotate: 270 },
  ] as const;

  it.each(billboardCases)(
    'cancels rotated anchor for %o',
    ({ anchor, halfWidth, halfHeight, rotate }) => {
      expectBillboardAnchorDisplacement(anchor, halfWidth, halfHeight, rotate);
    }
  );

  it('guard: zero size returns zero shift', () => {
    const shift = calculateBillboardAnchorShiftPixels(0, 0, { x: 1, y: 1 }, 30);
    expect(shift).toEqual({ x: 0, y: 0 });
  });
});

describe('surface helpers', () => {
  it('returns surface world dimensions in meters', () => {
    const dims = calculateSurfaceWorldDimensions(100, 200, 2, 1.5, 0.5);
    expect(dims.width).toBeCloseTo(150, 6);
    expect(dims.height).toBeCloseTo(300, 6);
    expect(dims.scaleAdjustment).toBeCloseTo(1, 6);
  });

  it('expands world dimensions to satisfy spriteMinPixel', () => {
    const dims = calculateSurfaceWorldDimensions(64, 32, 1, 1, 1, {
      effectivePixelsPerMeter: 0.5,
      spriteMinPixel: 200,
    });
    expect(dims.width).toBeCloseTo(400, 6);
    expect(dims.height).toBeCloseTo(200, 6);
    expect(dims.scaleAdjustment).toBeCloseTo(6.25, 6);
  });

  it('shrinks world dimensions to satisfy spriteMaxPixel', () => {
    const dims = calculateSurfaceWorldDimensions(64, 32, 1, 1, 1, {
      effectivePixelsPerMeter: 4,
      spriteMaxPixel: 128,
    });
    expect(dims.width).toBeCloseTo(32, 6);
    expect(dims.height).toBeCloseTo(16, 6);
    expect(dims.scaleAdjustment).toBeCloseTo(0.5, 6);
  });

  const expectSurfaceAnchorDisplacement = (
    anchor: { x: number; y: number },
    halfEast: number,
    halfNorth: number,
    rotateDeg: number
  ) => {
    const shift = calculateSurfaceAnchorShiftMeters(
      halfEast,
      halfNorth,
      anchor,
      rotateDeg
    );
    const rad = -rotateDeg * (Math.PI / 180);
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);
    const anchorEast = anchor.x * halfEast;
    const anchorNorth = anchor.y * halfNorth;
    const rotatedEast = anchorEast * cosR - anchorNorth * sinR;
    const rotatedNorth = anchorEast * sinR + anchorNorth * cosR;
    expect(shift.east + rotatedEast).toBeCloseTo(0, 6);
    expect(shift.north + rotatedNorth).toBeCloseTo(0, 6);
  };

  const surfaceCases = [
    { anchor: { x: 1, y: 0 }, halfEast: 10, halfNorth: 20, rotate: 90 },
    { anchor: { x: -1, y: 0 }, halfEast: 5, halfNorth: 15, rotate: 90 },
    { anchor: { x: 0, y: 1 }, halfEast: 12, halfNorth: 8, rotate: 45 },
    { anchor: { x: 0, y: -1 }, halfEast: 14, halfNorth: 9, rotate: 180 },
    { anchor: { x: 1, y: 1 }, halfEast: 6, halfNorth: 6, rotate: 270 },
  ] as const;

  it.each(surfaceCases)(
    'cancels rotated surface anchor for %o',
    ({ anchor, halfEast, halfNorth, rotate }) => {
      expectSurfaceAnchorDisplacement(anchor, halfEast, halfNorth, rotate);
    }
  );

  it('computes offset meters', () => {
    const offset = calculateSurfaceOffsetMeters(
      { offsetDeg: 180, offsetMeters: 5 },
      2,
      1
    );
    expect(offset.east).toBeCloseTo(0, 6);
    expect(offset.north).toBeCloseTo(-10, 6);
  });

  it('scales offset with zoom factor', () => {
    const offset = calculateSurfaceOffsetMeters(
      { offsetDeg: 90, offsetMeters: 4 },
      0.5,
      3
    );
    expect(offset.east).toBeCloseTo(6, 6);
    expect(offset.north).toBeCloseTo(0, 6);
  });

  it('keeps offset constant after spriteMaxPixel clamp', () => {
    const offsetDef = { offsetDeg: 0, offsetMeters: 10 } as const;
    const dimsAtClamp = calculateSurfaceWorldDimensions(128, 64, 1, 1, 1, {
      effectivePixelsPerMeter: 1,
      spriteMaxPixel: 128,
    });
    const offsetAtClamp = calculateSurfaceOffsetMeters(
      offsetDef,
      1,
      1,
      dimsAtClamp.scaleAdjustment
    );
    const dimsBeyondClamp = calculateSurfaceWorldDimensions(128, 64, 1, 1, 2, {
      effectivePixelsPerMeter: 1,
      spriteMaxPixel: 128,
    });
    const offsetBeyondClamp = calculateSurfaceOffsetMeters(
      offsetDef,
      1,
      2,
      dimsBeyondClamp.scaleAdjustment
    );
    expect(offsetAtClamp.north).toBeCloseTo(offsetBeyondClamp.north, 6);
  });

  it('keeps offset constant after spriteMinPixel inflation', () => {
    const offsetDef = { offsetDeg: 0, offsetMeters: 10 } as const;
    const dimsAtMin = calculateSurfaceWorldDimensions(128, 64, 1, 1, 1, {
      effectivePixelsPerMeter: 1,
      spriteMinPixel: 128,
    });
    const offsetAtMin = calculateSurfaceOffsetMeters(
      offsetDef,
      1,
      1,
      dimsAtMin.scaleAdjustment
    );
    const dimsBelowMin = calculateSurfaceWorldDimensions(128, 64, 1, 1, 0.5, {
      effectivePixelsPerMeter: 1,
      spriteMinPixel: 128,
    });
    const offsetBelowMin = calculateSurfaceOffsetMeters(
      offsetDef,
      1,
      0.5,
      dimsBelowMin.scaleAdjustment
    );
    expect(offsetAtMin.north).toBeCloseTo(offsetBelowMin.north, 6);
  });
});

describe('calculateEffectivePixelsPerMeter', () => {
  it('returns zero when meters per pixel is not positive', () => {
    expect(calculateEffectivePixelsPerMeter(0, 1)).toBe(0);
    expect(calculateEffectivePixelsPerMeter(Number.NaN, 1)).toBe(0);
  });

  it('defaults invalid perspective ratio to 1', () => {
    expect(calculateEffectivePixelsPerMeter(2, Number.NaN)).toBeCloseTo(0.5, 6);
  });

  it('applies perspective scaling', () => {
    expect(calculateEffectivePixelsPerMeter(2, 3)).toBeCloseTo(1.5, 6);
  });
});

describe('applySurfaceDisplacement', () => {
  it.each(displacementCases)(
    'matches analytic displacement %#',
    ({ baseLng, baseLat, east, north }) => {
      const result = applySurfaceDisplacement(
        { lng: baseLng, lat: baseLat },
        { east, north }
      );
      const cosLat = Math.cos(deg(baseLat));
      const clampedCos = Math.max(cosLat, 1e-6);
      const expectedLng =
        baseLng + (east / (EARTH_RADIUS_METERS * clampedCos)) * (180 / Math.PI);
      const expectedLat =
        baseLat + (north / EARTH_RADIUS_METERS) * (180 / Math.PI);
      expect(result.lng).toBeCloseTo(expectedLng, 6);
      expect(result.lat).toBeCloseTo(expectedLat, 6);
    }
  );

  it('clamps cosine near the poles', () => {
    const baseLat = 89.9999;
    const result = applySurfaceDisplacement(
      { lng: 45, lat: baseLat },
      { east: 500, north: 0 }
    );
    expect(Number.isFinite(result.lng)).toBe(true);
    const clampedCos = Math.max(Math.cos(deg(baseLat)), 1e-6);
    const expectedLng =
      45 + (500 / (EARTH_RADIUS_METERS * clampedCos)) * (180 / Math.PI);
    expect(result.lng).toBeCloseTo(expectedLng, 6);
    expect(result.lat).toBeCloseTo(baseLat, 6);
  });

  it('reverses small displacements symmetrically', () => {
    const forward = applySurfaceDisplacement(
      { lng: 10, lat: -20 },
      { east: 30, north: -15 }
    );
    const back = applySurfaceDisplacement(forward, { east: -30, north: 15 });
    expect(back.lng).toBeCloseTo(10, 6);
    expect(back.lat).toBeCloseTo(-20, 6);
  });
});

const anchorExtremes = [
  { x: -1, y: -1 },
  { x: -1, y: 1 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: 0, y: 0 },
] as const;

const rotationSamples = [0, 90, 180, 270] as const;
const scaleSamples = [0.01, 1, 10] as const;
const offsetSamples = [
  { offsetMeters: 0, offsetDeg: 0 },
  { offsetMeters: 500, offsetDeg: 0 },
  { offsetMeters: 500, offsetDeg: 90 },
] as const;

const buildBillboardCases = () => {
  const cases: Array<{
    anchor: { x: number; y: number };
    rotation: number;
    scale: number;
    offset: { offsetMeters: number; offsetDeg: number };
  }> = [];
  for (const anchor of anchorExtremes) {
    for (const rotation of rotationSamples) {
      for (const scale of scaleSamples) {
        for (const offset of offsetSamples) {
          cases.push({ anchor, rotation, scale, offset });
        }
      }
    }
  }
  return cases;
};

const buildSurfaceCases = buildBillboardCases;

const displacementCases = [
  { baseLng: 139.0, baseLat: 35.0, east: 100, north: 200 },
  { baseLng: -73.9857, baseLat: 40.758, east: -250, north: 400 },
  { baseLng: 12.4924, baseLat: 80.0, east: 50, north: -75 },
] as const;

const computeBillboardCornersShaderModel = ({
  center,
  halfWidth,
  halfHeight,
  anchor,
  totalRotateDeg,
}: {
  center: SpriteScreenPoint;
  halfWidth: number;
  halfHeight: number;
  anchor?: SpriteAnchor;
  totalRotateDeg: number;
}): Array<{ x: number; y: number; u: number; v: number }> => {
  const baseCorners: ReadonlyArray<readonly [number, number]> = [
    [-1, 1],
    [1, 1],
    [-1, -1],
    [1, -1],
  ];
  const anchorX = anchor?.x ?? 0;
  const anchorY = anchor?.y ?? 0;
  const rad = -totalRotateDeg * (Math.PI / 180);
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  return baseCorners.map(([cornerXNorm, cornerYNorm], index) => {
    const cornerX = cornerXNorm * halfWidth;
    const cornerY = cornerYNorm * halfHeight;
    const shiftedX = cornerX - anchorX * halfWidth;
    const shiftedY = cornerY - anchorY * halfHeight;
    const rotatedX = shiftedX * cosR - shiftedY * sinR;
    const rotatedY = shiftedX * sinR + shiftedY * cosR;
    const [u, v] = UV_CORNERS[index]!;
    return {
      x: center.x + rotatedX,
      y: center.y - rotatedY,
      u,
      v,
    };
  });
};

describe('calculateBillboardCenterPosition', () => {
  const base = { x: 120, y: 340 };
  const imageWidth = 200;
  const imageHeight = 100;
  const baseMetersPerPixel = 1;
  const zoomScaleFactor = 1;
  const effectivePixelsPerMeter = 2;

  it.each(buildBillboardCases())(
    'aligns anchor to base point %#',
    ({ anchor, rotation, scale, offset }) => {
      const placement = calculateBillboardCenterPosition({
        base,
        imageWidth,
        imageHeight,
        baseMetersPerPixel,
        imageScale: scale,
        zoomScaleFactor,
        effectivePixelsPerMeter,
        spriteMinPixel: 0,
        spriteMaxPixel: 0,
        totalRotateDeg: rotation,
        anchor,
        offset,
      });

      const offsetShift = calculateBillboardOffsetPixels(
        offset,
        scale,
        zoomScaleFactor,
        effectivePixelsPerMeter
      );

      const halfWidth = placement.halfWidth;
      const halfHeight = placement.halfHeight;
      const anchorOffsetX = (anchor?.x ?? 0) * halfWidth;
      const anchorOffsetY = (anchor?.y ?? 0) * halfHeight;
      const rad = -rotation * (Math.PI / 180);
      const cosR = Math.cos(rad);
      const sinR = Math.sin(rad);
      const rotatedAnchorX = anchorOffsetX * cosR - anchorOffsetY * sinR;
      const rotatedAnchorY = anchorOffsetX * sinR + anchorOffsetY * cosR;
      const anchorNeutralX = placement.anchorShift.x + rotatedAnchorX;
      const anchorNeutralY = placement.anchorShift.y + rotatedAnchorY;

      expect(placement.center.x).toBeCloseTo(base.x + offsetShift.x, 6);
      expect(placement.center.y).toBeCloseTo(base.y - offsetShift.y, 6);
      expect(anchorNeutralX).toBeCloseTo(0, 6);
      expect(anchorNeutralY).toBeCloseTo(0, 6);
    }
  );

  it('clamps to spriteMinPixel when image would be smaller', () => {
    const placement = calculateBillboardCenterPosition({
      base,
      imageWidth,
      imageHeight,
      baseMetersPerPixel,
      imageScale: 1,
      zoomScaleFactor,
      effectivePixelsPerMeter,
      spriteMinPixel: 500,
      spriteMaxPixel: 600,
      totalRotateDeg: 0,
      anchor: { x: 0, y: 0 },
      offset: { offsetMeters: 0, offsetDeg: 0 },
    });
    expect(placement.pixelWidth).toBeCloseTo(500, 6);
    expect(placement.pixelHeight).toBeCloseTo(250, 6);
    expect(placement.halfWidth).toBeCloseTo(250, 6);
    expect(placement.halfHeight).toBeCloseTo(125, 6);
  });

  it('clamps to spriteMaxPixel when image would exceed limit', () => {
    const placement = calculateBillboardCenterPosition({
      base,
      imageWidth,
      imageHeight,
      baseMetersPerPixel,
      imageScale: 2,
      zoomScaleFactor,
      effectivePixelsPerMeter,
      spriteMinPixel: 0,
      spriteMaxPixel: 300,
      totalRotateDeg: 0,
      anchor: { x: 0, y: 0 },
      offset: { offsetMeters: 0, offsetDeg: 0 },
    });
    expect(placement.pixelWidth).toBeCloseTo(300, 6);
    expect(placement.pixelHeight).toBeCloseTo(150, 6);
  });
});

describe('calculateBillboardDepthKey', () => {
  const center = { x: 256, y: 512 };

  const unproject = ({ x, y }: { x: number; y: number }) => ({
    lng: x / 10,
    lat: y / 10,
  });

  it('returns null when clip projection fails', () => {
    const depth = calculateBillboardDepthKey(center, unproject, () => null);
    expect(depth).toBeNull();
  });

  it('calculates depth from clip coordinates', () => {
    const depth = calculateBillboardDepthKey(center, unproject, () => [
      0, 0, 0.25, 1,
    ]);
    expect(depth).toBeCloseTo(-0.25, 6);
  });
});

describe('calculateBillboardCornerScreenPositions', () => {
  it.each(buildBillboardCases())(
    'produces rotated corners %#',
    ({ anchor, rotation, scale, offset }) => {
      const base = { x: -50, y: 75 };
      const placement = calculateBillboardCenterPosition({
        base,
        imageWidth: 160,
        imageHeight: 120,
        baseMetersPerPixel: 1,
        imageScale: scale,
        zoomScaleFactor: 1,
        effectivePixelsPerMeter: 3,
        spriteMinPixel: 0,
        spriteMaxPixel: 0,
        totalRotateDeg: rotation,
        anchor,
        offset,
      });

      const corners = calculateBillboardCornerScreenPositions({
        center: placement.center,
        halfWidth: placement.halfWidth,
        halfHeight: placement.halfHeight,
        anchor,
        totalRotateDeg: rotation,
      });

      const expected = computeBillboardCornersShaderModel({
        center: placement.center,
        halfWidth: placement.halfWidth,
        halfHeight: placement.halfHeight,
        anchor,
        totalRotateDeg: rotation,
      });

      expected.forEach((expectation, index) => {
        const corner = corners[index]!;
        expect(corner.x).toBeCloseTo(expectation.x, 6);
        expect(corner.y).toBeCloseTo(expectation.y, 6);
        expect(corner.u).toBe(expectation.u);
        expect(corner.v).toBe(expectation.v);
      });
    }
  );
});

describe('calculateSurfaceCenterPosition', () => {
  const baseLngLat = { lng: 139.7, lat: 35.6 };
  const projectLinear = ({ lng, lat }: { lng: number; lat: number }) => ({
    x: lng * 1000,
    y: lat * 1000,
  });

  it.each(buildSurfaceCases())(
    'returns expected displacement %#',
    ({ anchor, rotation, scale, offset }) => {
      const result = calculateSurfaceCenterPosition({
        baseLngLat,
        imageWidth: 128,
        imageHeight: 64,
        baseMetersPerPixel: 2,
        imageScale: scale,
        zoomScaleFactor: 1,
        totalRotateDeg: rotation,
        anchor,
        offset,
        project: projectLinear,
      });

      expect(result.center).not.toBeNull();
      if (!result.center) {
        return;
      }

      const worldDims = calculateSurfaceWorldDimensions(128, 64, 2, scale, 1);
      const anchorShift = calculateSurfaceAnchorShiftMeters(
        worldDims.width / 2,
        worldDims.height / 2,
        anchor,
        rotation
      );
      const offsetMeters = calculateSurfaceOffsetMeters(
        offset,
        scale,
        1,
        worldDims.scaleAdjustment
      );
      expect(result.totalDisplacement.east).toBeCloseTo(
        anchorShift.east + offsetMeters.east,
        6
      );
      expect(result.totalDisplacement.north).toBeCloseTo(
        anchorShift.north + offsetMeters.north,
        6
      );

      const expectedLngLat = applySurfaceDisplacement(
        baseLngLat,
        result.totalDisplacement
      );
      const expectedProjected = projectLinear(expectedLngLat);
      expect(result.center.x).toBeCloseTo(expectedProjected.x, 6);
      expect(result.center.y).toBeCloseTo(expectedProjected.y, 6);
    }
  );

  it('clamps world dimensions using sprite pixel bounds', () => {
    const result = calculateSurfaceCenterPosition({
      baseLngLat,
      imageWidth: 50,
      imageHeight: 20,
      baseMetersPerPixel: 2,
      imageScale: 1,
      zoomScaleFactor: 1,
      totalRotateDeg: 0,
      effectivePixelsPerMeter: 0.5,
      spriteMinPixel: 200,
      project: projectLinear,
    });
    expect(result.worldDimensions.width).toBeCloseTo(400, 6);
    expect(result.worldDimensions.height).toBeCloseTo(160, 6);
  });

  it('provides anchorless placement details when requested', () => {
    const offset = { offsetMeters: 5, offsetDeg: 90 };
    const result = calculateSurfaceCenterPosition({
      baseLngLat,
      imageWidth: 128,
      imageHeight: 64,
      baseMetersPerPixel: 1,
      imageScale: 1,
      zoomScaleFactor: 1,
      totalRotateDeg: 0,
      anchor: { x: 1, y: 1 },
      offset,
      effectivePixelsPerMeter: 1,
      resolveAnchorless: true,
      project: projectLinear,
    });
    expect(result.anchorlessCenter).not.toBeNull();
    expect(result.anchorlessDisplacement).toEqual(
      calculateSurfaceOffsetMeters(offset, 1, 1)
    );
    expect(result.center).not.toBeNull();
    expect(result.center!.x).not.toBeCloseTo(result.anchorlessCenter!.x, 6);
    expect(result.center!.y).not.toBeCloseTo(result.anchorlessCenter!.y, 6);
  });
});

describe('calculateSurfaceDepthKey', () => {
  const baseLngLat = { lng: 139.7, lat: 35.6 };
  const spriteLocation = { lng: 139.7, lat: 35.6, z: 0 };
  const displacements = [
    { east: 0, north: 0 },
    { east: 10, north: 0 },
    { east: 0, north: 20 },
    { east: 10, north: 20 },
  ];

  it('returns maximum depth across corners', () => {
    const clips: Array<[number, number, number, number]> = [
      [0, 0, -0.1, 1],
      [0, 0, -0.3, 1],
      [0, 0, -0.05, 1],
      [0, 0, -0.2, 1],
    ];
    let call = 0;
    const depth = calculateSurfaceDepthKey(
      baseLngLat,
      displacements,
      () => clips[call++] ?? [0, 0, 0, 1],
      { indices: [0, 1, 2, 3] }
    );
    expect(depth).toBeCloseTo(0.3, 6);
  });

  it('applies optional bias function', () => {
    const clips: Array<[number, number, number, number]> = [
      [0, 0, -0.1, 2],
      [0, 0, -0.1, 2],
    ];
    let call = 0;
    const biasFn: SurfaceDepthBiasFn = ({ clipZ, clipW }) => ({
      clipZ: clipZ + 0.2 * clipW,
      clipW,
    });
    const depth = calculateSurfaceDepthKey(
      baseLngLat,
      displacements,
      () => clips[call++] ?? [0, 0, 0, 1],
      { indices: [0, 1], biasFn }
    );
    expect(depth).toBeCloseTo(-0.15, 6);
  });
});

describe('calculateSurfaceCornerDisplacements', () => {
  it.each(buildSurfaceCases())(
    'matches manual corner rotation %#',
    ({ anchor, rotation, scale, offset }) => {
      const worldDims = calculateSurfaceWorldDimensions(
        128,
        256,
        1.5,
        scale,
        1
      );
      const offsetMeters = calculateSurfaceOffsetMeters(
        offset,
        scale,
        1,
        worldDims.scaleAdjustment
      );
      const corners = calculateSurfaceCornerDisplacements({
        worldWidthMeters: worldDims.width,
        worldHeightMeters: worldDims.height,
        anchor,
        totalRotateDeg: rotation,
        offsetMeters,
      });

      const halfWidth = worldDims.width / 2;
      const halfHeight = worldDims.height / 2;
      const anchorEast = anchor.x * halfWidth;
      const anchorNorth = anchor.y * halfHeight;
      const rad = -rotation * (Math.PI / 180);
      const cosR = Math.cos(rad);
      const sinR = Math.sin(rad);
      const baseCorners: Array<[number, number]> = [
        [-halfWidth, halfHeight],
        [halfWidth, halfHeight],
        [-halfWidth, -halfHeight],
        [halfWidth, -halfHeight],
      ];

      baseCorners.forEach(([cornerEast, cornerNorth], index) => {
        const localEast = cornerEast - anchorEast;
        const localNorth = cornerNorth - anchorNorth;
        const rotatedEast = localEast * cosR - localNorth * sinR;
        const rotatedNorth = localEast * sinR + localNorth * cosR;
        const expectedEast = rotatedEast + offsetMeters.east;
        const expectedNorth = rotatedNorth + offsetMeters.north;
        expect(corners[index]!.east).toBeCloseTo(expectedEast, 6);
        expect(corners[index]!.north).toBeCloseTo(expectedNorth, 6);
      });
    }
  );
});

describe('computeSurfaceCornerShaderModel', () => {
  const baseLocations = [
    { lng: 0, lat: 0 },
    { lng: 139.767125, lat: 35.681236 },
    { lng: -73.9857, lat: 40.758 },
    { lng: 45, lat: 85 },
  ] as const;

  it.each(buildSurfaceCases())(
    'matches CPU corner displacements %#',
    ({ anchor, rotation, scale, offset }) => {
      for (const base of baseLocations) {
        const worldDims = calculateSurfaceWorldDimensions(
          128,
          256,
          1.5,
          scale,
          1
        );
        const offsetMeters = calculateSurfaceOffsetMeters(
          offset,
          scale,
          1,
          worldDims.scaleAdjustment
        );

        const cpuCorners = calculateSurfaceCornerDisplacements({
          worldWidthMeters: worldDims.width,
          worldHeightMeters: worldDims.height,
          anchor,
          totalRotateDeg: rotation,
          offsetMeters,
        });

        const shaderCorners = computeSurfaceCornerShaderModel({
          baseLngLat: { lng: base.lng, lat: base.lat },
          worldWidthMeters: worldDims.width,
          worldHeightMeters: worldDims.height,
          anchor,
          totalRotateDeg: rotation,
          offsetMeters,
        });

        expect(shaderCorners).toHaveLength(cpuCorners.length);
        shaderCorners.forEach((corner, index) => {
          const cpuCorner = cpuCorners[index]!;
          expect(corner.east).toBeCloseTo(cpuCorner.east, 6);
          expect(corner.north).toBeCloseTo(cpuCorner.north, 6);
          const displaced = applySurfaceDisplacement(base, cpuCorner);
          expect(corner.lng).toBeCloseTo(displaced.lng, 6);
          expect(corner.lat).toBeCloseTo(displaced.lat, 6);
        });
      }
    }
  );

  it('returns offset-only corners for degenerate quads', () => {
    const base = { lng: 10, lat: 45 };
    const offsetMeters = { east: 12, north: -8 };
    const shaderCorners = computeSurfaceCornerShaderModel({
      baseLngLat: base,
      worldWidthMeters: 0,
      worldHeightMeters: 5,
      anchor: { x: 0, y: 0 },
      totalRotateDeg: 120,
      offsetMeters,
    });

    expect(shaderCorners).toHaveLength(4);
    shaderCorners.forEach((corner) => {
      expect(corner.east).toBeCloseTo(offsetMeters.east, 6);
      expect(corner.north).toBeCloseTo(offsetMeters.north, 6);
      const expected = applySurfaceDisplacement(base, offsetMeters);
      expect(corner.lng).toBeCloseTo(expected.lng, 6);
      expect(corner.lat).toBeCloseTo(expected.lat, 6);
    });
  });
});

describe('screenToClip', () => {
  it('transforms screen coordinates to clip space', () => {
    const [x, y] = screenToClip({ x: 256, y: 256 }, 512, 512, 1);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });
});

describe('clampOpacity', () => {
  it('limits values to the [0, 1] interval', () => {
    expect(clampOpacity(-1)).toBe(0);
    expect(clampOpacity(0.25)).toBe(0.25);
    expect(clampOpacity(2)).toBe(1);
  });
});
