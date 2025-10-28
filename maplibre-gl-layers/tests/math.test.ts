// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';

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
  DEFAULT_SPRITE_SCALING_OPTIONS,
  EARTH_RADIUS_METERS,
  calculateBillboardCenterPosition,
  calculateBillboardCornerScreenPositions,
  calculateSurfaceCenterPosition,
  calculateSurfaceCornerDisplacements,
  type SurfaceDepthBiasFn,
  TRIANGLE_INDICES,
  UV_CORNERS,
} from '../src/math';

const deg = (value: number) => (value * Math.PI) / 180;

describe('resolveScalingOptions / calculateZoomScaleFactor', () => {
  it('fills missing scaling fields with defaults', () => {
    const resolved = resolveScalingOptions({ metersPerPixel: 2 });
    expect(resolved).toEqual({
      metersPerPixel: 2,
      zoomMin: DEFAULT_SPRITE_SCALING_OPTIONS.zoomMin,
      zoomMax: DEFAULT_SPRITE_SCALING_OPTIONS.zoomMax,
      scaleMin: DEFAULT_SPRITE_SCALING_OPTIONS.scaleMin,
      scaleMax: DEFAULT_SPRITE_SCALING_OPTIONS.scaleMax,
      spriteMinPixel: DEFAULT_SPRITE_SCALING_OPTIONS.spriteMinPixel,
      spriteMaxPixel: DEFAULT_SPRITE_SCALING_OPTIONS.spriteMaxPixel,
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
    expect(dims).toEqual({ width: 0, height: 0 });
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
      2
    );
    expect(offset.east).toBeCloseTo(0, 6);
    expect(offset.north).toBeCloseTo(-10, 6);
  });

  it('applies displacement to lat/lng', () => {
    const result = applySurfaceDisplacement(139, 35, 100, 200);
    expect(result.lng).toBeCloseTo(
      139 + (100 / (EARTH_RADIUS_METERS * Math.cos(deg(35)))) * (180 / Math.PI),
      6
    );
    expect(result.lat).toBeCloseTo(
      35 + (200 / EARTH_RADIUS_METERS) * (180 / Math.PI),
      6
    );
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

      expect(placement.centerX).toBeCloseTo(base.x + offsetShift.x, 6);
      expect(placement.centerY).toBeCloseTo(base.y - offsetShift.y, 6);
      expect(anchorNeutralX).toBeCloseTo(0, 6);
      expect(anchorNeutralY).toBeCloseTo(0, 6);
    }
  );

  it('clamps to sprite min/max pixels', () => {
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
    const largest = Math.max(placement.pixelWidth, placement.pixelHeight);
    const smallest = Math.min(placement.pixelWidth, placement.pixelHeight);
    expect(largest).toBeGreaterThanOrEqual(500);
    expect(largest).toBeLessThanOrEqual(600);
    expect(placement.pixelWidth / placement.pixelHeight).toBeCloseTo(
      imageWidth / imageHeight,
      6
    );
    expect(smallest).toBeLessThanOrEqual(largest);
  });
});

describe('calculateBillboardDepthKey', () => {
  const spriteLocation = { lng: 139.7, lat: 35.6 };
  const center = { x: 256, y: 512 };

  const unproject = ({ x, y }: { x: number; y: number }) => ({
    lng: x / 10,
    lat: y / 10,
  });

  it('returns null when clip projection fails', () => {
    const depth = calculateBillboardDepthKey(
      center,
      spriteLocation,
      unproject,
      () => null
    );
    expect(depth).toBeNull();
  });

  it('calculates depth from clip coordinates', () => {
    const depth = calculateBillboardDepthKey(
      center,
      spriteLocation,
      unproject,
      () => [0, 0, 0.25, 1]
    );
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
        centerX: placement.centerX,
        centerY: placement.centerY,
        halfWidth: placement.halfWidth,
        halfHeight: placement.halfHeight,
        anchor,
        totalRotateDeg: rotation,
      });

      const anchorOffsetX = (anchor?.x ?? 0) * placement.halfWidth;
      const anchorOffsetY = (anchor?.y ?? 0) * placement.halfHeight;
      const rad = -rotation * (Math.PI / 180);
      const cosR = Math.cos(rad);
      const sinR = Math.sin(rad);

      UV_CORNERS.forEach(([u, v], index) => {
        const baseCorners: Array<[number, number]> = [
          [-placement.halfWidth, placement.halfHeight],
          [placement.halfWidth, placement.halfHeight],
          [-placement.halfWidth, -placement.halfHeight],
          [placement.halfWidth, -placement.halfHeight],
        ];
        const [cornerX, cornerY] = baseCorners[index]!;
        const shiftedX = cornerX - anchorOffsetX;
        const shiftedY = cornerY - anchorOffsetY;
        const rotatedX = shiftedX * cosR - shiftedY * sinR;
        const rotatedY = shiftedX * sinR + shiftedY * cosR;
        const expectedX = placement.centerX + rotatedX;
        const expectedY = placement.centerY - rotatedY;
        const corner = corners[index]!;
        expect(corner.x).toBeCloseTo(expectedX, 6);
        expect(corner.y).toBeCloseTo(expectedY, 6);
        expect(corner.u).toBe(u);
        expect(corner.v).toBe(v);
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
      const offsetMeters = calculateSurfaceOffsetMeters(offset, scale);
      expect(result.totalDisplacement.east).toBeCloseTo(
        anchorShift.east + offsetMeters.east,
        6
      );
      expect(result.totalDisplacement.north).toBeCloseTo(
        anchorShift.north + offsetMeters.north,
        6
      );

      const expectedLngLat = applySurfaceDisplacement(
        baseLngLat.lng,
        baseLngLat.lat,
        result.totalDisplacement.east,
        result.totalDisplacement.north
      );
      const expectedProjected = projectLinear(expectedLngLat);
      expect(result.center.x).toBeCloseTo(expectedProjected.x, 6);
      expect(result.center.y).toBeCloseTo(expectedProjected.y, 6);
    }
  );
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
      spriteLocation,
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
      spriteLocation,
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
      const offsetMeters = calculateSurfaceOffsetMeters(offset, scale);
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

describe('screenToClip', () => {
  it('transforms screen coordinates to clip space', () => {
    const [x, y] = screenToClip(256, 256, 512, 512, 1);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });
});
