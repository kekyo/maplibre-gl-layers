// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

const DEFAULT_MAX_ITEMS_PER_NODE = 16;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_LOOSENESS = 1.5;

export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface Item<TState> extends Rect {
  readonly state: TState;
}

export interface LooseQuadTreeOptions {
  readonly bounds: Rect;
  readonly maxItemsPerNode?: number;
  readonly maxDepth?: number;
  readonly looseness?: number;
}

export interface LooseQuadTree<TState> {
  readonly size: number;
  readonly add: (item: Item<TState>) => void;
  readonly remove: (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    item: Item<TState>
  ) => boolean;
  readonly lookup: (
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ) => Item<TState>[];
  readonly clear: () => void;
}

interface QuadItem<TState> {
  readonly item: Item<TState>;
  readonly rect: Rect;
}

interface QuadNode<TState> {
  readonly bounds: Rect;
  readonly looseBounds: Rect;
  items: QuadItem<TState>[];
  children: QuadNode<TState>[] | null;
  readonly depth: number;
}

const createNode = <TState>(
  bounds: Rect,
  looseness: number,
  depth: number
): QuadNode<TState> => {
  return {
    bounds,
    looseBounds: expandRect(bounds, looseness),
    items: [],
    children: null,
    depth,
  };
};

const normalizeRect = (rect: Rect): Rect => {
  const x0 = Math.min(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1);
  const x1 = Math.max(rect.x0, rect.x1);
  const y1 = Math.max(rect.y0, rect.y1);
  return { x0, y0, x1, y1 };
};

const isFiniteRect = (rect: Rect): boolean => {
  return (
    Number.isFinite(rect.x0) &&
    Number.isFinite(rect.y0) &&
    Number.isFinite(rect.x1) &&
    Number.isFinite(rect.y1)
  );
};

const expandRect = (rect: Rect, looseness: number): Rect => {
  if (looseness === 1) {
    return rect;
  }

  const width = rect.x1 - rect.x0;
  const height = rect.y1 - rect.y0;
  const halfWidth = (width * looseness) / 2;
  const halfHeight = (height * looseness) / 2;
  const centerX = rect.x0 + width / 2;
  const centerY = rect.y0 + height / 2;

  return {
    x0: centerX - halfWidth,
    y0: centerY - halfHeight,
    x1: centerX + halfWidth,
    y1: centerY + halfHeight,
  };
};

const rectContainsRectInclusive = (container: Rect, target: Rect): boolean => {
  return (
    container.x0 <= target.x0 &&
    container.y0 <= target.y0 &&
    container.x1 >= target.x1 &&
    container.y1 >= target.y1
  );
};

const rectsOverlapInclusive = (a: Rect, b: Rect): boolean => {
  return !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1);
};

const rectEquals = (a: Rect, b: Rect): boolean => {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
};

