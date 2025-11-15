// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import {
  DEFAULT_TEXT_GLYPH_ALIGN,
  DEFAULT_TEXT_GLYPH_COLOR,
  DEFAULT_TEXT_GLYPH_FONT_FAMILY,
  DEFAULT_TEXT_GLYPH_FONT_SIZE,
  DEFAULT_TEXT_GLYPH_FONT_STYLE,
  DEFAULT_TEXT_GLYPH_FONT_WEIGHT,
  DEFAULT_TEXT_GLYPH_RENDER_PIXEL_RATIO,
  MAX_TEXT_GLYPH_RENDER_PIXEL_RATIO,
  MIN_TEXT_GLYPH_FONT_SIZE,
} from '../const';
import type {
  Canvas2DContext,
  Canvas2DSource,
  ResolvedBorderSides,
  ResolvedTextGlyphOptions,
  ResolvedTextGlyphPadding,
} from '../internalTypes';
import type {
  SpriteTextGlyphBorderSide,
  SpriteTextGlyphDimensions,
  SpriteTextGlyphHorizontalAlign,
  SpriteTextGlyphOptions,
  SpriteTextGlyphPaddingPixel,
} from '../types';

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Resolves text padding into a fully populated structure with non-negative values.
 * @param {SpriteTextGlyphPaddingPixel} [padding] - Caller-supplied padding definition.
 * @returns {ResolvedTextGlyphPadding} Padding ready for measurement and drawing.
 */
const resolveTextGlyphPadding = (
  padding?: SpriteTextGlyphPaddingPixel
): ResolvedTextGlyphPadding => {
  if (typeof padding === 'number' && Number.isFinite(padding)) {
    const safeValue = Math.max(0, padding);
    return {
      top: safeValue,
      right: safeValue,
      bottom: safeValue,
      left: safeValue,
    };
  }

  if (typeof padding === 'object' && padding !== null) {
    const safe = (value?: number): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : 0;

    return {
      top: safe(padding.top),
      right: safe(padding.right),
      bottom: safe(padding.bottom),
      left: safe(padding.left),
    };
  }

  return { top: 0, right: 0, bottom: 0, left: 0 };
};

/**
 * Normalizes the border sides definition, defaulting to all sides when unspecified or invalid.
 * @param {readonly SpriteTextGlyphBorderSide[]} [sides] - Requested border sides.
 * @returns {ResolvedBorderSides} Derived sides ready for rendering.
 */
const resolveBorderSides = (
  sides?: readonly SpriteTextGlyphBorderSide[]
): ResolvedBorderSides => {
  if (!Array.isArray(sides) || sides.length === 0) {
    return { top: true, right: true, bottom: true, left: true };
  }

  let top = false;
  let right = false;
  let bottom = false;
  let left = false;

  for (const side of sides) {
    switch (side) {
      case 'top':
        top = true;
        break;
      case 'right':
        right = true;
        break;
      case 'bottom':
        bottom = true;
        break;
      case 'left':
        left = true;
        break;
      default:
        break;
    }
  }

  if (!top && !right && !bottom && !left) {
    return { top: true, right: true, bottom: true, left: true };
  }

  return { top, right, bottom, left };
};

/**
 * Picks a valid horizontal alignment, defaulting to center when unspecified.
 * @param {SpriteTextGlyphHorizontalAlign} [align] - Requested alignment.
 * @returns {SpriteTextGlyphHorizontalAlign} Derived alignment used during layer.
 */
const resolveTextAlign = (
  align?: SpriteTextGlyphHorizontalAlign
): SpriteTextGlyphHorizontalAlign => {
  switch (align) {
    case 'left':
    case 'right':
      return align;
    case 'center':
    default:
      return DEFAULT_TEXT_GLYPH_ALIGN;
  }
};

/**
 * Returns the font style when provided, falling back to the default when invalid.
 * @param {'normal' | 'italic'} [style] - Requested font style.
 * @returns {'normal' | 'italic'} Style to use for drawing.
 */
const resolveFontStyle = (style?: 'normal' | 'italic'): 'normal' | 'italic' =>
  style === 'italic' ? 'italic' : DEFAULT_TEXT_GLYPH_FONT_STYLE;

