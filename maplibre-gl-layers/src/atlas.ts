// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { Canvas2DContext, Canvas2DSource } from './internalTypes';
import type { Deferred } from 'async-primitives';

//////////////////////////////////////////////////////////////////////////////////////

export interface AtlasManagerOptions {
  readonly pageWidth?: number;
  readonly pageHeight?: number;
  readonly padding?: number;
}

export interface AtlasPlacement {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

export interface AtlasPageState {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly canvas: Canvas2DSource;
  needsUpload: boolean;
}

export interface AtlasManager {
  readonly upsertImage: (id: string, bitmap: ImageBitmap) => AtlasPlacement;
  readonly removeImage: (id: string) => boolean;
  readonly getImagePlacement: (id: string) => AtlasPlacement | null;
  readonly getPages: () => readonly AtlasPageState[];
  readonly markPageClean: (pageIndex: number) => void;
  readonly clear: () => void;
}

export interface AtlasQueueUpsertEntry {
  readonly imageId: string;
  readonly bitmap: ImageBitmap;
  readonly deferred: Deferred<boolean>;
}

export interface AtlasQueueOptions {
  readonly maxOperationsPerPass: number;
  readonly timeBudgetMs: number;
}

export interface AtlasQueueCallbacks {
  readonly onChunkProcessed: () => void;
}

export interface AtlasOperationQueue {
  readonly enqueueUpsert: (entry: AtlasQueueUpsertEntry) => void;
  readonly flushPending: () => void;
  readonly cancelForImage: (imageId: string, reason?: Error) => void;
  readonly rejectAll: (reason: Error) => void;
  readonly pendingCount: number;
}

//////////////////////////////////////////////////////////////////////////////////////

const DEFAULT_PAGE_WIDTH = 2048;
const DEFAULT_PAGE_HEIGHT = 2048;
const DEFAULT_PADDING = 1;

interface ManagedAtlasImage {
  readonly id: string;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  placement: AtlasPlacement | null;
}

interface LayoutSlot {
  readonly x: number;
  readonly y: number;
}

interface InternalAtlasPage extends AtlasPageState {
  readonly ctx: Canvas2DContext;
  cursorX: number;
  cursorY: number;
  rowHeight: number;
}

const createFallbackCanvas2D = (
  width: number,
  height: number
): { canvas: Canvas2DSource; ctx: Canvas2DContext } => {
  const fallbackCanvas = {
    width,
    height,
  } as Record<string, unknown>;

  const fallbackContext = {
    canvas: fallbackCanvas,
    drawImage: () => {},
    clearRect: () => {},
    save: () => {},
    restore: () => {},
    scale: () => {},
    translate: () => {},
    imageSmoothingEnabled: false,
  } as Record<string, unknown>;

  (fallbackCanvas as any).getContext = () =>
    fallbackContext as unknown as CanvasRenderingContext2D;

  return {
    canvas: fallbackCanvas as unknown as Canvas2DSource,
    ctx: fallbackContext as unknown as Canvas2DContext,
  };
};

const createCanvas2D = (
  width: number,
  height: number
): { canvas: Canvas2DSource; ctx: Canvas2DContext } => {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D context for sprite atlas.');
    }
    return { canvas, ctx };
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D context for sprite atlas.');
    }
    return { canvas, ctx };
  }

  return createFallbackCanvas2D(width, height);
};

const clampPositiveInteger = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.max(1, Math.round(value));
};

const tryAllocateInPage = (
  page: InternalAtlasPage,
  width: number,
  height: number
): LayoutSlot | null => {
  if (page.cursorX + width > page.width) {
    const nextRowY = page.cursorY + page.rowHeight;
    if (nextRowY + height > page.height) {
      return null;
    }
    page.cursorX = 0;
    page.cursorY = nextRowY;
    page.rowHeight = 0;
  }

  if (page.cursorY + height > page.height) {
    return null;
  }

  const slot: LayoutSlot = {
    x: page.cursorX,
    y: page.cursorY,
  };
  page.cursorX += width;
  if (height > page.rowHeight) {
    page.rowHeight = height;
  }
  return slot;
};

const createPage = (
  index: number,
  width: number,
  height: number
): InternalAtlasPage => {
  const { canvas, ctx } = createCanvas2D(width, height);
  ctx.clearRect(0, 0, width, height);
  return {
    index,
    width,
    height,
    canvas,
    ctx,
    cursorX: 0,
    cursorY: 0,
    rowHeight: 0,
    needsUpload: true,
  };
};

