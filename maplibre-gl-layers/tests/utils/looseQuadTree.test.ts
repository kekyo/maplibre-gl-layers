// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { describe, expect, it } from 'vitest';

import {
  createLooseQuadTree,
  type Item,
  type LooseQuadTree,
  type LooseQuadTreeOptions,
} from '../../src/utils/looseQuadTree';

const bounds = { x0: 0, y0: 0, x1: 100, y1: 100 };

const createTree = (): LooseQuadTree<string> => createTreeWith();

const createTreeWith = (
  overrides?: Partial<LooseQuadTreeOptions>
): LooseQuadTree<string> => {
  const {
    bounds: overrideBounds,
    maxItemsPerNode,
    maxDepth,
    looseness,
  } = overrides ?? {};
  return createLooseQuadTree<string>({
    bounds: overrideBounds ?? bounds,
    maxItemsPerNode: maxItemsPerNode ?? 3,
    maxDepth: maxDepth ?? 5,
    looseness: looseness ?? 1.5,
  });
};

describe('LooseQuadTree basic operations', () => {
  it('adds items and looks them up by overlapping range', () => {
    const tree = createTree();
    const items: Item<string>[] = [
      { x0: 5, y0: 5, x1: 15, y1: 15, state: 'first' },
      { x0: 60, y0: 60, x1: 80, y1: 80, state: 'second' },
      { x0: 10, y0: 40, x1: 30, y1: 70, state: 'third' },
    ];

    for (const item of items) {
      tree.add(item);
    }

    expect(tree.size).toBe(3);

    const all = tree.lookup(0, 0, 100, 100);
    expect(all).toHaveLength(3);
    expect(all).toEqual(expect.arrayContaining(items));

    const partial = tree.lookup(0, 0, 25, 25);
    expect(partial).toEqual(expect.arrayContaining([items[0]]));
    expect(partial).not.toContain(items[1]);

    const nonIntersecting = tree.lookup(85, 85, 95, 95);
    expect(nonIntersecting).toHaveLength(0);
  });

  it('removes matching items and leaves others untouched', () => {
    const tree = createTree();
    const target: Item<string> = {
      x0: 12,
      y0: 12,
      x1: 20,
      y1: 20,
      state: 'target',
    };
    const other: Item<string> = {
      x0: 40,
      y0: 40,
      x1: 50,
      y1: 50,
      state: 'other',
    };
    tree.add(target);
    tree.add(other);

    const missingRemoval = tree.remove(12, 12, 20, 20, other);
    expect(missingRemoval).toBe(false);
    expect(tree.size).toBe(2);

    const deleted = tree.remove(12, 12, 20, 20, target);
    expect(deleted).toBe(true);
    expect(tree.size).toBe(1);
    expect(tree.lookup(0, 0, 100, 100)).toEqual([other]);
  });

  it('treats shared boundaries as intersections (close-close)', () => {
    const tree = createTree();
    const item: Item<string> = {
      x0: 25,
      y0: 25,
      x1: 40,
      y1: 40,
      state: 'boundary',
    };
    tree.add(item);

    const touching = tree.lookup(40, 0, 80, 40);
    expect(touching).toContain(item);

    const pointTouch = tree.lookup(40, 40, 40, 40);
    expect(pointTouch).toContain(item);
  });

  it('clears all stored items', () => {
    const tree = createTree();
    tree.add({ x0: 1, y0: 1, x1: 2, y1: 2, state: 'a' });
    tree.add({ x0: 3, y0: 3, x1: 4, y1: 4, state: 'b' });

    tree.clear();
    expect(tree.size).toBe(0);
    expect(tree.lookup(0, 0, 100, 100)).toHaveLength(0);
  });

  it('rejects insertions outside of initial bounds', () => {
    const tree = createTree();
    expect(() =>
      tree.add({ x0: -10, y0: -10, x1: -5, y1: -5, state: 'out' })
    ).toThrowError(/outside of quadtree bounds/i);
  });

  it('lookups and removes items stored in subdivided children', () => {
    const tree = createTreeWith({ maxItemsPerNode: 1, maxDepth: 6 });
    const items: Item<string>[] = [
      { x0: 0, y0: 0, x1: 10, y1: 10, state: 'nw' },
      { x0: 60, y0: 0, x1: 90, y1: 30, state: 'ne' },
      { x0: 0, y0: 70, x1: 20, y1: 90, state: 'sw' },
      { x0: 60, y0: 60, x1: 90, y1: 90, state: 'se' },
    ];

    for (const item of items) {
      tree.add(item);
    }

    expect(tree.lookup(0, 0, 15, 15)).toEqual([items[0]]);
    expect(tree.lookup(55, -5, 95, 35)).toEqual([items[1]]);

    const target = items[3]!;
    const removed = tree.remove(
      target.x0,
      target.y0,
      target.x1,
      target.y1,
      target
    );
    expect(removed).toBe(true);
    expect(tree.lookup(50, 50, 95, 95)).toHaveLength(0);
    expect(tree.size).toBe(3);
  });

  it('keeps parent-held items accessible when spanning multiple quadrants', () => {
    const tree = createTreeWith({ maxItemsPerNode: 1, looseness: 1.1 });
    const spanning: Item<string> = {
      x0: 40,
      y0: 40,
      x1: 60,
      y1: 60,
      state: 'center',
    };
    const child: Item<string> = {
      x0: 5,
      y0: 5,
      x1: 15,
      y1: 15,
      state: 'child',
    };

    tree.add(spanning);
    tree.add(child);

    expect(tree.lookup(30, 30, 70, 70)).toEqual(
      expect.arrayContaining([spanning])
    );
    expect(
      tree.remove(spanning.x0, spanning.y0, spanning.x1, spanning.y1, spanning)
    ).toBe(true);
    expect(tree.lookup(30, 30, 70, 70)).not.toContain(spanning);
  });

  it('continues operating after removing multiple items', () => {
    const tree = createTreeWith({
      maxItemsPerNode: 2,
      maxDepth: 6,
      looseness: 1.2,
    });
    const cluster: Item<string>[] = [];

    for (let i = 0; i < 6; i += 1) {
      const base = i * 5;
      const item: Item<string> = {
        x0: 10 + base,
        y0: 10 + base,
        x1: 12 + base,
        y1: 12 + base,
        state: `item-${i}`,
      };
      cluster.push(item);
      tree.add(item);
    }

    expect(tree.size).toBe(6);

    for (let i = 0; i < 4; i += 1) {
      const item = cluster[i]!;
      const removed = tree.remove(item.x0, item.y0, item.x1, item.y1, item);
      expect(removed).toBe(true);
    }

    expect(tree.size).toBe(2);
    expect(tree.lookup(0, 0, 100, 100)).toEqual(
      expect.arrayContaining(cluster.slice(4))
    );

    const newItem: Item<string> = { x0: 1, y0: 1, x1: 4, y1: 4, state: 'new' };
    tree.add(newItem);

    expect(tree.size).toBe(3);
    expect(tree.lookup(0, 0, 10, 10)).toEqual([newItem]);
  });

  it('does not remove items when coordinates differ even with same instance', () => {
    const tree = createTree();
    const item: Item<string> = {
      x0: 20,
      y0: 20,
      x1: 30,
      y1: 30,
      state: 'exact',
    };

    tree.add(item);

    expect(tree.remove(0, 0, 10, 10, item)).toBe(false);
    expect(tree.lookup(0, 0, 100, 100)).toEqual([item]);
  });
});