/**
 * Validates that a numeric value is positive and finite; otherwise returns a fallback.
 * @param {number | undefined} value - Value to test.
 * @param {number} fallback - Value to use when the test fails.
 * @returns {number} Positive finite number suitable for layer math.
 */
const resolvePositiveFinite = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return value > 0 ? value : fallback;
};

/**
 * Normalizes a finite number to be non-negative, falling back when invalid.
 * @param {number | undefined} value - Value to validate.
 * @param {number} [fallback=0] - Fallback used when the value is negative or invalid.
 * @returns {number} Non-negative finite value.
 */
const resolveNonNegativeFinite = (value: number | undefined, fallback = 0) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return value >= 0 ? value : fallback;
};

/**
 * Resolves optional numeric values, returning a fallback when not finite.
 * @param {number | undefined} value - Value to test.
 * @param {number} fallback - Replacement when the value is invalid.
 * @returns {number} Provided value or fallback.
 */
const resolveFiniteOrDefault = (
  value: number | undefined,
  fallback: number
): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Ensures the text glyph render pixel ratio stays within supported bounds.
 * @param {number} [value] - Requested pixel ratio.
 * @returns {number} Clamped pixel ratio for rendering.
 */
const resolveRenderPixelRatio = (value?: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TEXT_GLYPH_RENDER_PIXEL_RATIO;
  }
  return Math.min(
    Math.max(value, DEFAULT_TEXT_GLYPH_RENDER_PIXEL_RATIO),
    MAX_TEXT_GLYPH_RENDER_PIXEL_RATIO
  );
};

/**
 * Draws a rounded rectangle path into the provided canvas context.
 * @param {Canvas2DContext} ctx - Canvas 2D context.
 * @param {number} x - X coordinate of the rectangle origin.
 * @param {number} y - Y coordinate of the rectangle origin.
 * @param {number} width - Width of the rectangle.
 * @param {number} height - Height of the rectangle.
 * @param {number} radius - Corner radius in pixels.
 */
const drawRoundedRectPath = (
  ctx: Canvas2DContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) => {
  const maxRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  // If the radius collapses, fall back to a plain rectangle.
  if (maxRadius === 0) {
    ctx.rect(x, y, width, height);
    return;
  }

  ctx.moveTo(x + maxRadius, y);
  ctx.lineTo(x + width - maxRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + maxRadius);
  ctx.lineTo(x + width, y + height - maxRadius);
  ctx.quadraticCurveTo(
    x + width,
    y + height,
    x + width - maxRadius,
    y + height
  );
  ctx.lineTo(x + maxRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - maxRadius);
  ctx.lineTo(x, y + maxRadius);
  ctx.quadraticCurveTo(x, y, x + maxRadius, y);
};

/**
 * Fills a rounded rectangle, preserving canvas state.
 * @param {Canvas2DContext} ctx - Canvas context.
 * @param {number} width - Rectangle width.
 * @param {number} height - Rectangle height.
 * @param {number} radius - Corner radius.
 * @param {string} color - Fill color.
 */
const fillRoundedRect = (
  ctx: Canvas2DContext,
  width: number,
  height: number,
  radius: number,
  color: string
) => {
  ctx.save();
  ctx.beginPath();
  drawRoundedRectPath(ctx, 0, 0, width, height, radius);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
};

/**
 * Strokes a rounded rectangle, preserving canvas state.
 * @param {Canvas2DContext} ctx - Canvas context.
 * @param {number} width - Rectangle width.
 * @param {number} height - Rectangle height.
 * @param {number} radius - Corner radius.
 * @param {string} color - Stroke color.
 * @param {number} lineWidth - Stroke width in pixels.
 * @param {ResolvedBorderSides} sides - Border sides to render.
 */
