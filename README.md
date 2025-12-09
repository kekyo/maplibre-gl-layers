# maplibre-gl-layers

MapLibre's layer extension library enabling the display, movement, and modification of large numbers of dynamic sprite images

![maplibre-gl-layers](images/maplibre-gl-layers-120.png)

[![Project Status: Active – The project has reached a stable, usable state and is being actively developed.](https://www.repostatus.org/badges/latest/active.svg)](https://www.repostatus.org/#active)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/maplibre-gl-layers.svg)](https://www.npmjs.com/package/maplibre-gl-layers)

---

[(Japanese language is here/日本語はこちら)](./README_ja.md)

## What is this?

With [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/), you can place markers on a map, decorate their appearance, and move them freely.
Markers often need to move smoothly, appear and disappear over time, and you may have countless coordinates to render.

**maplibre-gl-layers** is designed to meet that need.

Using this package, you can place and adjust large collections of sprites (marker images) through a straightforward API ([This demo page is here](https://kekyo.github.io/maplibre-gl-layers/)):

![demo 1](images/demo1.png)

Here is a minimal example that adds a single sprite:

```typescript
// Use MapLibre GL JS together with maplibre-gl-layers
import { Map } from 'maplibre-gl';
import {
  createSpriteLayer,
  initializeRuntimeHost,
} from 'maplibre-gl-layers';

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
  // Initialize and add SpriteLayer to MapLibre
  await initializeRuntimeHost();
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
- Fully imperative APIs. Updates with high-performance and extensible.
- Accelerating computational processing with WASM and shaders.

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
import {
  createSpriteLayer,
  initializeRuntimeHost,
} from 'maplibre-gl-layers';

// Create the MapLibre map with your desired style and initial view
const map = new Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [136.885202573, 35.170006912],
  zoom: 13,
});

// Create the SpriteLayer instance
const spriteLayer = createSpriteLayer({ id: 'vehicles' });

// When MapLibre is ready
map.on('load', async () => {
  // Initialize SpriteLayer
  await initializeRuntimeHost();

  // Add the layer once
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

The anchor applies in both surface and billboard modes. Other options such as `rotateDeg`, `scale`, `offsetMeters`/`offsetDeg`, and `originLocation` are all calculated from the anchor position.

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

Use `offsetMeters` and `offsetDeg` to displace an image from its anchor. `offsetMeters` specifies the distance in meters, and `offsetDeg` specifies the heading. Surface mode interprets the heading as clockwise degrees from geographic north, while billboard mode uses clockwise degrees from the top of the screen.

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
      offsetMeters: 12, // Shift right to 12 meters
      offsetDeg: 90,
    },
  ],
});
```

## Image Rotation

`rotateDeg` rotates an image around its anchor. Surface mode interprets angles as clockwise degrees from geographic north; billboard mode uses clockwise degrees from the top of the screen. Because the anchor is used as the pivot, you can rotate objects such as pins around their tips.

The following example sets an anchor at the tip of an upward-pointing arrow image, rotates the image 180 degrees, and makes it a downward-pointing arrow with the arrow tip as the anchor:

![Anchor-rotate](./images/anchor-rotate.png)

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

`scale` multiplies the width and height of the image and also affects `offsetMeters`.

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
      offsetMeters: 10,
      offsetDeg: 0,
    },
  ],
});
```

Note: `rotateDeg`, `offsetMeters`, and `offsetDeg` are interpreted after applying `scale` to the image's actual size and reflecting anchor-based reference point movement. That is:

1. Scale the image to enlarge or reduce it
2. Determine the reference coordinate point from the anchor position
3. Add the offset distance and direction
4. Rotate the image

Calculations proceed in the above order.

When the anchor is set outside the center, rotation and offsets are always applied relative to the anchor. If the position feels unintended, review the combination of anchor, rotation, and offsets. Note that in Billboard mode, the offset angle is relative to the screen, while in Surface mode it is relative to geographic coordinates using magnetic north as the reference.

## Opacity

Each image can have an `opacity` value specified, which is multiplied by the alpha channel within the range 0.0 to 1.0.
A value of 1.0 represents the texture's inherent opacity, while 0.0 makes it completely invisible.

Setting it below 0 excludes the image from the rendering queue. This allows you to set the `opacity` of unnecessary images to 0 when layering multiple images, reducing calculation cost.

The following example makes only the label semi-transparent:

```typescript
spriteLayer.addSprite('vehicle-opacity', {
  location: { lng: 136.8852, lat: 35.17 },
  images: [
    { subLayer: 0, order: 0, imageId: ARROW_IMAGE_ID },
    {
      subLayer: 1,
      order: 0,
      imageId: TEXT_LABEL1_ID,
      mode: 'billboard',
      opacity: 0.6, // Make only the text semi-transparent
    },
  ],
});
```

## Pseudo LOD

Pseudo LOD lets you toggle sprite visibility based on the camera distance to the sprite’s anchor point.

Set `visibilityDistanceMeters` member to the desired threshold and every image attached to that sprite disappears when the camera is farther away.
If you omit the property, pseudo LOD is disabled.

An example of using pseudo LOD:

```typescript
// Render the sprite only when the camera is within roughly 1.5 km
spriteLayer.addSprite('vehicle-lod', {
  location: { lng: 136.8852, lat: 35.17 },
  visibilityDistanceMeters: 1500, // Hide automatically farther away
  images: [
    {
      subLayer: 0,
      order: 0,
      imageId: ARROW_IMAGE_ID,
      autoRotation: true,
    },
  ],
});

