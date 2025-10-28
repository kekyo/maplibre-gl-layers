# maplibre-gl-layers

MapLibre's layer extension library enabling the display, movement, and modification of large numbers of dynamic sprite images

![maplibre-gl-layers](images/maplibre-gl-layers-120.png)

[![Project Status: Concept - Minimal or no implementation has been done yet, or the repository is only intended to be a limited example, demo, or proof-of-concept.](https://www.repostatus.org/badges/latest/concept.svg)](https://www.repostatus.org/#concept)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/maplibre-gl-layers.svg)](https://www.npmjs.com/package/maplibre-gl-layers)

---

[(Japanese language is here/日本語はこちら)](./README_ja.md)

## What is this?

With [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/), you can place markers on a map, decorate their appearance, and move them freely.
Markers often need to move smoothly, appear and disappear over time, and you may have countless coordinates to render.

**maplibre-gl-layers** is designed to meet that need.

Using this package, you can place and adjust large collections of sprites (marker images) through a straightforward API:

![demo 1](images/demo1.png)

Here is a minimal example that adds a single sprite:

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

## Initialization

First create a `SpriteLayer` instance and add it to the MapLibre map.

```typescript
// Use MapLibre GL JS
import { Map } from 'maplibre-gl';
import { createSpriteLayer } from 'maplibre-gl-layers';

// Create the MapLibre map with your desired style and initial view
const map = new Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [136.885202573, 35.170006912],
  zoom: 13,
});

// Create the SpriteLayer instance
const spriteLayer = createSpriteLayer({ id: 'vehicles' });

// Add the layer once the map is ready
map.on('load', async () => {
  map.addLayer(spriteLayer);

  // ...
});
```

That is all you need for the initial setup. After this, prepare the images and text you want to render and start displaying sprites.

## Registering Images and Text

Images must be registered with the SpriteLayer before they can be drawn. You can register or unregister them at any time; when you have many different images, register each one only when it is needed.

```typescript
// Register the specified image file
// with a SpriteLayer for display purposes
const ARROW_IMAGE_ID = 'arrow';
await spriteLayer.registerImage(
  ARROW_IMAGE_ID, // Image ID
  '/assets/arrow.png' // URL
);
```

You can also register arbitrary text. Internally, images and text glyphs are both managed as textures, so text shares the same ID space.

```typescript
// Registers the specified text as a SpriteLayer
const TEXT_LABEL1_ID = 'text-label-1';
await spriteLayer.registerTextGlyph(
  TEXT_LABEL1_ID, // Text ID (Same as image ID)
  'The Station', // The text string
  { maxWidthPixel: 128 }, // Maximum width in pixel
  {
    color: '#ffffff', // Apply text attributes
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingPixel: { top: 6, right: 10, bottom: 6, left: 10 },
  }
);
```

When you register an image, its intrinsic size is used automatically. Text requires explicit sizing information. Dimensions are specified in pixels but are ultimately converted to map scale through the SpriteLayer options. By default, 1 px corresponds to 1 meter.

The figure below compares the rendered sizes of an arrow and a text label, helping you balance them visually:

![Size comparison](images/size1.png)

(Be aware that the actual on-screen size may not exactly match the declared size. Surface and billboard modes, introduced below, can make the results appear different.)

There are two ways to size a text glyph:

- `maxWidthPixel`: The glyph scales to fit within the specified width. When the text contains line breaks, the longest line is used to calculate the font size.
- `lineHeightPixel`: The height of a single line is fixed. When line breaks are present, the total height becomes `lineHeightPixel × number_of_lines`.

In most situations, specifying `maxWidthPixel` is sufficient.

## Sprites and Rendering Modes

A sprite consists of:

- A base coordinate that acts as the origin.
- One or more images, each with its own offset and rendering attributes.

The following illustration shows a single sprite that renders two images. One is a red arrow centered on the sprite coordinate, the other is a text label offset to the left:

![Surface mode arrow 1](images/surface1.png)

The arrow appears slightly flattened because the map is pitched at 45 degrees. The arrow behaves as though it is attached to the map surface. This is called **surface mode**. The text label, however, looks different.

When the pitch increases to 60 degrees, the arrow is flattened even more, yet the text stays perfectly upright, facing the camera:

![Surface mode arrow 2](images/surface2.png)

The label always faces the camera regardless of pitch. This is called **billboard mode**.

Each image can choose its own mode. In the example above the arrow uses surface mode and the label uses billboard mode, but you can pick whatever makes sense for each image. Billboard mode is useful for icons or HUD-style overlays that must remain legible, while surface mode is ideal for elements that should follow the map surface.

The following code places a sprite similar to the example:

```typescript
// Place the sprite
const SPRITE_ID = 'vehicle-1';
spriteLayer.addSprite(SPRITE_ID, {
  // Sprite location (base location point)
  location: { lng: 136.8852, lat: 35.17 },
  // Sprite images
  images: [
    {
      subLayer: 0, // Render farther back
      order: 0,
      imageId: ARROW_IMAGE_ID, // Arrow image ID
    },
    {
      subLayer: 1, // Render in front
      order: 0,
      imageId: TEXT_LABEL1_ID, // Text label ID
    },
  ],
});
```

## Sub-layers and Order

Each image must specify both a sub-layer (`subLayer`) and an order (`order`). If you do not care about draw order, you can simply set both to `0`.

Sub-layers, orders, and camera-facing depth work together as follows:

1. **Sub-layer** - Works like separate MapLibre layers. Images assigned to different sub-layers never overlap with one another; higher sub-layer IDs render in front regardless of camera depth. This is useful for HUD-style overlays such as labels versus markers.
2. **Order** - Within the same sub-layer, higher order values render in front. Use this to stack multiple images at the same location, for example to combine a decorated background and text.
3. **Camera depth** - When both sub-layer and order are equal, camera-facing depth decides which image appears in front. Sprites are still 2D quads, so the result may not always match real-world expectations when many images overlap.

The following image shows an example where multiple arrows and labels overlap:

![Sub-layers](images/sublayer1.png)

Since the arrows and text labels are placed on different sublayers, the text labels are always drawn in front of the arrows, regardless of depth. Furthermore, since arrows and text labels are placed on the same sublayer, their order is determined based on the depth relative to the camera's front:

## Anchors

The `anchor` option controls which point inside the image aligns with the sprite’s base coordinate. Both `anchor.x` and `anchor.y` are normalized between -1 (left or bottom) and 1 (right or top). The default `{ x: 0, y: 0 }` places the image center on the sprite location. Adjusting the anchor lets you fine-tune the placement and the pivot used for rotation. Values should generally be between -1 and 1, but values outside this range may be specified as needed.

The anchor applies in both surface and billboard modes. Other options such as `rotateDeg`, `scale`, `offset`, and `originLocation` are all calculated from the anchor position.

The following example demonstrates how setting an anchor at the arrowhead enables more precise coordinate positioning on the map. For registered images where the arrowhead is drawn pointing upward, this is achieved by specifying the anchor position at the top center:

```typescript
// Place the tip of the arrow on the sprite location
spriteLayer.addSprite('vehicle-anchor', {
  location: { lng: 136.8852, lat: 35.17 },
  images: [
    {
      subLayer: 0,
      order: 0,
      imageId: ARROW_IMAGE_ID, // Arrow (Pointing upward)
      anchor: { x: 0, y: 1 }, // Use the top-center as the anchor
    },
  ],
});
```

## Offset

The `offset` option displaces an image from its anchor. `offset.offsetMeters` specifies the distance in meters, and `offset.offsetDeg` specifies the heading. Surface mode interprets the heading as clockwise degrees from geographic north, while billboard mode uses clockwise degrees from the top of the screen.

Distances are converted to pixels according to the SpriteLayer scaling options, so zooming or pitching the map keeps the relative placement intact. Without an offset, the image renders directly at the anchor.

```typescript
// Place a billboard label 12 meters to the right of the sprite
spriteLayer.addSprite('vehicle-label', {
  location: { lng: 136.8852, lat: 35.17 },
  images: [
    {
      subLayer: 1,
      order: 0,
      imageId: TEXT_LABEL1_ID, // Text ID (Image ID)
      mode: 'billboard',
      offset: { offsetMeters: 12, offsetDeg: 90 }, // Shift right to 12 meter
    },
  ],
});
```

## Image Rotation

`rotateDeg` rotates an image around its anchor. Surface mode interprets angles as clockwise degrees from geographic north; billboard mode uses clockwise degrees from the top of the screen. Because the anchor is used as the pivot, you can rotate objects such as pins around their tips.

The following example sets an anchor at the tip of an upward-pointing arrow image, rotates the image 180 degrees, and makes it a downward-pointing arrow with the arrow tip as the anchor:

```typescript
// Keep the arrow anchored at its tip while rotating it downward
spriteLayer.addSprite('vehicle-rotated', {
  location: { lng: 136.8852, lat: 35.17 },
  images: [
    {
      subLayer: 0,
      order: 0,
      imageId: ARROW_IMAGE_ID, // The image pointing upward
      anchor: { x: 0, y: 1 }, // Anchor at the up-center (arrow tip)
      rotateDeg: 180, // Rotate 180 degrees so the arrow points downward
    },
  ],
});
```

## Image Scale

`scale` multiplies the width and height of the image and also affects `offset.offsetMeters`.

First, the `scale` and zoom factor are multiplied by the original image size. Based on this result, the anchor position and rotation center are determined. Furthermore, the offset distance is also scaled by the `scale`, ensuring the overall relative balance of the sprite is maintained.

The calculation is common to both billboard and surface modes, yielding results similar to changing the actual scale on the map (`metersPerPixel`) for each image. While this appears natural in surface mode, it may differ from the intended sense of scale in billboard mode.

The following are examples of applying scale to each image:

```typescript
// Shrink the marker and label while keeping their relative spacing
spriteLayer.addSprite('vehicle-scaled', {
  location: { lng: 136.8852, lat: 35.17 },
  images: [
    {
      subLayer: 0,
      order: 0,
      imageId: ARROW_IMAGE_ID,
      scale: 0.5,  // Scale to reduce to half size
      anchor: { x: 0, y: -1 },
    },
    {
      subLayer: 1,
      order: 0,
      imageId: TEXT_LABEL1_ID,
      mode: 'billboard',
      scale: 0.5,  // Scale to reduce to half size
      originLocation: { subLayer: 0, order: 0, useResolvedAnchor: true },
      offset: { offsetMeters: 10, offsetDeg: 0 },
    },
  ],
});
```

Note: `rotateDeg` and `offset` are interpreted after applying `scale` to the image's actual size and reflecting anchor-based reference point movement. That is:

1. Scale the image to enlarge or reduce it
2. Determine the reference coordinate point from the anchor position
3. Add the offset distance and direction
4. Rotate the image

Calculations proceed in the above order.

When the anchor is set outside the center, rotation and offset are always applied relative to the anchor. If the position feels unintended, review the combination of anchor, rotation, and offset. Note that in Billboard mode, the offset angle is relative to the screen, while in Surface mode it is relative to geographic coordinates using magnetic north as the reference.

## Auto Heading Rotation

Enable `autoRotation` to rotate images automatically according to their movement.

In Surface Mode, this is set to `true` by default, calculating the reference angle based on the latest movement vector. It can also be enabled in Billboard Mode, where the angle itself is calculated. However, since the camera always faces forward and the upward direction does not align with magnetic north, the rendering may appear counterintuitive.

Specifying the minimum movement distance required for angle calculation with `autoRotationMinDistanceMeters` suppresses noise caused by minor vibrations. Since `rotateDeg` is added to the angle obtained by auto-rotation (it is not overwritten), it can also be used in combination when further correction from the reference direction is desired.

```typescript
// Rotate according to movement, updating only after the sprite moves 5 meters
spriteLayer.addSprite('vehicle-auto', {
  location: { lng: 136.8852, lat: 35.17 },
  images: [
    {
      subLayer: 0,
      order: 0,
      imageId: ARROW_IMAGE_ID,
      mode: 'surface',
      autoRotation: true, // Enabled auto rotation
      autoRotationMinDistanceMeters: 5, // Calculate after moving 5 meters
    },
  ],
});
```

## Sprite Movement Interpolation

SpriteLayer can interpolate sprite positions to produce smooth animations. Consider:

- **Start and end locations** - Interpolation travels between these two points automatically.
- **Duration** - The amount of time spent moving from start to end.
- **Mode** - Either feedback or feed-forward.

By default, when you update a sprite’s location it jumps immediately. Supplying interpolation options animates the movement instead.

```typescript
// Place the sprite by specifying its initial coordinates
const SPRITE_ID = 'vehicle-interpolation';
spriteLayer.addSprite(SPRITE_ID, {
  location: { lng: 136.8852, lat: 35.17 },
  images: [
    { subLayer: 0, order: 0, imageId: ARROW_IMAGE_ID, autoRotation: true },
  ],
});

// Travel to the next point in 800 ms,
// using feed-forward to anticipate heading
spriteLayer.updateSprite(SPRITE_ID, {
  location: { lng: 136.8875, lat: 35.165 },
  interpolation: { durationMs: 800, mode: 'feedforward' },
});
```

How the old and new coordinates are used for interpolation calculations depends on the interpolation method:

- **Feedback**: Moves from the old coordinates to the new coordinates over the specified interpolation time.
- **Feedforward**: Assumes movement from the old coordinates to the new coordinates over the specified interpolation time. Extends this vector by the interpolation time to obtain the predicted movement coordinates. Then moves from the new coordinates to the predicted movement coordinates over the specified interpolation time.

With feedback, even if a new coordinate is set, the animation won't reach that coordinate until it finishes, so there will always be a display delay. On the other hand, using feedforward allows reaching near the predicted movement coordinate, so the supplied coordinate and the displayed coordinate can be expected to match quite closely.

Of course, since this is a predicted coordinate, a disadvantage is that if the movement direction or speed changes significantly during the move, it will continue moving toward an incorrect coordinate. Nevertheless, when a new coordinate is supplied, it will be corrected to move quickly toward that new coordinate, so the coordinate deviation should converge.

## Interpolating Rotation and Offset Angles

Similar to sprite movement interpolation, you can also interpolate image rotation and angle rotation for offset rotation. While these functions are similar, they are distinct from sprite position interpolation.

Use `rotationInterpolation` to smooth changes to `rotateDeg` and/or `offset.offsetDeg`. Each accepts its own `durationMs` and optional easing function. While interpolation is active, the angles update every frame until the specified duration completes; passing `null` disables interpolation.

Below are examples of applying interpolation for the image rotation angle and offset angle respectively:

```typescript
// Smoothly rotate the image to 180 degrees over 400 ms
spriteLayer.updateSpriteImage('vehicle-rotated', 0, 0, {
  rotateDeg: 180, // Rotate toward 180 degrees
  rotationInterpolation: {
    rotateDeg: { durationMs: 400 },
  },
});

// Smoothly change the offset heading over 600 ms
spriteLayer.updateSpriteImage('vehicle-label', 1, 0, {
  offset: {
    offsetMeters: 12,
    offsetDeg: 45 // Rotate toward 180 degrees
  },
  rotationInterpolation: {
    offsetDeg: { durationMs: 600 },
  },
});
```

## Referencing Base Positions and Anchors

By default, each image uses the sprite’s (optionally interpolated) `location` as its base. You can reuse another image’s base by specifying `originLocation`. This lets you treat several images as a single grouped element.

References are resolved recursively. When `useResolvedAnchor` is `true`, the referenced image’s anchor, offset, and rotation are applied before the position is reused. When it is `false` or omitted, the raw position prior to applying the anchor is used.

```typescript
// Keep the label anchored above the arrow, even when the arrow moves or rotates
spriteLayer.addSprite('vehicle-group', {
  location: { lng: 136.8852, lat: 35.17 },
  images: [
    {
      subLayer: 0,
      order: 0,
      imageId: ARROW_IMAGE_ID,
      anchor: { x: 0, y: -1 },
    },
    {
      subLayer: 1,
      order: 0,
      imageId: TEXT_LABEL1_ID,
      mode: 'billboard',
      originLocation: { subLayer: 0, order: 0, useResolvedAnchor: true },
      offset: { offsetMeters: 8, offsetDeg: 0 },
    },
  ],
});
```

Keep in mind:

- The referenced image must belong to the same sprite.
- Circular references or references to missing images produce errors, so design chains carefully.

## Event Handlers

SpriteLayer exposes a `spriteclick` event that fires when a sprite is clicked or tapped. Inside the handler you can call `updateSprite` to trigger movement interpolation based on user interaction.

```typescript
// Called when the sprite is clicked or tapped
spriteLayer.on('spriteclick', ({ sprite }) => {
  const { spriteId } = sprite;
  // Calculating the next coordinates based on the click position
  // and moving them over 500ms
  const nextLocation = {
    lng: sprite.currentLocation.lng + 0.002,
    lat: sprite.currentLocation.lat,
  };
  spriteLayer.updateSprite(spriteId, {
    location: nextLocation,
    interpolation: { durationMs: 500, mode: 'feedback' },
  });
});
```

## Tags

Each sprite can store arbitrary metadata through the `tag` property.

You assign the tag when calling `addSprite` or `updateSprite`, then read it later from `sprite.tag`. Tags do not affect rendering directly; instead they let your application identify vehicle types, ownership, backend IDs, or drive custom behaviors when a sprite is interacted with.

Because the tag type is generic, you can provide an explicit type parameter when creating the SpriteLayer so that your code remains type-safe in TypeScript. Updating a tag does not trigger a redraw unless other visual properties change.

```typescript
// User defined tag type
type VehicleTag = {
  id: string;
  type: 'bus' | 'train' | 'delivery';
};

// Create the SpriteLayer with a strongly typed tag
const spriteLayer = createSpriteLayer<VehicleTag>({ id: 'vehicles' });

// Create the sprite with a tag
spriteLayer.addSprite('vehicle-101', {
  location: { lng: 136.8852, lat: 35.17 },
  tag: { id: 'veh-101', type: 'bus' },  // Tag
  images: [
    { subLayer: 0, order: 0, imageId: ARROW_IMAGE_ID, autoRotation: true },
  ],
});

// Branch behavior based on the tag when the sprite is clicked
spriteLayer.on('spriteclick', ({ sprite }) => {
  if (sprite.tag?.type === 'train') {
    openTrainDetail(sprite.tag.id);
  } else if (sprite.tag) {
    openVehicleSummary(sprite.tag.id);
  }
});
```

To change or remove a tag later, call `updateSprite` with a new `tag` value. Passing `null` (or omitting the property) clears the tag.

## Bulk Update API

When you need to update many sprites at once, SpriteLayer provides two helpers: `updateBulk` and `updateForEach`. Each returns the number of sprites that changed.

- `updateBulk` is best when you already know which sprite IDs should change — for example, applying a batch of positions received from a server.
- `updateForEach` iterates over every registered sprite so you can adjust them based on client-side context. Returning `false` from the callback stops the iteration early.

The following are examples of each:

```typescript
// Apply new positions to multiple sprites in one call
const changed = spriteLayer.updateBulk([
  {
    spriteId: 'vehicle-1',
    location: { lng: 136.886, lat: 35.1695 },
    interpolation: { durationMs: 600, mode: 'feedforward' },
  },
  {
    spriteId: 'vehicle-2',
    location: { lng: 136.883, lat: 35.1712 },
    interpolation: { durationMs: 600, mode: 'feedforward' },
  },
]);
console.log(`Sprites updated: ${changed}`);
```

```typescript
// Dim only sprites tagged as buses by lowering their opacity
const dimmed = spriteLayer.updateForEach((sprite, updater) => {
  if (sprite.tag?.type !== 'bus') {
    return true; // Skip sprites that are not buses
  }

  // Adjust the transparency of images in Sublayer 0/Order 0
  updater.updateImage(0, 0, { opacity: 0.6 });
  return true; // Continue iterating
});
console.log(`Sprites with adjusted opacity: ${dimmed}`);
```

The second argument passed to `updateForEach` is a reusable updater object. Avoid storing it outside the callback; apply the required changes immediately.

To inspect the current image layout, call `updater.getImageIndexMap()` and iterate over the available sub-layer and order combinations.

---

## TODO

- Improves performance, reduces calculation costs
- Improves minor interfaces
- Adds route-oriented layer
- Bug fixes

## License

Under MIT.
