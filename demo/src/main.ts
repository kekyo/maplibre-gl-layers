import './style.css';
import 'maplibre-gl/dist/maplibre-gl.css';

import { Map, type MapOptions, type SourceSpecification } from 'maplibre-gl';
import {
  createSpriteLayer,
  STANDARD_SPRITE_SCALING_OPTIONS,
} from 'maplibre-gl-layers';
import type {
  SpriteMode,
  SpriteLayerClickEvent,
  SpriteInterpolationMode,
  SpriteAnchor,
  SpriteImageInterpolationOptions,
  SpriteImageDefinitionUpdate,
  SpriteInitEntry,
  SpriteTextGlyphOptions,
  SpriteImageRegisterOptions,
} from 'maplibre-gl-layers';
import { version, repository_url } from './generated/packageMetadata';

/**
 * Maximum number of sprites shown simultaneously in the demo scene.
 */
const MAX_NUMBER_OF_SPRITES = 10000;

/**
 * Initial number of sprites to display when the demo loads.
 */
const INITIAL_NUMBER_OF_SPRITES = 1000;

/**
 * Interval in milliseconds between movement updates.
 */
const MOVEMENT_INTERVAL_MS = 500;

/**
 * Center position used as the demo origin.
 */
const STARTUP_CENTER = {
  lng: 136.885202573,
  lat: 35.170006912,
};

/** Initial camera state shared between the UI and map creation. */
const INITIAL_CAMERA_STATE = {
  zoom: 14.5,
  pitch: 45,
  bearing: 0,
} as const;

/**
 * Base MapLibre source specifications available in the demo.
 */
type SourceSpecifications = { readonly [_: string]: SourceSpecification };
const mapSourceSpecification: SourceSpecifications = {
  // OSM
  osm: {
    type: 'raster',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    tileSize: 256,
    attribution: '© OpenStreetMap contributors',
    maxzoom: 19,
  },
  // CARTO
  carto: {
    type: 'raster',
    tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
    tileSize: 256,
    attribution: '© OpenStreetMap contributors © CARTO',
  },
};

interface SpriteDemoDebugState {
  mapLoaded: boolean;
  spritesReady: boolean;
  spriteLimit: number;
  activeSpriteCount: number;
  mapInstance?: Map;
  spriteLayer?: unknown;
}

declare global {
  interface Window {
    __spriteDemo?: SpriteDemoDebugState;
  }
}

/////////////////////////////////////////////////////////////////////////////////////////

/**
 * @typedef {Object} IconSpec
 * @property {string} id - Identifier used when registering the image in the MapLibre overlay.
 * @property {string} color - Fill color applied when drawing the arrow icon.
 * Referenced while `createArrowBitmap` builds the ImageBitmap.
 */
type IconSpec = {
  id: string;
  color: string;
};

/**
 * Icon variations available in the demo.
 * Each entry's ID is used as the WebGL texture key, and the color variation keeps large sprite counts readable.
 */
const ICON_SPECS: IconSpec[] = [
  { id: 'arrow-red', color: '#ef476f' },
  { id: 'arrow-green', color: '#06d6a0' },
  { id: 'arrow-blue', color: '#118ab2' },
  { id: 'arrow-amber', color: '#ffd166' },
  { id: 'arrow-purple', color: '#9c6ade' },
];

/**
 * Base width in pixels when generating arrow icons.
 * Used for ImageBitmap creation and downstream WebGL scaling calculations.
 */
const ICON_SIZE = 64;

/** Mode that selects the vertical aspect ratio for the icon. */
type IconHeightMode = 'square' | 'elongated';

/** Lookup table describing the available aspect ratios. */
const ICON_HEIGHT_SCALES: Record<IconHeightMode, number> = {
  square: 1.0,
  elongated: 1.8,
};

/** Registration order of height modes used during preloading. */
const ICON_HEIGHT_MODES: IconHeightMode[] = ['square', 'elongated'];

/** Sub-layer index used for the primary arrow image. */
const PRIMARY_SUB_LAYER = 1;

/** Sprite ID assigned to the secondary image. */
const SECONDARY_IMAGE_ID = 'sprite-secondary-marker';

/** Aspect ratio (width:height) of the secondary image, kept wide for clarity. */
const SECONDARY_IMAGE_ASPECT_RATIO = 1.5;

/**
 * Padding applied around text when rendering secondary glyph images.
 * Keeps the text from touching the border when the orbiting marker is in text mode.
 */
const SECONDARY_TEXT_PADDING = ICON_SIZE * 0.14;
/**
 * Line height used when drawing text-based secondary images, clamped to avoid degenerate glyphs.
 */
const SECONDARY_TEXT_LINE_HEIGHT = Math.max(
  2,
  ICON_SIZE - SECONDARY_TEXT_PADDING * 2
);

/** Secondary image rendering modes exposed via the control panel. */
type SecondaryImageType = 'box' | 'text';
/** Prefix applied to secondary glyph IDs so they do not collide with pre-baked icons. */
const SECONDARY_TEXT_IMAGE_PREFIX = 'sprite-secondary-text-';
/** Registry that tracks which secondary text glyphs are already uploaded to the GPU. */
const registeredSecondaryTextGlyphs = new Set<string>();
/** Cached list of sprite IDs so helper routines can iterate without re-allocating arrays. */
const allSpriteIds: string[] = [];

/** Sub-layer index reserved for secondary images. */
const SECONDARY_SUB_LAYER = 10;

/** Default scale multiplier applied to the orbiting secondary image. */
const SECONDARY_IMAGE_SCALE = 0.5;
/** Distance in meters that secondary images orbit from their primary marker. */
const SECONDARY_ORBIT_RADIUS_METERS = 180;
/** Angular increment in degrees applied to the orbiting image during each step. */
const SECONDARY_ORBIT_STEP_DEG = 20;
/** Fixed angle (deg) used when the orbit mode is set to Shift. */
const SECONDARY_SHIFT_ANGLE_DEG = 120;

/** Threshold used to ignore tiny values near zero introduced by floating point error. */
const EPSILON_DELTA = 1e-12;

/** Frame time assuming 60 FPS, used to normalize step differences. */
const ASSUMED_FRAME_TIME_MS = 1000 / 60;

/** Factor that converts timer steps into frame-equivalent movement. */
const MOVEMENT_STEP_FACTOR = MOVEMENT_INTERVAL_MS / ASSUMED_FRAME_TIME_MS;

/** Fraction of the icon height occupied by the arrow head near the top edge. */
const ARROW_HEAD_TOP_FRACTION = 0.085;
/** Anchor y-position that aligns the arrow tip with the ground in billboard mode. */
const BILLBOARD_PRIMARY_ANCHOR_Y = 1 - 2 * ARROW_HEAD_TOP_FRACTION;

/** Interaction states that control if and how the secondary image orbits the primary marker. */
type SecondaryOrbitMode = 'hidden' | 'center' | 'shift' | 'orbit';

/////////////////////////////////////////////////////////////////////////////////////////

/** Builds the image ID from base name and height mode. */
const getIconImageId = (baseId: string, mode: IconHeightMode): string =>
  `${baseId}-${mode}`;

/**
 * Resolves the anchor position and static rotation for the primary arrow image based on the mode.
 */
const resolvePrimaryImagePlacement = (
  mode: SpriteMode,
  autoRotationEnabled: boolean
): { anchor: SpriteAnchor; rotateDeg: number } => {
  if (mode === 'billboard') {
    // Branch when billboard mode is active because the anchor and baseline rotation must align with the ground-facing arrow.
    // When auto rotation is active in billboard mode, SpriteLayer supplies the heading directly,
    // so the static 180° rotation applied here must be cancelled. If auto rotation is OFF, keep
    // the 180° offset so the arrow points downward.
    return {
      anchor: { x: 0, y: BILLBOARD_PRIMARY_ANCHOR_Y },
      rotateDeg: autoRotationEnabled ? 0 : 180,
    };
  }
  // Default branch: surface mode keeps the anchor centered and leaves rotation untouched.
  return {
    anchor: { x: 0, y: 0 },
    rotateDeg: 0,
  };
};

/**
 * Draws an arrow-shaped sprite on a canvas and returns it as an ImageBitmap.
 * The arrow points north (up) so that applying a bearing aligns with travel direction.
 *
 * @param {string} color - Fill color. Designed to match ICON_SPECS for high contrast.
 * @param {number} size - Base sprite width in pixels, used for the canvas width.
 * @param {number} heightScale - Vertical scale. 1.0 is square; higher values elongate the shape.
 * @returns {Promise<ImageBitmap>} Resolves with the generated ImageBitmap.
 */
const createArrowBitmap = async (
  color: string,
  size: number,
  heightScale: number
): Promise<ImageBitmap> => {
  const width = size;
  const height = Math.round(size * heightScale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // Guard: abort if the browser cannot provide a 2D context because drawing commands would otherwise throw downstream.
    throw new Error('Canvas 2D context is not available');
  }

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = color;

  // Draw a triangular arrowhead and body so the forward direction is obvious.
  ctx.beginPath();
  ctx.moveTo(width / 2, height * ARROW_HEAD_TOP_FRACTION);
  ctx.lineTo(width * 0.92, height * 0.68);
  ctx.lineTo(width * 0.6, height * 0.58);
  ctx.lineTo(width * 0.6, height * 0.92);
  ctx.lineTo(width * 0.4, height * 0.92);
  ctx.lineTo(width * 0.4, height * 0.58);
  ctx.lineTo(width * 0.08, height * 0.68);
  ctx.closePath();
  ctx.fill();

  // Add a faint center line to further highlight the direction of travel.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.lineWidth = width * 0.06;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(width / 2, height * 0.18);
  ctx.lineTo(width / 2, height * 0.88);
  ctx.stroke();

  return await createImageBitmap(canvas);
};

/**
 * Creates the secondary "satellite" marker bitmap that can orbit around the primary arrow.
 *
 * @param {number} size - Base size used to derive the width and height of the marker.
 * @returns {Promise<ImageBitmap>} Resolves with the generated glossy rounded rectangle image.
 */
const createSecondaryMarkerBitmap = async (
  size: number
): Promise<ImageBitmap> => {
  const height = size;
  const width = Math.round(size * SECONDARY_IMAGE_ASPECT_RATIO);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // Guard: fail fast if a 2D context cannot be established—rendering commands rely on it heavily.
    throw new Error('Canvas 2D context is not available');
  }

  // Helper: draws a rounded rectangle used for the layered panel framing.
  const drawRoundedRect = (
    x: number,
    y: number,
    rectWidth: number,
    rectHeight: number,
    radius: number
  ) => {
    const r = Math.min(radius, rectWidth / 2, rectHeight / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + rectWidth - r, y);
    ctx.quadraticCurveTo(x + rectWidth, y, x + rectWidth, y + r);
    ctx.lineTo(x + rectWidth, y + rectHeight - r);
    ctx.quadraticCurveTo(
      x + rectWidth,
      y + rectHeight,
      x + rectWidth - r,
      y + rectHeight
    );
    ctx.lineTo(x + r, y + rectHeight);
    ctx.quadraticCurveTo(x, y + rectHeight, x, y + rectHeight - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  // Background layer.
  const cornerRadius = height * 0.28;
  const gradient = ctx.createLinearGradient(0, 0, width, height); // Diagonal gradient keeps the direction easy to read.
  gradient.addColorStop(0, 'rgba(128, 128, 128, 1)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 1)');
  drawRoundedRect(0, 0, width, height, cornerRadius);
  ctx.fillStyle = gradient;
  ctx.fill();

  // Outer border rectangle.
  drawRoundedRect(0, 0, width, height, cornerRadius);
  ctx.strokeStyle = 'rgba(128, 13, 13, 0.85)';
  ctx.lineWidth = height * 0.08;
  ctx.stroke();

  // Inner subtle border (gray).
  const inset = height * 0.18;
  drawRoundedRect(
    inset,
    inset,
    width - inset * 2,
    height - inset * 2,
    cornerRadius * 0.6
  );
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.4)';
  ctx.lineWidth = height * 0.05;
  ctx.stroke();

  // Center dot.
  ctx.fillStyle = 'rgba(128, 13, 13, 0.85)';
  ctx.beginPath();
  const r = Math.min(width, height) * 0.12;
  ctx.ellipse(width / 2, height / 2, r, r, 0, 0, Math.PI * 2);
  ctx.fill();

  return await createImageBitmap(canvas);
};

/////////////////////////////////////////////////////////////////////////////////////////

/**
 * Internal types used to manage sprite state in the demo, including velocity vectors
 * and rendering modes required for animation.
 */
/**
 * @typedef {Object} LinearPath
 * @property {number} startLng - Starting longitude.
 * @property {number} startLat - Starting latitude.
 * @property {number} endLng - Ending longitude reached in linear animation mode.
 * @property {number} endLat - Ending latitude reached in linear animation mode.
 * @property {number} progress - Progress along the segment (0.0–1.0). Looping is achieved by incrementing and wrapping this value.
 * @property {number} speed - Fractional step size. Multiplied by MOVEMENT_STEP_FACTOR to obtain actual movement.
 */
interface LinearPath {
  startLng: number;
  startLat: number;
  endLng: number;
  endLat: number;
  progress: number;
  speed: number;
}

/**
 * @typedef {Object} DemoSpriteTag
 * @property {number} dx - Longitude velocity used in the previous step. Updated when reflecting at bounds.
 * @property {number} dy - Latitude velocity used in the previous step.
 * @property {LinearPath} [path] - Travel path when linear mode is active. Undefined during random walk mode.
 * @property {number} lastStepLng - Previous longitude delta applied. Used to compute orientation.
 * @property {number} lastStepLat - Previous latitude delta applied.
 */
