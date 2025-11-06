// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  ImageHandleBufferController,
  ImageHandleBuffers,
  ImageIdHandler,
  ImageResourceTable,
  RegisteredImage,
} from './internalTypes';
import type { SpriteImageRegisterOptions } from './types';

//////////////////////////////////////////////////////////////////////////////////////

interface ParsedSvgSize {
  readonly width?: number;
  readonly height?: number;
  readonly viewBoxWidth?: number;
  readonly viewBoxHeight?: number;
  readonly hasViewBox: boolean;
}

export type SvgSizeResolutionErrorCode =
  | 'size-missing'
  | 'viewbox-disabled'
  | 'invalid-dimensions';

export class SvgSizeResolutionError extends Error implements Error {
  readonly code: SvgSizeResolutionErrorCode;

  constructor(message: string, code: SvgSizeResolutionErrorCode) {
    super(message);
    this.name = 'SvgSizeResolutionError';
    this.code = code;
  }
}

const parseNumericLength = (
  value: string | null | undefined
): number | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
};

const extractStyleLength = (
  styleValue: string | null | undefined,
  property: 'width' | 'height'
): number | undefined => {
  if (!styleValue) {
    return undefined;
  }
  const declarations = styleValue
    .split(';')
    .map((decl) => decl.trim())
    .filter((decl) => decl.length > 0);
  for (const declaration of declarations) {
    const [prop, rawValue] = declaration.split(':');
    if (!prop || !rawValue) {
      continue;
    }
    if (prop.trim().toLowerCase() === property) {
      return parseNumericLength(rawValue);
    }
  }
  return undefined;
};

const parseSvgSize = (svgText: string): ParsedSvgSize => {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.tagName.toLowerCase() !== 'svg') {
      return { hasViewBox: false };
    }

    const attrWidth = parseNumericLength(svg.getAttribute('width'));
    const attrHeight = parseNumericLength(svg.getAttribute('height'));
    const styleWidth = extractStyleLength(svg.getAttribute('style'), 'width');
    const styleHeight = extractStyleLength(svg.getAttribute('style'), 'height');

    const width = attrWidth ?? styleWidth;
    const height = attrHeight ?? styleHeight;

    let viewBoxWidth: number | undefined;
    let viewBoxHeight: number | undefined;
    let hasViewBox = false;
    const viewBox = svg.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox
        .split(/[\s,]+/)
        .map((part) => Number.parseFloat(part))
        .filter((part) => Number.isFinite(part));
      if (parts.length === 4) {
        viewBoxWidth = parts[2]!;
        viewBoxHeight = parts[3]!;
        if (viewBoxWidth > 0 && viewBoxHeight > 0) {
          hasViewBox = true;
        } else {
          viewBoxWidth = undefined;
          viewBoxHeight = undefined;
        }
      }
    }

    return {
      width: width !== undefined && width > 0 ? width : undefined,
      height: height !== undefined && height > 0 ? height : undefined,
      viewBoxWidth,
      viewBoxHeight,
      hasViewBox,
    };
  } catch {
    return { hasViewBox: false };
  }
};

