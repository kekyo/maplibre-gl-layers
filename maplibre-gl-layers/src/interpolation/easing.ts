// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type {
  SpriteEasing,
  SpriteEasingBack,
  SpriteEasingBounce,
  SpriteEasingCubic,
  SpriteEasingEaseIn,
  SpriteEasingEaseInOut,
  SpriteEasingEaseOut,
  SpriteEasingExponential,
  SpriteEasingLinear,
  SpriteEasingQuadratic,
  SpriteEasingSine,
} from '../types';

export type EasingFunction = (progress: number) => number;

const clampProgress = (progress: number): number => {
  if (!Number.isFinite(progress)) {
    return 1;
  }
  if (progress <= 0) {
    return 0;
  }
  if (progress >= 1) {
    return 1;
  }
  return progress;
};

/**
 * Linear interpolation that clamps the value to the [0, 1] range.
 */
export const linearEasing: EasingFunction = (progress: number): number =>
  clampProgress(progress);

const normalizePower = (
  power: number | undefined,
  fallback: number
): number => {
  if (Number.isFinite(power) && power! > 0) {
    return power!;
  }
  return fallback;
};

const normalizeMode = (
  mode: SpriteEasingExponential['mode'] | undefined,
  fallback: NonNullable<SpriteEasingExponential['mode']>
): NonNullable<SpriteEasingExponential['mode']> => {
  if (mode === 'in' || mode === 'out' || mode === 'in-out') {
    return mode;
  }
  return fallback;
};

const toBounded = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const createPowerEasing = (
  power: number,
  mode: 'in' | 'out' | 'in-out'
): EasingFunction => {
  switch (mode) {
    case 'in':
      return (progress: number) => {
        const t = clampProgress(progress);
        return t ** power;
      };
    case 'out':
      return (progress: number) => {
        const t = clampProgress(progress);
        return 1 - (1 - t) ** power;
      };
    case 'in-out':
    default:
      return (progress: number) => {
        const t = clampProgress(progress);
        if (t < 0.5) {
          return 0.5 * (2 * t) ** power;
        }
        return 1 - 0.5 * (2 * (1 - t)) ** power;
      };
  }
};

const createExponentialEasing = (
  exponent: number,
  mode: NonNullable<SpriteEasingExponential['mode']>
): EasingFunction => {
  const safeExp = exponent > 0 ? exponent : 5;
  const denom = Math.expm1(safeExp);
  const expIn = (progress: number) => {
    const t = clampProgress(progress);
    if (t === 0) {
      return 0;
    }
    if (t === 1) {
      return 1;
    }
    return Math.expm1(safeExp * t) / denom;
  };
  const expOut = (progress: number) => {
    const t = clampProgress(progress);
    if (t === 0) {
      return 0;
    }
    if (t === 1) {
      return 1;
    }
    return 1 - Math.expm1(safeExp * (1 - t)) / denom;
  };
  if (mode === 'in') {
    return expIn;
  }
  if (mode === 'out') {
    return expOut;
  }
  return (progress: number) => {
    const t = clampProgress(progress);
    if (t < 0.5) {
      return 0.5 * expIn(t * 2);
    }
    return 0.5 + 0.5 * expOut(2 * t - 1);
  };
};

const createSineEasing = (
  mode: NonNullable<SpriteEasingSine['mode']>,
  amplitude: number
): EasingFunction => {
  const amp = amplitude;
  if (mode === 'in') {
    return (progress: number) => {
      const t = clampProgress(progress);
      return amp * (1 - Math.cos((Math.PI / 2) * t));
    };
  }
  if (mode === 'out') {
    return (progress: number) => {
      const t = clampProgress(progress);
      return amp * Math.sin((Math.PI / 2) * t);
    };
  }
  return (progress: number) => {
    const t = clampProgress(progress);
    return amp * 0.5 * (1 - Math.cos(Math.PI * t));
  };
};

