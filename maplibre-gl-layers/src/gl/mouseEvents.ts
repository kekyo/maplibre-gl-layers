// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import type { Releasable } from '../internalTypes';
import type {
  SpriteLayerClickEvent,
  SpriteLayerEventListener,
  SpriteLayerEventMap,
  SpriteLayerHoverEvent,
  SpriteScreenPoint,
  SpriteImageState,
  SpriteCurrentState,
} from '../types';
import type { HitTestEntry } from './hitTest';

export interface SpriteMouseEventsController<T> extends Releasable {
  readonly canvasElement: HTMLCanvasElement | undefined;
  readonly addEventListener: <K extends keyof SpriteLayerEventMap<T>>(
    type: K,
    listener: SpriteLayerEventListener<T, K>
  ) => void;
  readonly removeEventListener: <K extends keyof SpriteLayerEventMap<T>>(
    type: K,
    listener: SpriteLayerEventListener<T, K>
  ) => void;
  readonly hasSpriteClickListeners: () => boolean;
  readonly hasSpriteHoverListeners: () => boolean;
  readonly bindCanvas: (canvasElement: HTMLCanvasElement | undefined) => void;
}

export interface SpriteMouseEventsControllerParams<T> {
  readonly resolveHitTestResult: (
    nativeEvent: MouseEvent | PointerEvent | TouchEvent
  ) =>
    | {
        hitEntry: HitTestEntry<T> | undefined;
        screenPoint: SpriteScreenPoint;
      }
    | undefined;
  readonly resolveSpriteEventPayload: (
    hitEntry: HitTestEntry<T> | undefined
  ) => {
    sprite: SpriteCurrentState<T> | undefined;
    image: SpriteImageState | undefined;
  };
  readonly updateVisibilityState: () => void;
}

/**
 * Consolidates mouse/touch DOM hooks and SpriteLayer event listener bookkeeping.
 */