const strokeRoundedRect = (
  ctx: Canvas2DContext,
  width: number,
  height: number,
  radius: number,
  color: string,
  lineWidth: number,
  sides: ResolvedBorderSides
) => {
  const { top, right, bottom, left } = sides;
  if (lineWidth <= 0 || (!top && !right && !bottom && !left)) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;

  const cornerRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  const previousCap = ctx.lineCap;
  ctx.lineCap = cornerRadius === 0 ? 'square' : 'butt';

  if (top) {
    const startX = cornerRadius;
    const endX = width - cornerRadius;
    if (endX > startX) {
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(endX, 0);
      ctx.stroke();
    }
  }

  if (right) {
    const startY = cornerRadius;
    const endY = height - cornerRadius;
    if (endY > startY) {
      ctx.beginPath();
      ctx.moveTo(width, startY);
      ctx.lineTo(width, endY);
      ctx.stroke();
    }
  }

  if (bottom) {
    const startX = width - cornerRadius;
    const endX = cornerRadius;
    if (startX > endX) {
      ctx.beginPath();
      ctx.moveTo(startX, height);
      ctx.lineTo(endX, height);
      ctx.stroke();
    }
  }

  if (left) {
    const startY = height - cornerRadius;
    const endY = cornerRadius;
    if (startY > endY) {
      ctx.beginPath();
      ctx.moveTo(0, startY);
      ctx.lineTo(0, endY);
      ctx.stroke();
    }
  }

  ctx.lineCap = previousCap;
  ctx.restore();
};

/**
 * Measures text width while considering custom letter spacing.
 * @param {Canvas2DContext} ctx - Canvas context.
 * @param {string} text - Text to measure.
 * @param {number} letterSpacing - Additional spacing between glyphs.
 * @returns {number} Width in pixels.
 */
const measureTextWidthWithSpacing = (
  ctx: Canvas2DContext,
  text: string,
  letterSpacing: number
): number => {
  // Empty strings contribute zero width regardless of spacing.
  if (text.length === 0) {
    return 0;
  }
  // When no spacing is requested rely on the built-in measurement.
  if (letterSpacing === 0) {
    return ctx.measureText(text).width;
  }

  const glyphs = Array.from(text);
  let total = 0;
  for (const glyph of glyphs) {
    total += ctx.measureText(glyph).width;
  }
  return total + letterSpacing * Math.max(0, glyphs.length - 1);
};

/**
 * Estimates text height using font metrics with fallbacks for older browsers.
 * @param {Canvas2DContext} ctx - Canvas context.
 * @param {string} text - Text to measure.
 * @param {number} fontSize - Font size in pixels used to derive fallbacks.
 * @returns {number} Text height in pixels.
 */
const measureTextHeight = (
  ctx: Canvas2DContext,
  text: string,
  fontSize: number
): number => {
  const metrics = ctx.measureText(text);
  const fallbackAscent = fontSize * 0.8;
  const fallbackDescent = fontSize * 0.2;
  const ascent = Number.isFinite(metrics.actualBoundingBoxAscent)
    ? metrics.actualBoundingBoxAscent
    : fallbackAscent;
  const descent = Number.isFinite(metrics.actualBoundingBoxDescent)
    ? metrics.actualBoundingBoxDescent
    : fallbackDescent;
  const height = ascent + descent;
  // Use measured height only when valid; otherwise fall back to font size for readability.
  if (Number.isFinite(height) && height > 0) {
    return height;
  }
  return Math.max(fontSize, 1);
};

/**
 * Draws text while applying uniform letter spacing between glyphs.
 * @param {Canvas2DContext} ctx - Canvas context.
 * @param {string} text - Text to render.
 * @param {number} startX - Initial X coordinate.
 * @param {number} y - Baseline Y coordinate.
 * @param {number} letterSpacing - Additional spacing per glyph.
 */