const determineSvgRasterDimensions = (
  parsed: ParsedSvgSize | null,
  options: SpriteImageRegisterOptions | undefined
): { width: number; height: number } => {
  const overrideWidth = options?.width;
  const overrideHeight = options?.height;

  if (
    overrideWidth !== undefined &&
    overrideHeight !== undefined &&
    overrideWidth > 0 &&
    overrideHeight > 0
  ) {
    return {
      width: Math.max(1, Math.round(overrideWidth)),
      height: Math.max(1, Math.round(overrideHeight)),
    };
  }

  const intrinsicWidth = parsed?.width;
  const intrinsicHeight = parsed?.height;

  const hasValidViewBox = Boolean(
    parsed?.hasViewBox &&
      parsed.viewBoxWidth !== undefined &&
      parsed.viewBoxHeight !== undefined &&
      parsed.viewBoxWidth > 0 &&
      parsed.viewBoxHeight > 0
  );
  const viewBoxAspect = hasValidViewBox
    ? (parsed!.viewBoxWidth as number) / (parsed!.viewBoxHeight as number)
    : undefined;

  let baseWidth: number | undefined;
  let baseHeight: number | undefined;
  let aspect =
    intrinsicWidth !== undefined &&
    intrinsicHeight !== undefined &&
    intrinsicHeight > 0
      ? intrinsicWidth / intrinsicHeight
      : viewBoxAspect;

  if (
    intrinsicWidth !== undefined &&
    intrinsicWidth > 0 &&
    intrinsicHeight !== undefined &&
    intrinsicHeight > 0
  ) {
    baseWidth = intrinsicWidth;
    baseHeight = intrinsicHeight;
  } else if (
    intrinsicWidth !== undefined &&
    intrinsicWidth > 0 &&
    aspect !== undefined
  ) {
    baseWidth = intrinsicWidth;
    baseHeight = intrinsicWidth / aspect;
  } else if (
    intrinsicHeight !== undefined &&
    intrinsicHeight > 0 &&
    aspect !== undefined
  ) {
    baseHeight = intrinsicHeight;
    baseWidth = intrinsicHeight * aspect;
  } else if (hasValidViewBox && options?.svg?.useViewBoxDimensions) {
    baseWidth = parsed!.viewBoxWidth as number;
    baseHeight = parsed!.viewBoxHeight as number;
    aspect = baseWidth / baseHeight;
  }

  if (
    (baseWidth === undefined || baseHeight === undefined) &&
    hasValidViewBox &&
    !options?.svg?.useViewBoxDimensions
  ) {
    throw new SvgSizeResolutionError(
      'SVG width/height attributes are missing and useViewBoxDimensions option is disabled.',
      'viewbox-disabled'
    );
  }

  if (baseWidth === undefined || baseHeight === undefined) {
    throw new SvgSizeResolutionError(
      'SVG image lacks sufficient sizing information.',
      'size-missing'
    );
  }

  aspect = aspect ?? baseWidth / baseHeight;

  let finalWidth = baseWidth;
  let finalHeight = baseHeight;

  if (overrideWidth !== undefined && overrideWidth > 0) {
    finalWidth = overrideWidth;
    if (overrideHeight === undefined) {
      if (aspect === undefined) {
        throw new SvgSizeResolutionError(
          'Unable to infer SVG height from width; aspect ratio is undefined.',
          'invalid-dimensions'
        );
      }
      finalHeight = finalWidth / aspect;
    }
  }

  if (overrideHeight !== undefined && overrideHeight > 0) {
    finalHeight = overrideHeight;
    if (overrideWidth === undefined) {
      if (aspect === undefined) {
        throw new SvgSizeResolutionError(
          'Unable to infer SVG width from height; aspect ratio is undefined.',
          'invalid-dimensions'
        );
      }
      finalWidth = finalHeight * aspect;
    }
  }

  if (
    !Number.isFinite(finalWidth) ||
    !Number.isFinite(finalHeight) ||
    finalWidth <= 0 ||
    finalHeight <= 0
  ) {
    throw new SvgSizeResolutionError(
      'Resolved SVG dimensions are invalid.',
      'invalid-dimensions'
    );
  }

  return {
    width: Math.max(1, Math.round(finalWidth)),
    height: Math.max(1, Math.round(finalHeight)),
  };
};

const isSvgMimeType = (mimeType: string | null): boolean => {
  if (!mimeType) {
    return false;
  }
  return mimeType.toLowerCase().includes('image/svg');
};

const rasterizeSvgWithCanvas = async (
  blob: Blob,
  width: number,
  height: number,
  options: SpriteImageRegisterOptions | undefined
): Promise<ImageBitmap> => {
  if (typeof document === 'undefined') {
    throw new Error(
      'SVG rasterization fallback requires a browser environment'
    );
  }

  const blobUrl = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () =>
        reject(new Error('Failed to load SVG for rasterization'));
      element.src = blobUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D context for SVG rasterization');
    }

    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    if (options?.resizeQuality === 'pixelated') {
      ctx.imageSmoothingEnabled = false;
    } else if (options?.resizeQuality) {
      ctx.imageSmoothingQuality = options.resizeQuality;
    }
    ctx.drawImage(image, 0, 0, width, height);

    try {
      return await createImageBitmap(canvas);
    } catch {
      const canvasBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) {
            resolve(result);
          } else {
            reject(
              new Error('Failed to convert canvas to blob during rasterization')
            );
          }
        });
      });
      return await createImageBitmap(canvasBlob);
    }
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
};