const applyPlacementToPage = (
  image: ManagedAtlasImage,
  page: InternalAtlasPage,
  slot: LayoutSlot,
  padding: number
): AtlasPlacement => {
  const drawX = slot.x + padding;
  const drawY = slot.y + padding;
  page.ctx.drawImage(image.bitmap, drawX, drawY);
  page.needsUpload = true;

  const placement: AtlasPlacement = {
    pageIndex: page.index,
    width: image.width,
    height: image.height,
    x: drawX,
    y: drawY,
    u0: drawX / page.width,
    v0: drawY / page.height,
    u1: (drawX + image.width) / page.width,
    v1: (drawY + image.height) / page.height,
  };
  image.placement = placement;
  return placement;
};

const redrawPlacementOnPage = (
  image: ManagedAtlasImage,
  page: InternalAtlasPage,
  placement: AtlasPlacement
): AtlasPlacement => {
  page.ctx.clearRect(
    placement.x,
    placement.y,
    placement.width,
    placement.height
  );
  page.ctx.drawImage(image.bitmap, placement.x, placement.y);
  page.needsUpload = true;
  image.placement = placement;
  return placement;
};

const sortImagesForPacking = (
  left: ManagedAtlasImage,
  right: ManagedAtlasImage
): number => {
  if (left.height !== right.height) {
    return right.height - left.height;
  }
  if (left.width !== right.width) {
    return right.width - left.width;
  }
  return left.id.localeCompare(right.id);
};

export const createAtlasManager = (
  options?: AtlasManagerOptions
): AtlasManager => {
  const pageWidth = clampPositiveInteger(
    options?.pageWidth ?? DEFAULT_PAGE_WIDTH
  );
  const pageHeight = clampPositiveInteger(
    options?.pageHeight ?? DEFAULT_PAGE_HEIGHT
  );
  const padding = Math.max(0, Math.round(options?.padding ?? DEFAULT_PADDING));

  const images = new Map<string, ManagedAtlasImage>();
  let pages: InternalAtlasPage[] = [];

  const ensureFitsInPage = (image: ManagedAtlasImage): void => {
    const paddedWidth = image.width + padding * 2;
    const paddedHeight = image.height + padding * 2;
    if (paddedWidth > pageWidth || paddedHeight > pageHeight) {
      throw new Error(
        `[SpriteLayer][Atlas] Image "${image.id}" (${image.width}x${image.height}) exceeds atlas page size ${pageWidth}x${pageHeight}.`
      );
    }
  };

  const placeImageIncrementally = (
    image: ManagedAtlasImage
  ): AtlasPlacement => {
    ensureFitsInPage(image);
    const paddedWidth = image.width + padding * 2;
    const paddedHeight = image.height + padding * 2;

    for (const page of pages) {
      const slot = tryAllocateInPage(page, paddedWidth, paddedHeight);
      if (slot) {
        return applyPlacementToPage(image, page, slot, padding);
      }
    }

    const newPage = createPage(pages.length, pageWidth, pageHeight);
    pages.push(newPage);
    const slot = tryAllocateInPage(newPage, paddedWidth, paddedHeight);
    if (!slot) {
      throw new Error(
        `[SpriteLayer][Atlas] Unable to allocate image "${image.id}" on a fresh page.`
      );
    }
    return applyPlacementToPage(image, newPage, slot, padding);
  };

  const rebuildAtlas = (): void => {
    if (images.size === 0) {
      pages = [];
      return;
    }

    const sortedImages = Array.from(images.values()).sort(sortImagesForPacking);
    const rebuiltPages: InternalAtlasPage[] = [];

    for (const entry of sortedImages) {
      const paddedWidth = entry.width + padding * 2;
      const paddedHeight = entry.height + padding * 2;

      if (paddedWidth > pageWidth || paddedHeight > pageHeight) {
        throw new Error(
          `[SpriteLayer][Atlas] Image "${entry.id}" (${entry.width}x${entry.height}) exceeds atlas page size ${pageWidth}x${pageHeight}.`
        );
      }

      let allocatedSlot: LayoutSlot | null = null;
      let targetPage: InternalAtlasPage | null = null;

      for (const page of rebuiltPages) {
        const slot = tryAllocateInPage(page, paddedWidth, paddedHeight);
        if (slot) {
          allocatedSlot = slot;
          targetPage = page;
          break;
        }
      }

      if (!allocatedSlot || !targetPage) {
        const newPage = createPage(rebuiltPages.length, pageWidth, pageHeight);
        rebuiltPages.push(newPage);
        allocatedSlot = tryAllocateInPage(newPage, paddedWidth, paddedHeight);
        targetPage = newPage;

        if (!allocatedSlot) {
          throw new Error(
            `[SpriteLayer][Atlas] Unable to allocate image "${entry.id}" on a fresh page.`
          );
        }
      }

      applyPlacementToPage(entry, targetPage, allocatedSlot, padding);
    }

    pages = rebuiltPages;
  };

  return {
    upsertImage: (id: string, bitmap: ImageBitmap): AtlasPlacement => {
      const width = clampPositiveInteger(bitmap.width);
      const height = clampPositiveInteger(bitmap.height);
      const existing = images.get(id);

      if (existing) {
        existing.bitmap = bitmap;
        const sizeChanged =
          existing.width !== width || existing.height !== height;
        existing.width = width;
        existing.height = height;

        if (!sizeChanged && existing.placement) {
          const page = pages[existing.placement.pageIndex];
          if (!page) {
            throw new Error(
              `[SpriteLayer][Atlas] Missing atlas page ${existing.placement.pageIndex} for image "${id}".`
            );
          }
          return redrawPlacementOnPage(existing, page, existing.placement);
        }

        rebuildAtlas();
      } else {
        const image: ManagedAtlasImage = {
          id,
          bitmap,
          width,
          height,
          placement: null,
        };
        images.set(id, image);

        try {
          return placeImageIncrementally(image);
        } catch (error) {
          images.delete(id);
          throw error;
        }
      }

      const entry = images.get(id);
      if (!entry || !entry.placement) {
        throw new Error(
          `[SpriteLayer][Atlas] Failed to register image "${id}" in the atlas.`
        );
      }
      return entry.placement;
    },

    removeImage: (id: string): boolean => {
      const removed = images.delete(id);
      if (removed) {
        rebuildAtlas();
      }
      return removed;
    },

    getImagePlacement: (id: string): AtlasPlacement | null => {
      const entry = images.get(id);
      return entry?.placement ?? null;
    },

    getPages: (): readonly AtlasPageState[] => {
      return pages.slice();
    },

    markPageClean: (pageIndex: number): void => {
      const page = pages[pageIndex];
      if (page) {
        page.needsUpload = false;
      }
    },

    clear: (): void => {
      images.clear();
      pages = [];
    },
  };
};