const drawTextWithLetterSpacing = (
  ctx: Canvas2DContext,
  text: string,
  startX: number,
  y: number,
  letterSpacing: number
) => {
  if (text.length === 0) {
    return;
  }
  // When spacing is zero fall back to a single fillText call for performance.
  if (letterSpacing === 0) {
    ctx.fillText(text, startX, y);
    return;
  }

  const glyphs = Array.from(text);
  let cursorX = startX;
  for (const glyph of glyphs) {
    ctx.fillText(glyph, cursorX, y);
    cursorX += ctx.measureText(glyph).width + letterSpacing;
  }
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Merges text glyph options with defaults, producing a fully resolved configuration.
 * @param {SpriteTextGlyphOptions} [options] - User-specified options.
 * @param {number} [preferredLineHeight] - Optional line height used as fallback for font size.
 * @returns {ResolvedTextGlyphOptions} Resolved options ready for glyph rendering.
 */
const resolveTextGlyphOptions = (
  options?: SpriteTextGlyphOptions,
  preferredLineHeight?: number
): ResolvedTextGlyphOptions => {
  const fallbackFontSize =
    typeof preferredLineHeight === 'number' && preferredLineHeight > 0
      ? // When a preferred line height is provided, use it as the baseline font size.
        preferredLineHeight
      : // Otherwise fall back to the default glyph font size.
        DEFAULT_TEXT_GLYPH_FONT_SIZE;

  const resolvedFontSize = resolvePositiveFinite(
    options?.fontSizePixelHint,
    fallbackFontSize
  );

  return {
    fontFamily: options?.fontFamily ?? DEFAULT_TEXT_GLYPH_FONT_FAMILY,
    fontStyle: resolveFontStyle(options?.fontStyle),
    fontWeight: options?.fontWeight ?? DEFAULT_TEXT_GLYPH_FONT_WEIGHT,
    fontSizePixel: resolvedFontSize,
    color: options?.color ?? DEFAULT_TEXT_GLYPH_COLOR,
    letterSpacingPixel: resolveFiniteOrDefault(options?.letterSpacingPixel, 0),
    backgroundColor: options?.backgroundColor,
    paddingPixel: resolveTextGlyphPadding(options?.paddingPixel),
    borderColor: options?.borderColor,
    borderWidthPixel: resolveNonNegativeFinite(options?.borderWidthPixel, 0),
    borderRadiusPixel: resolveNonNegativeFinite(options?.borderRadiusPixel, 0),
    borderSides: resolveBorderSides(options?.borderSides),
    textAlign: resolveTextAlign(options?.textAlign),
    renderPixelRatio: resolveRenderPixelRatio(options?.renderPixelRatio),
  };
};

/**
 * Coerces glyph dimensions to positive integers to satisfy canvas requirements.
 * @param {number} value - Raw dimension.
 * @returns {number} Rounded, positive dimension.
 */
const clampGlyphDimension = (value: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : 1;
};

/**
 * Creates a 2D canvas context using either `OffscreenCanvas` or a DOM canvas as fallback.
 * @param {number} width - Canvas width in pixels.
 * @param {number} height - Canvas height in pixels.
 * @returns {{ canvas: Canvas2DSource; ctx: Canvas2DContext }} Canvas and rendering context.
 * @throws When no 2D canvas implementation is available.
 */
const createCanvas2D = (
  width: number,
  height: number
): { canvas: Canvas2DSource; ctx: Canvas2DContext } => {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2d context for text glyph rendering.');
    }
    return { canvas, ctx };
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2d context for text glyph rendering.');
    }
    return { canvas, ctx };
  }

  throw new Error('Canvas 2D is not supported in this environment.');
};

/**
 * Creates an ImageBitmap from a canvas, optionally resizing when a pixel ratio is applied.
 * @param {Canvas2DSource} canvas - Source canvas.
 * @param {number} renderWidth - Width of the rendered content before scaling.
 * @param {number} renderHeight - Height of the rendered content before scaling.
 * @param {number} targetWidth - Width after applying pixel ratio adjustments.
 * @param {number} targetHeight - Height after applying pixel ratio adjustments.
 * @param {number} renderPixelRatio - Pixel ratio used to calculate resize hints.
 * @returns {Promise<ImageBitmap>} Bitmap ready for texture upload.
 */