// Adjust at runtime with updateSprite
spriteLayer.updateSprite('vehicle-lod', {
  visibilityDistanceMeters: null, // null disables pseudo LOD
});
```

## Opacity and Show-up Control

The final opacity used for drawing is determined by multiplying the following three elements:

1. The `opacity` value for each sprite image
2. The opacity value from pseudo-LOD
3. The `opacityMultiplier` value for each sprite

The value obtained by multiplying the above is referred to as `finalOpacity`, and this value is used for rendering.
Therefore, use `opacityMultiplier` if you want to apply a uniform opacity to all images of a sprite.

```typescript
// Make all sprite images semi-transparent
spriteLayer.addSprite('vehicle-half', {
  location: { lng: 136.8852, lat: 35.17 },
  opacityMultiplier: 0.5,  // Semi-transparent
  images: [
    // ...
  ],
});
```

On the demo page, you can test switching between elements 1 and 3 using the `Wave` and `Wave All` buttons.

Additionally, `isEnabled` is another way to toggle the visibility of sprites.
This switches the sprite's rendering pipeline on or off.
Therefore, setting `isEnabled` to `false` and having `finalOpacity` comes to 0.0 are not strictly equivalent.

```typescript
// Disable the sprite
spriteLayer.addSprite('vehicle-half', {
  location: { lng: 136.8852, lat: 35.17 },
  isEnabled: false,  // Disabled
  images: [
    // ...
  ],
});
```

Setting `isEnabled` to `false` will cause most calculations for that sprite to be skipped, allowing you to use it to improve performance.
However, if you change `isEnabled` to `false` to make the sprite invisible, no interpolation processing will be applied until the sprite disappears; the sprite will suddenly become invisible.

Note: When `finalOpacity` is set to 0.0, coordinate calculations cannot be skipped, but rendering requests to WebGL are omitted, which slightly improves performance.

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

SpriteLayer can interpolate sprite locations to produce smooth animations. Consider:

- **Start and end locations** - Interpolation travels between these two locations automatically.
- **Duration** - The amount of time spent moving from start to end.
- **Mode** - Either feedback or feedforward.
- **Curve** - Specified as an easing function type (described later).

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

  ![Feedback](./images/feedback.png)
- **Feedforward**: Assumes movement from the old coordinates to the new coordinates over the specified interpolation time. Extends this vector by the interpolation time to obtain the predicted movement coordinates. Then moves from the new coordinates to the predicted movement coordinates over the specified interpolation time.

  ![Feedforward](./images/feedforward.png)

With feedback, even if a new coordinate is set, the animation won't reach that coordinate until it finishes, so there will always be a display delay. On the other hand, using feedforward allows reaching near the predicted movement coordinate, so the supplied coordinate and the displayed coordinate can be expected to match quite closely.

Of course, since this is a predicted coordinate, a disadvantage is that if the movement direction or speed changes significantly during the move, it will continue moving toward an incorrect coordinate. Nevertheless, when a new coordinate is supplied, it will be corrected to move quickly toward that new coordinate, so the coordinate deviation should converge.

## Interpolation of Image Rotation Angle, Offset, and Opacity

Similar to sprite movement interpolation, you can smoothly change the rotation, offset, and opacity for each image.
These are independent of sprite movement interpolation.

Each interpolation parameter is specified in the sprite image's `interpolation` member:

- `finalRotateDeg`: The final rotation angle of the image.
  This is the sum of the `rotateDeg` value and the angle from automatic heading rotation.
  Interpolated using the shortest angle path.
- `offsetDeg`: The direction of the offset. Interpolated using the shortest angle path.
- `offsetMeters`: The distance of the offset.
- `finalOpacity`: The final opacity of the image.
  This is the value obtained by multiplying the `opacity` value, the pseudo-LOD calculation result, and the `opacityMultiplier` value for the sprite.
  It is clipped to the range 0.0 to 1.0.

Each interpolation parameter is given an interpolation duration `durationMs`, an interpolation mode (`feedback`/`feedforward`), and an optional easing function type (described later).

Interpolation modes are explained in the same way as sprite movement interpolation.

Setting the `interpolation` member itself to `null` stops all interpolation processing.
Setting any individual interpolation parameter to `null` immediately stops only that specific interpolation process.

Below is an example applying interpolation to rotation, offset, and opacity:

```typescript
// Smoothly rotate the image to 180 degrees over 400 ms
spriteLayer.updateSpriteImage('vehicle-rotated', 0, 0, {
  rotateDeg: 180, // Rotate toward 180 degrees
  interpolation: {
    finalRotateDeg: { durationMs: 400, },
  },
});

