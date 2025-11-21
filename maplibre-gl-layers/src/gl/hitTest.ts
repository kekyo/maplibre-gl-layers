// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { type Map as MapLibreMap } from 'maplibre-gl';

import type {
  InternalSpriteCurrentState,
  InternalSpriteImageState,
  ProjectionHost,
  RegisteredImage,
} from '../internalTypes';
import type {
  SpriteLocation,
  SpriteScreenPoint,
  SpriteImageOffset,
} from '../types';
import {
  applySurfaceDisplacement,
  calculateBillboardAnchorShiftPixels,
  calculateBillboardOffsetPixels,
  calculateBillboardPixelDimensions,
  calculateEffectivePixelsPerMeter,
  calculateMetersPerPixelAtLatitude,
  calculateSurfaceCornerDisplacements,
  calculateSurfaceOffsetMeters,
  calculateSurfaceWorldDimensions,
  calculateZoomScaleFactor,
  resolveSpriteMercator,
  type ResolvedSpriteScalingOptions,
} from '../utils/math';
import { normalizeAngleDeg } from '../interpolation/rotationInterpolation';
import {
  createLooseQuadTree,
  type Item as LooseQuadTreeItem,
  type Rect as LooseQuadTreeRect,
} from '../utils/looseQuadTree';
import { BORDER_OUTLINE_CORNER_ORDER } from './shader';
import {
  DEFAULT_ANCHOR,
  DEFAULT_IMAGE_OFFSET,
  HIT_TEST_EPSILON,
  HIT_TEST_WORLD_BOUNDS,
} from '../const';

//////////////////////////////////////////////////////////////////////////////////////

const HIT_TEST_QUERY_RADIUS_PIXELS = 32;

const resolveImageOffset = (
  image: Readonly<InternalSpriteImageState>
): SpriteImageOffset => {
  const offset = image.offset;
  if (!offset) {
    return { ...DEFAULT_IMAGE_OFFSET };
  }
  return {
    offsetMeters: offset.offsetMeters.current,
    offsetDeg: offset.offsetDeg.current,
  };
};

interface HitTestTreeState<T> {
  readonly sprite: Readonly<InternalSpriteCurrentState<T>>;
  readonly image: Readonly<InternalSpriteImageState>;
  drawIndex: number;
}

interface HitTestTreeHandle<T> {
  rect: Readonly<LooseQuadTreeRect>;
  item: Readonly<LooseQuadTreeItem<HitTestTreeState<T>>>;
}