const createImageBitmapFromCanvas = async (
  canvas: Canvas2DSource,
  renderWidth: number,
  renderHeight: number,
  targetWidth: number,
  targetHeight: number,
  renderPixelRatio: number
): Promise<ImageBitmap> => {
  if (typeof createImageBitmap === 'function') {
    // When renderPixelRatio differs from 1 we request the browser to perform the resize.
    if (renderPixelRatio !== 1) {
      return await createImageBitmap(
        canvas as any,
        0,
        0,
        renderWidth,
        renderHeight,
        {
          resizeWidth: targetWidth,
          resizeHeight: targetHeight,
        }
      );
    }
    return await createImageBitmap(canvas as any);
  }

  const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  if (hasOffscreenCanvas && canvas instanceof OffscreenCanvas) {
    // OffscreenCanvas can provide transferToImageBitmap without DOM involvement.
    if (renderPixelRatio !== 1) {
      const targetCanvas = new OffscreenCanvas(targetWidth, targetHeight);
      const targetCtx = targetCanvas.getContext('2d');
      if (!targetCtx) {
        throw new Error('Failed to acquire 2d context for image resizing.');
      }
      targetCtx.imageSmoothingEnabled = true;
      targetCtx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
      return targetCanvas.transferToImageBitmap();
    }
    return canvas.transferToImageBitmap();
  }

  if (hasOffscreenCanvas) {
    const targetCanvas = new OffscreenCanvas(targetWidth, targetHeight);
    const targetCtx = targetCanvas.getContext('2d');
    if (!targetCtx) {
      throw new Error('Failed to acquire 2d context for image resizing.');
    }
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.drawImage(
      canvas as HTMLCanvasElement,
      0,
      0,
      targetWidth,
      targetHeight
    );
    return targetCanvas.transferToImageBitmap();
  }

  throw new Error('ImageBitmap API is not supported in this environment.');
};

/**
 * Builds a CSS font string from resolved text glyph options.
 * @param {ResolvedTextGlyphOptions} options - Resolved typography options.
 * @returns {string} CSS font shorthand string.
 */
const buildFontString = (options: ResolvedTextGlyphOptions): string =>
  `${options.fontStyle} ${options.fontWeight} ${options.fontSizePixel}px ${options.fontFamily}`;

//////////////////////////////////////////////////////////////////////////////////////

export interface TextGlyphRenderResult {
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
}