// Smoothly change the offset heading over 600 ms
spriteLayer.updateSpriteImage('vehicle-label', 1, 0, {
  offsetDeg: 45, // Rotate toward 45 degrees
  offsetMeters: 12,
  interpolation: {
    offsetDeg: { durationMs: 600, mode: 'feedforward', },
    offsetMeters: { durationMs: 600, },
  },
});

// To stop interpolation, set the relevant parameter to `null`
spriteLayer.updateSpriteImage('vehicle-label', 1, 0, {
  interpolation: {
    offsetDeg: null,  // Stop offset rotation interpolation
  },
});

// Fade out the opacity over 800 milliseconds.
spriteLayer.updateSpriteImage('vehicle-anchor', 1, 0, {
  opacity: 0,
  interpolation: {
    finalOpacity: { durationMs: 800, },
  },
});
```

## Easing Functions

Each interpolation specification can also specify an easing function for the interpolation curve.
If no easing function is specified, `linear` is used. The available easing functions and their parameters are as follows:

Available easing presets are:

| Easing preset | Behavior | Adjustable parameters |
|:---|:---|:---|
| `linear` | Constant-speed interpolation. | (none) |
| `ease` | General power ease for a gentle start/end. | `power` (3), `mode` (`in`\|`out`\|`in-out`, default: `in-out`) |
| `exponential` | Exponential curve that accelerates/decelerates sharply. | `exponent` (5), `mode` (`in`\|`out`\|`in-out`, default: `in-out`) |
| `quadratic` | Quadratic variant of the ease curve. | `mode` (`in`\|`out`\|`in-out`, default: `in-out`) |
| `cubic` | Cubic variant of the ease curve. | `mode` (`in`\|`out`\|`in-out`, default: `in-out`) |
| `sine` | Sinusoidal oscillation. | `mode` (`in`\|`out`\|`in-out`, default: `in-out`), `amplitude` (1, > 0) |
| `bounce` | Bouncy curve that rebounds before settling. | `bounces` (3, > 0), `decay` (0.5, (0, 1]) |
| `back` | Overshoots the target and returns. | `overshoot` (1.70158) |

For example:

```typescript
// Example of specifying easing for interpolation
spriteLayer.updateSpriteImage('vehicle-easing', 0, 0, {
  // While rotating up to 90 degrees
  rotateDeg: 90,
  // Nearly transparent
  opacity: 0.2,
  interpolation: {
    finalRotateDeg: {
      durationMs: 600,
      // Suddenly slowing down toward the end
      easing: { type: 'bounce', bounces: 4, decay: 0.6 },
    },
    finalOpacity: {
      durationMs: 400,
      mode: 'feedforward',
      // Fade out gradually
      easing: { type: 'ease', power: 2, mode: 'out' },
    },
  },
});
```

## Controlling Overall Interpolation Calculation

To pause interpolation for the entire sprite attributes, call `setInterpolationCalculation(false)`.
The pause takes effect immediately, halting all ongoing interpolation behavior.
Setting it back to `true` smoothly resumes the paused interpolation from its current position.

The initial state is `true`, and interpolation is continuously calculated.

Here's an example:

```typescript
// Pause interpolation
spriteLayer.setInterpolationCalculation(false);