export interface HitTestEntry<T> {
  readonly sprite: InternalSpriteCurrentState<T>;
  readonly image: InternalSpriteImageState;
  readonly corners: readonly [
    SpriteScreenPoint,
    SpriteScreenPoint,
    SpriteScreenPoint,
    SpriteScreenPoint,
  ];
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface HitTestResult<T> {
  readonly hitEntry: HitTestEntry<T> | undefined;
  readonly screenPoint: SpriteScreenPoint;
}

export interface HitTestControllerParams {
  readonly images: Map<string, RegisteredImage>;
  readonly getResolvedScaling: () => ResolvedSpriteScalingOptions;
}

export interface HitTestController<T> {
  readonly beginFrame: () => void;
  readonly clearAll: () => void;
  readonly getHitTestEntries: () => readonly HitTestEntry<T>[];
  readonly registerHitTestEntry: (
    sprite: Readonly<InternalSpriteCurrentState<T>>,
    image: Readonly<InternalSpriteImageState>,
    corners: readonly [
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
    ],
    drawIndex: number
  ) => void;
  readonly removeImageBounds: (image: InternalSpriteImageState) => void;
  readonly refreshSpriteHitTestBounds: (
    projectionHost: ProjectionHost,
    sprite: Readonly<InternalSpriteCurrentState<T>>
  ) => void;
  readonly findTopmostHitEntry: (
    point: SpriteScreenPoint,
    map: MapLibreMap | undefined
  ) => HitTestEntry<T> | undefined;
  readonly resolveHitTestResult: (
    nativeEvent: MouseEvent | PointerEvent | TouchEvent,
    canvasElement: HTMLCanvasElement | undefined,
    map: MapLibreMap | undefined
  ) => HitTestResult<T> | undefined;
  readonly setHitTestDetection: (enabled: boolean) => boolean;
  readonly isHitTestEnabled: () => boolean;
}

//////////////////////////////////////////////////////////////////////////////////////

export const createHitTestController = <T>({
  images,
  getResolvedScaling,
}: HitTestControllerParams): HitTestController<T> => {
  const hitTestTree = createLooseQuadTree<HitTestTreeState<T>>({
    bounds: HIT_TEST_WORLD_BOUNDS,
  });

  let hitTestTreeItems = new WeakMap<
    InternalSpriteImageState,
    HitTestTreeHandle<T>
  >();

  const hitTestEntries: HitTestEntry<T>[] = [];
  let hitTestEntryByImage = new WeakMap<
    InternalSpriteImageState,
    HitTestEntry<T>
  >();
  let isHitTestEnabled = true;

  const rectFromLngLatPoints = (
    points: readonly Readonly<SpriteLocation>[]
  ): LooseQuadTreeRect | null => {
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;

    for (const point of points) {
      if (
        !point ||
        !Number.isFinite(point.lng) ||
        !Number.isFinite(point.lat)
      ) {
        continue;
      }
      if (point.lng < minLng) minLng = point.lng;
      if (point.lng > maxLng) maxLng = point.lng;
      if (point.lat < minLat) minLat = point.lat;
      if (point.lat > maxLat) maxLat = point.lat;
    }

    if (
      minLng === Number.POSITIVE_INFINITY ||
      maxLng === Number.NEGATIVE_INFINITY ||
      minLat === Number.POSITIVE_INFINITY ||
      maxLat === Number.NEGATIVE_INFINITY
    ) {
      return null;
    }

    return {
      x0: Math.max(
        HIT_TEST_WORLD_BOUNDS.x0,
        Math.min(minLng, HIT_TEST_WORLD_BOUNDS.x1)
      ),
      y0: Math.max(
        HIT_TEST_WORLD_BOUNDS.y0,
        Math.min(minLat, HIT_TEST_WORLD_BOUNDS.y1)
      ),
      x1: Math.max(
        HIT_TEST_WORLD_BOUNDS.x0,
        Math.min(maxLng, HIT_TEST_WORLD_BOUNDS.x1)
      ),
      y1: Math.max(
        HIT_TEST_WORLD_BOUNDS.y0,
        Math.min(maxLat, HIT_TEST_WORLD_BOUNDS.y1)
      ),
    };
  };

  const rectFromRadiusMeters = (
    base: Readonly<SpriteLocation>,
    radiusMeters: number
  ): LooseQuadTreeRect | null => {
    if (
      !Number.isFinite(base.lng) ||
      !Number.isFinite(base.lat) ||
      !Number.isFinite(radiusMeters) ||
      radiusMeters <= 0
    ) {
      return null;
    }

    const cornerNE = applySurfaceDisplacement(base, {
      east: radiusMeters,
      north: radiusMeters,
    });
    const cornerSW = applySurfaceDisplacement(base, {
      east: -radiusMeters,
      north: -radiusMeters,
    });

    return rectFromLngLatPoints([cornerNE, cornerSW]);
  };

  const estimateSurfaceImageBounds = (
    projectionHost: ProjectionHost,
    sprite: Readonly<InternalSpriteCurrentState<T>>,
    image: Readonly<InternalSpriteImageState>
  ): LooseQuadTreeRect | null => {
    const imageResource = images.get(image.imageId);
    if (!imageResource) {
      return null;
    }

    const scaling = getResolvedScaling();
    const baseLocation = sprite.location.current;
    const zoom = projectionHost.getZoom();
    const zoomScaleFactor = calculateZoomScaleFactor(zoom, scaling);
    const metersPerPixelAtLat = calculateMetersPerPixelAtLatitude(
      zoom,
      baseLocation.lat
    );
    if (!Number.isFinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0) {
      return null;
    }

    const spriteMercator = resolveSpriteMercator(projectionHost, sprite);
    const perspectiveRatio = projectionHost.calculatePerspectiveRatio(
      baseLocation,
      spriteMercator
    );
    const effectivePixelsPerMeter = calculateEffectivePixelsPerMeter(
      metersPerPixelAtLat,
      perspectiveRatio
    );
    if (
      !Number.isFinite(effectivePixelsPerMeter) ||
      effectivePixelsPerMeter <= 0
    ) {
      return null;
    }

    const imageScale = image.scale ?? 1;
    const baseMetersPerPixel = scaling.metersPerPixel;
    const spriteMinPixel = scaling.spriteMinPixel;
    const spriteMaxPixel = scaling.spriteMaxPixel;

    const worldDims = calculateSurfaceWorldDimensions(
      imageResource.width,
      imageResource.height,
      baseMetersPerPixel,
      imageScale,
      zoomScaleFactor,
      {
        effectivePixelsPerMeter,
        spriteMinPixel,
        spriteMaxPixel,
      }
    );
    if (worldDims.width <= 0 || worldDims.height <= 0) {
      return null;
    }

    const anchor = image.anchor ?? DEFAULT_ANCHOR;
    const offsetDef = resolveImageOffset(image);
    const offsetMetersVec = calculateSurfaceOffsetMeters(
      offsetDef,
      imageScale,
      zoomScaleFactor,
      worldDims.scaleAdjustment
    );

    const totalRotateDeg = normalizeAngleDeg(
      Number.isFinite(image.finalRotateDeg.current)
        ? image.finalRotateDeg.current
        : (image.currentAutoRotateDeg ?? 0) + image.rotateDeg
    );

    const cornerDisplacements = calculateSurfaceCornerDisplacements({
      worldWidthMeters: worldDims.width,
      worldHeightMeters: worldDims.height,
      anchor,
      totalRotateDeg,
      offsetMeters: offsetMetersVec,
    });

    const corners = cornerDisplacements.map((corner) =>
      applySurfaceDisplacement(baseLocation, corner)
    );
    return rectFromLngLatPoints(corners);
  };

  const estimateBillboardImageBounds = (
    projectionHost: ProjectionHost,
    sprite: InternalSpriteCurrentState<T>,
    image: InternalSpriteImageState
  ): LooseQuadTreeRect | null => {
    const imageResource = images.get(image.imageId);
    if (!imageResource) {
      return null;
    }

    const scaling = getResolvedScaling();
    const baseLocation = sprite.location.current;
    const zoom = projectionHost.getZoom();
    const zoomScaleFactor = calculateZoomScaleFactor(zoom, scaling);
    const metersPerPixelAtLat = calculateMetersPerPixelAtLatitude(
      zoom,
      baseLocation.lat
    );
    if (!Number.isFinite(metersPerPixelAtLat) || metersPerPixelAtLat <= 0) {
      return null;
    }

    const spriteMercator = resolveSpriteMercator(projectionHost, sprite);
    const perspectiveRatio = projectionHost.calculatePerspectiveRatio(
      baseLocation,
      spriteMercator
    );
    const effectivePixelsPerMeter = calculateEffectivePixelsPerMeter(
      metersPerPixelAtLat,
      perspectiveRatio
    );
    if (
      !Number.isFinite(effectivePixelsPerMeter) ||
      effectivePixelsPerMeter <= 0
    ) {
      return null;
    }

    const baseMetersPerPixel = scaling.metersPerPixel;
    const spriteMinPixel = scaling.spriteMinPixel;
    const spriteMaxPixel = scaling.spriteMaxPixel;
    const imageScale = image.scale ?? 1;
    const totalRotateDeg = normalizeAngleDeg(
      Number.isFinite(image.finalRotateDeg.current)
        ? image.finalRotateDeg.current
        : (image.currentAutoRotateDeg ?? 0) + image.rotateDeg
    );

    const pixelDims = calculateBillboardPixelDimensions(
      imageResource.width,
      imageResource.height,
      baseMetersPerPixel,
      imageScale,
      zoomScaleFactor,
      effectivePixelsPerMeter,
      spriteMinPixel,
      spriteMaxPixel
    );

    const halfWidthMeters = pixelDims.width / 2 / effectivePixelsPerMeter;
    const halfHeightMeters = pixelDims.height / 2 / effectivePixelsPerMeter;

    const anchorShift = calculateBillboardAnchorShiftPixels(
      pixelDims.width / 2,
      pixelDims.height / 2,
      image.anchor,
      totalRotateDeg
    );

    const offsetShift = calculateBillboardOffsetPixels(
      resolveImageOffset(image),
      imageScale,
      zoomScaleFactor,
      effectivePixelsPerMeter
    );

    const anchorShiftMeters =
      Math.hypot(anchorShift.x, anchorShift.y) / effectivePixelsPerMeter;
    const offsetShiftMeters =
      Math.hypot(offsetShift.x, offsetShift.y) / effectivePixelsPerMeter;
    const safetyRadius =
      Math.hypot(halfWidthMeters, halfHeightMeters) +
      anchorShiftMeters +
      offsetShiftMeters;

    return rectFromRadiusMeters(baseLocation, safetyRadius);
  };

  const estimateImageBounds = (
    projectionHost: ProjectionHost,
    sprite: Readonly<InternalSpriteCurrentState<T>>,
    image: Readonly<InternalSpriteImageState>
  ): LooseQuadTreeRect | null => {
    if (image.finalOpacity.current <= 0 || !sprite.isEnabled) {
      return null;
    }
    if (image.mode === 'surface') {
      return estimateSurfaceImageBounds(projectionHost, sprite, image);
    }
    return estimateBillboardImageBounds(projectionHost, sprite, image);
  };

  const removeImageBounds = (image: InternalSpriteImageState): void => {
    const handle = hitTestTreeItems.get(image);
    if (!handle) {
      return;
    }
    hitTestTree.remove(
      handle.rect.x0,
      handle.rect.y0,
      handle.rect.x1,
      handle.rect.y1,
      handle.item
    );
    hitTestTreeItems.delete(image);
  };

  const setItemRect = (
    item: LooseQuadTreeItem<HitTestTreeState<T>>,
    rect: LooseQuadTreeRect
  ): void => {
    const mutable = item as unknown as {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    };
    mutable.x0 = rect.x0;
    mutable.y0 = rect.y0;
    mutable.x1 = rect.x1;
    mutable.y1 = rect.y1;
  };

  const registerImageBoundsInHitTestTree = (
    projectionHost: ProjectionHost,
    sprite: Readonly<InternalSpriteCurrentState<T>>,
    image: Readonly<InternalSpriteImageState>
  ): void => {
    const existingHandle = hitTestTreeItems.get(image);

    if (!isHitTestEnabled) {
      if (existingHandle) {
        removeImageBounds(image);
      }
      return;
    }

    const rect = estimateImageBounds(projectionHost, sprite, image);

    if (!rect) {
      if (existingHandle) {
        removeImageBounds(image);
      }
      return;
    }
    if (!existingHandle) {
      const handle: HitTestTreeHandle<T> = {
        rect,
        item: {
          x0: rect.x0,
          y0: rect.y0,
          x1: rect.x1,
          y1: rect.y1,
          state: {
            sprite,
            image,
            drawIndex: 0,
          },
        },
      };
      hitTestTree.add(handle.item);
      hitTestTreeItems.set(image, handle);
      return;
    }

    const currentRect = existingHandle.rect;
    const unchanged =
      currentRect.x0 === rect.x0 &&
      currentRect.y0 === rect.y0 &&
      currentRect.x1 === rect.x1 &&
      currentRect.y1 === rect.y1;

    if (unchanged) {
      return;
    }

    const updated = hitTestTree.update(
      currentRect.x0,
      currentRect.y0,
      currentRect.x1,
      currentRect.y1,
      rect.x0,
      rect.y0,
      rect.x1,
      rect.y1,
      existingHandle.item
    );

    if (updated) {
      existingHandle.rect = rect;
      setItemRect(existingHandle.item, rect);
      return;
    }

    removeImageBounds(image);
    const newHandle: HitTestTreeHandle<T> = {
      rect,
      item: {
        x0: rect.x0,
        y0: rect.y0,
        x1: rect.x1,
        y1: rect.y1,
        state: {
          sprite,
          image,
          drawIndex: 0,
        },
      },
    };
    hitTestTree.add(newHandle.item);
    hitTestTreeItems.set(image, newHandle);
  };

  const refreshSpriteHitTestBounds = (
    projectionHost: ProjectionHost,
    sprite: Readonly<InternalSpriteCurrentState<T>>
  ): void => {
    sprite.images.forEach((orderMap) => {
      orderMap.forEach((image) => {
        registerImageBoundsInHitTestTree(projectionHost, sprite, image);
      });
    });
  };

  const pointInRenderedQuad = (
    point: SpriteScreenPoint,
    corners: readonly [
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
    ]
  ): boolean => {
    let hasPositiveCross = false;
    let hasNegativeCross = false;
    for (let i = 0; i < BORDER_OUTLINE_CORNER_ORDER.length; i++) {
      const currentIndex = BORDER_OUTLINE_CORNER_ORDER[i]!;
      const nextIndex =
        BORDER_OUTLINE_CORNER_ORDER[
          (i + 1) % BORDER_OUTLINE_CORNER_ORDER.length
        ]!;
      const a = corners[currentIndex]!;
      const b = corners[nextIndex]!;
      const edgeX = b.x - a.x;
      const edgeY = b.y - a.y;
      const pointX = point.x - a.x;
      const pointY = point.y - a.y;
      const cross = edgeX * pointY - edgeY * pointX;
      if (Math.abs(cross) <= HIT_TEST_EPSILON) {
        continue;
      }
      if (cross > 0) {
        hasPositiveCross = true;
      } else {
        hasNegativeCross = true;
      }
      if (hasPositiveCross && hasNegativeCross) {
        return false;
      }
    }
    return true;
  };

  const isPointInsideHitEntry = (
    entry: HitTestEntry<T>,
    point: SpriteScreenPoint
  ): boolean => {
    if (
      point.x < entry.minX - HIT_TEST_EPSILON ||
      point.x > entry.maxX + HIT_TEST_EPSILON ||
      point.y < entry.minY - HIT_TEST_EPSILON ||
      point.y > entry.maxY + HIT_TEST_EPSILON
    ) {
      return false;
    }
    return pointInRenderedQuad(point, entry.corners);
  };

  const registerHitTestEntry = (
    spriteEntry: Readonly<InternalSpriteCurrentState<T>>,
    imageEntry: Readonly<InternalSpriteImageState>,
    screenCorners: readonly [
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
    ],
    drawIndex: number
  ): void => {
    if (!isHitTestEnabled) {
      return;
    }

    const corners = screenCorners;
    let minX = corners[0].x;
    let maxX = corners[0].x;
    let minY = corners[0].y;
    let maxY = corners[0].y;
    for (let i = 1; i < corners.length; i++) {
      const corner = corners[i]!;
      if (corner.x < minX) minX = corner.x;
      if (corner.x > maxX) maxX = corner.x;
      if (corner.y < minY) minY = corner.y;
      if (corner.y > maxY) maxY = corner.y;
    }

    const entry: HitTestEntry<T> = {
      sprite: spriteEntry,
      image: imageEntry,
      corners,
      minX,
      maxX,
      minY,
      maxY,
    };
    hitTestEntries.push(entry);
    hitTestEntryByImage.set(imageEntry, entry);

    const handle = hitTestTreeItems.get(imageEntry);
    if (handle) {
      handle.item.state.drawIndex = drawIndex;
    }
  };

  const findTopmostHitEntryLinear = (
    point: SpriteScreenPoint
  ): HitTestEntry<T> | undefined => {
    for (let i = hitTestEntries.length - 1; i >= 0; i--) {
      const entry = hitTestEntries[i]!;
      if (isPointInsideHitEntry(entry, point)) {
        return entry;
      }
    }
    return undefined;
  };

  const findTopmostHitEntry = (
    point: SpriteScreenPoint,
    mapInstance: MapLibreMap | undefined
  ): HitTestEntry<T> | undefined => {
    if (!isHitTestEnabled) {
      return undefined;
    }
    if (!mapInstance) {
      return findTopmostHitEntryLinear(point);
    }

    const centerLngLat = mapInstance.unproject([point.x, point.y] as any);
    if (!centerLngLat) {
      return findTopmostHitEntryLinear(point);
    }

    const searchPoints: SpriteLocation[] = [
      { lng: centerLngLat.lng, lat: centerLngLat.lat },
    ];
    const radius = HIT_TEST_QUERY_RADIUS_PIXELS;
    const offsets: Array<[number, number]> = [
      [point.x - radius, point.y - radius],
      [point.x + radius, point.y - radius],
      [point.x - radius, point.y + radius],
      [point.x + radius, point.y + radius],
    ];
    for (const [x, y] of offsets) {
      const lngLat = mapInstance.unproject([x, y] as any);
      if (lngLat) {
        searchPoints.push({ lng: lngLat.lng, lat: lngLat.lat });
      }
    }

    const searchRect = rectFromLngLatPoints(searchPoints);
    if (!searchRect) {
      return findTopmostHitEntryLinear(point);
    }

    const candidates = hitTestTree.lookup(
      searchRect.x0,
      searchRect.y0,
      searchRect.x1,
      searchRect.y1
    );
    if (candidates.length === 0) {
      return findTopmostHitEntryLinear(point);
    }

    candidates.sort((a, b) => a.state.drawIndex - b.state.drawIndex);

    const seenImages = new Set<InternalSpriteImageState>();
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i]!;
      const image = candidate.state.image;
      if (seenImages.has(image)) {
        continue;
      }
      seenImages.add(image);

      const entry = hitTestEntryByImage.get(image);
      if (!entry) {
        continue;
      }
      if (isPointInsideHitEntry(entry, point)) {
        return entry;
      }
    }

