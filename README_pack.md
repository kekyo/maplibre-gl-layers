# maplibre-gl-layers

MapLibre's layer extension library enabling the display, movement, and modification of large numbers of dynamic sprite images

![maplibre-gl-layers](images/maplibre-gl-layers-120.png)

[![Project Status: Concept – Minimal or no implementation has been done yet, or the repository is only intended to be a limited example, demo, or proof-of-concept.](https://www.repostatus.org/badges/latest/concept.svg)](https://www.repostatus.org/#concept)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

----

## What is this?

With [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/), you can place markers on a map, decorate their appearance, and move them freely.
Markers often need to move smoothly, appear and disappear over time, and you may have countless coordinates to render.

**maplibre-gl-layers** is designed to meet that need.

Using this package, you can place and adjust large collections of sprites (marker images) through a straightforward API ([This demo page is here](https://kekyo.github.io/maplibre-gl-layers/)):

![demo 1](images/demo1.png)

Here is a minimal example that places a single sprite:

```typescript
// Use MapLibre GL JS together with maplibre-gl-layers
import { Map } from 'maplibre-gl';
import { createSpriteLayer } from 'maplibre-gl-layers';

// Create the MapLibre instance
const map = new Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [136.885202573, 35.170006912],
  zoom: 13,
});

// Create the SpriteLayer
const spriteLayer = createSpriteLayer({ id: 'vehicles' });

// Add the layer after the map finishes loading
map.on('load', async () => {
  map.addLayer(spriteLayer);

  // Register an image that can be referenced by sprites
  const MARKER_IMAGE_ID = 'marker';
  await spriteLayer.registerImage(MARKER_IMAGE_ID, '/assets/marker.png');

  // Place a sprite that uses the registered image
  const SPRITE_ID = 'vehicle-1';
  spriteLayer.addSprite(SPRITE_ID, {
    // Specific location
    location: { lng: 136.8852, lat: 35.17 },
    images: [
      {
        subLayer: 0,
        order: 0,
        imageId: MARKER_IMAGE_ID, // The image ID
      },
    ],
  });

  // ...continue manipulating sprites through the SpriteLayer API
});
```

You can place, update, and remove sprites or the images assigned to them at any time through the API.

In addition to images, you can render text alongside sprites and animate them together. That makes it easy to build the kinds of visualizations typically required for assets, vehicles, or other moving features:

![demo 2](images/demo2.png)

### Main Features

- Place, update, and remove large numbers of sprites.
- Move each sprite's coordinate freely, making it easy to represent moving objects.
- Specify per-sprite anchor positions for precise rendering.
- Add multiple images and text to the same sprite, adjusting rotation, offset, scale, opacity, and more.
- Animate sprite movement, rotation, and offsets with interpolation controls.
- Control draw order via sub-layers and per-sprite ordering.
- Bulk update API for many sprite states.
- No package dependencies except MapLibre.

### Requirements

- MapLibre GL JS 5.9 or higher

---

## Installation

The library is published as an npm package. Install it in your project with:

```bash
npm install maplibre-gl-layers
```

----

## Documentation

[See the repository documentation](http://github.com/kekyo/maplibre-gl-layers/).

## Discussions and Pull Requests

For discussions, please refer to the [GitHub Discussions page](https://github.com/kekyo/maplibre-gl-layers/discussions). We have currently stopped issue-based discussions.

Pull requests are welcome! Please submit them as diffs against the `develop` branch and squashed changes before send.

## License

Under MIT.