// (Your another tasks...)

// Resuming interpolation smoothly continues the paused
spriteLayer.setInterpolationCalculation(true);
```

Note: If you update the sprite or sprite image while paused, the internal interpolation state will be reset:

```typescript
// Pause interpolation
spriteLayer.setInterpolationCalculation(false);

// Modify sprites or images
spriteLayer.updateSprite('car-1', {
  location: { lng: 136.8853, lat: 35.1702 },  // Immediately applied
  interpolation: { durationMs: 1000 },
});
spriteLayer.updateSpriteImage('car-1', 0, 0, {
  rotateDeg: 45,  // Immediately applied
  offsetMeters: 12,  // Immediately applied
  offsetDeg: 30,  // Immediately applied
  interpolation: {
    finalRotateDeg: { durationMs: 800 },
    offsetDeg: { durationMs: 500 },
  },
});

// When interpolation resumes, it will start from the above settings
// (the previous interpolation state is reset).
spriteLayer.setInterpolationCalculation(true);
```

### Interpolation Processing When MapLibre is Hidden

When MapLibre becomes hidden (more precisely, when the page containing it becomes hidden), interpolation processing is interrupted and stopped.Additionally, any values currently being interpolated at the time of stopping are reflected as the current values.

Subsequently, when MapLibre becomes visible again, interpolation processing remains stopped, so the sprites are frozen in place.
When new coordinates or values are set via update APIs, they are updated immediately without interpolation, and interpolation resumes with the next update.

This prevents extreme drawing updates upon reappearance (e.g., coordinates moving far away or moving at high speed) caused by the subsequent interpolation processing.

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
      offsetMeters: 30,  // Keep 30 meters away from the arrow
      offsetDeg: 0,  // Position upward along the arrow
    },
  ],
});
```

Keep in mind:

- The referenced image must belong to the same sprite.
- Circular references or references to missing images produce errors, so design chains carefully.

## Borders

Each sprite image can draw its own border.
This helps emphasize an icon or show selection state without changing the texture itself.
Additionally, the event handler described later indicates the area used as the criteria for determining the sprite image.

![borders](./images/borders1.png)

Example:

```typescript
// Add a 2m red border to the arrow
spriteLayer.addSprite('bordered-marker', {
  location: { lng: 136.8852, lat: 35.17 },
  images: [
    {
      subLayer: 0,
      order: 0,
      imageId: ARROW_IMAGE_ID,
      border: { color: '#ff0000', widthMeters: 2 },
    },
  ],
});

// Remove a border later (null clears it)
spriteLayer.updateSpriteImage(
  'bordered-marker', 0, 0, { border: null });
```

Note: Borders are always drawn in front of all sprites.
This means it is equivalent to always placing the sublayer at the topmost position.

### Leader lines

Set the optional `leaderLine` on an image to draw a connecting line between the image’s own anchor position and the anchor position of the image specified by `originLocation`.
The line uses your specified CSS `color` and `widthMeters`, and the effective opacity follows the image’s (post-interpolation) `opacity`.

![leader-line1](./images/leader-line1.png)

In the following example, a pull-out line is drawn between two images:

```typescript
spriteLayer.addSprite('vehicle-group', {
  location: { lng: 136.8852, lat: 35.17 },
  images: [
    // Primary image
    {
      subLayer: 0,
      order: 0,
      imageId: ARROW_IMAGE_ID,
    },
    // Secondary image (text)
    {
      subLayer: 1,
      order: 0,
      imageId: TEXT_LABEL1_ID,
      // Refer to primary image
      originLocation: { subLayer: 0, order: 0, useResolvedAnchor: true },
      // Draw leader line
      leaderLine: { color: '#00aa00', widthMeters: 2 },
    },
  ],
});
```

Note: Leader lines are always drawn behind all sprites.
This means it is equivalent to always placing the sublayer at the lowest position.

## Event Handlers

SpriteLayer exposes interaction events so your application can react to clicks and hovers:

- `spriteclick` fires when the user clicks or taps on an image.
- `spritehover` fires whenever the pointer moves over an image.

If either event fails to detect the target image, it will notify with `sprite`/`image` set to `undefined`.

