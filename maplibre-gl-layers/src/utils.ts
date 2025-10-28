// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

/**
 * Helper that loads an ImageBitmap from a URL.
 * @param url Target image URL.
 * @returns Promise resolving to the ImageBitmap.
 */
export const loadImageBitmap = async (url: string): Promise<ImageBitmap> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from ${url}`);
  }
  const blob = await response.blob();
  return await createImageBitmap(blob);
};
