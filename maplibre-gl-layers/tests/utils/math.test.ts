// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it, vi } from 'vitest';

import {
  applySurfaceDisplacement,
  calculateBillboardAnchorShiftPixels,
  calculateBillboardCornerScreenPositions,
  calculateBillboardDepthKey,
  calculateBillboardOffsetPixels,
  calculateBillboardPixelDimensions,
  calculateBillboardCenterPosition,
  calculateCartesianDistanceMeters,
  calculateDistanceAndBearingMeters,
  calculateDistanceScaleFactor,
  calculateEffectivePixelsPerMeter,
  calculateMetersPerPixelAtLatitude,
  calculateSurfaceAnchorShiftMeters,
  calculateSurfaceCenterPosition,
  calculateSurfaceCornerDisplacements,
  calculateSurfaceDepthKey,
  calculateSurfaceOffsetMeters,
  calculateSurfaceWorldDimensions,
  clampOpacity,
  cloneSpriteLocation,
  computeSurfaceCornerShaderModel,
  lerpSpriteLocation,
  multiplyMatrixAndVector,
  normalizeAngleDeg,
  resolveScalingOptions,
  screenToClip,
  spriteLocationsEqual,
} from '../../src/utils/math';
import type { SpriteAnchor, SpriteScreenPoint } from '../../src/types';
import { EARTH_RADIUS_METERS, UV_CORNERS } from '../../src/const';

const deg = (value: number) => (value * Math.PI) / 180;

describe('location helpers', () => {
  it('clones sprite location', () => {
    const source = { lng: 10, lat: -5, z: 100 };
    const cloned = cloneSpriteLocation(source);
    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
  });

  it('linearly interpolates sprite location', () => {
    const from = { lng: 0, lat: 0, z: 0 };
    const to = { lng: 10, lat: -20, z: 30 };
    expect(lerpSpriteLocation(from, to, 0)).toEqual(from);
    expect(lerpSpriteLocation(from, to, 1)).toEqual(to);
    const mid = lerpSpriteLocation(from, to, 0.5);
    expect(mid.lng).toBeCloseTo(5, 6);
    expect(mid.lat).toBeCloseTo(-10, 6);
    expect(mid.z).toBeCloseTo(15, 6);
  });

  it('compares sprite locations', () => {
    const a = { lng: 1, lat: 2, z: 3 };
    expect(spriteLocationsEqual(a, { ...a })).toBe(true);
    expect(spriteLocationsEqual(a, { lng: 1, lat: 2, z: 4 })).toBe(false);
  });
});

describe('normalizeAngleDeg', () => {
  it('wraps angles to [0, 360)', () => {
    expect(normalizeAngleDeg(0)).toBe(0);
    expect(normalizeAngleDeg(190)).toBe(190);
    expect(normalizeAngleDeg(-200)).toBe(160);
    expect(normalizeAngleDeg(720)).toBe(0);
  });
});

describe('multiplyMatrixAndVector', () => {
  it('multiplies 4x4 matrix and vector', () => {
    const matrix = new Float64Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    const [x, y, z, w] = multiplyMatrixAndVector(matrix, 1, 0, 0, 1);
    expect(x).toBeCloseTo(14, 6);
    expect(y).toBeCloseTo(16, 6);
    expect(z).toBeCloseTo(18, 6);
    expect(w).toBeCloseTo(20, 6);
  });
});