These event detections can be enabled using `setHitTestDetection()`:

```typescript
// Enable hit test detection
spriteLayer.setHitTestDetection(true);
```

Inside either handler you can call `updateSprite` or other APIs to react to user interaction.

```typescript
// When a MapLibre map is clicked or tapped
spriteLayer.on('spriteclick', ({ sprite }) => {
  // A sprite image is present at the clicked position
  if (sprite) {
    const { spriteId } = sprite;
    // Calculating the next coordinates based on the click position
    // and moving them over 500ms
    const nextLocation = {
      lng: sprite.location.current.lng + 0.002,
      lat: sprite.location.current.lat,
    };
    spriteLayer.updateSprite(spriteId, {
      location: nextLocation,
      interpolation: { durationMs: 500, mode: 'feedback' },
    });
  }
});
```

When inspecting `sprite.images` you can use `image.finalRotateDeg.current` (and optional `from`/`to`) to see the manual rotation interpolation state, mirroring how `sprite.location` behaves.

You can also surface hover highlights or tooltips:

```typescript
// When hovering over the MapLibre map
spriteLayer.on('spritehover', ({ sprite, image }) => {
  // Sprite image not detected
  if (!sprite || !image) {
    hideTooltip();
    return;
  }
  // Display sprite and image information
  showTooltip({
    spriteId: sprite.spriteId,
    imageId: image.imageId,
    mode: image.mode,
  });
});
```

Note: Enabling hit testing incurs additional overhead for coordinate detection.
This may impact performance, especially when handling large numbers of sprites.

## Sprite Tracking

Use `trackSprite()` to keep the map centered on a sprite every animation frame.
When `trackRotation` is `true` (default), the map bearing follows the sprite’s current `finalRotateDeg`, making it easy to keep vehicles or markers aligned to the screen.

If the sprite ID cannot be found, tracking is canceled automatically.

```typescript
// Center the map and align it with the sprite's rotation
spriteLayer.trackSprite('vehicle-101');

// Center only (do not rotate the map)
spriteLayer.trackSprite('vehicle-101', false);

// Stop tracking entirely
spriteLayer.untrackSprite();
```

Call `untrackSprite()` when you want to hand camera control back to the user or after the sprite is removed.

## Tags

Each sprite can store arbitrary metadata through the `tag` property.

You assign the tag when calling `addSprite()` or `updateSprite()`, then read it later from `sprite.tag`. Tags do not affect rendering directly; instead they let your application identify vehicle types, ownership, backend IDs, or drive custom behaviors when a sprite is interacted with.

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

To change or remove a tag later, call `updateSprite()` with a new `tag` value.
Passing `null` (or omitting the property) clears the tag.

## Bulk Sprite Management

To efficiently place or remove large numbers of sprites at once, use bulk functions like `addSprites()` or `removeSprites()`.

- `addSprites()` accepts either a record (`Record<string, SpriteInit<TTag>>`) or an array of [`SpriteInitEntry<TTag>`](./maplibre-gl-layers/src/types.ts) objects. The latter simply extends `SpriteInit` with a `spriteId` field for convenience. The method returns how many sprites were inserted.
- `removeSprites()` removes multiple sprites by ID and returns the number of entries that were present.
- `removeAllSprites()` clears every sprite and reports how many were removed.
- `removeAllSpriteImages(spriteId)` removes every image assignment from the specified sprite while leaving the sprite shell intact, returning the number of images that were removed.

Examples:

```typescript
// Array form using SpriteInitEntry
const vehicles: SpriteInitEntry<VehicleTag>[] = [
  {
    spriteId: 'vehicle-201',
    location: { lng: 136.881, lat: 35.169 },
    images: [{ subLayer: 0, order: 0, imageId: ARROW_IMAGE_ID }],
    tag: { id: 'veh-201', type: 'bus' },
  },
  {
    spriteId: 'vehicle-202',
    location: { lng: 136.883, lat: 35.172 },
    images: [{ subLayer: 0, order: 0, imageId: ARROW_IMAGE_ID }],
    tag: { id: 'veh-202', type: 'delivery' },
  },
];

// Bulk place helpers
const added = spriteLayer.addSprites(vehicles);
console.log(`Sprites added: ${added}`);

// Record form
const moreVehicles = {
  'vehicle-301': {
    location: { lng: 136.89, lat: 35.173 },
    images: [{ subLayer: 0, order: 0, imageId: ARROW_IMAGE_ID }],
  },
  'vehicle-302': {
    location: { lng: 136.887, lat: 35.168 },
    images: [{ subLayer: 0, order: 0, imageId: ARROW_IMAGE_ID }],
  },
} satisfies Record<string, SpriteInit<VehicleTag>>;
spriteLayer.addSprites(moreVehicles);

// Bulk removal helpers
const removed = spriteLayer.removeSprites(['vehicle-201', 'vehicle-302']);
console.log(`Sprites removed: ${removed}`);

spriteLayer.removeAllSpriteImages('vehicle-202'); // Removes all images from a single sprite
spriteLayer.removeAllSprites(); // Removes every sprite
```