const resolveSvgBitmapWithFallback = async (
  blob: Blob,
  width: number,
  height: number,
  options: SpriteImageRegisterOptions | undefined
): Promise<ImageBitmap> => {
  const bitmapOptions: ImageBitmapOptions = {
    resizeWidth: width,
    resizeHeight: height,
  };
  if (options?.resizeQuality) {
    bitmapOptions.resizeQuality = options.resizeQuality;
  }

  try {
    return await createImageBitmap(blob, bitmapOptions);
  } catch (error) {
    return await rasterizeSvgWithCanvas(blob, width, height, options);
  }
};

const internalReadImageBitmap = async (
  blob: Blob,
  shouldTreatAsSvg: boolean,
  options?: SpriteImageRegisterOptions
): Promise<ImageBitmap> => {
  const svgOptions = options?.svg;

  if (shouldTreatAsSvg) {
    let parsed: ParsedSvgSize | null = null;
    if (svgOptions?.inspectSize !== false) {
      const text = await blob.text();
      parsed = parseSvgSize(text);
    }

    const { width, height } = determineSvgRasterDimensions(parsed, options);
    return await resolveSvgBitmapWithFallback(blob, width, height, options);
  }

  return await createImageBitmap(blob, {
    resizeWidth: options?.width,
    resizeHeight: options?.height,
    resizeQuality: options?.resizeQuality,
  });
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Helper that read an ImageBitmap from a blob.
 * @param blob Target blob.
 * @param options Optional reading options.
 * @returns Promise resolving to the ImageBitmap.
 * @remarks This function helps reading SVG with better manner.
 */
export const readImageBitmap = (
  blob: Blob,
  options?: SpriteImageRegisterOptions
): Promise<ImageBitmap> => {
  const svgOptions = options?.svg;
  const shouldTreatAsSvg = svgOptions?.assumeSvg === true;

  return internalReadImageBitmap(blob, shouldTreatAsSvg, options);
};

/**
 * Helper that loads an ImageBitmap from a URL.
 * @param url Target image URL.
 * @param options Optional loading options.
 * @returns Promise resolving to the ImageBitmap.
 * @remarks This function helps loading SVG with better manner.
 */
export const loadImageBitmap = async (
  url: string,
  options?: SpriteImageRegisterOptions
): Promise<ImageBitmap> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from ${url}`);
  }

  const mimeType = response.headers.get('content-type');
  const blob = await response.blob();
  const shouldTreatAsSvg =
    options?.svg?.assumeSvg === true || isSvgMimeType(mimeType);

  return await internalReadImageBitmap(blob, shouldTreatAsSvg, options);
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Create image id handler object.
 * @returns Image id handler object.
 * @remarks It is used for (wasm) interoperability for image identity.
 */
export const createImageIdHandler = (): ImageIdHandler => {
  /**
   * Maps image identifiers to their numeric handles.
   */
  const imageHandleById = new Map<string, number>();

  /**
   * Table of registered images indexed by handle. Index 0 is reserved.
   */
  const imagesByHandle: Array<RegisteredImage | undefined> = [undefined];

  /**
   * Reusable handles reclaimed from unregistered images.
   */
  const reusableImageHandles: number[] = [];

  /**
   * Next handle to allocate when the reusable pool is empty.
   */
  let nextImageHandle = 1;

  /**
   * Allocates a numeric handle for the specified image identifier.
   * @param {string} imageId - Image identifier.
   * @returns {number} Allocated handle.
   */
  const allocate = (imageId: string): number => {
    const handle =
      reusableImageHandles.length > 0
        ? reusableImageHandles.pop()!
        : nextImageHandle++;
    imageHandleById.set(imageId, handle);
    return handle;
  };

  /**
   * Stores an image reference at the given handle index.
   * @param {number} handle - Numeric handle.
   * @param {RegisteredImage} image - Registered image.
   * @returns {void}
   */
  const store = (handle: number, image: RegisteredImage): void => {
    imagesByHandle[handle] = image;
  };

  /**
   * Releases the numeric handle associated with the provided identifier.
   * @param {string} imageId - Image identifier.
   * @returns {void}
   */
  const release = (imageId: string): void => {
    const handle = imageHandleById.get(imageId);
    if (handle === undefined) {
      return;
    }
    imageHandleById.delete(imageId);
    imagesByHandle[handle] = undefined;
    reusableImageHandles.push(handle);
  };

  /**
   * Clears all handle bookkeeping state.
   * @returns {void}
   */
  const reset = (): void => {
    imageHandleById.clear();
    imagesByHandle.length = 1;
    imagesByHandle[0] = undefined;
    reusableImageHandles.length = 0;
    nextImageHandle = 1;
  };

  return {
    allocate,
    store,
    release,
    reset,
  };
};

/**
 * Image handle buffer controller interface.
 * @remarks It is used for (wasm) interoperability for image identity.
 */
export const createImageHandleBufferController =
  (): ImageHandleBufferController => {
    /**
     * Scheduled image map, interprets at the ensure function.
     */
    let scheduledImages: ReadonlyMap<string, RegisteredImage> = undefined!;

    /**
     * Marks whether the metadata buffers require regeneration.
     */
    let imageHandleBuffersDirty = false;

    /**
     * Cached metadata buffers indexed by image handle.
     * Index 0 remains unused so handle values start at 1.
     */
    let imageHandleBuffers: ImageHandleBuffers = {
      widths: new Float32Array(1),
      heights: new Float32Array(1),
      textureReady: new Uint8Array(1),
    };

    let resourcesByHandle: (RegisteredImage | undefined)[] = [undefined];

    /**
     * Flag metadata buffers for regeneration.
     * @param images Image map.
     */
    const markDirty = (images: ReadonlyMap<string, RegisteredImage>): void => {
      scheduledImages = images;
      imageHandleBuffersDirty = true;
    };

    /**
     * Rebuilds the metadata buffers when flagged as dirty.
     * @returns {ImageHandleBuffers} Metadata buffers aligned by handle index.
     */
    const ensure = (): ImageHandleBuffers => {
      if (!imageHandleBuffersDirty) {
        return imageHandleBuffers;
      }

      let maxHandle = 0;
      scheduledImages.forEach((image) => {
        if (image.handle > maxHandle) {
          maxHandle = image.handle;
        }
      });

      const size = Math.max(maxHandle + 1, 1);
      if (imageHandleBuffers.widths.length !== size) {
        imageHandleBuffers = {
          widths: new Float32Array(size),
          heights: new Float32Array(size),
          textureReady: new Uint8Array(size),
        };
      } else {
        imageHandleBuffers.widths.fill(0);
        imageHandleBuffers.heights.fill(0);
        imageHandleBuffers.textureReady.fill(0);
      }

      if (resourcesByHandle.length !== size) {
        resourcesByHandle = new Array<RegisteredImage | undefined>(size).fill(
          undefined
        );
      } else {
        resourcesByHandle.fill(undefined);
      }

      scheduledImages.forEach((image) => {
        const handle = image.handle;
        if (handle <= 0 || handle >= size) {
          return;
        }
        imageHandleBuffers.widths[handle] = image.width;
        imageHandleBuffers.heights[handle] = image.height;
        imageHandleBuffers.textureReady[handle] = image.texture ? 1 : 0;
        resourcesByHandle[handle] = image;
      });

      imageHandleBuffersDirty = false;
      return imageHandleBuffers;
    };

    /**
     * Returns registered images aligned by handle index. Ensures buffers are up to date.
     */
    const getResourcesByHandle = (): ImageResourceTable => {
      if (imageHandleBuffersDirty) {
        ensure();
      }
      return resourcesByHandle;
    };

    return {
      markDirty,
      ensure,
      getResourcesByHandle,
    };
  };