describe('LooseQuadTree update operations', () => {
  it('updates items in place when staying within the same node', () => {
    const tree = createTree();
    const item: Item<string> = { x0: 10, y0: 10, x1: 20, y1: 20, state: 'a' };
    tree.add(item);

    const updated = tree.update(10, 10, 20, 20, 12, 12, 22, 22, item);
    expect(updated).toBe(true);
    expect(tree.lookup(0, 0, 11, 11)).toHaveLength(0);
    expect(tree.lookup(12, 12, 22, 22)).toEqual([item]);
    expect(tree.size).toBe(1);
  });

  it('moves items into child nodes when they now fit deeper', () => {
    const tree = createTreeWith({ maxItemsPerNode: 1, maxDepth: 5 });
    const item: Item<string> = { x0: 5, y0: 5, x1: 45, y1: 45, state: 'wide' };
    tree.add(item);

    const updated = tree.update(5, 5, 45, 45, 5, 5, 15, 15, item);
    expect(updated).toBe(true);
    expect(tree.lookup(4, 4, 16, 16)).toEqual([item]);
  });

  it('reassigns items across quadrants when crossing node boundaries', () => {
    const tree = createTreeWith({ maxItemsPerNode: 1, maxDepth: 5 });
    const item: Item<string> = {
      x0: 10,
      y0: 10,
      x1: 20,
      y1: 20,
      state: 'move',
    };
    tree.add(item);

    const updated = tree.update(10, 10, 20, 20, 70, 70, 80, 80, item);
    expect(updated).toBe(true);
    expect(tree.lookup(0, 0, 30, 30)).toHaveLength(0);
    expect(tree.lookup(60, 60, 90, 90)).toEqual([item]);
  });

  it('expands items to span multiple quadrants and keeps them queryable', () => {
    const tree = createTreeWith({ maxItemsPerNode: 1, looseness: 1.5 });
    const item: Item<string> = {
      x0: 10,
      y0: 10,
      x1: 15,
      y1: 15,
      state: 'grow',
    };
    tree.add(item);

    const updated = tree.update(10, 10, 15, 15, 10, 10, 90, 90, item);
    expect(updated).toBe(true);
    expect(tree.lookup(0, 0, 20, 20)).toContain(item);
    expect(tree.lookup(80, 80, 95, 95)).toContain(item);
  });

  it('throws when updated rectangle leaves tree bounds', () => {
    const tree = createTree();
    const item: Item<string> = { x0: 1, y0: 1, x1: 2, y1: 2, state: 'b' };
    tree.add(item);

    expect(() => tree.update(1, 1, 2, 2, -5, -5, -1, -1, item)).toThrowError(
      /outside of quadtree bounds/i
    );
  });

  it('returns false when updating an unknown item', () => {
    const tree = createTree();
    const ghost: Item<string> = { x0: 0, y0: 0, x1: 1, y1: 1, state: 'ghost' };
    expect(tree.update(0, 0, 1, 1, 2, 2, 3, 3, ghost)).toBe(false);
  });
});
