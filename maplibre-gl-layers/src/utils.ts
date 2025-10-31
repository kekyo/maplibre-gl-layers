// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  SpriteImageRegisterOptions,
  SpriteImageSvgOptions,
} from './types';

interface ParsedSvgSize {
  readonly width?: number;
  readonly height?: number;
  readonly aspectRatio?: number;
  readonly hasExplicitSize: boolean;
}

const DEFAULT_SVG_WIDTH = 300;
const DEFAULT_SVG_HEIGHT = 150;

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
      return { hasExplicitSize: false };
    }

    const attrWidth = parseNumericLength(svg.getAttribute('width'));
    const attrHeight = parseNumericLength(svg.getAttribute('height'));
    const styleWidth = extractStyleLength(svg.getAttribute('style'), 'width');
    const styleHeight = extractStyleLength(svg.getAttribute('style'), 'height');

    const width = attrWidth ?? styleWidth;
    const height = attrHeight ?? styleHeight;

    let aspectRatio: number | undefined;
    const viewBox = svg.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox
        .split(/[\s,]+/)
        .map((part) => Number.parseFloat(part))
        .filter((part) => Number.isFinite(part));
      if (parts.length === 4) {
        const viewBoxWidth = parts[2]!;
        const viewBoxHeight = parts[3]!;
        if (viewBoxWidth > 0 && viewBoxHeight > 0) {
          aspectRatio = viewBoxWidth / viewBoxHeight;
        }
      }
    }

    if (width && height && height > 0) {
      aspectRatio = width / height;
    }

    return {
      width,
      height,
      aspectRatio,
      hasExplicitSize: width !== undefined || height !== undefined,
    };
  } catch {
    return { hasExplicitSize: false };
  }
};

const resolveSvgResizeDimensions = (
  parsed: ParsedSvgSize,
  options: SpriteImageSvgOptions | undefined
): { width: number; height: number } => {
  const optionWidth = options?.width;
  const optionHeight = options?.height;

  let targetWidth: number | undefined;
  let targetHeight: number | undefined;

  if (parsed.hasExplicitSize) {
    targetWidth = optionWidth ?? parsed.width;
    targetHeight = optionHeight ?? parsed.height;
    if (
      targetWidth !== undefined &&
      targetHeight === undefined &&
      parsed.aspectRatio
    ) {
      targetHeight = targetWidth / parsed.aspectRatio;
    } else if (
      targetHeight !== undefined &&
      targetWidth === undefined &&
      parsed.aspectRatio
    ) {
      targetWidth = targetHeight * parsed.aspectRatio;
    }
  } else {
    targetWidth = optionWidth ?? DEFAULT_SVG_WIDTH;
    targetHeight = optionHeight ?? DEFAULT_SVG_HEIGHT;
    if (parsed.aspectRatio) {
      if (optionWidth !== undefined && optionHeight === undefined) {
        targetHeight = optionWidth / parsed.aspectRatio;
      } else if (optionHeight !== undefined && optionWidth === undefined) {
        targetWidth = optionHeight * parsed.aspectRatio;
      }
    }
  }

  const width = Math.max(1, Math.round(targetWidth ?? DEFAULT_SVG_WIDTH));
  const height = Math.max(1, Math.round(targetHeight ?? DEFAULT_SVG_HEIGHT));

  return { width, height };
};

const isSvgMimeType = (mimeType: string | null): boolean => {
  if (!mimeType) {
    return false;
  }
  return mimeType.toLowerCase().includes('image/svg');
};

/**
 * Helper that loads an ImageBitmap from a URL.
 * @param url Target image URL.
 * @param options Optional SVG-aware loading options.
 * @returns Promise resolving to the ImageBitmap.
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

  const svgOptions = options?.svg;
  const shouldTreatAsSvg =
    svgOptions?.assumeSvg === true || isSvgMimeType(mimeType);

  if (shouldTreatAsSvg) {
    let parsed: ParsedSvgSize = { hasExplicitSize: false };
    if (svgOptions?.inspectSize !== false) {
      const text = await blob.text();
      parsed = parseSvgSize(text);
    }

    if (
      svgOptions?.width !== undefined ||
      svgOptions?.height !== undefined ||
      svgOptions?.inspectSize !== false
    ) {
      const { width, height } = resolveSvgResizeDimensions(parsed, svgOptions);
      const bitmapOptions: ImageBitmapOptions = {
        resizeWidth: width,
        resizeHeight: height,
      };
      if (svgOptions?.resizeQuality) {
        bitmapOptions.resizeQuality = svgOptions.resizeQuality;
      }
      return await createImageBitmap(blob, bitmapOptions);
    }
  }

  return await createImageBitmap(blob);
};
