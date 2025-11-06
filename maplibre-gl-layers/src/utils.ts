// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { ORDER_BUCKET } from './const';
import {
  SPRITE_ORIGIN_REFERENCE_INDEX_NONE,
  SPRITE_ORIGIN_REFERENCE_KEY_NONE,
  type ImageHandleBufferController,
  type ImageHandleBuffers,
  type ImageIdHandler,
  type ImageResourceTable,
  type RegisteredImage,
  type RenderTargetBucketBuffers,
  type RenderTargetEntryLike,
  type SpriteOriginReference,
  type SpriteOriginReferenceKey,
} from './internalTypes';

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

//////////////////////////////////////////////////////////////////////////////////////

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

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Creates typed buffers aligned with the supplied render target bucket for WASM interop.
 * @param bucket Render target bucket containing sprite/image pairs.
 * @param options Optional configuration.
 * @returns {RenderTargetBucketBuffers} Typed array views of origin metadata.
 */
export const createRenderTargetBucketBuffers = <T>(
  bucket: readonly Readonly<RenderTargetEntryLike<T>>[],
  options: {
    readonly originReference?: SpriteOriginReference;
  } = {}
): RenderTargetBucketBuffers => {
  const length = bucket.length;
  const originReferenceKeys = new Int32Array(length);
  const originTargetIndices = new Int32Array(length);

  for (let index = 0; index < length; index++) {
    const entry = bucket[index];
    if (!entry) {
      originReferenceKeys[index] = SPRITE_ORIGIN_REFERENCE_KEY_NONE;
      originTargetIndices[index] = SPRITE_ORIGIN_REFERENCE_INDEX_NONE;
      continue;
    }
    const [, image] = entry;
    let key = image.originReferenceKey;
    if (
      key === undefined ||
      key === null ||
      Number.isNaN(key) ||
      !Number.isFinite(key)
    ) {
      key = SPRITE_ORIGIN_REFERENCE_KEY_NONE;
    }
    if (
      key === SPRITE_ORIGIN_REFERENCE_KEY_NONE &&
      image.originLocation !== undefined &&
      options.originReference
    ) {
      key = options.originReference.encodeKey(
        image.originLocation.subLayer,
        image.originLocation.order
      );
    }
    originReferenceKeys[index] = key;

    let originIndex = image.originRenderTargetIndex;
    if (
      originIndex === undefined ||
      originIndex === null ||
      !Number.isFinite(originIndex)
    ) {
      originIndex = SPRITE_ORIGIN_REFERENCE_INDEX_NONE;
    }
    originTargetIndices[index] = originIndex;
  }

  return {
    originReferenceKeys,
    originTargetIndices,
  };
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Encode/Decode a (subLayer, order) pair into a compact numeric key.
 * @remarks It is used for (wasm) interoperability for image identity.
 */
export const createSpriteOriginReference = (): SpriteOriginReference => {
  /**
   * Encodes a (subLayer, order) pair into a compact numeric key.
   * @param subLayer Sub-layer identifier within the sprite.
   * @param order Order slot inside the sub-layer.
   * @returns Encoded origin reference key.
   */
  const encodeKey = (
    subLayer: number,
    order: number
  ): SpriteOriginReferenceKey => subLayer * ORDER_BUCKET + order;

  /**
   * Decodes an origin reference key back into the sub-layer and order pair.
   * @param key Encoded origin reference key.
   * @returns `subLayer` and `order` components; when the key is invalid,   both values are set to `-1`.
   */
  const decodeKey = (
    key: SpriteOriginReferenceKey
  ): { subLayer: number; order: number } => {
    if (key < 0) {
      return { subLayer: -1, order: -1 };
    }
    const subLayer = Math.trunc(key / ORDER_BUCKET);
    const order = key % ORDER_BUCKET;
    return { subLayer, order };
  };

  return {
    encodeKey,
    decodeKey,
  };
};
