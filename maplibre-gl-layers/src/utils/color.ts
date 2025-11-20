// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

/**
 * Minimal CSS color parser used for resolving sprite border colors.
 */

import { CSS_KEYWORD_COLORS } from '../const';
import type { RgbaColor } from '../internalTypes';

//////////////////////////////////////////////////////////////////////////////////////////

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const clamp255 = (value: number): number => Math.min(255, Math.max(0, value));

const normalizeRgba = (
  r: number,
  g: number,
  b: number,
  a: number
): RgbaColor => [
  clamp255(r) / 255,
  clamp255(g) / 255,
  clamp255(b) / 255,
  clamp01(a),
];

const tryParseHexColor = (value: string): RgbaColor | null => {
  const match = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const hex = match[1] ?? '';
  if (hex.length === 3) {
    const [r, g, b] = hex.split('').map((c) => parseInt(c + c, 16)) as [
      number,
      number,
      number,
    ];
    return normalizeRgba(r, g, b, 1);
  }
  if (hex.length === 4) {
    const [r, g, b, a] = hex.split('').map((c) => parseInt(c + c, 16)) as [
      number,
      number,
      number,
      number,
    ];
    return normalizeRgba(r, g, b, a / 255);
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
    return normalizeRgba(r, g, b, a / 255);
  }
  return null;
};

const parseChannel = (value: string): number => {
  if (value.endsWith('%')) {
    const percent = Number.parseFloat(value.slice(0, -1));
    if (!Number.isFinite(percent)) {
      return Number.NaN;
    }
    return clamp255((percent / 100) * 255);
  }
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? clamp255(number) : Number.NaN;
};

const parseAlpha = (value: string | undefined): number => {
  if (value === undefined) {
    return 1;
  }
  if (value.endsWith('%')) {
    const percent = Number.parseFloat(value.slice(0, -1));
    if (!Number.isFinite(percent)) {
      return Number.NaN;
    }
    return clamp01(percent / 100);
  }
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? clamp01(number) : Number.NaN;
};

const tryParseRgbFunction = (value: string): RgbaColor | null => {
  const match =
    /^rgba?\(\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^,]+?)(?:\s*,\s*([^,]+?)\s*)?\)$/i.exec(
      value.trim()
    );
  if (!match) {
    return null;
  }

  const r = parseChannel(match[1] ?? '');
  const g = parseChannel(match[2] ?? '');
  const b = parseChannel(match[3] ?? '');
  const a = parseAlpha(match[4]);

  if (
    Number.isNaN(r) ||
    Number.isNaN(g) ||
    Number.isNaN(b) ||
    Number.isNaN(a)
  ) {
    return null;
  }

  return normalizeRgba(r, g, b, a);
};

const parseColorUsingDom = (value: string): RgbaColor | null => {
  if (typeof document === 'undefined') {
    return null;
  }
  const element = document.createElement('div');
  element.style.color = '';
  element.style.color = value;
  if (!element.style.color) {
    return null;
  }
  return (
    tryParseRgbFunction(element.style.color) ??
    tryParseHexColor(element.style.color.toLowerCase())
  );
};

//////////////////////////////////////////////////////////////////////////////////////////

/**
 * Parses a CSS color string into normalized RGBA values.
 * Falls back to the supplied default when parsing fails.
 *
 * @param color CSS color string to parse.
 * @param fallback Fallback value used when parsing fails.
 * @returns Parsed RGBA tuple.
 */
export const parseCssColorToRgba = (
  color: string | undefined,
  fallback: RgbaColor
): RgbaColor => {
  if (!color) {
    return fallback;
  }
  const trimmed = color.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  const keyword = CSS_KEYWORD_COLORS[trimmed.toLowerCase()];
  if (keyword) {
    return keyword;
  }

  return (
    tryParseHexColor(trimmed) ??
    tryParseRgbFunction(trimmed) ??
    parseColorUsingDom(trimmed) ??
    fallback
  );
};