export const createLooseQuadTree = <TState>(
  options: LooseQuadTreeOptions
): LooseQuadTree<TState> => {
  const maxItemsPerNode = options.maxItemsPerNode ?? DEFAULT_MAX_ITEMS_PER_NODE;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const looseness = options.looseness ?? DEFAULT_LOOSENESS;

  if (maxItemsPerNode <= 0) {
    throw new Error('maxItemsPerNode must be greater than 0.');
  }

  if (maxDepth < 0) {
    throw new Error('maxDepth must be 0 or greater.');
  }

  if (!(looseness >= 1)) {
    throw new Error('looseness must be greater than or equal to 1.');
  }

  const normalizedBounds = normalizeRect(options.bounds);
  if (!isFiniteRect(normalizedBounds)) {
    throw new Error('Bounds must have finite coordinates.');
  }

  let root: QuadNode<TState> = createNode(normalizedBounds, looseness, 0);
  let count = 0;

  const insertIntoNode = (
    node: QuadNode<TState>,
    quadItem: QuadItem<TState>
  ): void => {
    if (node.children) {
      const childIndex = findChildIndex(node.children, quadItem.rect);
      if (childIndex !== -1) {
        const child = node.children[childIndex];
        if (child) {
          insertIntoNode(child, quadItem);
          return;
        }
      }
    }

    node.items.push(quadItem);

    if (node.items.length > maxItemsPerNode && node.depth < maxDepth) {
      if (!node.children) {
        subdivide(node);
      }

      if (!node.children) {
        return;
      }

      let i = 0;
      while (i < node.items.length) {
        const itemToReassign = node.items[i];
        if (!itemToReassign) {
          i += 1;
          continue;
        }
        const childIndex = findChildIndex(node.children, itemToReassign.rect);
        if (childIndex !== -1) {
          const child = node.children[childIndex];
          if (child) {
            node.items.splice(i, 1);
            insertIntoNode(child, itemToReassign);
            continue;
          }
        }
        i += 1;
      }
    }
  };

  const removeFromNode = (
    node: QuadNode<TState>,
    rect: Rect,
    target: Item<TState>
  ): boolean => {
    if (node.children) {
      const childIndex = findChildIndex(node.children, rect);
      if (childIndex !== -1) {
        const child = node.children[childIndex];
        if (child && removeFromNode(child, rect, target)) {
          tryMerge(node);
          return true;
        }
      }
    }

    const index = node.items.findIndex(
      (candidate) =>
        candidate.item === target && rectEquals(candidate.rect, rect)
    );

    if (index !== -1) {
      node.items.splice(index, 1);
      return true;
    }

    return false;
  };

  const collectFromNode = (
    node: QuadNode<TState>,
    rect: Rect,
    results: Item<TState>[]
  ): void => {
    if (!rectsOverlapInclusive(node.looseBounds, rect)) {
      return;
    }

    for (const item of node.items) {
      if (rectsOverlapInclusive(item.rect, rect)) {
        results.push(item.item);
      }
    }

    if (!node.children) {
      return;
    }

    for (const child of node.children) {
      if (child) {
        collectFromNode(child, rect, results);
      }
    }
  };

  const tryMerge = (node: QuadNode<TState>): void => {
    const children = node.children;
    if (!children) {
      return;
    }

    let total = node.items.length;
    for (const child of children) {
      if (child.children) {
        return;
      }
      total += child.items.length;
      if (total > maxItemsPerNode) {
        return;
      }
    }

    for (const child of children) {
      node.items.push(...child.items);
      child.items = [];
    }
    node.children = null;
  };

  const subdivide = (node: QuadNode<TState>): void => {
    if (node.children) {
      return;
    }

    const { bounds } = node;
    const splitX = bounds.x0 + (bounds.x1 - bounds.x0) / 2;
    const splitY = bounds.y0 + (bounds.y1 - bounds.y0) / 2;

    const childrenBounds: Rect[] = [
      normalizeRect({ x0: bounds.x0, y0: bounds.y0, x1: splitX, y1: splitY }),
      normalizeRect({ x0: splitX, y0: bounds.y0, x1: bounds.x1, y1: splitY }),
      normalizeRect({ x0: bounds.x0, y0: splitY, x1: splitX, y1: bounds.y1 }),
      normalizeRect({ x0: splitX, y0: splitY, x1: bounds.x1, y1: bounds.y1 }),
    ];

    node.children = childrenBounds.map((childBounds) =>
      createNode(childBounds, looseness, node.depth + 1)
    );
  };

  const findChildIndex = <T>(children: QuadNode<T>[], rect: Rect): number => {
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child && rectContainsRectInclusive(child.looseBounds, rect)) {
        return index;
      }
    }
    return -1;
  };

  const add = (item: Item<TState>): void => {
    const rect = normalizeRect(item);
    const quadItem: QuadItem<TState> = { item, rect };

    if (!rectContainsRectInclusive(root.bounds, rect)) {
      throw new Error('Item rectangle is outside of quadtree bounds.');
    }

    insertIntoNode(root, quadItem);
    count += 1;
  };

  const remove = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    item: Item<TState>
  ): boolean => {
    const rect = normalizeRect({ x0, y0, x1, y1 });
    if (!rectContainsRectInclusive(root.bounds, rect)) {
      return false;
    }

    const removed = removeFromNode(root, rect, item);
    if (removed) {
      count -= 1;
    }
    return removed;
  };

  const lookup = (
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): Item<TState>[] => {
    const rect = normalizeRect({ x0, y0, x1, y1 });
    const results: Item<TState>[] = [];
    collectFromNode(root, rect, results);
    return results;
  };

  const clear = (): void => {
    root = createNode(normalizedBounds, looseness, 0);
    count = 0;
  };

  return {
    get size(): number {
      return count;
    },
    add,
    remove,
    lookup,
    clear,
  };
};