interface DemoSpriteTag {
  dx: number;
  dy: number;
  path?: LinearPath;
  lastStepLng: number;
  lastStepLat: number;
  orderIndex: number;
  iconSpecId: string;
  worldLng: number;
  worldLat: number;
}

/**
 * @typedef {'random'|'linear'} AnimationMode
 * `random` performs a boundary-reflecting random walk, while `linear` loops over predefined paths.
 */
type AnimationMode = 'random' | 'linear';

/** Identifiers for the base maps available in the demo. */
type BasemapId = 'osm' | 'carto';

/** Currently active animation mode, toggled from the control panel. */
let currentAnimationMode: AnimationMode = 'random';
/** Currently selected base map. */
let currentBasemapId: BasemapId = 'osm';
/** Sprite rendering mode, toggled between billboard and surface. */
let currentSpriteMode: SpriteMode = 'surface';
/** Whether the sprite auto-rotates to face the direction of travel. */
let isAutoRotationEnabled = true;
/** Enables movement interpolation; when false, updates happen per step only. */
let isMovementInterpolationEnabled = true;
/** Interpolation mode applied to sprite location updates. */
let locationInterpolationMode: SpriteInterpolationMode = 'feedback';
/** Whether the primary image uses rotation interpolation. */
let isRotateInterpolationEnabled = true;
/** Interpolation mode applied to primary image rotation. */
let rotateInterpolationMode: SpriteInterpolationMode = 'feedback';
/** Height mode used for arrow icons. */
let currentArrowShapeMode: IconHeightMode = 'elongated';
/** Flag indicating whether the movement timer is active. */
let isMovementLoopEnabled = true;
/** Mode for the secondary image (e.g., orbiting satellite indicator). */
let currentSecondaryImageOrbitMode: SecondaryOrbitMode = 'hidden';
/** Currently selected secondary image type. */
let currentSecondaryImageType: SecondaryImageType = 'box';
/** Whether we interpolate the orbital angle of the secondary image. */
let isOrbitDegInterpolationEnabled = true;
/** Whether we interpolate the orbital distance of the secondary image. */
let isOrbitMetersInterpolationEnabled = true;
/** Interpolation mode applied to orbital angle changes. */
let orbitOffsetDegInterpolationMode: SpriteInterpolationMode = 'feedback';
/** Interpolation mode applied to orbital distance changes. */
let orbitOffsetMetersInterpolationMode: SpriteInterpolationMode = 'feedback';
/** Timer handle for coordinate updates. */
let movementUpdateIntervalId: number | undefined;
/** Indicates whether supplemental images have been registered. */
let isSecondaryImageReady = false;
/** UI updater for the secondary-image toggle buttons. */
let updateSecondaryImageButtons: (() => void) | undefined;
/** UI updater for secondary image type buttons. */
let updateSecondaryImageTypeButtons: (() => void) | undefined;
/** UI updater for the rotate-interpolation toggle. */
let updateRotateInterpolationButton: (() => void) | undefined;
/** UI updater for the orbit degree interpolation toggle. */
let updateOrbitDegInterpolationButton: (() => void) | undefined;
/** UI updater for the orbit meters interpolation toggle. */
let updateOrbitMetersInterpolationButton: (() => void) | undefined;
/** Rotation angle in degrees for secondary images. */
let secondaryImageOrbitDegrees = 0;
/** UI updater for the movement toggle. */
let updateMovementToggleButton: (() => void) | undefined;
/** UI updater for the location interpolation toggle. */
let updateLocationInterpolationButton: (() => void) | undefined;

/**
 * Template that builds the application HUD.
 * @returns {string} HTML string inserted into the root element.
 */