To efficiently update multiple sprites at once, use `mutateSprites()` and `updateForEach()`. Both return the number of sprites that were modified.

- `mutateSprites()` synchronises a known set of sprite IDs in one pass. It works well when you have a batch of server-side updates or a diff-like structure.
- `updateForEach()` iterates over every registered sprite so you can adjust them based on client-side context. Returning `false` from the callback stops the iteration early.

The snippet below demonstrates `mutateSprites()` in conjunction with server data that may create, update, or remove sprites:

```typescript
import type { SpriteLocation, SpriteMutateSourceItem } from 'maplibre-gl-layers';

// Differential data structure
interface VehicleUpdate extends SpriteMutateSourceItem {
  spriteId: string;  // Need spriteId field
  location: SpriteLocation;
  tag?: VehicleTag | null;
  remove?: boolean;
};

// Receives differential data
const serverUpdates: VehicleUpdate[] = await fetchVehicleUpdates();

// Bulk mutation
const changed = spriteLayer.mutateSprites(serverUpdates, {
  // For adding (when does not exist the sprite id)
  add: (update) => ({
    location: update.location,
    images: [{ subLayer: 0, order: 0, imageId: ARROW_IMAGE_ID }],
    tag: update.tag ?? null,
  }),
  // For modifying
  modify: (update, sprite, updater) => {
    // Remove when raised a flag
    if (update.remove) {
      return 'remove';
    }

    // Updates attributes
    updater.location = update.location;
    updater.interpolation = { durationMs: 600, mode: 'feedforward' };
    updater.tag = update.tag ?? null;
    return 'notremove';
  },
});

console.log(`Sprites changed: ${changed}`);
```

If you only need to mutate existing sprites based on local state, keep using `updateForEach()`:

```typescript
// Dim only sprites tagged as buses by lowering their opacity
const dimmed = spriteLayer.updateForEach((sprite, updater) => {
  if (sprite.tag?.type !== 'bus') {
    return true; // Skip sprites that are not buses
  }

  // Adjust the transparency of images in sub-layer 0/order 0
  updater.updateImage(0, 0, { opacity: 0.6 });
  return true; // Continue iterating
});

console.log(`Sprites with adjusted opacity: ${dimmed}`);
```

The updater passed to `updateForEach()` is reusable. Avoid storing it outside the callback; apply changes immediately. To inspect the current image layout, call `updater.getImageIndexMap()` and iterate through the available sub-layer and order pairs.

---

## Initialize Options

`createSpriteLayer()` accepts a small set of configuration values that govern how sprites are identified and scaled on the map:

```typescript
// Create a SpriteLayer with specified initialization options
const spriteLayer = createSpriteLayer({
  id: 'vehicles',
  spriteScaling: {  // Apply scaling limit options
    metersPerPixel: 1,
    minScaleDistanceMeters: 500,
    maxScaleDistanceMeters: 10000,
  },
  textureFiltering: {  // Apply texture quality options
    minFilter: 'linear-mipmap-linear',
    generateMipmaps: true,
    maxAnisotropy: 4,
  },
});
```

- `id` - Optional MapLibre layer identifier. If omitted the layer registers itself as `sprite-layer`.
- `spriteScaling.metersPerPixel` - This value defines how many meters each pixel of the texture represents on the map.
  A larger value will display the image larger at the same zoom level.
  Since this value affects all calculations, it is generally recommended to use the default value of 1 and adjust the size per sprite image using the `scale` parameter.