export const renderTextGlyphBitmap = async (
  text: string,
  dimensions: SpriteTextGlyphDimensions,
  options?: SpriteTextGlyphOptions
): Promise<TextGlyphRenderResult> => {
  let lineHeight: number | undefined;
  let maxWidth: number | undefined;
  const isLineHeightMode = 'lineHeightPixel' in dimensions;
  if (isLineHeightMode) {
    const { lineHeightPixel } = dimensions as { lineHeightPixel: number };
    lineHeight = clampGlyphDimension(lineHeightPixel);
  } else {
    const { maxWidthPixel } = dimensions as { maxWidthPixel: number };
    maxWidth = clampGlyphDimension(maxWidthPixel);
  }

  const resolved = resolveTextGlyphOptions(options, lineHeight);
  let fontSize = resolved.fontSizePixel;

  const { ctx: measureCtx } = createCanvas2D(1, 1);
  const applyFontSize = (ctx: Canvas2DContext, size: number) => {
    ctx.font = buildFontString({ ...resolved, fontSizePixel: size });
  };
  applyFontSize(measureCtx, fontSize);
  measureCtx.textBaseline = 'alphabetic';

  const letterSpacing = resolved.letterSpacingPixel;
  let measuredWidth = measureTextWidthWithSpacing(
    measureCtx,
    text,
    letterSpacing
  );

  let contentWidthLimit: number | undefined;
  if (!isLineHeightMode && typeof maxWidth === 'number') {
    const padding = resolved.paddingPixel;
    const borderWidth = resolved.borderWidthPixel;
    const glyphCount = Array.from(text).length;
    const letterSpacingTotal = letterSpacing * Math.max(glyphCount - 1, 0);

    contentWidthLimit = Math.max(
      1,
      maxWidth - borderWidth - padding.left - padding.right
    );
    if (contentWidthLimit < letterSpacingTotal) {
      contentWidthLimit = letterSpacingTotal;
    }

    if (text.length > 0 && measuredWidth > contentWidthLimit) {
      const initialRatio = contentWidthLimit / measuredWidth;
      fontSize = Math.max(
        MIN_TEXT_GLYPH_FONT_SIZE,
        Math.floor(fontSize * initialRatio)
      );
      applyFontSize(measureCtx, fontSize);
      measuredWidth = measureTextWidthWithSpacing(
        measureCtx,
        text,
        letterSpacing
      );

      let guard = 0;
      while (
        measuredWidth > contentWidthLimit &&
        fontSize > MIN_TEXT_GLYPH_FONT_SIZE &&
        guard < 12
      ) {
        const ratio = contentWidthLimit / measuredWidth;
        const nextFontSize = Math.max(
          MIN_TEXT_GLYPH_FONT_SIZE,
          Math.floor(fontSize * Math.max(ratio, 0.75))
        );
        if (nextFontSize === fontSize) {
          fontSize = Math.max(MIN_TEXT_GLYPH_FONT_SIZE, fontSize - 1);
        } else {
          fontSize = nextFontSize;
        }
        applyFontSize(measureCtx, fontSize);
        measuredWidth = measureTextWidthWithSpacing(
          measureCtx,
          text,
          letterSpacing
        );
        guard += 1;
      }
    }
  }

  applyFontSize(measureCtx, fontSize);
  measuredWidth = measureTextWidthWithSpacing(measureCtx, text, letterSpacing);
  const measuredHeight = measureTextHeight(measureCtx, text, fontSize);

  const paddingPixel = resolved.paddingPixel;
  const borderWidthPixel = resolved.borderWidthPixel;

  const contentHeight = isLineHeightMode
    ? lineHeight!
    : clampGlyphDimension(Math.ceil(measuredHeight));

  const totalWidth = clampGlyphDimension(
    Math.ceil(
      borderWidthPixel + paddingPixel.left + paddingPixel.right + measuredWidth
    )
  );
  const totalHeight = clampGlyphDimension(
    Math.ceil(
      borderWidthPixel + paddingPixel.top + paddingPixel.bottom + contentHeight
    )
  );

  const renderPixelRatio = resolved.renderPixelRatio;
  const renderWidth = Math.max(1, Math.round(totalWidth * renderPixelRatio));
  const renderHeight = Math.max(1, Math.round(totalHeight * renderPixelRatio));

  const { canvas, ctx } = createCanvas2D(renderWidth, renderHeight);
  ctx.clearRect(0, 0, renderWidth, renderHeight);
  ctx.save();
  if (renderPixelRatio !== 1) {
    ctx.scale(renderPixelRatio, renderPixelRatio);
  }
  ctx.imageSmoothingEnabled = true;

  if (resolved.backgroundColor) {
    fillRoundedRect(
      ctx,
      totalWidth,
      totalHeight,
      resolved.borderRadiusPixel,
      resolved.backgroundColor
    );
  }

  if (resolved.borderColor && borderWidthPixel > 0) {
    const inset = borderWidthPixel / 2;
    const strokeWidth = Math.max(0, totalWidth - borderWidthPixel);
    const strokeHeight = Math.max(0, totalHeight - borderWidthPixel);
    const strokeRadius = Math.max(0, resolved.borderRadiusPixel - inset);
    ctx.save();
    ctx.translate(inset, inset);
    strokeRoundedRect(
      ctx,
      strokeWidth,
      strokeHeight,
      strokeRadius,
      resolved.borderColor,
      borderWidthPixel,
      resolved.borderSides
    );
    ctx.restore();
  }

  const borderInset = borderWidthPixel / 2;
  const contentWidth = Math.max(
    0,
    totalWidth - borderWidthPixel - paddingPixel.left - paddingPixel.right
  );
  const contentHeightInner = Math.max(
    0,
    totalHeight - borderWidthPixel - paddingPixel.top - paddingPixel.bottom
  );
  const contentLeft = borderInset + paddingPixel.left;
  const contentTop = borderInset + paddingPixel.top;
  const textY = contentTop + contentHeightInner / 2;

  const renderOptions = { ...resolved, fontSizePixel: fontSize };
  ctx.font = buildFontString(renderOptions);
  ctx.fillStyle = resolved.color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const totalTextWidth = measureTextWidthWithSpacing(ctx, text, letterSpacing);

  let textStartX = contentLeft;
  switch (resolved.textAlign) {
    case 'right':
      textStartX = contentLeft + (contentWidth - totalTextWidth);
      break;
    case 'center':
      textStartX = contentLeft + (contentWidth - totalTextWidth) / 2;
      break;
    case 'left':
    default:
      textStartX = contentLeft;
      break;
  }

  drawTextWithLetterSpacing(ctx, text, textStartX, textY, letterSpacing);

  ctx.restore();

  const bitmap = await createImageBitmapFromCanvas(
    canvas,
    renderWidth,
    renderHeight,
    totalWidth,
    totalHeight,
    renderPixelRatio
  );

  return { bitmap, width: totalWidth, height: totalHeight };
};