export const createSpriteMouseEventsController = <T>({
  resolveHitTestResult,
  resolveSpriteEventPayload,
  updateVisibilityState,
}: SpriteMouseEventsControllerParams<T>): SpriteMouseEventsController<T> => {
  type SpriteEventKey = keyof SpriteLayerEventMap<T>;
  type GenericSpriteListener = SpriteLayerEventListener<T, SpriteEventKey>;

  const eventListeners = new Map<SpriteEventKey, Set<GenericSpriteListener>>();
  const inputListenerDisposers: Array<() => void> = [];
  let boundCanvasElement: HTMLCanvasElement | undefined;

  const registerDisposer = (disposer: () => void) => {
    inputListenerDisposers.push(disposer);
  };

  const clearDomListeners = (): void => {
    inputListenerDisposers.forEach((dispose) => dispose());
    inputListenerDisposers.length = 0;
  };

  const getListenerSet = (type: SpriteEventKey): Set<GenericSpriteListener> => {
    let set = eventListeners.get(type);
    if (!set) {
      set = new Set();
      eventListeners.set(type, set);
    }
    return set;
  };

  const addEventListener = <K extends SpriteEventKey>(
    type: K,
    listener: SpriteLayerEventListener<T, K>
  ): void => {
    getListenerSet(type).add(listener as GenericSpriteListener);
  };

  const removeEventListener = <K extends SpriteEventKey>(
    type: K,
    listener: SpriteLayerEventListener<T, K>
  ): void => {
    const listeners = eventListeners.get(type);
    if (!listeners) {
      return;
    }
    listeners.delete(listener as GenericSpriteListener);
    if (listeners.size === 0) {
      eventListeners.delete(type);
    }
  };

  const hasSpriteListeners = (type: SpriteEventKey): boolean =>
    (eventListeners.get(type)?.size ?? 0) > 0;

  const hasSpriteClickListeners = (): boolean =>
    hasSpriteListeners('spriteclick');

  const hasSpriteHoverListeners = (): boolean =>
    hasSpriteListeners('spritehover');

  const dispatchSpriteClick = (
    hitEntry: HitTestEntry<T>,
    screenPoint: SpriteScreenPoint,
    originalEvent: MouseEvent | PointerEvent | TouchEvent
  ): void => {
    const listeners = eventListeners.get('spriteclick');
    if (!listeners || listeners.size === 0) {
      return;
    }

    const payload = resolveSpriteEventPayload(hitEntry);
    const clickEvent: SpriteLayerClickEvent<T> = {
      type: 'spriteclick',
      sprite: payload.sprite,
      image: payload.image,
      screenPoint,
      originalEvent,
    };

    listeners.forEach((listener) => {
      (listener as SpriteLayerEventListener<T, 'spriteclick'>)(clickEvent);
    });
  };

  const dispatchSpriteHover = (
    hitEntry: HitTestEntry<T> | undefined,
    screenPoint: SpriteScreenPoint,
    originalEvent: MouseEvent | PointerEvent
  ): void => {
    const listeners = eventListeners.get('spritehover');
    if (!listeners || listeners.size === 0) {
      return;
    }

    const payload = resolveSpriteEventPayload(hitEntry);
    const hoverEvent: SpriteLayerHoverEvent<T> = {
      type: 'spritehover',
      sprite: payload.sprite,
      image: payload.image,
      screenPoint,
      originalEvent,
    };

    listeners.forEach((listener) => {
      (listener as SpriteLayerEventListener<T, 'spritehover'>)(hoverEvent);
    });
  };

  const processClickEvent = (
    nativeEvent: MouseEvent | PointerEvent | TouchEvent
  ): void => {
    if (!hasSpriteClickListeners()) {
      return;
    }

    const hitResult = resolveHitTestResult(nativeEvent);
    if (!hitResult || !hitResult.hitEntry) {
      return;
    }

    dispatchSpriteClick(hitResult.hitEntry, hitResult.screenPoint, nativeEvent);
  };

  const processHoverEvent = (nativeEvent: MouseEvent | PointerEvent): void => {
    if (!hasSpriteHoverListeners()) {
      return;
    }

    const hitResult = resolveHitTestResult(nativeEvent);
    if (!hitResult) {
      return;
    }

    dispatchSpriteHover(hitResult.hitEntry, hitResult.screenPoint, nativeEvent);
  };

  const bindCanvas = (canvasElement: HTMLCanvasElement | undefined): void => {
    clearDomListeners();
    boundCanvasElement = canvasElement;

    const supportsPointerEvents =
      typeof window !== 'undefined' && 'PointerEvent' in window;

    if (canvasElement) {
      if (supportsPointerEvents) {
        const pointerUpListener = (event: PointerEvent) => {
          if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
          }
          processClickEvent(event);
        };
        canvasElement.addEventListener('pointerup', pointerUpListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement.removeEventListener('pointerup', pointerUpListener);
        });

        const pointerMoveListener = (event: PointerEvent) => {
          if (!event.isPrimary) {
            return;
          }
          if (event.pointerType === 'touch') {
            return;
          }
          processHoverEvent(event);
        };
        canvasElement.addEventListener('pointermove', pointerMoveListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement.removeEventListener('pointermove', pointerMoveListener);
        });
      } else {
        const clickListener = (event: MouseEvent) => {
          if (event.button !== 0) {
            return;
          }
          processClickEvent(event);
        };
        canvasElement.addEventListener('click', clickListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement.removeEventListener('click', clickListener);
        });

        const touchListener = (event: TouchEvent) => {
          processClickEvent(event);
        };
        canvasElement.addEventListener('touchend', touchListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement.removeEventListener('touchend', touchListener);
        });

        const mouseMoveListener = (event: MouseEvent) => {
          processHoverEvent(event);
        };
        canvasElement.addEventListener('mousemove', mouseMoveListener, {
          passive: true,
        });
        registerDisposer(() => {
          canvasElement.removeEventListener('mousemove', mouseMoveListener);
        });
      }

      const visibilityTarget =
        canvasElement.ownerDocument ??
        (typeof document !== 'undefined' ? document : undefined);
      if (visibilityTarget) {
        const visibilityListener = () => updateVisibilityState();
        visibilityTarget.addEventListener(
          'visibilitychange',
          visibilityListener
        );
        registerDisposer(() => {
          visibilityTarget.removeEventListener(
            'visibilitychange',
            visibilityListener
          );
        });
        updateVisibilityState();
      }
    }
  };

  return {
    get canvasElement() {
      return boundCanvasElement;
    },
    addEventListener,
    removeEventListener,
    hasSpriteClickListeners,
    hasSpriteHoverListeners,
    bindCanvas,
    release: () => {
      clearDomListeners();
      eventListeners.forEach((set) => set.clear());
      eventListeners.clear();
      boundCanvasElement = undefined;
    },
  };
};