- `spriteScaling.minScaleDistanceMeters` - Camera-to-sprite distance (meters) where sprites stop getting larger as the camera moves closer. Set to `0` or omit to disable near clamping.
- `spriteScaling.maxScaleDistanceMeters` - Camera-to-sprite distance (meters) where sprites stop shrinking as the camera moves away. Set to `0` or omit to disable far clamping.
- `textureFiltering.minFilter` / `magFilter` - Override the WebGL texture filters used when sprites shrink or expand.
  The defaults match `linear` filtering in both directions.
  Setting `minFilter` to a mipmap variant (for example `linear-mipmap-linear`) automatically enables mipmap generation for newly registered images.
- `textureFiltering.generateMipmaps` - Forces mipmap generation even when the chosen filter does not require it, improving quality for aggressively downscaled sprites on WebGL2 or power-of-two images.
  When the context cannot build mipmaps (for example WebGL1 with non power-of-two textures) the layer falls back to linear filtering automatically.
- `textureFiltering.maxAnisotropy` - Requests anisotropic filtering (>= 1) when the runtime exposes `EXT_texture_filter_anisotropic`, helping surface-aligned sprites remain sharp at shallow viewing angles.
  The requested value is clamped to the GPU limit and only applied when mipmaps are available.

All scaling values and texture filtering values are resolved once when `createSpriteLayer` is called. To change them later, remove the layer and recreate it with new options.
Invalid inputs are normalized and reported via `console.warn` to help catch configuration mistakes during development.

### Scaling Limit Options

The motivation for fine-tuning scaling limit options is to keep sprites readable at extreme camera distances.
When no restrictions are applied (unspecified or `UNLIMITED_SPRITE_SCALING_OPTIONS`), zooming in significantly causes sprites to render extremely large, while zooming out makes them appear very small, making their presence difficult to see:

![Unlimited](images/scaling1.png)

As a standard option for moderate scaling limitations, you can use `STANDARD_SPRITE_SCALING_OPTIONS`.
This prevents further enlargement when the camera approaches closer than approximately 500m, and further reduction when it moves farther than approximately 10km.

For example, using this option allows you to see that something exists there even when zooming out:

![Standard](images/scaling2.png)

```typescript
// Create using standard scaling limit options
const spriteLayer = createSpriteLayer({
  id: 'vehicles',
  spriteScaling: STANDARD_SPRITE_SCALING_OPTIONS,
});
```

Of course, you can explicitly specify the value of `spriteScaling` to freely determine the restriction distance.

The [demo page](https://kekyo.github.io/maplibre-gl-layers/) features a button to switch between `Standard` and `Unlimited`.
You may want to check what happens when you zoom in and out.

Note: The default scaling limit option is set to `Unlimited` because introducing restrictions causes loss of accurate size rendering.
It is best to keep it unlimited when adjusting image or text placement, and enable restrictions only when prioritizing readability.

---

## Enabling WASM acceleration

By default, SpriteLayer performs coordinate calculations using its JavaScript implementation.
Initializing the WASM runtime module offloads coordinate calculations to the WASM module.

You can attempt to load the WASM host by calling `initializeRuntimeHost()` once, specifying options in the form of `{ variant?, wasmBaseUrl? }` as arguments.
If you do not call it or if initialization fails, it will automatically fall back to JavaScript calculations.

```typescript
// Execute initialization to obtain the selected calculation type
const selectedVariant = await initializeRuntimeHost({
  variant: 'simd',
  wasmBaseUrl: '/custom-assets/maplibre-wasm/',
});
```

The `variant` parameter specifies the type of WASM module.

* `simd` uses SIMD operations.
* `nosimd` does not use SIMD operations.
* `simd-mt` uses multithreading and SIMD operations (with limitations; see below).

The default is `simd`. Since most modern browsers support SIMD operations, the default setting should be fine.

By specifying `wasmBaseUrl`, you can copy the `dist/wasm` directory included in the npm package to any location (such as a CDN) for operation.
If omitted, `*.wasm` files located directly under the distributed `dist` directory will be loaded as-is,
requiring no special configuration in Vite/Rollup/webpack, etc.
However, the server must include the `Content-Type: application/wasm` header.
Note that depending on the browser implementation, if the correct MIME type is not applied, the module may not load as a WASM module.

The return value indicates the selected calculation type.
For example, if loading a SIMD calculation module fails, a different type is returned.

If an unknown error occurs during calculation in the WASM module (mainly OOM (Out of memory)), it will fall back to the JavaScript implementation and continue working.
Once this situation occurs, the WASM module cannot be reused unless the page is reloaded.

To release WASM when the SPA page terminates, call `releaseRuntimeHost()`.
After release, it will operate using JavaScript calculation until `initializeRuntimeHost()` is called again.

#### WASM multi-threading limitation

By specifying `simd-mt` for the `variant`, you can load a multithreaded module that enables parallel processing of WASM operations using multiple threads.
However, `simd-mt` does not function simply by being specified.

> Note: WASM multi-threading technology does not yet appear to be sufficiently practical.
> While the code itself executed without issues, but significant constraints exist in the runtime environment.
> The situation may improve in the future, such as through browser specification revisions, but please carefully consider its use at the production level.

1. The multi-threading variant utilizes [`SharedArrayBuffer`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer), so it will not be enabled unless cross-origin isolation is satisfied on the browser side.
   The web server must include the following response headers:
   - Top-level HTML opened directly by the user: `Cross-Origin-Opener-Policy: same-origin`
   - That HTML and all Worker entries loaded from it (`dist/wasm/offloads-simd-mt.js`, `*.wasm` files, custom Worker bundles, etc.): `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless` if you choose that)
   - Assets from other origins are blocked by COEP, so explicitly allow them with CORS or an appropriate `Cross-Origin-Resource-Policy` response
   If these conditions are not met, the `simd-mt` module will fail to load and fall back to `simd`.