describe('resolveScalingOptions / calculateDistanceScaleFactor', () => {
  it('fills missing scaling fields with defaults', () => {
    const base = resolveScalingOptions();
    const resolved = resolveScalingOptions({ metersPerPixel: 2 });
    expect(resolved).toEqual({
      ...base,
      metersPerPixel: 2,
    });
  });

  it('clamps scale when distance crosses thresholds', () => {
    const resolved = resolveScalingOptions({
      minScaleDistanceMeters: 10,
      maxScaleDistanceMeters: 100,
    });
    expect(calculateDistanceScaleFactor(50, resolved)).toBe(1);
    expect(calculateDistanceScaleFactor(5, resolved)).toBeCloseTo(0.5, 6);
    expect(calculateDistanceScaleFactor(200, resolved)).toBeCloseTo(2, 6);
  });

  it('normalizes descending ranges and emits warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolveScalingOptions({
      minScaleDistanceMeters: 200,
      maxScaleDistanceMeters: 100,
    });
    expect(resolved.minScaleDistanceMeters).toBe(100);
    expect(resolved.maxScaleDistanceMeters).toBe(200);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('SpriteScalingOptions');
    warnSpy.mockRestore();
  });

  it('clips invalid numeric inputs to safe defaults', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = resolveScalingOptions();
    const resolved = resolveScalingOptions({
      metersPerPixel: -5,
      minScaleDistanceMeters: -10,
      maxScaleDistanceMeters: Number.NaN,
    });
    expect(resolved.metersPerPixel).toBe(base.metersPerPixel);
    expect(resolved.minScaleDistanceMeters).toBe(0);
    expect(resolved.maxScaleDistanceMeters).toBe(Number.POSITIVE_INFINITY);
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

describe('distance helpers', () => {
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

  it('calculates cartesian distance', () => {
    const from = { lng: 0, lat: 0, z: 0 };
    const to = { lng: 0, lat: 0, z: 1000 };
    expect(calculateCartesianDistanceMeters(from, to)).toBeCloseTo(1000, 6);
  });
});

describe('billboard helpers', () => {
  it('scales pixel size with distanceScaleFactor', () => {
    const base = calculateBillboardPixelDimensions(100, 80, 1, 1, 2, 1);
    expect(base.width).toBeCloseTo(200, 6);
    expect(base.height).toBeCloseTo(160, 6);
    expect(base.scaleAdjustment).toBeCloseTo(1, 6);
  });

  it('returns zero when resource size invalid', () => {
    const dims = calculateBillboardPixelDimensions(undefined, 80, 1, 1, 1, 1);
    expect(dims).toEqual({ width: 0, height: 0, scaleAdjustment: 1 });
  });

  it('computes offset pixels and respects size adjustment', () => {
    const offset = calculateBillboardOffsetPixels(
      { offsetDeg: 90, offsetMeters: 10 },
      1,
      2,
      3,
      0.5
    );
    expect(offset.x).toBeCloseTo(30, 6);
    expect(offset.y).toBeCloseTo(0, 6);
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

  it('computes offset meters with scaling', () => {
    const offset = calculateSurfaceOffsetMeters(
      { offsetDeg: 180, offsetMeters: 5 },
      2,
      1,
      0.5
    );
    expect(offset.east).toBeCloseTo(0, 6);
    expect(offset.north).toBeCloseTo(-5, 6);
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
  const displacementCases = [
    { baseLng: 139.0, baseLat: 35.0, east: 100, north: 200 },
    { baseLng: -73.9857, baseLat: 40.758, east: -250, north: 400 },
    { baseLng: 12.4924, baseLat: 80.0, east: 50, north: -75 },
  ] as const;

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
const scaleSamples = [0.01, 0.5, 1, 5, 10] as const;
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
  const distanceScaleFactor = 1;
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
        distanceScaleFactor,
        effectivePixelsPerMeter,
        totalRotateDeg: rotation,
        anchor,
        offset,
      });

      const offsetShift = calculateBillboardOffsetPixels(
        offset,
        scale,
        distanceScaleFactor,
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
});

describe('calculateBillboardDepthKey', () => {
  const center = { x: 256, y: 512 };

  const unproject = ({ x, y }: { x: number; y: number }) => ({
    lng: x / 10,
    lat: y / 10,
  });

  it('returns null when clip projection fails', () => {
    const depth = calculateBillboardDepthKey(
      center,
      unproject,
      () => undefined
    );
    expect(depth).toBeUndefined();
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
        distanceScaleFactor: 1,
        effectivePixelsPerMeter: 3,
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
        distanceScaleFactor: 1,
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

  it('provides anchorless placement details when requested', () => {
    const offset = { offsetMeters: 5, offsetDeg: 90 };
    const result = calculateSurfaceCenterPosition({
      baseLngLat,
      imageWidth: 128,
      imageHeight: 64,
      baseMetersPerPixel: 1,
      imageScale: 1,
      distanceScaleFactor: 1,
      totalRotateDeg: 0,
      anchor: { x: 1, y: 1 },
      offset,
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
    const biasFn = ({ clipZ, clipW }: { clipZ: number; clipW: number }) => ({
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