const createHud = () => {
  const locationFeedforwardEnabled =
    locationInterpolationMode === 'feedforward';
  const rotateFeedforwardEnabled = rotateInterpolationMode === 'feedforward';
  const orbitDegFeedforwardEnabled =
    orbitOffsetDegInterpolationMode === 'feedforward';
  const orbitMetersFeedforwardEnabled =
    orbitOffsetMetersInterpolationMode === 'feedforward';
  return `
    <div id="map" data-testid="map-canvas"></div>
    <aside id="panel" data-testid="panel-info">
      <h1 data-testid="panel-title">MapLibre <a href="${repository_url}" target="_blank">SpriteLayer ${version}</a> Demo</h1>
      <p>
        Each sprite stays clamped to the ground and randomly chooses between screen-aligned and map-aligned orientations. Increase the count to as many as ${MAX_NUMBER_OF_SPRITES} sprites when needed.
      </p>
      <p>Pan, tilt, or zoom the map to inspect how the sprites respond.</p>
      <section id="map-status" data-testid="section-map-status">
        <h2>Map Status</h2>
        <div class="status-row" data-testid="status-row-zoom">
          <span class="status-label">Zoom</span>
          <span
            class="status-value"
            data-status="zoom"
            data-testid="status-zoom"
          >--</span>
        </div>
        <div class="status-row" data-testid="status-row-bearing">
          <span class="status-label">Bearing</span>
          <span
            class="status-value"
            data-status="bearing"
            data-testid="status-bearing"
          >--</span>
        </div>
        <div class="status-row" data-testid="status-row-pitch">
          <span class="status-label">Pitch</span>
          <span
            class="status-value"
            data-status="pitch"
            data-testid="status-pitch"
          >--</span>
        </div>
        <div class="status-row" data-testid="status-row-center">
          <span class="status-label">Center</span>
          <span
            class="status-value"
            data-status="center"
            data-testid="status-center"
          >--</span>
        </div>
        <div class="status-row" data-testid="status-row-pointer">
          <span class="status-label">Pointer</span>
          <span
            class="status-value"
            data-status="pointer"
            data-testid="status-pointer"
          >Move cursor</span>
        </div>
      </section>
      <section id="selected-sprite" data-testid="section-selected-sprite">
        <h2>Selected Sprite</h2>
        <p
          class="status-placeholder"
          data-selected-placeholder
          data-testid="selected-placeholder"
        >
          Click a sprite to view its details here.
        </p>
        <div data-selected-details hidden data-testid="selected-details">
          <div class="status-row" data-testid="selected-row-id">
            <span class="status-label">ID</span>
            <span
              class="status-value"
              data-selected-field="id"
              data-testid="selected-id"
            >--</span>
          </div>
          <div class="status-row" data-testid="selected-row-mode">
            <span class="status-label">Mode</span>
            <span
              class="status-value"
              data-selected-field="mode"
              data-testid="selected-mode"
            >--</span>
          </div>
          <div class="status-row" data-testid="selected-row-image">
            <span class="status-label">Image</span>
            <span
              class="status-value"
              data-selected-field="image"
              data-testid="selected-image"
            >--</span>
          </div>
          <div class="status-row" data-testid="selected-row-visible">
            <span class="status-label">Visible</span>
            <span
              class="status-value"
              data-selected-field="visible"
              data-testid="selected-visible"
            >--</span>
          </div>
          <div class="status-row" data-testid="selected-row-lnglat">
            <span class="status-label">LngLat</span>
            <span
              class="status-value"
              data-selected-field="lnglat"
              data-testid="selected-lnglat"
            >--</span>
          </div>
          <div class="status-row" data-testid="selected-row-screen">
            <span class="status-label">Screen (px)</span>
            <span
              class="status-value"
              data-selected-field="screen"
              data-testid="selected-screen"
            >--</span>
          </div>
          <div class="status-row" data-testid="selected-row-tag">
            <span class="status-label">Tag</span>
            <span
              class="status-value"
              data-selected-field="tag"
              data-testid="selected-tag"
            >--</span>
          </div>
        </div>
      </section>
    </aside>
    <aside id="controls" data-testid="panel-controls">
      <div class="control-group" data-testid="group-basemap">
        <h1>Base Map</h1>
        <button
          type="button"
          class="toggle-button${currentBasemapId === 'osm' ? ' active' : ''}"
          data-control="basemap"
          data-option="osm"
          data-label="OSM"
          aria-pressed="${currentBasemapId === 'osm'}"
          data-testid="toggle-basemap-osm"
        >
          ${currentBasemapId === 'osm' ? 'OSM ✓' : 'OSM'}
        </button>
        <button
          type="button"
          class="toggle-button${currentBasemapId === 'carto' ? ' active' : ''}"
          data-control="basemap"
          data-option="carto"
          data-label="CARTO"
          aria-pressed="${currentBasemapId === 'carto'}"
          data-testid="toggle-basemap-carto"
        >
          ${currentBasemapId === 'carto' ? 'CARTO ✓' : 'CARTO'}
        </button>
      </div>
      <div class="control-group" data-testid="group-layer-toggle">
        <h1>Enable</h1>
        <button
          type="button"
          class="toggle-button active"
          data-control="sprite-layer-toggle"
          data-label="Sprite Layer"
          aria-pressed="true"
          data-testid="toggle-sprite-layer"
        >
          Sprite Layer
        </button>
      </div>
      <div class="control-group" data-testid="group-movement-loop">
        <h1>Move Location</h1>
        <button
          type="button"
          class="toggle-button${isMovementLoopEnabled ? ' active' : ''}"
          data-control="movement-toggle"
          data-label="Movement"
          data-active-text="On"
          data-inactive-text="Off"
          aria-pressed="${isMovementLoopEnabled}"
          data-testid="toggle-movement"
        >
          Movement: ${isMovementLoopEnabled ? 'On' : 'Off'}
        </button>
      </div>
      <div class="control-group" data-testid="group-animation">
        <h1>Animation</h1>
        <button type="button" class="toggle-button${currentAnimationMode === 'random' ? ' active' : ''}" data-control="animation-mode" data-option="random" data-label="Random Walk" aria-pressed="${currentAnimationMode === 'random'}" data-testid="toggle-animation-random">
          Random Walk
        </button>
        <button type="button" class="toggle-button${currentAnimationMode === 'linear' ? ' active' : ''}" data-control="animation-mode" data-option="linear" data-label="Linear Loop" aria-pressed="${currentAnimationMode === 'linear'}" data-testid="toggle-animation-linear">
          Linear Loop
        </button>
      </div>
      <div class="control-group" data-testid="group-sprite-count">
        <h1>Sprite Count</h1>
        <label class="range-label" for="sprite-count-slider">
          Active
          <span
            class="range-value"
            data-status="sprite-count-active"
            data-testid="status-sprite-count-active"
          >0</span>
          /
          <span
            class="range-value"
            data-status="sprite-count-limit"
            data-testid="status-sprite-count-limit"
          >${MAX_NUMBER_OF_SPRITES}</span>
        </label>
        <input
          type="range"
          id="sprite-count-slider"
          class="range-input"
          min="1"
          max="${MAX_NUMBER_OF_SPRITES}"
          step="1"
          value="${INITIAL_NUMBER_OF_SPRITES}"
          data-control="sprite-count"
          data-testid="slider-sprite-count"
          aria-valuemin="1"
          aria-valuemax="${MAX_NUMBER_OF_SPRITES}"
          aria-valuenow="${INITIAL_NUMBER_OF_SPRITES}"
          aria-label="Active sprite count limit"
        />
        <p class="control-hint" data-testid="hint-sprite-count">
          Preloads ${INITIAL_NUMBER_OF_SPRITES} sprites; the slider tops out at ${MAX_NUMBER_OF_SPRITES}.
        </p>
      </div>
      <div class="control-group" data-testid="group-sprite-mode">
        <h1>Sprite Mode</h1>
        <button
          type="button"
          class="toggle-button${currentSpriteMode === 'billboard' ? ' active' : ''}"
          data-control="sprite-mode-toggle"
          data-label="Sprite Mode"
          data-active-text="Billboard"
          data-inactive-text="Surface"
          aria-pressed="${currentSpriteMode === 'billboard'}"
          data-testid="toggle-sprite-mode"
        >
          Sprite Mode: ${
            currentSpriteMode === 'billboard' ? 'Billboard' : 'Surface'
          }
        </button>
      </div>
      <div class="control-group" data-testid="group-auto-rotation">
        <h1>Auto rotation</h1>
        <button
          type="button"
          class="toggle-button${isAutoRotationEnabled ? ' active' : ''}"
          data-control="auto-rotation-toggle"
          data-label="Auto rotation"
          data-active-text="ON"
          data-inactive-text="OFF"
          aria-pressed="${isAutoRotationEnabled}"
          data-testid="toggle-auto-rotation"
        >
          Auto rotation: ${isAutoRotationEnabled ? 'ON' : 'OFF'}
        </button>
      </div>
      <div class="control-group" data-testid="group-location-interpolation">
        <h1>Location interpolation</h1>
        <div>
          <button
            type="button"
            class="toggle-button${isMovementInterpolationEnabled ? ' active' : ''}"
            data-control="location-interpolation-toggle"
            data-label="Move Interpolation"
            data-active-text="On"
            data-inactive-text="Off"
            aria-pressed="${isMovementInterpolationEnabled}"
            data-testid="toggle-location-interpolation"
          >
            Move Interpolation: ${isMovementInterpolationEnabled ? 'On' : 'Off'}
          </button>
        </div>
        <div>
          <button
            type="button"
            class="toggle-button${locationFeedforwardEnabled ? '' : ' active'}"
            data-control="location-interpolation-mode"
            data-option="feedback"
            data-label="Feedback"
            aria-pressed="${locationFeedforwardEnabled ? 'false' : 'true'}"
            data-testid="toggle-location-feedback"
          >
            Feedback
          </button>
          <button
            type="button"
            class="toggle-button${locationFeedforwardEnabled ? ' active' : ''}"
            data-control="location-interpolation-mode"
            data-option="feedforward"
            data-label="Feedforward"
            aria-pressed="${locationFeedforwardEnabled ? 'true' : 'false'}"
            data-testid="toggle-location-feedforward"
          >
            Feedforward
          </button>
        </div>
      </div>
      <div class="control-group" data-testid="group-rotation-interpolation">
        <h1>Rotation interpolation</h1>
        <div>
          <button
            type="button"
            class="toggle-button${isRotateInterpolationEnabled ? ' active' : ''}"
            data-control="rotate-interpolation-toggle"
            data-label="Rotate Interpolation"
            data-active-text="On"
            data-inactive-text="Off"
            aria-pressed="${isRotateInterpolationEnabled}"
            data-testid="toggle-rotate-interpolation"
          >
            Rotate Interpolation: ${isRotateInterpolationEnabled ? 'On' : 'Off'}
          </button>
        </div>
        <div>
          <button
            type="button"
            class="toggle-button${rotateFeedforwardEnabled ? '' : ' active'}"
            data-control="rotate-interpolation-mode"
            data-option="feedback"
            data-label="Feedback"
            aria-pressed="${rotateFeedforwardEnabled ? 'false' : 'true'}"
            data-testid="toggle-rotate-feedback"
          >
            Feedback
          </button>
          <button
            type="button"
            class="toggle-button${rotateFeedforwardEnabled ? ' active' : ''}"
            data-control="rotate-interpolation-mode"
            data-option="feedforward"
            data-label="Feedforward"
            aria-pressed="${rotateFeedforwardEnabled ? 'true' : 'false'}"
            data-testid="toggle-rotate-feedforward"
          >
            Feedforward
          </button>
        </div>
      </div>
      <div class="control-group" data-testid="group-secondary-image">
        <h1>Secondary Image</h1>
        <div>
          <button
            type="button"
            class="toggle-button${currentSecondaryImageType === 'box' ? ' active' : ''}"
            data-control="secondary-image-type"
            data-option="box"
            data-label="Box"
            aria-pressed="${currentSecondaryImageType === 'box'}"
            data-testid="toggle-secondary-type-box"
          >
            Box
          </button>
          <button
            type="button"
            class="toggle-button${currentSecondaryImageType === 'text' ? ' active' : ''}"
            data-control="secondary-image-type"
            data-option="text"
            data-label="Text"
            aria-pressed="${currentSecondaryImageType === 'text'}"
            data-testid="toggle-secondary-type-text"
          >
            Text
          </button>
        </div>
        <div>
          <button
            type="button"
            class="toggle-button${currentSecondaryImageOrbitMode === 'hidden' ? ' active' : ''}"
            data-control="secondary-image-mode"
            data-option="hidden"
            data-label="Hidden"
            aria-pressed="${currentSecondaryImageOrbitMode === 'hidden'}"
            data-testid="toggle-secondary-hidden"
          >
            ${currentSecondaryImageOrbitMode === 'hidden' ? 'Hidden ✓' : 'Hidden'}
          </button>
          <button
            type="button"
            class="toggle-button${currentSecondaryImageOrbitMode === 'center' ? ' active' : ''}"
            data-control="secondary-image-mode"
            data-option="center"
            data-label="Center"
            aria-pressed="${currentSecondaryImageOrbitMode === 'center'}"
            data-testid="toggle-secondary-center"
          >
            Center
          </button>
          <button
            type="button"
            class="toggle-button${currentSecondaryImageOrbitMode === 'shift' ? ' active' : ''}"
            data-control="secondary-image-mode"
            data-option="shift"
            data-label="Shift"
            aria-pressed="${currentSecondaryImageOrbitMode === 'shift'}"
            data-testid="toggle-secondary-shift"
          >
            Shift
          </button>
          <button
            type="button"
            class="toggle-button${currentSecondaryImageOrbitMode === 'orbit' ? ' active' : ''}"
            data-control="secondary-image-mode"
            data-option="orbit"
            data-label="Orbit"
            aria-pressed="${currentSecondaryImageOrbitMode === 'orbit'}"
            data-testid="toggle-secondary-orbit"
          >
            Orbit
          </button>
        </div>
        <div class="secondary-interpolation-group">
          <button
            type="button"
            class="toggle-button${isOrbitDegInterpolationEnabled ? ' active' : ''}"
            data-control="orbit-deg-interpolation-toggle"
            data-label="Orbit Degree Interpolation"
            data-active-text="On"
            data-inactive-text="Off"
            aria-pressed="${isOrbitDegInterpolationEnabled}"
            data-testid="toggle-orbit-deg-interpolation"
          >
            Orbit Degree Interpolation: ${
              isOrbitDegInterpolationEnabled ? 'On' : 'Off'
            }
          </button>
        </div>
        <div>
          <button
            type="button"
            class="toggle-button${orbitDegFeedforwardEnabled ? '' : ' active'}"
            data-control="orbit-deg-interpolation-mode"
            data-option="feedback"
            data-label="Feedback"
            aria-pressed="${orbitDegFeedforwardEnabled ? 'false' : 'true'}"
            data-testid="toggle-orbit-deg-feedback"
          >
            Feedback
          </button>
          <button
            type="button"
            class="toggle-button${orbitDegFeedforwardEnabled ? ' active' : ''}"
            data-control="orbit-deg-interpolation-mode"
            data-option="feedforward"
            data-label="Feedforward"
            aria-pressed="${orbitDegFeedforwardEnabled ? 'true' : 'false'}"
            data-testid="toggle-orbit-deg-feedforward"
          >
            Feedforward
          </button>
        </div>
        <div class="secondary-interpolation-group">
          <button
            type="button"
            class="toggle-button${isOrbitMetersInterpolationEnabled ? ' active' : ''}"
            data-control="orbit-meters-interpolation-toggle"
            data-label="Orbit Meters Interpolation"
            data-active-text="On"
            data-inactive-text="Off"
            aria-pressed="${isOrbitMetersInterpolationEnabled}"
            data-testid="toggle-orbit-meters-interpolation"
          >
            Orbit Meters Interpolation: ${
              isOrbitMetersInterpolationEnabled ? 'On' : 'Off'
            }
          </button>
        </div>
        <div>
          <button
            type="button"
            class="toggle-button${orbitMetersFeedforwardEnabled ? '' : ' active'}"
            data-control="orbit-meters-interpolation-mode"
            data-option="feedback"
            data-label="Feedback"
            aria-pressed="${orbitMetersFeedforwardEnabled ? 'false' : 'true'}"
            data-testid="toggle-orbit-meters-feedback"
          >
            Feedback
          </button>
          <button
            type="button"
            class="toggle-button${orbitMetersFeedforwardEnabled ? ' active' : ''}"
            data-control="orbit-meters-interpolation-mode"
            data-option="feedforward"
            data-label="Feedforward"
            aria-pressed="${orbitMetersFeedforwardEnabled ? 'true' : 'false'}"
            data-testid="toggle-orbit-meters-feedforward"
          >
            Feedforward
          </button>
        </div>
      </div>
      <div class="control-group" data-testid="group-arrow-shape">
        <h1>Arrow Shape</h1>
        <button
          type="button"
          class="toggle-button${currentArrowShapeMode === 'elongated' ? ' active' : ''}"
          data-control="arrow-shape-toggle"
          data-label="Arrow Shape"
          data-active-text="Elongated"
          data-inactive-text="Square"
          aria-pressed="${currentArrowShapeMode === 'elongated'}"
          data-testid="toggle-arrow-shape"
        >
          Arrow Shape: ${
            currentArrowShapeMode === 'elongated' ? 'Elongated' : 'Square'
          }
        </button>
        <input
          type="file"
          accept="image/*"
          data-control="arrow-image-file-input"
          data-testid="input-arrow-image"
          hidden
        />
        <button
          type="button"
          class="toggle-button"
          data-control="arrow-image-file-button"
          data-testid="btn-arrow-image"
        >
          Replace Primary Arrow Image
        </button>
      </div>
      <div class="control-group" data-testid="group-camera">
        <h1>Camera</h1>
        <div class="range-control" data-testid="control-camera-zoom">
          <label class="range-label" for="camera-zoom-input">
            Zoom
            <span
              class="range-value"
              data-status="camera-zoom"
              data-testid="status-camera-zoom"
            >--</span>
          </label>
          <input
            type="range"
            id="camera-zoom-input"
            class="range-input"
            min="5"
            max="20"
            step="0.1"
            value="${INITIAL_CAMERA_STATE.zoom}"
            data-control="camera-zoom"
            data-testid="slider-camera-zoom"
            aria-label="Map zoom level"
            aria-valuemin="5"
            aria-valuemax="20"
            aria-valuenow="${INITIAL_CAMERA_STATE.zoom}"
          />
        </div>
        <div class="range-control" data-testid="control-camera-bearing">
          <label class="range-label" for="camera-bearing-input">
            Bearing
            <span
              class="range-value"
              data-status="camera-bearing"
              data-testid="status-camera-bearing"
            >--</span>
          </label>
          <input
            type="range"
            id="camera-bearing-input"
            class="range-input"
            min="-180"
            max="180"
            step="1"
            value="${INITIAL_CAMERA_STATE.bearing}"
            data-control="camera-bearing"
            data-testid="slider-camera-bearing"
            aria-label="Map bearing"
            aria-valuemin="-180"
            aria-valuemax="180"
            aria-valuenow="${INITIAL_CAMERA_STATE.bearing}"
          />
        </div>
        <div class="range-control" data-testid="control-camera-pitch">
          <label class="range-label" for="camera-pitch-input">
            Pitch
            <span
              class="range-value"
              data-status="camera-pitch"
              data-testid="status-camera-pitch"
            >--</span>
          </label>
          <input
            type="range"
            id="camera-pitch-input"
            class="range-input"
            min="0"
            max="80"
            step="1"
            value="${INITIAL_CAMERA_STATE.pitch}"
            data-control="camera-pitch"
            data-testid="slider-camera-pitch"
            aria-label="Map pitch"
            aria-valuemin="0"
            aria-valuemax="80"
            aria-valuenow="${INITIAL_CAMERA_STATE.pitch}"
          />
        </div>
        <button
          type="button"
          class="toggle-button"
          data-control="camera-reset"
          data-testid="btn-camera-reset"
        >
          Reset View
        </button>
      </div>
    </aside>
  `;
};

/////////////////////////////////////////////////////////////////////////////////////////

/**
 * Application entry point.
 * - Build HUD elements.
 * - Initialize the MapLibre map.
 * - Create and mount the custom sprite layer.
 * - Schedule the animation update loop.
 *
 * Executes these steps sequentially, wiring up event listeners and button behavior.
 *
 * @returns {Promise<void>} Resolves when initialization completes.
 */