2. The amount of memory used and the number of threads used must be statically determined during the WASM module build.
   The WASM module included in the distribution package is set to 512MB/4 threads.
   - The 512MB memory requirement is based on displaying 10,000 sprites with secondary images on the demo page.
   - If memory usage exceeds the limit, an OOM occurs within the WASM module worker, causing a fallback to the JavaScript implementation.
     Therefore, if your usage conditions differ from the assumptions, you must build and deploy your own WASM module.

Note: The [demo page](https://kekyo.github.io/maplibre-gl-layers/) is deployed on github.io, but unfortunately, github.io does not meet these requirements, so you cannot select `simd-mt` on the demo page.
If you want to try it out quickly, clone the repository and run the demo page locally with `npm install && npm run dev`.
The maintainer has verified that it works on Firefox on Ubuntu 24.04/22.04 (Build 144.0.2).

When using `simd-mt` with a development server like Vite, `COOP` and `COEP` headers are also required.
For example, specify them in `vite.config.ts` as follows:

```typescript
// COOP, COEP headers
const COOP_COEP_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // When running the development server (vite dev)
  server: {
    headers: COOP_COEP_HEADERS,
  },
  // When running in preview
  preview: {
    headers: COOP_COEP_HEADERS,
  },
});
```

Additionally, you can dynamically determine whether multi-threaded modules are available using `detectMultiThreadedModuleAvailability()`.
Here is the overall initialization flow:

```typescript
import {
  initializeRuntimeHost,
  detectMultiThreadedModuleAvailability,
} from ‘maplibre-gl-layers’;

// Determine if multi-threaded modules are available
const { available, reason } = detectMultiThreadedModuleAvailability();
if (!available) {
  console.warn(
    `SIMD + Threads unavailable: ${reason ?? 'Unknown constraint'}`
  );
}

// Choose between using the multithreaded module or the regular SIMD module
const desiredVariant = available ? 'simd-mt' : 'simd';
const effectiveVariant = await initializeRuntimeHost({
  variant: desiredVariant,
});

console.log(`Actual variant used: ${effectiveVariant}`);
```

---

## TODO

- Improves performance, reduces calculation costs
- Improves minor interfaces
- Adds route-oriented layer

## Motivation

This API was designed because MapLibre's standard `Facilities` imposed significant functional constraints when displaying large numbers of moving objects or landmarks, and we wanted a simpler, more direct API for dynamic manipulation.

MapLibre's Facilities API implements immutability.
While this is beneficial in itself, it hinders dynamic handling of large numbers of coordinate points (sprites) and significantly degrades performance.

`maplibre-gl-layers` abandons immutability and unifies the API as imperative.
Even if you wish to introduce immutability, you can easily achieve it by wrapping this API.

## Discussions and Pull Requests

For discussions, please refer to the [GitHub Discussions page](https://github.com/kekyo/maplibre-gl-layers/discussions). We have currently stopped issue-based discussions.

Pull requests are welcome! Please submit them as diffs against the `develop` branch and squashed changes before send.

## License

Under MIT.