    return findTopmostHitEntryLinear(point);
  };

  const resolveScreenPointFromEvent = (
    nativeEvent: MouseEvent | PointerEvent | TouchEvent,
    canvasElement: HTMLCanvasElement | undefined
  ): SpriteScreenPoint | undefined => {
    if (!canvasElement) {
      return undefined;
    }
    const rect = canvasElement.getBoundingClientRect();
    const toScreenPoint = (
      clientX: number,
      clientY: number
    ): SpriteScreenPoint => ({
      x: clientX - rect.left,
      y: clientY - rect.top,
    });

    if ('changedTouches' in nativeEvent) {
      const touchEvent = nativeEvent as TouchEvent;
      const touch = touchEvent.changedTouches?.[0] ?? touchEvent.touches?.[0];
      if (!touch) {
        return undefined;
      }
      return toScreenPoint(touch.clientX, touch.clientY);
    }

    const mouseLike = nativeEvent as MouseEvent;
    return toScreenPoint(mouseLike.clientX, mouseLike.clientY);
  };

  const resolveHitTestResult = (
    nativeEvent: MouseEvent | PointerEvent | TouchEvent,
    canvasElement: HTMLCanvasElement | undefined,
    mapInstance: MapLibreMap | undefined
  ): HitTestResult<T> | undefined => {
    const screenPoint = resolveScreenPointFromEvent(nativeEvent, canvasElement);
    if (!screenPoint) {
      return undefined;
    }

    const hitEntry = findTopmostHitEntry(screenPoint, mapInstance);
    return { hitEntry: hitEntry ?? undefined, screenPoint };
  };

  const beginFrame = (): void => {
    hitTestEntries.length = 0;
    hitTestEntryByImage = new WeakMap<
      InternalSpriteImageState,
      HitTestEntry<T>
    >();
  };

  const clearAll = (): void => {
    beginFrame();
    hitTestTree.clear();
    hitTestTreeItems = new WeakMap<
      InternalSpriteImageState,
      HitTestTreeHandle<T>
    >();
  };

  const setHitTestDetection = (enabled: boolean): boolean => {
    if (isHitTestEnabled === enabled) {
      return false;
    }
    isHitTestEnabled = enabled;
    clearAll();
    return true;
  };

  const getHitTestEntries = (): readonly HitTestEntry<T>[] => hitTestEntries;

  const isHitTestEnabledFn = (): boolean => isHitTestEnabled;

  return {
    beginFrame,
    clearAll,
    getHitTestEntries,
    registerHitTestEntry,
    removeImageBounds,
    refreshSpriteHitTestBounds,
    findTopmostHitEntry,
    resolveHitTestResult,
    setHitTestDetection,
    isHitTestEnabled: isHitTestEnabledFn,
  };
};