//////////////////////////////////////////////////////////////////////////////////////

export const createAtlasOperationQueue = (
  atlasManager: AtlasManager,
  options: AtlasQueueOptions,
  callbacks: AtlasQueueCallbacks
): AtlasOperationQueue => {
  const queue: AtlasQueueUpsertEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let isProcessing = false;

  const normalizedMaxOps = Math.max(1, options.maxOperationsPerPass | 0);

  const now = (): number =>
    typeof performance !== 'undefined' ? performance.now() : Date.now();

  const processChunk = (
    timeBudgetMs: number = options.timeBudgetMs
  ): { processedAny: boolean; hasRemaining: boolean } => {
    if (isProcessing || queue.length === 0) {
      return {
        processedAny: false,
        hasRemaining: queue.length > 0,
      };
    }
    isProcessing = true;
    let processedAny = false;
    const hasBudget = Number.isFinite(timeBudgetMs) && timeBudgetMs > 0;
    const budgetStart = hasBudget ? now() : 0;
    try {
      let processedCount = 0;
      while (queue.length > 0) {
        const entry = queue.shift()!;
        try {
          atlasManager.upsertImage(entry.imageId, entry.bitmap);
          entry.deferred.resolve(true);
          processedAny = true;
        } catch (error) {
          entry.deferred.reject(error);
        }
        processedCount += 1;
        if (processedCount >= normalizedMaxOps) {
          break;
        }
        if (hasBudget && now() - budgetStart >= timeBudgetMs) {
          break;
        }
      }
      if (processedAny) {
        callbacks.onChunkProcessed();
      }
      return {
        processedAny,
        hasRemaining: queue.length > 0,
      };
    } finally {
      isProcessing = false;
    }
  };

  const schedule = (): void => {
    if (timer || queue.length === 0) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      const { hasRemaining } = processChunk();
      if (hasRemaining) {
        schedule();
      }
    }, 0);
  };

  const cancelEntriesForImage = (imageId: string, reason: Error): void => {
    for (let idx = queue.length - 1; idx >= 0; idx -= 1) {
      const entry = queue[idx];
      if (entry && entry.imageId === imageId) {
        queue.splice(idx, 1);
        entry.deferred.reject(reason);
      }
    }
  };

  return {
    enqueueUpsert: (entry: AtlasQueueUpsertEntry): void => {
      queue.push(entry);
      schedule();
    },
    flushPending: (): void => {
      const { hasRemaining } = processChunk();
      if (hasRemaining) {
        schedule();
      }
    },
    cancelForImage: (imageId: string, reason?: Error): void => {
      const rejectionReason =
        reason ??
        new Error(
          `[SpriteLayer][Atlas] Image "${imageId}" was cancelled before placement.`
        );
      cancelEntriesForImage(imageId, rejectionReason);
    },
    rejectAll: (reason: Error): void => {
      while (queue.length > 0) {
        const entry = queue.shift();
        entry?.deferred.reject(reason);
      }
    },
    get pendingCount(): number {
      return queue.length;
    },
  };
};

//////////////////////////////////////////////////////////////////////////////////////