const main = async () => {
  const app = document.querySelector<HTMLDivElement>('#app');
  // Abort immediately if the container is missing; nothing would render to the user otherwise.
  if (!app) {
    throw new Error('App container element not found');
  }
  // Rebuild the HUD each time so the same container can be reused.
  app.innerHTML = createHud();

  const statusZoomEl = document.querySelector<HTMLSpanElement>(
    '[data-status="zoom"]'
  );
  const statusBearingEl = document.querySelector<HTMLSpanElement>(
    '[data-status="bearing"]'
  );
  const statusPitchEl = document.querySelector<HTMLSpanElement>(
    '[data-status="pitch"]'
  );
  const statusCenterEl = document.querySelector<HTMLSpanElement>(
    '[data-status="center"]'
  );
  const statusPointerEl = document.querySelector<HTMLSpanElement>(
    '[data-status="pointer"]'
  );
  const selectedPlaceholderEl = document.querySelector<HTMLElement>(
    '[data-selected-placeholder]'
  );
  const selectedDetailsEl = document.querySelector<HTMLElement>(
    '[data-selected-details]'
  );
  const selectedFieldEls = {
    id: document.querySelector<HTMLSpanElement>('[data-selected-field="id"]'),
    mode: document.querySelector<HTMLSpanElement>(
      '[data-selected-field="mode"]'
    ),
    image: document.querySelector<HTMLSpanElement>(
      '[data-selected-field="image"]'
    ),
    visible: document.querySelector<HTMLSpanElement>(
      '[data-selected-field="visible"]'
    ),
    lnglat: document.querySelector<HTMLSpanElement>(
      '[data-selected-field="lnglat"]'
    ),
    screen: document.querySelector<HTMLSpanElement>(
      '[data-selected-field="screen"]'
    ),
    tag: document.querySelector<HTMLSpanElement>('[data-selected-field="tag"]'),
  } as const;

  let updateCameraControls: (() => void) | undefined;
  let updateSpriteCountUI:
    | ((activeCount: number, limit: number) => void)
    | undefined;

  /**
   * MapLibre initialization options.
   */
  const mapOptions: MapOptions = {
    container: 'map',
    style: {
      version: 8,
      sources: mapSourceSpecification,
      layers: [
        {
          id: 'osm',
          type: 'raster',
          source: 'osm',
          layout: {
            visibility: currentBasemapId === 'osm' ? 'visible' : 'none',
          },
        },
        {
          id: 'carto',
          type: 'raster',
          source: 'carto',
          layout: {
            visibility: currentBasemapId === 'carto' ? 'visible' : 'none',
          },
        },
      ],
    },
    center: STARTUP_CENTER,
    zoom: INITIAL_CAMERA_STATE.zoom,
    pitch: INITIAL_CAMERA_STATE.pitch,
    bearing: INITIAL_CAMERA_STATE.bearing,
  };

  /**
   * MapLibre map instance.
   * - The `style` uses a lightweight OSM raster tileset to keep the focus on the demo.
   * - The `center` and `pitch` highlight STARTUP_CENTER with a moderate tilt.
   */
  const map = new Map(mapOptions);

  if (typeof window !== 'undefined') {
    // Browser runtime detected: expose debug state for manual inspection via DevTools.
    const debugState: SpriteDemoDebugState = window.__spriteDemo ?? {
      mapLoaded: false,
      spritesReady: false,
      spriteLimit: INITIAL_NUMBER_OF_SPRITES,
      activeSpriteCount: 0,
    };
    debugState.mapInstance = map;
    window.__spriteDemo = debugState;
  }

  /**
   * Formats a longitude/latitude pair for HUD display with fixed precision.
   *
   * @param {number} lng - Longitude in degrees.
   * @param {number} lat - Latitude in degrees.
   * @returns {string} Readable coordinate string for status labels.
   */
  const formatLngLat = (lng: number, lat: number) =>
    `${lng.toFixed(5)}, ${lat.toFixed(5)}`;

  /**
   * Synchronizes the map status indicators with the current camera position.
   * Guard clauses prevent dereferencing nodes that were not found in the DOM.
   */
  const updateMapStatus = () => {
    if (
      !statusZoomEl ||
      !statusBearingEl ||
      !statusPitchEl ||
      !statusCenterEl
    ) {
      // Skip the update when any status element is unavailable, which can happen during teardown or in test harnesses.
      return;
    }
    statusZoomEl.textContent = map.getZoom().toFixed(2);
    statusBearingEl.textContent = `${map.getBearing().toFixed(2)}°`;
    statusPitchEl.textContent = `${map.getPitch().toFixed(1)}°`;
    const center = map.getCenter();
    statusCenterEl.textContent = formatLngLat(center.lng, center.lat);
    updateCameraControls?.();
  };

  /**
   * Updates the pointer status readout with the latest cursor position over the map.
   *
   * @param {number} lng - Cursor longitude.
   * @param {number} lat - Cursor latitude.
   */
  const updatePointerStatus = (lng: number, lat: number) => {
    if (!statusPointerEl) {
      // Pointer element is optional outside the interactive demo layer, so bail if it is missing.
      return;
    }
    statusPointerEl.textContent = formatLngLat(lng, lat);
  };

  /**
   * Generates a textual description for a sprite tag so the detail panel can display metadata.
   *
   * @param {DemoSpriteTag|null} tag - Tag associated with the sprite or null when missing.
   * @returns {string} Description string for the selected sprite.
   */
  const describeTag = (tag: DemoSpriteTag | null): string => {
    if (!tag) {
      // Report an explicit fallback when the sprite lacks a tag so the UI does not appear blank.
      return 'none';
    }
    const parts = [`icon=${tag.iconSpecId}`];
    return parts.join(', ');
  };

  /**
   * Populates the detail panel with information about the sprite that was clicked.
   *
   * @param {SpriteLayerClickEvent<DemoSpriteTag>} event - Click payload emitted by the sprite layer.
   */
  const renderSelectedSprite = (
    event: SpriteLayerClickEvent<DemoSpriteTag>
  ) => {
    if (selectedPlaceholderEl) {
      // Hide the placeholder summary whenever a real sprite has been chosen.
      selectedPlaceholderEl.hidden = true;
    }
    if (selectedDetailsEl) {
      // Reveal the detail section now that the UI has specific sprite data to show.
      selectedDetailsEl.hidden = false;
    }
    if (selectedFieldEls.id) {
      // Update the sprite ID readout if the corresponding DOM node exists.
      selectedFieldEls.id.textContent = event.sprite.spriteId;
    }
    if (selectedFieldEls.mode) {
      // Display the rendering mode (surface or billboard) for the selected image entry.
      selectedFieldEls.mode.textContent = event.image.mode;
    }
    if (selectedFieldEls.image) {
      // Provide the exact image identifier that rendered the clicked sprite.
      selectedFieldEls.image.textContent = event.image.imageId;
    }
    if (selectedFieldEls.visible) {
      // Reflect whether the sprite image was visible (non-zero opacity) at the time of the click.
      selectedFieldEls.visible.textContent =
        event.image.opacity !== 0.0 ? 'Visible' : 'Hidden';
    }
    if (selectedFieldEls.lnglat) {
      // Show the geographic coordinates for the sprite's current location.
      selectedFieldEls.lnglat.textContent = formatLngLat(
        event.sprite.currentLocation.lng,
        event.sprite.currentLocation.lat
      );
    }
    if (selectedFieldEls.screen) {
      // Convert the projected screen coordinates to a human-friendly string.
      selectedFieldEls.screen.textContent = `${event.screenPoint.x.toFixed(1)}, ${event.screenPoint.y.toFixed(1)}`;
    }
    if (selectedFieldEls.tag) {
      // Render the metadata summary extracted from the sprite tag for debugging.
      selectedFieldEls.tag.textContent = describeTag(event.sprite.tag ?? null);
    }
  };

  map.on('move', updateMapStatus);
  map.on('zoom', updateMapStatus);
  map.on('rotate', updateMapStatus);
  map.on('pitch', updateMapStatus);
  map.on('mousemove', (event) => {
    // On mouse move we continuously refresh the HUD pointer indicator.
    updatePointerStatus(event.lngLat.lng, event.lngLat.lat);
  });
  map.on('mouseout', () => {
    if (statusPointerEl) {
      // When the cursor leaves the map canvas, prompt the user to move back in.
      statusPointerEl.textContent = 'Move cursor';
    }
  });

  updateMapStatus();

  /** Sprite layer instance. MapLibre manages the WebGL context, so only the layer ID is needed here. */
  const spriteLayer = createSpriteLayer<DemoSpriteTag>({
    id: 'demo-sprite',
    spriteScaling: STANDARD_SPRITE_SCALING_OPTIONS,
    //    spriteScaling: UNLIMITED_SPRITE_SCALING_OPTIONS,
    textureFiltering: {
      minFilter: 'linear-mipmap-linear',
      magFilter: 'linear',
      generateMipmaps: true,
      maxAnisotropy: 4,
    },
  });

  if (typeof window !== 'undefined') {
    // Register sprite layer references on the window for integration tests and debugging tools.
    const debugState: SpriteDemoDebugState = window.__spriteDemo ?? {
      mapLoaded: false,
      spritesReady: false,
      spriteLimit: INITIAL_NUMBER_OF_SPRITES,
      activeSpriteCount: 0,
    };
    debugState.spriteLayer = spriteLayer;
    debugState.mapInstance = map;
    debugState.spriteLimit = INITIAL_NUMBER_OF_SPRITES;
    window.__spriteDemo = debugState;
    // Expose the sprite layer for debugging in the browser console.
    (window as any).__spriteLayerMap = map;
    (window as any).__spriteLayer = spriteLayer;
  }

  // Run the remaining setup once all map resources finish loading.
  map.on('load', async () => {
    map.addLayer(spriteLayer);
    spriteLayer.on('spriteclick', renderSelectedSprite);

    let updateBasemapButtons: (() => void) | undefined;

    /**
     * Shows or hides each raster basemap layer to match the current selection.
     */
    const applyBasemapVisibility = () => {
      // Toggle the OSM layer depending on whether it matches the chosen base map.
      map.setLayoutProperty(
        'osm',
        'visibility',
        currentBasemapId === 'osm' ? 'visible' : 'none'
      );
      // Apply the inverse visibility to the CARTO layer so only one tileset renders at a time.
      map.setLayoutProperty(
        'carto',
        'visibility',
        currentBasemapId === 'carto' ? 'visible' : 'none'
      );
    };

    /**
     * Switches the active basemap and refreshes associated UI toggles.
     *
     * @param {BasemapId} nextBasemap - Identifier chosen by the user.
     */
    const selectBasemap = (nextBasemap: BasemapId) => {
      if (currentBasemapId === nextBasemap) {
        // Already on the requested basemap—just sync button state and exit.
        updateBasemapButtons?.();
        return;
      }
      currentBasemapId = nextBasemap;
      applyBasemapVisibility();
      updateBasemapButtons?.();
    };

    applyBasemapVisibility();

    let isActive = true;
    let spriteVisibilityLimit = INITIAL_NUMBER_OF_SPRITES;
    let lastVisibleSpriteCount = 0;
    let syncSpritePoolWithLimit: (targetSize: number) => {
      added: number;
      removed: number;
    } = () => ({
      added: 0,
      removed: 0,
    });

    /**
     * Computes a scaling factor that widens the random-walk bounds as more sprites become visible.
     *
     * @param {number} count - Number of sprites the user wants active.
     * @returns {number} Logarithmic scale factor for movement ranges.
     */
    const computeMovementExtentScale = (count: number): number => {
      // Use a logarithmic curve so the playground gradually expands without exploding for large counts.
      return count > 1 ? Math.log(count) / Math.log(4.8) : 1;
    };

    let movementExtentScale = computeMovementExtentScale(spriteVisibilityLimit);
    let lngExtent = 0.01 * movementExtentScale;
    let latExtent = 0.008 * movementExtentScale;
    let lngRadius = lngExtent / 2;
    let latRadius = latExtent / 2;

    /**
     * Recomputes the longitudinal and latitudinal extents used when distributing sprites.
     *
     * @param {number} count - Target number of visible sprites.
     */
    const updateMovementExtents = (count: number) => {
      movementExtentScale = computeMovementExtentScale(count);
      lngExtent = 0.01 * movementExtentScale;
      latExtent = 0.008 * movementExtentScale;
      lngRadius = lngExtent / 2;
      latRadius = latExtent / 2;
    };
    updateMovementExtents(spriteVisibilityLimit);

    /**
     * Enables or disables sprites so only the desired number render while honoring the current activity flag.
     */
    const reconcileSpriteVisibility = () => {
      let activeCount = 0;
      spriteLayer.updateForEach((sprite, update) => {
        const tag = sprite.tag as DemoSpriteTag | undefined;
        const index = tag?.orderIndex ?? MAX_NUMBER_OF_SPRITES;
        const enabled = isActive && index < spriteVisibilityLimit;
        update.isEnabled = enabled;
        if (enabled) {
          // Count only sprites that remain within the currently requested limit.
          activeCount += 1;
        }
        return true;
      });
      lastVisibleSpriteCount = activeCount;
      updateSpriteCountUI?.(activeCount, spriteVisibilityLimit);
      if (typeof window !== 'undefined' && window.__spriteDemo) {
        // Mirror the visibility stats on the shared debug object so automated tests can assert values.
        window.__spriteDemo.activeSpriteCount = activeCount;
        window.__spriteDemo.spriteLimit = spriteVisibilityLimit;
      }
    };

    /**
     * Updates the target sprite count, clamping to valid bounds and optionally reinitializing movement.
     *
     * @param {number} limit - Desired number of visible sprites.
     * @param {boolean} [shouldReinitialize=false] - Whether to rebuild movement paths after clamping.
     */
    const setSpriteVisibilityLimit = (
      limit: number,
      shouldReinitialize = false
    ) => {
      if (!Number.isFinite(limit)) {
        // Reject NaN values from malformed inputs, keeping the previous limit intact.
        updateSpriteCountUI?.(lastVisibleSpriteCount, spriteVisibilityLimit);
        return;
      }
      const clampedLimit = Math.min(
        Math.max(Math.round(limit), 1),
        MAX_NUMBER_OF_SPRITES
      );
      if (
        spriteVisibilityLimit === clampedLimit &&
        allSpriteIds.length === clampedLimit
      ) {
        if (typeof window !== 'undefined' && window.__spriteDemo) {
          // Even without a change, keep the debug state synchronized for consistency.
          window.__spriteDemo.spriteLimit = spriteVisibilityLimit;
        }
        updateSpriteCountUI?.(lastVisibleSpriteCount, spriteVisibilityLimit);
        return;
      }
      spriteVisibilityLimit = clampedLimit;
      updateMovementExtents(spriteVisibilityLimit);
      const { added } = syncSpritePoolWithLimit(clampedLimit);
      reconcileSpriteVisibility();
      if (added > 0 && currentSecondaryImageType === 'text') {
        // Refresh secondary glyph bindings so newly added sprites match the current text mode.
        void setSecondaryImageType('text');
      }
      if (shouldReinitialize) {
        // When the count slider triggers a full reinit, rebuild the sprite positions for fairness.
        reinitializeMovement();
      }
    };

    if (typeof window !== 'undefined') {
      // When running in a browser, publish the latest counts so DevTools observers and tests stay in sync.
      const debugState: SpriteDemoDebugState = window.__spriteDemo ?? {
        mapLoaded: false,
        spritesReady: false,
        spriteLimit: spriteVisibilityLimit,
        activeSpriteCount: lastVisibleSpriteCount,
      };
      debugState.mapLoaded = true;
      debugState.spriteLimit = spriteVisibilityLimit;
      debugState.activeSpriteCount = lastVisibleSpriteCount;
      debugState.mapInstance = map;
      debugState.spriteLayer = spriteLayer;
      window.__spriteDemo = debugState;
      window.dispatchEvent(
        new CustomEvent('sprite-demo-map-loaded', {
          detail: {
            spriteLimit: spriteVisibilityLimit,
          },
        })
      );
    }

    /**
     * Rotates every sprite's secondary image around its primary marker.
     */
    const advanceSecondaryOrbitRotation = () => {
      if (
        !isSecondaryImageReady ||
        currentSecondaryImageOrbitMode !== 'orbit'
      ) {
        // Skip rotation updates while images are still loading or when orbit mode is disabled.
        return;
      }

      // Advance the orbit angle.
      secondaryImageOrbitDegrees =
        (secondaryImageOrbitDegrees + SECONDARY_ORBIT_STEP_DEG) % 360;

      // Iterate over every sprite.
      spriteLayer.updateForEach((sprite, update) => {
        // Traverse every image registered on the sprite.
        sprite.images.forEach((orderMap) => {
          orderMap.forEach((image) => {
            // Only update the secondary (orbiting satellite) image.
            if (image.subLayer === SECONDARY_SUB_LAYER) {
              // Update the offset to represent the orbiting motion.
              const imageUpdate: SpriteImageDefinitionUpdate = {
                offset: {
                  offsetDeg: secondaryImageOrbitDegrees, // Apply the computed angle.
                  offsetMeters: SECONDARY_ORBIT_RADIUS_METERS, // Maintain the configured orbit radius.
                },
              };
              const orbitInterpolation = createOrbitInterpolationOptions();
              imageUpdate.interpolation = orbitInterpolation ?? {
                offsetDeg: null,
                offsetMeters: null,
              };
              update.updateImage(image.subLayer, image.order, imageUpdate);
            }
          });
        });
        return true;
      });
    };

    /**
     * Toggles visibility for all sprites simultaneously.
     *
     * @param {boolean} isVisible - `true` keeps sprites visible.
     */
    const applyLayerVisibility = (isVisible: boolean) => {
      isActive = isVisible;
      reconcileSpriteVisibility();
    };

    /**
     * Applies the auto-rotation flag across every sprite image.
     *
     * @param {boolean} autoRotation - `true` enables automatic rotation.
     */
    const applyAutoRotation = (autoRotation: boolean) => {
      const placement = resolvePrimaryImagePlacement(
        currentSpriteMode,
        autoRotation
      );
      // Iterate over every sprite.
      spriteLayer.updateForEach((sprite, update) => {
        // Traverse every image on the sprite.
        sprite.images.forEach((orderMap) => {
          orderMap.forEach((image) => {
            // Only the primary arrow image receives auto rotation.
            if (image.subLayer === PRIMARY_SUB_LAYER) {
              // Write the updated auto-rotation settings.
              const imageUpdate: SpriteImageDefinitionUpdate = {
                autoRotation,
                rotateDeg: placement.rotateDeg,
              };
              const rotationInterpolation = createRotateInterpolationOptions();
              if (rotationInterpolation) {
                // Respect the rotate interpolation toggle before mutating the image definition.
                imageUpdate.interpolation = rotationInterpolation;
              }
              update.updateImage(image.subLayer, image.order, imageUpdate);
            }
          });
        });
        return true;
      });
    };

    /**
     * Updates the rendering mode for every sprite.
     * Switching between billboard and surface changes rotation and scaling behaviour.
     *
     * @param {SpriteMode} mode - Rendering mode to apply.
     */
    const applySpriteMode = (mode: SpriteMode) => {
      const placement = resolvePrimaryImagePlacement(
        mode,
        isAutoRotationEnabled
      );
      // Iterate over every sprite.
      spriteLayer.updateForEach((sprite, update) => {
        // Traverse every image on the sprite.
        sprite.images.forEach((orderMap) => {
          orderMap.forEach((image) => {
            // Only adjust the primary arrow image.
            if (image.subLayer === PRIMARY_SUB_LAYER) {
              // Apply the new rendering mode.
              const imageUpdate: SpriteImageDefinitionUpdate = {
                mode,
                autoRotation: mode === 'surface', // Enable auto-rotation by default only in surface mode.
                rotateDeg: placement.rotateDeg,
                anchor: placement.anchor,
              };
              const rotationInterpolation = createRotateInterpolationOptions();
              if (rotationInterpolation) {
                // Only set rotation interpolation when the user has enabled the smoothing toggle.
                imageUpdate.interpolation = rotationInterpolation;
              }
              update.updateImage(image.subLayer, image.order, imageUpdate);
            } else {
              //update.updateImage(image.subLayer, image.order, {
              //  mode,
              //  autoRotation: mode === 'surface',
              //});
            }
          });
        });
        return true;
      });
    };

    /**
     * Updates the primary sprite image based on the selected aspect ratio mode.
     *
     * @param {IconHeightMode} mode - Aspect ratio mode to apply.
     */
    const applyIconHeightMode = (mode: IconHeightMode) => {
      // Iterate over every sprite.
      spriteLayer.updateForEach((sprite, update) => {
        // Traverse every image on the sprite.
        sprite.images.forEach((orderMap) => {
          orderMap.forEach((image) => {
            // Only update the primary arrow image.
            if (image.subLayer === PRIMARY_SUB_LAYER) {
              // Swap the image ID to match the new mode.
              update.updateImage(image.subLayer, image.order, {
                imageId: getIconImageId(sprite.tag!.iconSpecId, mode),
              });
            }
          });
        });
        return true;
      });
    };

    /**
     * Applies location interpolation settings across all sprites.
     */
    const applyLocationInterpolationToAll = () => {
      spriteLayer.updateForEach((_sprite, update) => {
        update.interpolation = isMovementInterpolationEnabled
          ? {
              mode: locationInterpolationMode,
              durationMs: MOVEMENT_INTERVAL_MS,
            }
          : null;
        return true;
      });
    };

    /**
     * Toggles rotation interpolation on every primary sprite so the animation speed stays consistent.
     *
     * @param {boolean} enabled - Whether interpolation should remain active.
     */
    const applyRotateInterpolationToAll = (enabled: boolean) => {
      spriteLayer.updateForEach((sprite, spriteUpdate) => {
        sprite.images.forEach((orderMap) => {
          orderMap.forEach((image) => {
            if (image.subLayer !== PRIMARY_SUB_LAYER) {
              // Secondary images do not rotate around their own axis, so skip them.
              return;
            }
            const imageUpdate: SpriteImageDefinitionUpdate = {
              interpolation: enabled
                ? {
                    rotateDeg: {
                      mode: rotateInterpolationMode,
                      durationMs: MOVEMENT_INTERVAL_MS,
                    },
                  }
                : { rotateDeg: null },
            };
            spriteUpdate.updateImage(image.subLayer, image.order, imageUpdate);
          });
        });
        return true;
      });
    };

    /**
     * Enables or disables interpolation on the orbit offsets so secondary images animate smoothly.
     */
    const applyOrbitInterpolationToAll = () => {
      spriteLayer.updateForEach((sprite, spriteUpdate) => {
        sprite.images.forEach((orderMap) => {
          orderMap.forEach((image) => {
            if (image.subLayer !== SECONDARY_SUB_LAYER) {
              // Only the secondary sub-layer performs orbital motion; others are unaffected.
              return;
            }
            const imageUpdate: SpriteImageDefinitionUpdate = {
              interpolation: {
                offsetDeg: isOrbitDegInterpolationEnabled
                  ? {
                      mode: orbitOffsetDegInterpolationMode,
                      durationMs: MOVEMENT_INTERVAL_MS,
                    }
                  : null,
                offsetMeters: isOrbitMetersInterpolationEnabled
                  ? {
                      mode: orbitOffsetMetersInterpolationMode,
                      durationMs: MOVEMENT_INTERVAL_MS,
                    }
                  : null,
              },
            };
            spriteUpdate.updateImage(image.subLayer, image.order, imageUpdate);
          });
        });
        return true;
      });
    };

    /**
     * Starts the fixed-timestep loop that drives sprite movement updates.
     */
    const startMovementInterval = () => {
      if (movementUpdateIntervalId !== undefined) {
        // Avoid registering multiple intervals if the loop is already running.
        return;
      }
      movementUpdateIntervalId = window.setInterval(() => {
        performMovementStep();
      }, MOVEMENT_INTERVAL_MS);
    };

    /**
     * Stops the movement loop so sprites no longer update positions.
     */
    const stopMovementInterval = () => {
      if (movementUpdateIntervalId === undefined) {
        // Nothing to stop, so exit quietly.
        return;
      }
      window.clearInterval(movementUpdateIntervalId);
      movementUpdateIntervalId = undefined;
    };

    /**
     * Toggles the global movement loop and updates associated UI state.
     *
     * @param {boolean} enabled - Desired movement state.
     */
    const setMovementLoopEnabled = (enabled: boolean) => {
      if (isMovementLoopEnabled === enabled) {
        // State unchanged; refresh the toggle label to prevent stale text.
        updateMovementToggleButton?.();
        return;
      }
      isMovementLoopEnabled = enabled;
      if (isMovementLoopEnabled) {
        // When turning the loop back on, execute one step immediately for responsiveness.
        performMovementStep();
        startMovementInterval();
      } else {
        // Pausing the simulation requires cancelling the interval to stop CPU usage.
        stopMovementInterval();
      }
      updateMovementToggleButton?.();
    };

    /**
     * Lazily registers text-based secondary glyphs for every sprite ID so the text mode can swap instantly.
     */
    const ensureSecondaryTextGlyphs = async (): Promise<void> => {
      if (allSpriteIds.length === 0) {
        // Sprite collection has not been populated yet; defer until initialization completes.
        return;
      }
      const options: SpriteTextGlyphOptions = {
        backgroundColor: '#3a3a3a',
        color: '#ffffff',
        paddingPixel: SECONDARY_TEXT_PADDING,
        borderColor: '#55b022',
        borderWidthPixel: 3,
        borderSides: ['top', 'bottom'],
      };

      await Promise.all(
        allSpriteIds.map(async (spriteId) => {
          const textImageId = `${SECONDARY_TEXT_IMAGE_PREFIX}${spriteId}`;
          if (registeredSecondaryTextGlyphs.has(textImageId)) {
            // Skip glyph creation when the text variant is already cached.
            return;
          }
          try {
            await spriteLayer.registerTextGlyph(
              textImageId,
              spriteId,
              { lineHeightPixel: SECONDARY_TEXT_LINE_HEIGHT },
              options
            );
            registeredSecondaryTextGlyphs.add(textImageId);
          } catch (error) {
            // Log and continue when text glyph generation fails, preserving other glyphs.
            console.warn('Failed to register text glyph:', textImageId, error);
          }
        })
      );
    };

    /**
     * Switches between the textured and text-based secondary image variants.
     *
     * @param {SecondaryImageType} type - Desired secondary sprite content.
     */
    const setSecondaryImageType = async (
      type: SecondaryImageType
    ): Promise<void> => {
      if (!isSecondaryImageReady) {
        // Defer the change until all assets have been uploaded to the GPU.
        currentSecondaryImageType = type;
        updateSecondaryImageTypeButtons?.();
        return;
      }

      if (type === 'text') {
        // Ensure every sprite ID has a pre-generated glyph texture before switching modes.
        await ensureSecondaryTextGlyphs();
      }

      const previousType = currentSecondaryImageType;
      currentSecondaryImageType = type;
      updateSecondaryImageTypeButtons?.();

      if (previousType === type && type !== 'text') {
        // Nothing changed, and non-text modes do not need forced refreshes.
        return;
      }

      spriteLayer.updateForEach((sprite, update) => {
        const targetImageId =
          type === 'text'
            ? `${SECONDARY_TEXT_IMAGE_PREFIX}${sprite.spriteId}`
            : SECONDARY_IMAGE_ID;

        const subLayerImages = sprite.images.get(SECONDARY_SUB_LAYER);
        if (!subLayerImages) {
          // Some sprites might not have secondary images yet; skip them safely.
          return true;
        }

        subLayerImages.forEach((imageState) => {
          if (imageState.imageId !== targetImageId) {
            // Replace outdated secondary textures with the newly requested variant.
            update.updateImage(imageState.subLayer, imageState.order, {
              imageId: targetImageId,
            });
          }
        });

        return true;
      });
    };

    /**
     * Switches the secondary image orbit mode for every sprite.
     * @param {SecondaryOrbitMode} mode - Mode to activate.
     */
    const setSecondaryImageOrbitMode = (mode: SecondaryOrbitMode) => {
      if (!isSecondaryImageReady) {
        // When assets have not loaded yet, just remember the requested mode for later.
        currentSecondaryImageOrbitMode = mode;
        secondaryImageOrbitDegrees =
          mode === 'orbit'
            ? secondaryImageOrbitDegrees
            : mode === 'shift'
              ? SECONDARY_SHIFT_ANGLE_DEG
              : 0;
        updateSecondaryImageButtons?.();
        return;
      }
      currentSecondaryImageOrbitMode = mode;
      secondaryImageOrbitDegrees =
        mode === 'orbit'
          ? secondaryImageOrbitDegrees
          : mode === 'shift'
            ? SECONDARY_SHIFT_ANGLE_DEG
            : 0;

      spriteLayer.updateForEach((sprite, update) => {
        sprite.images.forEach((orderMap) => {
          orderMap.forEach((image) => {
            if (image.subLayer !== SECONDARY_SUB_LAYER) {
              // Ignore primary images; only the secondary sub-layer participates in the orbit toggle.
              return;
            }
            let imageUpdate: SpriteImageDefinitionUpdate;
            if (mode === 'hidden') {
              imageUpdate = {
                opacity: 0.0,
                autoRotation: false,
              };
            } else if (mode === 'center') {
              // Center mode keeps the image visible but locked to the primary sprite position.
              imageUpdate = {
                opacity: 1.0,
                autoRotation: false,
                offset: {
                  offsetMeters: 0.0,
                  offsetDeg: 0.0,
                },
              };
            } else if (mode === 'shift') {
              // Shift mode keeps a fixed radius and angle without continuous orbiting.
              imageUpdate = {
                opacity: 1.0,
                autoRotation: false,
                offset: {
                  offsetMeters: SECONDARY_ORBIT_RADIUS_METERS,
                  offsetDeg: SECONDARY_SHIFT_ANGLE_DEG,
                },
              };
            } else {
              // Orbit mode offsets the sprite by the configured radius and maintains the current angle.
              imageUpdate = {
                opacity: 1.0,
                autoRotation: false,
                offset: {
                  offsetMeters: SECONDARY_ORBIT_RADIUS_METERS,
                  offsetDeg: secondaryImageOrbitDegrees,
                },
              };
            }
            const orbitInterpolation = createOrbitInterpolationOptions();
            if (orbitInterpolation) {
              // Only attach interpolation data when the global toggle allows it.
              imageUpdate.interpolation = orbitInterpolation;
            } else {
              imageUpdate.interpolation = {
                offsetDeg: null,
                offsetMeters: null,
              };
            }
            update.updateImage(image.subLayer, image.order, imageUpdate);
          });
        });
        return true;
      });
      updateSecondaryImageButtons?.();
    };

    // Arrow images are generated asynchronously, so wait until every variant is ready.
    for (const mode of ICON_HEIGHT_MODES) {
      // Preload arrow bitmaps for each aspect ratio so runtime switches are instant.
      await Promise.all(
        ICON_SPECS.map(async (spec) => {
          const bitmap = await createArrowBitmap(
            spec.color,
            ICON_SIZE,
            ICON_HEIGHT_SCALES[mode]
          );
          const imageId = getIconImageId(spec.id, mode);
          await spriteLayer.registerImage(imageId, bitmap);
        })
      );
    }

    // Generate the secondary (orbiting satellite) image.
    const secondaryBitmap = await createSecondaryMarkerBitmap(ICON_SIZE);
    await spriteLayer.registerImage(SECONDARY_IMAGE_ID, secondaryBitmap);

    isSecondaryImageReady = true;
    updateSecondaryImageButtons?.();
    updateSecondaryImageTypeButtons?.();
    await setSecondaryImageType(currentSecondaryImageType);

    if (currentSecondaryImageOrbitMode !== 'hidden') {
      // Reapply the stored orbit mode so sprites immediately reflect the persisted state.
      setSecondaryImageOrbitMode(currentSecondaryImageOrbitMode);
    }

    // Expand the movement extent based on sprite count.
    /**
     * Updates the appearance and accessibility state of toggle buttons.
     * Adjusts text and check marks based on the active state so screen readers announce changes.
     *
     * @param {HTMLButtonElement} button - Target button element.
     * @param {boolean} active - Whether the button is active.
     * @param {'binary'|'select'} style - Interaction style for the button.
     */
    const setToggleButtonState = (
      button: HTMLButtonElement,
      active: boolean,
      style: 'binary' | 'select'
    ) => {
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      const fallbackLabel = button.textContent?.split(':')?.[0]?.trim() ?? '';
      const baseLabel = button.dataset.label ?? fallbackLabel;
      if (style === 'binary') {
        // Binary-style buttons flip between two states, so use explicit active/inactive labels.
        const activeText = button.dataset.activeText;
        const inactiveText = button.dataset.inactiveText;
        // Prefer the provided labels when present; otherwise fall back to a generic ON/OFF string.
        if (activeText && inactiveText) {
          button.textContent = `${baseLabel}: ${active ? activeText : inactiveText}`;
        } else {
          button.textContent = `${baseLabel}: ${active ? 'ON' : 'OFF'}`;
        }
      } else {
        button.textContent = active ? `${baseLabel} ✓` : baseLabel;
      }
    };

    /**
     * Builds rotation interpolation settings when the global toggle is enabled.
     *
     * @returns {SpriteImageInterpolationOptions|undefined} Interpolation config or undefined when disabled.
     */
    const createRotateInterpolationOptions = ():
      | SpriteImageInterpolationOptions
      | undefined => {
      if (!isRotateInterpolationEnabled) {
        // Returning undefined signals callers to omit interpolation data entirely.
        return undefined;
      }
      return {
        rotateDeg: {
          mode: rotateInterpolationMode,
          durationMs: MOVEMENT_INTERVAL_MS,
        },
      };
    };

    /**
     * Constructs interpolation options for orbital offsets when allowed by the toggle state.
     *
     * @returns {SpriteImageInterpolationOptions|undefined} Offset interpolation details.
     */
    const createOrbitInterpolationOptions = ():
      | SpriteImageInterpolationOptions
      | undefined => {
      if (
        !isOrbitDegInterpolationEnabled &&
        !isOrbitMetersInterpolationEnabled
      ) {
        // Skip interpolation when the user has disabled smoothing for orbit motion.
        return undefined;
      }
      const options: SpriteImageInterpolationOptions = {};
      if (isOrbitDegInterpolationEnabled) {
        options.offsetDeg = {
          mode: orbitOffsetDegInterpolationMode,
          durationMs: MOVEMENT_INTERVAL_MS,
        };
      }
      if (isOrbitMetersInterpolationEnabled) {
        options.offsetMeters = {
          mode: orbitOffsetMetersInterpolationMode,
          durationMs: MOVEMENT_INTERVAL_MS,
        };
      }
      return options;
    };

    /**
     * Initializes sprite state for random-walk mode.
     * Generates a random velocity vector and clamps near-zero movement to stay visible.
     *
     * @param {{lng:number, lat:number}} baseCenter - Layer origin.
     * @param {DemoSpriteTag} outTag - Tag object to mutate.
     * @returns {{lng:number, lat:number}} Starting position.
     */
    const createRandomState = (
      baseCenter: { lng: number; lat: number },
      outTag: DemoSpriteTag
    ): { lng: number; lat: number } => {
      const lng = baseCenter.lng + (Math.random() - 0.5) * lngExtent;
      const lat = baseCenter.lat + (Math.random() - 0.5) * latExtent;
      let dx = (Math.random() - 0.5) * 0.0001;
      let dy = (Math.random() - 0.5) * 0.0001;
      // Avoid stationary sprites by nudging near-zero velocities.
      if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
        dx = 0.0001;
      }
      outTag.dx = dx;
      outTag.dy = dy;
      outTag.path = undefined;
      outTag.lastStepLng = dx * MOVEMENT_STEP_FACTOR;
      outTag.lastStepLat = dy * MOVEMENT_STEP_FACTOR;
      outTag.worldLng = lng;
      outTag.worldLat = lat;
      return { lng, lat };
    };

    /**
     * Initializes sprite state for linear-path mode.
     * Randomizes start/end points and starts from a progress point along the path.
     *
     * @param {{lng:number, lat:number}} baseCenter - Layer origin.
     * @param {DemoSpriteTag} outTag - Tag object to mutate.
     * @returns {{lng:number, lat:number}} Starting position.
     */
    const createLinearState = (
      baseCenter: { lng: number; lat: number },
      outTag: DemoSpriteTag
    ): { lng: number; lat: number } => {
      const startLng = baseCenter.lng + (Math.random() - 0.5) * lngExtent;
      const startLat = baseCenter.lat + (Math.random() - 0.5) * latExtent;
      const angle = Math.random() * Math.PI * 2;
      const spanFactor = 0.4 + Math.random() * 0.4;
      const endLng = startLng + Math.sin(angle) * lngExtent * spanFactor;
      const endLat = startLat + Math.cos(angle) * latExtent * spanFactor;
      const progress = Math.random();
      const speed = 0.001 + Math.random() * 0.0001;
      const path: LinearPath = {
        startLng,
        startLat,
        endLng,
        endLat,
        progress,
        speed,
      };
      const lng = startLng + (endLng - startLng) * progress;
      const lat = startLat + (endLat - startLat) * progress;
      const directionLng = endLng - startLng;
      const directionLat = endLat - startLat;
      const stepLng = directionLng * speed;
      const stepLat = directionLat * speed;
      outTag.dx = stepLng;
      outTag.dy = stepLat;
      outTag.path = path;
      outTag.lastStepLng = stepLng * MOVEMENT_STEP_FACTOR;
      outTag.lastStepLat = stepLat * MOVEMENT_STEP_FACTOR;
      outTag.worldLng = lng;
      outTag.worldLat = lat;
      return { lng, lat };
    };

    /**
     * Dispatches to the appropriate initializer based on the animation mode.
     *
     * @param {{lng:number, lat:number}} baseCenter - Layer origin.
     * @param {AnimationMode} mode - Selected animation mode.
     * @param {DemoSpriteTag} outTag - Tag object to mutate.
     * @returns {{lng:number, lat:number}} Starting position.
     */
    const initializeMovementState = (
      baseCenter: { lng: number; lat: number },
      mode: AnimationMode,
      outTag: DemoSpriteTag
    ): { lng: number; lat: number } => {
      // Choose between the deterministic linear loop and the reflective random walk depending on the selected mode.
      return mode === 'linear'
        ? createLinearState(baseCenter, outTag)
        : createRandomState(baseCenter, outTag);
    };

    /**
     * Recomputes sprite positions according to the current animation mode.
     * Keeps previously created sprites but resets their movement state.
     */
    const reinitializeMovement = () => {
      spriteLayer.updateForEach((sprite, update) => {
        update.location = initializeMovementState(
          STARTUP_CENTER,
          currentAnimationMode,
          sprite.tag!
        );
        return true;
      });
    };

    /**
     * Wires up control panel buttons and synchronizes text/ARIA attributes with the current state.
     */
    const initializeControlPanel = () => {
      const controlRoots = [
        document.getElementById('controls'),
        document.getElementById('panel'),
      ].filter((root): root is HTMLElement => root !== null);
      // Skip registration if there are no control panels in the DOM.
      if (controlRoots.length === 0) {
        // Without any control panels in the DOM there is nothing to wire up.
        return;
      }
      const queryAll = <T extends Element>(selector: string): T[] =>
        controlRoots.flatMap((root) =>
          Array.from(root.querySelectorAll<T>(selector))
        );
      const queryFirst = <T extends Element>(selector: string): T | null => {
        for (const root of controlRoots) {
          const match = root.querySelector<T>(selector);
          if (match) {
            // Immediately return the first match to avoid redundant scanning.
            return match;
          }
        }
        return null;
      };

      const registerInterpolationModeButtons = (
        selector: string,
        getMode: () => SpriteInterpolationMode,
        onChange: (mode: SpriteInterpolationMode) => void
      ) => {
        const buttons = Array.from<HTMLButtonElement>(
          queryAll<HTMLButtonElement>(selector)
        );
        if (buttons.length === 0) {
          return;
        }
        const updateButtons = () => {
          const current = getMode();
          buttons.forEach((button) => {
            const option = button.dataset.option as
              | SpriteInterpolationMode
              | undefined;
            if (!option) {
              return;
            }
            setToggleButtonState(button, current === option, 'select');
          });
        };
        updateButtons();
        buttons.forEach((button) => {
          const option = button.dataset.option as
            | SpriteInterpolationMode
            | undefined;
          if (!option) {
            return;
          }
          button.addEventListener('click', () => {
            if (getMode() === option) {
              return;
            }
            onChange(option);
            updateButtons();
          });
        });
      };

      const spriteCountActiveEl = queryFirst<HTMLElement>(
        '[data-status="sprite-count-active"]'
      );
      const spriteCountLimitEl = queryFirst<HTMLElement>(
        '[data-status="sprite-count-limit"]'
      );
      if (spriteCountLimitEl) {
        // Seed the limit display with the absolute maximum so the UI reflects the slider range.
        spriteCountLimitEl.textContent = String(MAX_NUMBER_OF_SPRITES);
      }
      const spriteCountSlider = queryFirst<HTMLInputElement>(
        '[data-control="sprite-count"]'
      );
      if (spriteCountSlider) {
        // Initialize the slider with the default sprite count so the knob matches the rendered state.
        spriteCountSlider.value = String(INITIAL_NUMBER_OF_SPRITES);
        spriteCountSlider.valueAsNumber = INITIAL_NUMBER_OF_SPRITES;
        spriteCountSlider.setAttribute(
          'aria-valuenow',
          String(INITIAL_NUMBER_OF_SPRITES)
        );
      }

      updateSpriteCountUI = (activeCount: number, limit: number) => {
        if (spriteCountActiveEl) {
          // Reflect the number of sprites currently visible in the HUD.
          spriteCountActiveEl.textContent = String(activeCount);
        }
        if (spriteCountSlider) {
          // Keep the slider knob and ARIA values synchronized with the clamped limit.
          spriteCountSlider.value = String(limit);
          spriteCountSlider.valueAsNumber = limit;
          spriteCountSlider.setAttribute('aria-valuenow', String(limit));
        }
      };

      if (spriteCountSlider) {
        const applyLimitFromSlider = (
          rawValue: string,
          shouldReinitialize: boolean
        ) => {
          setSpriteVisibilityLimit(Number(rawValue), shouldReinitialize);
        };
        spriteCountSlider.addEventListener('input', () => {
          // While dragging keep counts responsive but avoid expensive reinitialization.
          applyLimitFromSlider(spriteCountSlider.value, false);
        });
        spriteCountSlider.addEventListener('change', () => {
          // Once the user releases the slider, optionally rebuild movement paths.
          applyLimitFromSlider(spriteCountSlider.value, true);
        });
      }

      updateSpriteCountUI?.(lastVisibleSpriteCount, spriteVisibilityLimit);

      const cameraZoomStatusEl = queryFirst<HTMLElement>(
        '[data-status="camera-zoom"]'
      );
      const cameraBearingStatusEl = queryFirst<HTMLElement>(
        '[data-status="camera-bearing"]'
      );
      const cameraPitchStatusEl = queryFirst<HTMLElement>(
        '[data-status="camera-pitch"]'
      );
      const cameraZoomInput = queryFirst<HTMLInputElement>(
        '[data-control="camera-zoom"]'
      );
      const cameraBearingInput = queryFirst<HTMLInputElement>(
        '[data-control="camera-bearing"]'
      );
      const cameraPitchInput = queryFirst<HTMLInputElement>(
        '[data-control="camera-pitch"]'
      );
      const cameraResetButton = queryFirst<HTMLButtonElement>(
        '[data-control="camera-reset"]'
      );

      updateCameraControls = () => {
        const zoom = map.getZoom();
        if (cameraZoomStatusEl) {
          // Update the textual zoom display so observers see the actual value.
          cameraZoomStatusEl.textContent = zoom.toFixed(2);
        }
        if (cameraZoomInput) {
          // Mirror the live zoom value into the slider so subsequent interactions stay smooth.
          cameraZoomInput.value = zoom.toFixed(2);
          cameraZoomInput.setAttribute('aria-valuenow', zoom.toFixed(2));
        }
        const bearing = map.getBearing();
        if (cameraBearingStatusEl) {
          // Show the formatted bearing in degrees in the status section.
          cameraBearingStatusEl.textContent = `${bearing.toFixed(1)}°`;
        }
        if (cameraBearingInput) {
          // Keep the bearing slider in sync with the map camera.
          cameraBearingInput.value = bearing.toFixed(1);
          cameraBearingInput.setAttribute('aria-valuenow', bearing.toFixed(1));
        }
        const pitch = map.getPitch();
        if (cameraPitchStatusEl) {
          // Present the current pitch so users can reason about the camera tilt.
          cameraPitchStatusEl.textContent = `${pitch.toFixed(1)}°`;
        }
        if (cameraPitchInput) {
          // Align the pitch slider and ARIA attribute with the real map value.
          cameraPitchInput.value = pitch.toFixed(1);
          cameraPitchInput.setAttribute('aria-valuenow', pitch.toFixed(1));
        }
      };

      updateCameraControls?.();

      const easingDurationMs = 300;

      if (cameraZoomInput) {
        cameraZoomInput.addEventListener('input', () => {
          const nextZoom = Number(cameraZoomInput.value);
          if (!Number.isFinite(nextZoom)) {
            // Ignore invalid numeric values so MapLibre never receives NaN.
            return;
          }
          map.easeTo({ zoom: nextZoom, duration: easingDurationMs });
        });
      }

      if (cameraBearingInput) {
        cameraBearingInput.addEventListener('input', () => {
          const nextBearing = Number(cameraBearingInput.value);
          if (!Number.isFinite(nextBearing)) {
            // Abort when user input cannot be parsed to a finite number.
            return;
          }
          map.easeTo({ bearing: nextBearing, duration: easingDurationMs });
        });
      }

      if (cameraPitchInput) {
        cameraPitchInput.addEventListener('input', () => {
          const nextPitch = Number(cameraPitchInput.value);
          if (!Number.isFinite(nextPitch)) {
            // Prevent MapLibre from receiving invalid pitch values.
            return;
          }
          map.easeTo({ pitch: nextPitch, duration: easingDurationMs });
        });
      }

      if (cameraResetButton) {
        cameraResetButton.addEventListener('click', () => {
          map.easeTo({
            center: [STARTUP_CENTER.lng, STARTUP_CENTER.lat],
            zoom: INITIAL_CAMERA_STATE.zoom,
            pitch: INITIAL_CAMERA_STATE.pitch,
            bearing: INITIAL_CAMERA_STATE.bearing,
            duration: 500,
          });
        });
      }

      let updateAutoRotationButton: (() => void) | undefined;
      const setAutoRotationEnabled = (enabled: boolean) => {
        if (isAutoRotationEnabled === enabled) {
          // No change—still refresh the UI so it reflects the existing state.
          updateAutoRotationButton?.();
          return;
        }
        isAutoRotationEnabled = enabled;
        updateAutoRotationButton?.();
        applyAutoRotation(isAutoRotationEnabled);
      };

      const spriteLayerToggleButton = Array.from(
        queryAll<HTMLButtonElement>('[data-control="sprite-layer-toggle"]')
      )[0]!;
      const updateSpriteLayerToggle = () => {
        setToggleButtonState(spriteLayerToggleButton, isActive, 'binary');
      };
      updateSpriteLayerToggle();
      spriteLayerToggleButton.addEventListener('click', () => {
        applyLayerVisibility(!isActive);
        updateSpriteLayerToggle();
      });

      const basemapButtons = Array.from(
        queryAll<HTMLButtonElement>('[data-control="basemap"]')
      );
      if (basemapButtons.length > 0) {
        // Bind basemap controls only when the buttons are present in the DOM.
        updateBasemapButtons = () => {
          basemapButtons.forEach((button) => {
            const { option } = button.dataset;
            if (!option) {
              // Some test fixtures omit data-option; skip those buttons safely.
              return;
            }
            setToggleButtonState(
              button,
              currentBasemapId === (option as BasemapId),
              'select'
            );
          });
        };
        updateBasemapButtons();
        basemapButtons.forEach((button) => {
          const { option } = button.dataset;
          if (!option) {
            // Ignore buttons lacking an option identifier to avoid runtime errors.
            return;
          }
          button.addEventListener('click', () => {
            selectBasemap(option as BasemapId);
          });
        });
      }

      const spriteModeButton = queryFirst<HTMLButtonElement>(
        '[data-control="sprite-mode-toggle"]'
      );
      if (spriteModeButton) {
        // Sprite mode button is optional, so guard against missing controls.
        const updateSpriteModeButton = () => {
          setToggleButtonState(
            spriteModeButton,
            currentSpriteMode === 'billboard',
            'binary'
          );
        };
        updateSpriteModeButton();
        spriteModeButton.addEventListener('click', () => {
          // Alternate between billboard and surface modes to highlight their rendering differences.
          currentSpriteMode =
            currentSpriteMode === 'billboard' ? 'surface' : 'billboard';
          setAutoRotationEnabled(currentSpriteMode === 'surface'); // Switch default to keep behaviour easy to understand.
          applySpriteMode(currentSpriteMode);
          updateSpriteModeButton();
        });
      }

      const autoRotationButton = queryFirst<HTMLButtonElement>(
        '[data-control="auto-rotation-toggle"]'
      );
      if (autoRotationButton) {
        // Auto-rotation toggle exists only when sprite mode controls are visible.
        updateAutoRotationButton = () => {
          setToggleButtonState(
            autoRotationButton,
            isAutoRotationEnabled,
            'binary'
          );
        };
        updateAutoRotationButton();
        autoRotationButton.addEventListener('click', () => {
          setAutoRotationEnabled(!isAutoRotationEnabled);
        });
      }

      const arrowShapeButton = queryFirst<HTMLButtonElement>(
        '[data-control="arrow-shape-toggle"]'
      );
      if (arrowShapeButton) {
        // Arrow shape control is optional in condensed layers, hence the null check.
        const updateArrowShapeButton = () => {
          setToggleButtonState(
            arrowShapeButton,
            currentArrowShapeMode === 'elongated',
            'binary'
          );
        };
        updateArrowShapeButton();
        arrowShapeButton.addEventListener('click', () => {
          currentArrowShapeMode =
            currentArrowShapeMode === 'elongated' ? 'square' : 'elongated';
          updateArrowShapeButton();
          applyIconHeightMode(currentArrowShapeMode);
        });
      }

      const arrowImageInput = queryFirst<HTMLInputElement>(
        '[data-control="arrow-image-file-input"]'
      );
      const arrowImageButton = queryFirst<HTMLButtonElement>(
        '[data-control="arrow-image-file-button"]'
      );
      if (arrowImageInput && arrowImageButton && ICON_SPECS.length > 0) {
        const baseIconId = ICON_SPECS[0]!.id;
        const replacePrimaryArrowImage = async (file: File) => {
          const objectUrl = URL.createObjectURL(file);
          const lowerName = file.name.toLowerCase();
          const isSvg =
            file.type === 'image/svg+xml' || lowerName.endsWith('.svg');
          let registerOptions: SpriteImageRegisterOptions | undefined;
          if (isSvg) {
            registerOptions = {
              svg: {
                assumeSvg: true,
                useViewBoxDimensions: true,
              },
            };
          }

          try {
            for (const mode of ICON_HEIGHT_MODES) {
              const imageId = getIconImageId(baseIconId, mode);
              spriteLayer.unregisterImage(imageId);
              const registered = await spriteLayer.registerImage(
                imageId,
                objectUrl,
                registerOptions
              );
              if (!registered) {
                console.warn(
                  `Failed to register replacement image for ${imageId}`
                );
              }
            }
            // Re-apply the current height mode so sprites refresh immediately.
            applyIconHeightMode(currentArrowShapeMode);
          } catch (error) {
            console.error('Failed to replace arrow image', error);
          } finally {
            URL.revokeObjectURL(objectUrl);
            arrowImageInput.value = '';
          }
        };

        arrowImageButton.addEventListener('click', () => {
          arrowImageInput.click();
        });

        arrowImageInput.addEventListener('change', async () => {
          const file = arrowImageInput.files?.[0];
          if (!file) {
            return;
          }
          await replacePrimaryArrowImage(file);
        });
      }

      const animationButtons = Array.from(
        queryAll<HTMLButtonElement>('[data-control="animation-mode"]')
      );
      const updateAnimationButtons = () => {
        animationButtons.forEach((button) => {
          const option = button.dataset.option as AnimationMode | undefined;
          if (!option) {
            // Skip buttons missing a data-option attribute to avoid casting issues.
            return;
          }
          setToggleButtonState(
            button,
            currentAnimationMode === option,
            'select'
          );
        });
      };
      updateAnimationButtons();
      animationButtons.forEach((button) => {
        const option = button.dataset.option as AnimationMode | undefined;
        if (!option) {
          // Ignore buttons with undefined options—likely placeholder markup.
          return;
        }
        button.addEventListener('click', () => {
          // Avoid redundant reinitialization when clicking the already-selected mode.
          if (currentAnimationMode === option) {
            // No mode change occurred; keep the current state.
            return;
          }
          currentAnimationMode = option;
          updateAnimationButtons();
          reinitializeMovement();
        });
      });

      registerInterpolationModeButtons(
        '[data-control="location-interpolation-mode"]',
        () => locationInterpolationMode,
        (mode) => {
          locationInterpolationMode = mode;
          applyLocationInterpolationToAll();
          reinitializeMovement();
        }
      );

      registerInterpolationModeButtons(
        '[data-control="rotate-interpolation-mode"]',
        () => rotateInterpolationMode,
        (mode) => {
          rotateInterpolationMode = mode;
          applyRotateInterpolationToAll(isRotateInterpolationEnabled);
        }
      );

      registerInterpolationModeButtons(
        '[data-control="orbit-deg-interpolation-mode"]',
        () => orbitOffsetDegInterpolationMode,
        (mode) => {
          orbitOffsetDegInterpolationMode = mode;
          applyOrbitInterpolationToAll();
        }
      );

      registerInterpolationModeButtons(
        '[data-control="orbit-meters-interpolation-mode"]',
        () => orbitOffsetMetersInterpolationMode,
        (mode) => {
          orbitOffsetMetersInterpolationMode = mode;
          applyOrbitInterpolationToAll();
        }
      );

      const movementToggleButton = queryFirst<HTMLButtonElement>(
        '[data-control="movement-toggle"]'
      );
      if (movementToggleButton) {
        // Guard against layers where the movement toggle is hidden.
        updateMovementToggleButton = () => {
          setToggleButtonState(
            movementToggleButton,
            isMovementLoopEnabled,
            'binary'
          );
        };
        updateMovementToggleButton();
        movementToggleButton.addEventListener('click', () => {
          setMovementLoopEnabled(!isMovementLoopEnabled);
        });
      }

      // Secondary image buttons.
      const secondaryImageTypeButtons = Array.from(
        queryAll<HTMLButtonElement>('[data-control="secondary-image-type"]')
      );
      if (secondaryImageTypeButtons.length > 0) {
        // The secondary image controls might be omitted on narrow screens, so check before wiring.
        updateSecondaryImageTypeButtons = () => {
          secondaryImageTypeButtons.forEach((button) => {
            const type = button.dataset.option as
              | SecondaryImageType
              | undefined;
            if (!type) {
              // Buttons without a type attribute are unsupported.
              return;
            }
            setToggleButtonState(
              button,
              currentSecondaryImageType === type,
              'select'
            );
            button.disabled = !isSecondaryImageReady;
          });
        };
        updateSecondaryImageTypeButtons();
        secondaryImageTypeButtons.forEach((button) => {
          const type = button.dataset.option as SecondaryImageType | undefined;
          if (!type) {
            // Ignore undefined type entries to avoid runtime errors.
            return;
          }
          button.addEventListener('click', () => {
            if (!isSecondaryImageReady) {
              // Prevent toggling before assets finish loading to avoid flashing.
              return;
            }
            void setSecondaryImageType(type);
          });
        });
      }

      const secondaryImageModeButtons = Array.from(
        queryAll<HTMLButtonElement>('[data-control="secondary-image-mode"]')
      );
      if (secondaryImageModeButtons.length > 0) {
        // Only bind orbit mode toggles when they are part of the rendered UI.
        updateSecondaryImageButtons = () => {
          secondaryImageModeButtons.forEach((button) => {
            const mode = button.dataset.option as
              | SecondaryOrbitMode
              | undefined;
            if (!mode) {
              // Skip accidental entries lacking a mode identifier.
              return;
            }
            setToggleButtonState(
              button,
              currentSecondaryImageOrbitMode === mode,
              'select'
            );
            button.disabled = !isSecondaryImageReady && mode !== 'hidden';
          });
        };
        updateSecondaryImageButtons();
        secondaryImageModeButtons.forEach((button) => {
          const mode = button.dataset.option as SecondaryOrbitMode | undefined;
          if (!mode) {
            // Without a valid mode attribute the button cannot perform an action.
            return;
          }
          button.addEventListener('click', () => {
            if (!isSecondaryImageReady && mode !== 'hidden') {
              // Block orbit transitions when assets are not prepared, except for hiding.
              return;
            }
            setSecondaryImageOrbitMode(mode);
          });
        });
      }

      const locationInterpolationToggleButton = queryFirst<HTMLButtonElement>(
        '[data-control="location-interpolation-toggle"]'
      );
      if (locationInterpolationToggleButton) {
        updateLocationInterpolationButton = () => {
          setToggleButtonState(
            locationInterpolationToggleButton,
            isMovementInterpolationEnabled,
            'binary'
          );
        };
        updateLocationInterpolationButton();
        locationInterpolationToggleButton.addEventListener('click', () => {
          isMovementInterpolationEnabled = !isMovementInterpolationEnabled;
          updateLocationInterpolationButton?.();
          applyLocationInterpolationToAll();
        });
      }

      const orbitDegInterpolationButton = queryFirst<HTMLButtonElement>(
        '[data-control="orbit-deg-interpolation-toggle"]'
      );
      if (orbitDegInterpolationButton) {
        updateOrbitDegInterpolationButton = () => {
          setToggleButtonState(
            orbitDegInterpolationButton,
            isOrbitDegInterpolationEnabled,
            'binary'
          );
        };
        updateOrbitDegInterpolationButton();
        orbitDegInterpolationButton.addEventListener('click', () => {
          isOrbitDegInterpolationEnabled = !isOrbitDegInterpolationEnabled;
          updateOrbitDegInterpolationButton?.();
          applyOrbitInterpolationToAll();
        });
      }

      const orbitMetersInterpolationButton = queryFirst<HTMLButtonElement>(
        '[data-control="orbit-meters-interpolation-toggle"]'
      );
      if (orbitMetersInterpolationButton) {
        updateOrbitMetersInterpolationButton = () => {
          setToggleButtonState(
            orbitMetersInterpolationButton,
            isOrbitMetersInterpolationEnabled,
            'binary'
          );
        };
        updateOrbitMetersInterpolationButton();
        orbitMetersInterpolationButton.addEventListener('click', () => {
          isOrbitMetersInterpolationEnabled =
            !isOrbitMetersInterpolationEnabled;
          updateOrbitMetersInterpolationButton?.();
          applyOrbitInterpolationToAll();
        });
      }

      const rotateInterpolationButton = queryFirst<HTMLButtonElement>(
        '[data-control="rotate-interpolation-toggle"]'
      );
      if (rotateInterpolationButton) {
        // Rotation interpolation toggle exists only when the layer has enough space.
        updateRotateInterpolationButton = () => {
          setToggleButtonState(
            rotateInterpolationButton,
            isRotateInterpolationEnabled,
            'binary'
          );
        };
        updateRotateInterpolationButton();
        rotateInterpolationButton.addEventListener('click', () => {
          isRotateInterpolationEnabled = !isRotateInterpolationEnabled;
          updateRotateInterpolationButton?.();
          applyRotateInterpolationToAll(isRotateInterpolationEnabled);
        });
      }
    };

    initializeControlPanel();

    //////////////////////////////////////////////////////////////////////////////////
    // Initialization: sprite placement routine.

    // Pre-create INITIAL_NUMBER_OF_SPRITES sprites. Additional sprites are created on demand.
    const iconSpecCount = ICON_SPECS.length;
    if (iconSpecCount === 0) {
      // Without predefined icon variants the demo cannot render sprites, so bail out quietly.
      return;
    }

    const createSpriteInitEntry = (
      index: number
    ): SpriteInitEntry<DemoSpriteTag> => {
      const id = `sprite-${index}`;
      allSpriteIds.push(id);
      const imageSpec = ICON_SPECS[index % iconSpecCount]!;
      const primaryPlacement = resolvePrimaryImagePlacement(
        currentSpriteMode,
        isAutoRotationEnabled
      );

      // Prepare a tag object so the initializer can populate required fields.
      const newTag = {} as DemoSpriteTag;
      newTag.orderIndex = index;
      newTag.iconSpecId = imageSpec.id;
      const location = initializeMovementState(
        STARTUP_CENTER,
        currentAnimationMode,
        newTag
      );
      return {
        spriteId: id,
        location: {
          lng: location.lng,
          lat: location.lat,
        },
        tag: newTag,
        // Assign images to the sprite.
        images: [
          // Primary arrow image.
          {
            subLayer: PRIMARY_SUB_LAYER, // Place on the primary sub-layer.
            order: 0,
            imageId: getIconImageId(imageSpec.id, currentArrowShapeMode),
            mode: currentSpriteMode,
            autoRotation: isAutoRotationEnabled,
            rotateDeg: primaryPlacement.rotateDeg,
            anchor: primaryPlacement.anchor,
            interpolation: isRotateInterpolationEnabled
              ? {
                  rotateDeg: {
                    mode: rotateInterpolationMode,
                    durationMs: MOVEMENT_INTERVAL_MS,
                  },
                }
              : undefined,
          },
          // Orbiting satellite indicator.
          {
            subLayer: SECONDARY_SUB_LAYER, // Place on the secondary sub-layer.
            order: 0,
            imageId: SECONDARY_IMAGE_ID, // Fixed image ID.
            mode: 'billboard', // Always render the satellite as a billboard.
            autoRotation: false, // Satellite orbits the anchor and does not face direction.
            originLocation: { subLayer: PRIMARY_SUB_LAYER, order: 0 }, // Use the primary image as the origin.
            scale: SECONDARY_IMAGE_SCALE,
            opacity: currentSecondaryImageOrbitMode === 'hidden' ? 0.0 : 1.0,
            interpolation:
              isOrbitDegInterpolationEnabled ||
              isOrbitMetersInterpolationEnabled
                ? {
                    ...(isOrbitDegInterpolationEnabled
                      ? {
                          offsetDeg: {
                            mode: orbitOffsetDegInterpolationMode,
                            durationMs: MOVEMENT_INTERVAL_MS,
                          },
                        }
                      : {}),
                    ...(isOrbitMetersInterpolationEnabled
                      ? {
                          offsetMeters: {
                            mode: orbitOffsetMetersInterpolationMode,
                            durationMs: MOVEMENT_INTERVAL_MS,
                          },
                        }
                      : {}),
                  }
                : undefined,
          },
        ],
      };
    };

    syncSpritePoolWithLimit = (targetSize: number) => {
      const currentSize = allSpriteIds.length;
      let added = 0;
      let removed = 0;

      if (targetSize > currentSize) {
        const newEntries: SpriteInitEntry<DemoSpriteTag>[] = [];
        for (let index = currentSize; index < targetSize; index += 1) {
          newEntries.push(createSpriteInitEntry(index));
        }
        if (newEntries.length > 0) {
          spriteLayer.addSprites(newEntries);
          added = newEntries.length;
        }
      } else if (targetSize < currentSize) {
        const removedIds = allSpriteIds.splice(targetSize);
        if (removedIds.length > 0) {
          spriteLayer.removeSprites(removedIds);
          removed = removedIds.length;
        }
      }

      return { added, removed };
    };

    const initialSpriteEntries: SpriteInitEntry<DemoSpriteTag>[] = [];
    for (let i = 0; i < INITIAL_NUMBER_OF_SPRITES; i += 1) {
      initialSpriteEntries.push(createSpriteInitEntry(i));
    }
    if (initialSpriteEntries.length > 0) {
      spriteLayer.addSprites(initialSpriteEntries);
    }

    applyLocationInterpolationToAll();

    if (isRotateInterpolationEnabled) {
      // Apply rotation interpolation immediately so the initial state matches the toggle.
      applyRotateInterpolationToAll(true);
    }
    if (isOrbitDegInterpolationEnabled || isOrbitMetersInterpolationEnabled) {
      // Ensure orbit interpolation is set when the feature starts enabled.
      applyOrbitInterpolationToAll();
    }
    // Apply the layer visibility flag so initial state matches the toggle.
    applyLayerVisibility(isActive);

    if (typeof window !== 'undefined' && window.__spriteDemo) {
      // Broadcast readiness so integration tests or observers can react once sprites are drawn.
      window.__spriteDemo.spritesReady = true;
      window.__spriteDemo.activeSpriteCount = lastVisibleSpriteCount;
      window.__spriteDemo.spriteLimit = spriteVisibilityLimit;
      window.dispatchEvent(
        new CustomEvent('sprite-demo-ready', {
          detail: {
            activeSpriteCount: lastVisibleSpriteCount,
            spriteLimit: spriteVisibilityLimit,
          },
        })
      );
    }

    //////////////////////////////////////////////////////////////////////////////////
    // Animation loop.

    /**
     * Step handler that updates sprite positions at fixed intervals.
     * Handles movement, boundary reflection, and rotation calculation.
     */
    const performMovementStep = (): void => {
      if (!isMovementLoopEnabled) {
        // Skip processing when the movement loop toggle is OFF to conserve CPU time.
        return;
      }

      // Update every sprite.
      spriteLayer.updateForEach((sprite, update) => {
        const boundaryLng = STARTUP_CENTER.lng;
        const boundaryLat = STARTUP_CENTER.lat;

        const tag = sprite.tag!;

        // Feed-forward interpolation displays positions ahead of time; basing the next frame solely
        // on what was rendered would double the perceived speed. Keep the world coordinates stored
        // in the tag as the single source of truth and always compute differences from them.
        const prevWorldLng = tag.worldLng;
        const prevWorldLat = tag.worldLat;

        let nextWorldLng = prevWorldLng;
        let nextWorldLat = prevWorldLat;

        // Follow the precomputed path when linear mode is active.
        if (currentAnimationMode === 'linear' && tag.path) {
          const path = tag.path;
          path.progress += path.speed * MOVEMENT_STEP_FACTOR;
          // Wrap progress to 0 when it exceeds 1 to maintain looping motion.
          while (path.progress > 1) {
            path.progress -= 1;
          }
          nextWorldLng =
            path.startLng + (path.endLng - path.startLng) * path.progress;
          nextWorldLat =
            path.startLat + (path.endLat - path.startLat) * path.progress;
        } else {
          // In random mode, apply the velocity vector directly.
          nextWorldLng += tag.dx * MOVEMENT_STEP_FACTOR;
          nextWorldLat += tag.dy * MOVEMENT_STEP_FACTOR;

          if (
            nextWorldLng > boundaryLng + lngRadius ||
            nextWorldLng < boundaryLng - lngRadius
          ) {
            // Reverse longitude velocity when exceeding the allowed horizontal extent.
            tag.dx *= -1;
            nextWorldLng = Math.min(
              Math.max(nextWorldLng, boundaryLng - lngRadius),
              boundaryLng + lngRadius
            );
          }
          if (
            nextWorldLat > boundaryLat + latRadius ||
            nextWorldLat < boundaryLat - latRadius
          ) {
            // Reflect vertically when crossing the latitude bounds to keep sprites within view.
            tag.dy *= -1;
            nextWorldLat = Math.min(
              Math.max(nextWorldLat, boundaryLat - latRadius),
              boundaryLat + latRadius
            );
          }
        }

        const movementLng = nextWorldLng - prevWorldLng;
        const movementLat = nextWorldLat - prevWorldLat;

        // Only update lastStep when movement occurs to avoid noise while stationary.
        if (
          Math.abs(movementLng) > EPSILON_DELTA ||
          Math.abs(movementLat) > EPSILON_DELTA
        ) {
          tag.lastStepLng = movementLng;
          tag.lastStepLat = movementLat;
        }

        tag.worldLng = nextWorldLng;
        tag.worldLat = nextWorldLat;

        // Write the updated position.
        update.location = { lng: nextWorldLng, lat: nextWorldLat };

        // Apply interpolation only when there is visible motion to avoid unnecessary animation.
        const hasMovement =
          Math.abs(movementLng) > EPSILON_DELTA ||
          Math.abs(movementLat) > EPSILON_DELTA;
        if (hasMovement) {
          update.interpolation = isMovementInterpolationEnabled
            ? {
                mode: locationInterpolationMode,
                durationMs: MOVEMENT_INTERVAL_MS,
              }
            : null;
        }

        return true;
      });
      advanceSecondaryOrbitRotation();
    };

    // Execute the first step immediately, then continue on the interval timer.
    performMovementStep();
    startMovementInterval();
  });
};

// Log initialization failures so developers can spot them quickly.
main().catch((error) => {
  // Log asynchronous failures such as MapLibre initialization.
  // eslint-disable-next-line no-console
  console.error(error);
});