const createBounceEasing = (bounces: number, decay: number): EasingFunction => {
  const bounceCount = Math.max(1, Math.round(bounces));
  const decayFactor = toBounded(decay, Number.EPSILON, 1);
  return (progress: number) => {
    const t = clampProgress(progress);
    const oscillation = Math.cos(Math.PI * (bounceCount + 0.5) * t);
    const dampening = Math.pow(decayFactor, t * bounceCount);
    return 1 - Math.abs(oscillation) * dampening;
  };
};

const createBackEasing = (overshoot: number): EasingFunction => {
  const c1 = overshoot;
  const c3 = c1 + 1;
  return (progress: number) => {
    const t = clampProgress(progress);
    const p = t - 1;
    return 1 + c3 * p * p * p + c1 * p * p;
  };
};

export interface ResolvedEasing {
  readonly easing: EasingFunction;
  readonly preset: SpriteEasing;
}

/**
 * Resolves an easing definition into its implementation, defaulting to linear when unspecified or unknown.
 */
export const resolveEasing = (easing?: SpriteEasing): ResolvedEasing => {
  const fallback: ResolvedEasing = {
    easing: linearEasing,
    preset: { type: 'linear' },
  };
  if (!easing) {
    return fallback;
  }

  switch (easing.type) {
    case 'linear': {
      const preset: SpriteEasingLinear = { type: 'linear' };
      return { easing: linearEasing, preset };
    }
    case 'ease-in': {
      const power = normalizePower(easing.power, 3);
      const preset: SpriteEasingEaseIn = { type: 'ease-in', power };
      return { easing: createPowerEasing(power, 'in'), preset };
    }
    case 'ease-out': {
      const power = normalizePower(easing.power, 3);
      const preset: SpriteEasingEaseOut = { type: 'ease-out', power };
      return { easing: createPowerEasing(power, 'out'), preset };
    }
    case 'ease-in-out': {
      const power = normalizePower(easing.power, 3);
      const preset: SpriteEasingEaseInOut = { type: 'ease-in-out', power };
      return { easing: createPowerEasing(power, 'in-out'), preset };
    }
    case 'exponential': {
      const exponent = normalizePower(easing.exponent, 5);
      const mode = normalizeMode(easing.mode, 'in-out');
      const preset: SpriteEasingExponential = {
        type: 'exponential',
        exponent,
        mode,
      };
      return { easing: createExponentialEasing(exponent, mode), preset };
    }
    case 'quadratic': {
      const mode = normalizeMode(easing.mode, 'in-out');
      const preset: SpriteEasingQuadratic = { type: 'quadratic', mode };
      return { easing: createPowerEasing(2, mode), preset };
    }
    case 'cubic': {
      const mode = normalizeMode(easing.mode, 'in-out');
      const preset: SpriteEasingCubic = { type: 'cubic', mode };
      return { easing: createPowerEasing(3, mode), preset };
    }
    case 'sine': {
      const mode = normalizeMode(easing.mode, 'in-out');
      const amplitude =
        Number.isFinite(easing.amplitude) && easing.amplitude! > 0
          ? easing.amplitude!
          : 1;
      const preset: SpriteEasingSine = { type: 'sine', mode, amplitude };
      return { easing: createSineEasing(mode, amplitude), preset };
    }
    case 'bounce': {
      const bounces =
        Number.isFinite(easing.bounces) && easing.bounces! > 0
          ? easing.bounces!
          : 3;
      const decay =
        Number.isFinite(easing.decay) && easing.decay! > 0
          ? easing.decay!
          : 0.5;
      const preset: SpriteEasingBounce = {
        type: 'bounce',
        bounces,
        decay,
      };
      return { easing: createBounceEasing(bounces, decay), preset };
    }
    case 'back': {
      const overshoot =
        Number.isFinite(easing.overshoot) && easing.overshoot !== undefined
          ? easing.overshoot
          : 1.70158;
      const preset: SpriteEasingBack = { type: 'back', overshoot };
      return { easing: createBackEasing(overshoot), preset };
    }
    default:
      return fallback;
  }
};
