// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

/**
 * shader.ts
 *
 * Centralises shader source definitions, buffer layout constants, reusable scratch
 * buffers, and helper utilities for compiling and linking WebGL shader programs.
 */

import type {
  SpriteAnchor,
  SpriteScreenPoint,
  SpriteTextureFilteringOptions,
  SpriteTextureMagFilter,
  SpriteTextureMinFilter,
} from '../types';
import type {
  ImageHandleBufferController,
  PreparedDrawSpriteImageParams,
  RegisteredImage,
  Releasable,
  ResolvedTextureFilteringOptions,
  RgbaColor,
  SurfaceShaderInputs,
} from '../internalTypes';
import type {
  AtlasManager,
  AtlasOperationQueue,
  AtlasPageState,
} from './atlas';
import { DEG2RAD, UV_CORNERS } from '../const';
import { DEFAULT_TEXTURE_FILTERING_OPTIONS } from '../default';

//////////////////////////////////////////////////////////////////////////////////////

/** Number of components per vertex (clipPosition.xyzw + uv.xy). */
export const VERTEX_COMPONENT_COUNT = 6;
/** Component count for clip-space position attributes. */
export const POSITION_COMPONENT_COUNT = 4;
/** Component count for UV attributes. */
export const UV_COMPONENT_COUNT = 2;
/** Byte size of a Float32. */
export const FLOAT_SIZE = Float32Array.BYTES_PER_ELEMENT;
/** Stride per vertex in bytes. */
export const VERTEX_STRIDE = VERTEX_COMPONENT_COUNT * FLOAT_SIZE;
/** Byte offset for the UV attribute. */
export const UV_OFFSET = POSITION_COMPONENT_COUNT * FLOAT_SIZE;
/** Vertex count required to draw one sprite as two triangles. */
export const QUAD_VERTEX_COUNT = 6;

/** Initial vertex data for a unit quad. */
export const INITIAL_QUAD_VERTICES = new Float32Array(
  QUAD_VERTEX_COUNT * VERTEX_COMPONENT_COUNT
);

/** Scratch buffer rewritten for each draw call. */
export const QUAD_VERTEX_SCRATCH = new Float32Array(
  QUAD_VERTEX_COUNT * VERTEX_COMPONENT_COUNT
);

//////////////////////////////////////////////////////////////////////////////////////

/** Shared vertex shader that converts screen-space vertices when requested. */
const VERTEX_SHADER_SOURCE = `
attribute vec4 a_position;
attribute vec2 a_uv;
uniform vec2 u_screenToClipScale;
uniform vec2 u_screenToClipOffset;
uniform float u_billboardMode;
uniform float u_surfaceMode;
uniform vec2 u_billboardCenter;
uniform vec2 u_billboardHalfSize;
uniform vec2 u_billboardAnchor;
uniform vec2 u_billboardSinCos;
uniform float u_surfaceClipEnabled;
uniform mat4 u_surfaceClipMatrix;
uniform float u_surfaceDepthBias;
varying vec2 v_uv;
vec2 computeBillboardCorner(vec2 baseCorner) {
  vec2 anchorShift = vec2(u_billboardAnchor.x * u_billboardHalfSize.x, u_billboardAnchor.y * u_billboardHalfSize.y);
  vec2 shifted = vec2(baseCorner.x * u_billboardHalfSize.x, baseCorner.y * u_billboardHalfSize.y) - anchorShift;
  float sinR = u_billboardSinCos.x;
  float cosR = u_billboardSinCos.y;
  vec2 rotated = vec2(
    shifted.x * cosR - shifted.y * sinR,
    shifted.x * sinR + shifted.y * cosR
  );
  return vec2(
    u_billboardCenter.x + rotated.x,
    u_billboardCenter.y - rotated.y
  );
}
vec4 computeSurfaceCorner(vec2 corner) {
  if (u_surfaceClipEnabled < 0.5) {
    return vec4(0.0, 0.0, 0.0, 1.0);
  }
  vec4 clip = u_surfaceClipMatrix * vec4(1.0, corner.x, corner.y, 0.0);
  clip.z += u_surfaceDepthBias * clip.w;
  return clip;
}
void main() {
  v_uv = a_uv;
  vec4 position;
  if (u_billboardMode > 0.5) {
    vec2 screenPosition = computeBillboardCorner(a_position.xy);
    position = vec4(screenPosition, 0.0, 1.0);
  } else if (u_surfaceMode > 0.5) {
    vec2 baseCorner = vec2(a_position.x, a_position.y);
    position = computeSurfaceCorner(baseCorner);
  } else {
    position = a_position;
  }
  position.xy = position.xy * u_screenToClipScale + u_screenToClipOffset;
  gl_Position = position;
}
` as const;

/** Fragment shader that applies texture sampling and opacity. */
const FRAGMENT_SHADER_SOURCE = `
precision mediump float;
uniform sampler2D u_texture;
uniform float u_opacity;
varying vec2 v_uv;
void main() {
  vec4 texel = texture2D(u_texture, v_uv);
  gl_FragColor = vec4(texel.rgb, texel.a) * u_opacity;
}
` as const;

/** Vertex shader for sprite-border outline rendering using screen coordinates. */
const BORDER_OUTLINE_VERTEX_SHADER_SOURCE = `
attribute vec4 a_position;
uniform vec2 u_screenToClipScale;
uniform vec2 u_screenToClipOffset;
void main() {
  vec4 position = a_position;
  position.xy = position.xy * u_screenToClipScale + u_screenToClipOffset;
  gl_Position = position;
}
` as const;

/** Fragment shader emitting a solid color for border outlines. */
const BORDER_OUTLINE_FRAGMENT_SHADER_SOURCE = `
precision mediump float;
uniform vec4 u_color;
void main() {
  gl_FragColor = u_color;
}
` as const;

/** Maximum vertex count when drawing a quad outline as four edge quads (two triangles per edge). */
const BORDER_OUTLINE_MAX_VERTEX_COUNT =
  4 /* edges */ * 2 /* triangles */ * 3; /* vertices */

/** Components per debug outline vertex (clipPosition.xyzw). */
const BORDER_OUTLINE_POSITION_COMPONENT_COUNT = 4;

/** Stride in bytes for debug outline vertices. */
const BORDER_OUTLINE_VERTEX_STRIDE =
  BORDER_OUTLINE_POSITION_COMPONENT_COUNT * FLOAT_SIZE;

/** Scratch buffer reused when emitting debug outlines. */
const BORDER_OUTLINE_VERTEX_SCRATCH = new Float32Array(
  BORDER_OUTLINE_MAX_VERTEX_COUNT * BORDER_OUTLINE_POSITION_COMPONENT_COUNT
);

/** Components per leader line vertex (clipPosition.xyzw). */
const LEADER_LINE_POSITION_COMPONENT_COUNT = 4;
/** Vertex count when drawing a single thick line as two triangles. */
const LEADER_LINE_VERTEX_COUNT = 6;
/** Stride in bytes for leader line vertices. */
const LEADER_LINE_VERTEX_STRIDE =
  LEADER_LINE_POSITION_COMPONENT_COUNT * FLOAT_SIZE;
/** Scratch buffer reused when emitting leader line quads. */
const LEADER_LINE_VERTEX_SCRATCH = new Float32Array(
  LEADER_LINE_VERTEX_COUNT * LEADER_LINE_POSITION_COMPONENT_COUNT
);

/** Corner traversal order used when outlining a quad without crossing diagonals. */
export const BORDER_OUTLINE_CORNER_ORDER = [0, 1, 3, 2] as const;

/** Base corner definitions used when expanding billboards in shaders. */
export const BILLBOARD_BASE_CORNERS: ReadonlyArray<readonly [number, number]> =
  [
    [-1, 1],
    [1, 1],
    [-1, -1],
    [1, -1],
  ] as const;

/** Base corner definitions used when expanding surface quads in shaders. */
export const SURFACE_BASE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, 1],
  [1, 1],
  [-1, -1],
  [1, -1],
] as const;

//////////////////////////////////////////////////////////////////////////////////////

export const computeBillboardCornersShaderModel = ({
  center,
  halfWidth,
  halfHeight,
  anchor,
  rotationDeg,
}: {
  center: Readonly<SpriteScreenPoint>;
  halfWidth: number;
  halfHeight: number;
  anchor?: Readonly<SpriteAnchor>;
  rotationDeg: number;
}): Array<{ x: number; y: number; u: number; v: number }> => {
  const anchorX = anchor?.x ?? 0;
  const anchorY = anchor?.y ?? 0;
  const rad = -rotationDeg * DEG2RAD;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  return BILLBOARD_BASE_CORNERS.map(([cornerXNorm, cornerYNorm], index) => {
    const cornerX = cornerXNorm * halfWidth;
    const cornerY = cornerYNorm * halfHeight;
    const shiftedX = cornerX - anchorX * halfWidth;
    const shiftedY = cornerY - anchorY * halfHeight;
    const rotatedX = shiftedX * cosR - shiftedY * sinR;
    const rotatedY = shiftedX * sinR + shiftedY * cosR;
    const [u, v] = UV_CORNERS[index]!;
    return {
      x: center.x + rotatedX,
      y: center.y - rotatedY,
      u,
      v,
    };
  });
};

/**
 * Compiles a shader from source, throwing if compilation fails.
 * @param {WebGLRenderingContext} glContext - Active WebGL context.
 * @param {number} type - Shader type (`VERTEX_SHADER` or `FRAGMENT_SHADER`).
 * @param {string} source - GLSL source code.
 * @returns {WebGLShader} Compiled shader object.
 * @throws When shader creation or compilation fails.
 */
export const compileShader = (
  glContext: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader => {
  const shader = glContext.createShader(type);
  if (!shader) {
    throw new Error('Failed to create shader.');
  }
  glContext.shaderSource(shader, source);
  glContext.compileShader(shader);
  if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
    const info = glContext.getShaderInfoLog(shader) ?? 'unknown error';
    glContext.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info}`);
  }
  return shader;
};

/**
 * Links a vertex and fragment shader into a WebGL program.
 * @param {WebGLRenderingContext} glContext - Active WebGL context.
 * @param {string} vertexSource - Vertex shader GLSL source.
 * @param {string} fragmentSource - Fragment shader GLSL source.
 * @returns {WebGLProgram} Linked shader program ready for use.
 * @throws When linking fails or a program cannot be created.
 */
export const createShaderProgram = (
  glContext: WebGLRenderingContext,
  vertexSource: string,
  fragmentSource: string
): WebGLProgram => {
  const vertexShader = compileShader(
    glContext,
    glContext.VERTEX_SHADER,
    vertexSource
  );
  const fragmentShader = compileShader(
    glContext,
    glContext.FRAGMENT_SHADER,
    fragmentSource
  );
  const program = glContext.createProgram();
  if (!program) {
    glContext.deleteShader(vertexShader);
    glContext.deleteShader(fragmentShader);
    throw new Error('Failed to create WebGL program.');
  }
  glContext.attachShader(program, vertexShader);
  glContext.attachShader(program, fragmentShader);
  glContext.linkProgram(program);
  glContext.deleteShader(vertexShader);
  glContext.deleteShader(fragmentShader);

  if (!glContext.getProgramParameter(program, glContext.LINK_STATUS)) {
    const info = glContext.getProgramInfoLog(program) ?? 'unknown error';
    glContext.deleteProgram(program);
    throw new Error(`Program link failed: ${info}`);
  }

  return program;
};

const SURFACE_CLIP_MATRIX_IDENTITY = new Float32Array([
  0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

const FLOATS_PER_VERTEX = VERTEX_COMPONENT_COUNT;
const FLOATS_PER_SPRITE = QUAD_VERTEX_COUNT * VERTEX_COMPONENT_COUNT;

export interface SpriteDrawProgram<TTag> extends Releasable {
  beginFrame(): void;
  uploadVertexBatch(items: PreparedDrawSpriteImageParams<TTag>[]): void;
  draw(prepared: PreparedDrawSpriteImageParams<TTag>): boolean;
}

export const createSpriteDrawProgram = <TTag>(
  glContext: WebGLRenderingContext
): SpriteDrawProgram<TTag> => {
  const vertexBuffer = glContext.createBuffer();
  if (!vertexBuffer) {
    throw new Error('Failed to create vertex buffer.');
  }

  glContext.bindBuffer(glContext.ARRAY_BUFFER, vertexBuffer);
  glContext.bufferData(
    glContext.ARRAY_BUFFER,
    INITIAL_QUAD_VERTICES,
    glContext.DYNAMIC_DRAW
  );

  let vertexBufferCapacityFloats = INITIAL_QUAD_VERTICES.length;

  const program = createShaderProgram(
    glContext,
    VERTEX_SHADER_SOURCE,
    FRAGMENT_SHADER_SOURCE
  );
  glContext.useProgram(program);

  const attribPositionLocation = glContext.getAttribLocation(
    program,
    'a_position'
  );
  const attribUvLocation = glContext.getAttribLocation(program, 'a_uv');
  if (attribPositionLocation === -1 || attribUvLocation === -1) {
    glContext.deleteBuffer(vertexBuffer);
    glContext.deleteProgram(program);
    throw new Error('Failed to acquire attribute locations.');
  }

  const uniformTextureLocation = glContext.getUniformLocation(
    program,
    'u_texture'
  );
  const uniformOpacityLocation = glContext.getUniformLocation(
    program,
    'u_opacity'
  );
  const uniformScreenToClipScaleLocation = glContext.getUniformLocation(
    program,
    'u_screenToClipScale'
  );
  const uniformScreenToClipOffsetLocation = glContext.getUniformLocation(
    program,
    'u_screenToClipOffset'
  );
  const uniformBillboardModeLocation = glContext.getUniformLocation(
    program,
    'u_billboardMode'
  );
  const uniformBillboardCenterLocation = glContext.getUniformLocation(
    program,
    'u_billboardCenter'
  );
  const uniformBillboardHalfSizeLocation = glContext.getUniformLocation(
    program,
    'u_billboardHalfSize'
  );
  const uniformBillboardAnchorLocation = glContext.getUniformLocation(
    program,
    'u_billboardAnchor'
  );
  const uniformBillboardSinCosLocation = glContext.getUniformLocation(
    program,
    'u_billboardSinCos'
  );
  const uniformSurfaceModeLocation = glContext.getUniformLocation(
    program,
    'u_surfaceMode'
  );
  const uniformSurfaceDepthBiasLocation = glContext.getUniformLocation(
    program,
    'u_surfaceDepthBias'
  );
  const uniformSurfaceClipEnabledLocation = glContext.getUniformLocation(
    program,
    'u_surfaceClipEnabled'
  );
  const uniformSurfaceClipMatrixLocation = glContext.getUniformLocation(
    program,
    'u_surfaceClipMatrix'
  );

  if (
    !uniformTextureLocation ||
    !uniformOpacityLocation ||
    !uniformScreenToClipScaleLocation ||
    !uniformScreenToClipOffsetLocation ||
    !uniformBillboardModeLocation ||
    !uniformBillboardCenterLocation ||
    !uniformBillboardHalfSizeLocation ||
    !uniformBillboardAnchorLocation ||
    !uniformBillboardSinCosLocation ||
    !uniformSurfaceModeLocation ||
    !uniformSurfaceDepthBiasLocation ||
    !uniformSurfaceClipEnabledLocation ||
    !uniformSurfaceClipMatrixLocation
  ) {
    glContext.deleteBuffer(vertexBuffer);
    glContext.deleteProgram(program);
    throw new Error('Failed to acquire uniform locations.');
  }

  glContext.uniform1i(uniformTextureLocation, 0);
  glContext.uniform1f(uniformOpacityLocation, 1.0);
  glContext.uniform2f(uniformScreenToClipScaleLocation, 1.0, 1.0);
  glContext.uniform2f(uniformScreenToClipOffsetLocation, 0.0, 0.0);
  glContext.uniform1f(uniformSurfaceClipEnabledLocation, 0.0);
  glContext.uniformMatrix4fv(
    uniformSurfaceClipMatrixLocation,
    false,
    SURFACE_CLIP_MATRIX_IDENTITY
  );
  glContext.uniform1f(uniformBillboardModeLocation, 0);
  glContext.uniform2f(uniformBillboardCenterLocation, 0.0, 0.0);
  glContext.uniform2f(uniformBillboardHalfSizeLocation, 0.0, 0.0);
  glContext.uniform2f(uniformBillboardAnchorLocation, 0.0, 0.0);
  glContext.uniform2f(uniformBillboardSinCosLocation, 0.0, 1.0);
  glContext.uniform1f(uniformSurfaceModeLocation, 0);
  glContext.uniform1f(uniformSurfaceDepthBiasLocation, 0);

  const vertexBatchOffsets = new Map<
    PreparedDrawSpriteImageParams<TTag>,
    number
  >();
  let batchedVertexScratch = new Float32Array(FLOATS_PER_SPRITE);

  const ensureVertexBatchCapacity = (requiredFloatCount: number): void => {
    if (batchedVertexScratch.length >= requiredFloatCount) {
      return;
    }
    let capacity = batchedVertexScratch.length || FLOATS_PER_SPRITE;
    while (capacity < requiredFloatCount) {
      capacity *= 2;
    }
    batchedVertexScratch = new Float32Array(capacity);
  };

  const ensureVertexBufferCapacity = (requiredFloatCount: number): void => {
    if (requiredFloatCount <= vertexBufferCapacityFloats) {
      return;
    }
    let capacity = Math.max(vertexBufferCapacityFloats, FLOATS_PER_SPRITE);
    while (capacity < requiredFloatCount) {
      capacity *= 2;
    }
    glContext.bufferData(
      glContext.ARRAY_BUFFER,
      capacity * FLOAT_SIZE,
      glContext.DYNAMIC_DRAW
    );
    vertexBufferCapacityFloats = capacity;
  };

  const orphanVertexBuffer = (): void => {
    glContext.bufferData(
      glContext.ARRAY_BUFFER,
      vertexBufferCapacityFloats * FLOAT_SIZE,
      glContext.DYNAMIC_DRAW
    );
  };

  let currentScaleX = Number.NaN;
  let currentScaleY = Number.NaN;
  let currentOffsetX = Number.NaN;
  let currentOffsetY = Number.NaN;
  let currentSurfaceMode = Number.NaN;
  let currentSurfaceClipEnabled = Number.NaN;
  const currentSurfaceClipMatrix = new Float32Array(16);
  currentSurfaceClipMatrix.fill(Number.NaN);
  const surfaceClipMatrixScratch = new Float32Array(16);
  let currentSurfaceDepthBias = Number.NaN;
  let currentBillboardMode = Number.NaN;
  const currentBillboardCenter = { x: Number.NaN, y: Number.NaN };
  const currentBillboardHalfSize = { x: Number.NaN, y: Number.NaN };
  const currentBillboardAnchor = { x: Number.NaN, y: Number.NaN };
  const currentBillboardSinCos = { x: Number.NaN, y: Number.NaN };
  let currentOpacity = Number.NaN;
  let currentBoundTexture: WebGLTexture | null = null;

  const resetFrameState = (): void => {
    currentScaleX = Number.NaN;
    currentScaleY = Number.NaN;
    currentOffsetX = Number.NaN;
    currentOffsetY = Number.NaN;
    currentSurfaceMode = Number.NaN;
    currentSurfaceClipEnabled = Number.NaN;
    currentSurfaceClipMatrix.fill(Number.NaN);
    currentSurfaceDepthBias = Number.NaN;
    currentBillboardMode = Number.NaN;
    currentBillboardCenter.x = Number.NaN;
    currentBillboardCenter.y = Number.NaN;
    currentBillboardHalfSize.x = Number.NaN;
    currentBillboardHalfSize.y = Number.NaN;
    currentBillboardAnchor.x = Number.NaN;
    currentBillboardAnchor.y = Number.NaN;
    currentBillboardSinCos.x = Number.NaN;
    currentBillboardSinCos.y = Number.NaN;
    currentOpacity = Number.NaN;
    currentBoundTexture = null;
    vertexBatchOffsets.clear();
  };

  const matricesEqual = (a: Float32Array, b: Float32Array): boolean => {
    for (let index = 0; index < a.length; index++) {
      if (a[index] !== b[index]) {
        return false;
      }
    }
    return true;
  };

  const writeSurfaceClipMatrix = (
    target: Float32Array,
    inputs: SurfaceShaderInputs
  ): void => {
    const center = inputs.clipCenter;
    const basisEast = inputs.clipBasisEast;
    const basisNorth = inputs.clipBasisNorth;
    target[0] = center.x;
    target[1] = center.y;
    target[2] = center.z;
    target[3] = center.w;
    target[4] = basisEast.x;
    target[5] = basisEast.y;
    target[6] = basisEast.z;
    target[7] = basisEast.w;
    target[8] = basisNorth.x;
    target[9] = basisNorth.y;
    target[10] = basisNorth.z;
    target[11] = basisNorth.w;
    target[12] = 0;
    target[13] = 0;
    target[14] = 0;
    target[15] = 0;
  };

  const applyScreenToClipUniforms = (
    scaleX: number,
    scaleY: number,
    offsetX: number,
    offsetY: number
  ): void => {
    if (
      scaleX !== currentScaleX ||
      scaleY !== currentScaleY ||
      offsetX !== currentOffsetX ||
      offsetY !== currentOffsetY
    ) {
      glContext.uniform2f(uniformScreenToClipScaleLocation, scaleX, scaleY);
      glContext.uniform2f(uniformScreenToClipOffsetLocation, offsetX, offsetY);
      currentScaleX = scaleX;
      currentScaleY = scaleY;
      currentOffsetX = offsetX;
      currentOffsetY = offsetY;
    }
  };

  const applySurfaceMode = (enabled: boolean): void => {
    const value = enabled ? 1 : 0;
    if (value !== currentSurfaceMode) {
      glContext.uniform1f(uniformSurfaceModeLocation, value);
      currentSurfaceMode = value;
    }
  };

  const applySurfaceClipUniforms = (
    enabled: boolean,
    inputs: SurfaceShaderInputs | null
  ): void => {
    const hasInputs = Boolean(enabled && inputs);
    const value = hasInputs ? 1 : 0;
    if (value !== currentSurfaceClipEnabled) {
      glContext.uniform1f(uniformSurfaceClipEnabledLocation, value);
      currentSurfaceClipEnabled = value;
    }
    if (!hasInputs || !inputs) {
      return;
    }
    writeSurfaceClipMatrix(surfaceClipMatrixScratch, inputs);
    if (!matricesEqual(surfaceClipMatrixScratch, currentSurfaceClipMatrix)) {
      glContext.uniformMatrix4fv(
        uniformSurfaceClipMatrixLocation,
        false,
        surfaceClipMatrixScratch
      );
      currentSurfaceClipMatrix.set(surfaceClipMatrixScratch);
    }
  };

  const beginFrame = (): void => {
    glContext.useProgram(program);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, vertexBuffer);
    glContext.enableVertexAttribArray(attribPositionLocation);
    glContext.vertexAttribPointer(
      attribPositionLocation,
      POSITION_COMPONENT_COUNT,
      glContext.FLOAT,
      false,
      VERTEX_STRIDE,
      0
    );
    glContext.enableVertexAttribArray(attribUvLocation);
    glContext.vertexAttribPointer(
      attribUvLocation,
      UV_COMPONENT_COUNT,
      glContext.FLOAT,
      false,
      VERTEX_STRIDE,
      UV_OFFSET
    );
    resetFrameState();
  };

  const uploadVertexBatch = (
    items: PreparedDrawSpriteImageParams<TTag>[]
  ): void => {
    vertexBatchOffsets.clear();
    if (items.length === 0) {
      return;
    }
    let requiredFloatCount = 0;
    for (const prepared of items) {
      requiredFloatCount += prepared.vertexData.length;
    }
    ensureVertexBatchCapacity(requiredFloatCount);
    let floatOffset = 0;
    let vertexOffset = 0;
    for (const prepared of items) {
      const data = prepared.vertexData;
      batchedVertexScratch.set(data, floatOffset);
      vertexBatchOffsets.set(prepared, vertexOffset);
      floatOffset += data.length;
      vertexOffset += data.length / FLOATS_PER_VERTEX;
    }
    const uploadView = batchedVertexScratch.subarray(0, floatOffset);
    ensureVertexBufferCapacity(uploadView.length);
    orphanVertexBuffer();
    glContext.bufferSubData(glContext.ARRAY_BUFFER, 0, uploadView);
  };

  const draw = (prepared: PreparedDrawSpriteImageParams<TTag>): boolean => {
    const { screenToClip } = prepared;
    applyScreenToClipUniforms(
      screenToClip.scaleX,
      screenToClip.scaleY,
      screenToClip.offsetX,
      screenToClip.offsetY
    );

    applySurfaceMode(prepared.useShaderSurface);

    const surfaceInputs = prepared.surfaceShaderInputs;
    if (prepared.useShaderSurface && surfaceInputs) {
      const depthBias = surfaceInputs.depthBiasNdc;
      if (depthBias !== currentSurfaceDepthBias) {
        glContext.uniform1f(uniformSurfaceDepthBiasLocation, depthBias);
        currentSurfaceDepthBias = depthBias;
      }
      applySurfaceClipUniforms(
        prepared.surfaceClipEnabled,
        prepared.surfaceClipEnabled ? surfaceInputs : null
      );
    } else {
      if (currentSurfaceDepthBias !== 0) {
        glContext.uniform1f(uniformSurfaceDepthBiasLocation, 0);
        currentSurfaceDepthBias = 0;
      }
      applySurfaceClipUniforms(false, null);
    }

    const billboardMode = prepared.useShaderBillboard ? 1 : 0;
    if (billboardMode !== currentBillboardMode) {
      glContext.uniform1f(uniformBillboardModeLocation, billboardMode);
      currentBillboardMode = billboardMode;
    }
    if (prepared.useShaderBillboard && prepared.billboardUniforms) {
      const uniforms = prepared.billboardUniforms;
      if (
        uniforms.center.x !== currentBillboardCenter.x ||
        uniforms.center.y !== currentBillboardCenter.y
      ) {
        glContext.uniform2f(
          uniformBillboardCenterLocation,
          uniforms.center.x,
          uniforms.center.y
        );
        currentBillboardCenter.x = uniforms.center.x;
        currentBillboardCenter.y = uniforms.center.y;
      }
      if (
        uniforms.halfWidth !== currentBillboardHalfSize.x ||
        uniforms.halfHeight !== currentBillboardHalfSize.y
      ) {
        glContext.uniform2f(
          uniformBillboardHalfSizeLocation,
          uniforms.halfWidth,
          uniforms.halfHeight
        );
        currentBillboardHalfSize.x = uniforms.halfWidth;
        currentBillboardHalfSize.y = uniforms.halfHeight;
      }
      if (
        uniforms.anchor.x !== currentBillboardAnchor.x ||
        uniforms.anchor.y !== currentBillboardAnchor.y
      ) {
        glContext.uniform2f(
          uniformBillboardAnchorLocation,
          uniforms.anchor.x,
          uniforms.anchor.y
        );
        currentBillboardAnchor.x = uniforms.anchor.x;
        currentBillboardAnchor.y = uniforms.anchor.y;
      }
      if (
        uniforms.sin !== currentBillboardSinCos.x ||
        uniforms.cos !== currentBillboardSinCos.y
      ) {
        glContext.uniform2f(
          uniformBillboardSinCosLocation,
          uniforms.sin,
          uniforms.cos
        );
        currentBillboardSinCos.x = uniforms.sin;
        currentBillboardSinCos.y = uniforms.cos;
      }
    }

    const texture = prepared.imageResource.texture;
    if (!texture) {
      return false;
    }

    if (prepared.opacity !== currentOpacity) {
      glContext.uniform1f(uniformOpacityLocation, prepared.opacity);
      currentOpacity = prepared.opacity;
    }
    if (currentBoundTexture !== texture) {
      glContext.activeTexture(glContext.TEXTURE0);
      glContext.bindTexture(glContext.TEXTURE_2D, texture);
      currentBoundTexture = texture;
    }

    const vertexOffset = vertexBatchOffsets.get(prepared);
    if (vertexOffset === undefined) {
      return false;
    }

    glContext.drawArrays(glContext.TRIANGLES, vertexOffset, QUAD_VERTEX_COUNT);
    return true;
  };

  const release = (): void => {
    glContext.deleteBuffer(vertexBuffer);
    glContext.deleteProgram(program);
  };

  return {
    beginFrame,
    uploadVertexBatch,
    draw,
    release,
  };
};

export interface BorderOutlineRenderer extends Releasable {
  begin(
    screenToClipScaleX: number,
    screenToClipScaleY: number,
    screenToClipOffsetX: number,
    screenToClipOffsetY: number
  ): void;
  drawOutline(
    corners: readonly [
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
    ],
    color: RgbaColor,
    lineWidth: number
  ): void;
  end(): void;
}

export const createBorderOutlineRenderer = (
  glContext: WebGLRenderingContext
): BorderOutlineRenderer => {
  const program = createShaderProgram(
    glContext,
    BORDER_OUTLINE_VERTEX_SHADER_SOURCE,
    BORDER_OUTLINE_FRAGMENT_SHADER_SOURCE
  );

  const attribPositionLocation = glContext.getAttribLocation(
    program,
    'a_position'
  );
  if (attribPositionLocation === -1) {
    glContext.deleteProgram(program);
    throw new Error('Failed to acquire outline attribute location.');
  }

  const uniformColorLocation = glContext.getUniformLocation(program, 'u_color');
  const uniformScreenToClipScaleLocation = glContext.getUniformLocation(
    program,
    'u_screenToClipScale'
  );
  const uniformScreenToClipOffsetLocation = glContext.getUniformLocation(
    program,
    'u_screenToClipOffset'
  );
  if (
    !uniformColorLocation ||
    !uniformScreenToClipScaleLocation ||
    !uniformScreenToClipOffsetLocation
  ) {
    glContext.deleteProgram(program);
    throw new Error('Failed to acquire outline uniforms.');
  }

  const vertexBuffer = glContext.createBuffer();
  if (!vertexBuffer) {
    glContext.deleteProgram(program);
    throw new Error('Failed to create outline vertex buffer.');
  }
  glContext.bindBuffer(glContext.ARRAY_BUFFER, vertexBuffer);
  glContext.bufferData(
    glContext.ARRAY_BUFFER,
    BORDER_OUTLINE_VERTEX_SCRATCH,
    glContext.DYNAMIC_DRAW
  );
  glContext.bindBuffer(glContext.ARRAY_BUFFER, null);

  let active = false;

  const begin = (
    screenToClipScaleX: number,
    screenToClipScaleY: number,
    screenToClipOffsetX: number,
    screenToClipOffsetY: number
  ): void => {
    glContext.useProgram(program);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, vertexBuffer);
    glContext.enableVertexAttribArray(attribPositionLocation);
    glContext.vertexAttribPointer(
      attribPositionLocation,
      BORDER_OUTLINE_POSITION_COMPONENT_COUNT,
      glContext.FLOAT,
      false,
      BORDER_OUTLINE_VERTEX_STRIDE,
      0
    );
    glContext.disable(glContext.DEPTH_TEST);
    glContext.depthMask(false);
    glContext.uniform2f(
      uniformScreenToClipScaleLocation,
      screenToClipScaleX,
      screenToClipScaleY
    );
    glContext.uniform2f(
      uniformScreenToClipOffsetLocation,
      screenToClipOffsetX,
      screenToClipOffsetY
    );
    glContext.lineWidth(1);
    active = true;
  };

  const currentColor = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];

  const applyColor = (color: RgbaColor): void => {
    const [r, g, b, a] = color;
    if (
      currentColor[0] !== r ||
      currentColor[1] !== g ||
      currentColor[2] !== b ||
      currentColor[3] !== a
    ) {
      glContext.uniform4f(uniformColorLocation, r, g, b, a);
      currentColor[0] = r;
      currentColor[1] = g;
      currentColor[2] = b;
      currentColor[3] = a;
    }
  };

  const drawOutline = (
    corners: readonly [
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
    ],
    color: RgbaColor,
    lineWidth: number
  ): void => {
    if (!active) {
      return;
    }
    applyColor(color);

    // gl.lineWidth is clamped to 1px on many platforms, so build a quad ring in
    // screen space to visualize thicker borders.
    const halfWidth =
      Number.isFinite(lineWidth) && lineWidth > 0 ? lineWidth / 2 : 0;
    if (halfWidth <= 0) {
      return;
    }

    // Determine winding to pick outward normals correctly.
    let signedArea = 0;
    for (let i = 0; i < BORDER_OUTLINE_CORNER_ORDER.length; i++) {
      const a = corners[BORDER_OUTLINE_CORNER_ORDER[i]!]!;
      const b = corners[BORDER_OUTLINE_CORNER_ORDER[(i + 1) % 4]!]!;
      signedArea += a.x * b.y - b.x * a.y;
    }
    const isCcw = signedArea >= 0;

    let writeOffset = 0;
    const emitVertex = (point: SpriteScreenPoint): void => {
      BORDER_OUTLINE_VERTEX_SCRATCH[writeOffset++] = point.x;
      BORDER_OUTLINE_VERTEX_SCRATCH[writeOffset++] = point.y;
      BORDER_OUTLINE_VERTEX_SCRATCH[writeOffset++] = 0;
      BORDER_OUTLINE_VERTEX_SCRATCH[writeOffset++] = 1;
    };

    for (let i = 0; i < BORDER_OUTLINE_CORNER_ORDER.length; i++) {
      const start = corners[BORDER_OUTLINE_CORNER_ORDER[i]!]!;
      const end = corners[BORDER_OUTLINE_CORNER_ORDER[(i + 1) % 4]!]!;

      const dirX = end.x - start.x;
      const dirY = end.y - start.y;
      const length = Math.hypot(dirX, dirY);
      if (length <= 0) {
        continue;
      }

      // outward normal (right-hand for CCW, left-hand for CW)
      const normalX = (isCcw ? dirY : -dirY) / length;
      const normalY = (isCcw ? -dirX : dirX) / length;
      const offsetX = normalX * halfWidth;
      const offsetY = normalY * halfWidth;

      const v0 = { x: start.x + offsetX, y: start.y + offsetY };
      const v1 = { x: end.x + offsetX, y: end.y + offsetY };
      const v2 = { x: end.x - offsetX, y: end.y - offsetY };
      const v3 = { x: start.x - offsetX, y: start.y - offsetY };

      // Two triangles per edge quad.
      emitVertex(v0);
      emitVertex(v1);
      emitVertex(v2);
      emitVertex(v0);
      emitVertex(v2);
      emitVertex(v3);
    }

    const vertexCount = writeOffset / BORDER_OUTLINE_POSITION_COMPONENT_COUNT;
    if (vertexCount <= 0) {
      return;
    }

    glContext.bufferSubData(
      glContext.ARRAY_BUFFER,
      0,
      BORDER_OUTLINE_VERTEX_SCRATCH
    );
    glContext.drawArrays(glContext.TRIANGLES, 0, vertexCount);
  };

  const end = (): void => {
    if (!active) {
      return;
    }
    currentColor[0] = Number.NaN;
    currentColor[1] = Number.NaN;
    currentColor[2] = Number.NaN;
    currentColor[3] = Number.NaN;
    glContext.depthMask(true);
    glContext.enable(glContext.DEPTH_TEST);
    glContext.disableVertexAttribArray(attribPositionLocation);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, null);
    active = false;
  };

  const release = (): void => {
    end();
    glContext.deleteBuffer(vertexBuffer);
    glContext.deleteProgram(program);
  };

  return {
    begin,
    drawOutline,
    end,
    release,
  };
};

export interface LeaderLineRenderer extends Releasable {
  begin(
    screenToClipScaleX: number,
    screenToClipScaleY: number,
    screenToClipOffsetX: number,
    screenToClipOffsetY: number
  ): void;
  drawLine(
    from: Readonly<SpriteScreenPoint>,
    to: Readonly<SpriteScreenPoint>,
    color: RgbaColor,
    lineWidth: number
  ): void;
  end(): void;
}

export const createLeaderLineRenderer = (
  glContext: WebGLRenderingContext
): LeaderLineRenderer => {
  const program = createShaderProgram(
    glContext,
    BORDER_OUTLINE_VERTEX_SHADER_SOURCE,
    BORDER_OUTLINE_FRAGMENT_SHADER_SOURCE
  );

  const attribPositionLocation = glContext.getAttribLocation(
    program,
    'a_position'
  );
  if (attribPositionLocation === -1) {
    glContext.deleteProgram(program);
    throw new Error('Failed to acquire leader line attribute location.');
  }

  const uniformColorLocation = glContext.getUniformLocation(program, 'u_color');
  const uniformScreenToClipScaleLocation = glContext.getUniformLocation(
    program,
    'u_screenToClipScale'
  );
  const uniformScreenToClipOffsetLocation = glContext.getUniformLocation(
    program,
    'u_screenToClipOffset'
  );
  if (
    !uniformColorLocation ||
    !uniformScreenToClipScaleLocation ||
    !uniformScreenToClipOffsetLocation
  ) {
    glContext.deleteProgram(program);
    throw new Error('Failed to acquire leader line uniforms.');
  }

  const vertexBuffer = glContext.createBuffer();
  if (!vertexBuffer) {
    glContext.deleteProgram(program);
    throw new Error('Failed to create leader line vertex buffer.');
  }
  glContext.bindBuffer(glContext.ARRAY_BUFFER, vertexBuffer);
  glContext.bufferData(
    glContext.ARRAY_BUFFER,
    LEADER_LINE_VERTEX_SCRATCH,
    glContext.DYNAMIC_DRAW
  );
  glContext.bindBuffer(glContext.ARRAY_BUFFER, null);

  let active = false;

  const begin = (
    screenToClipScaleX: number,
    screenToClipScaleY: number,
    screenToClipOffsetX: number,
    screenToClipOffsetY: number
  ): void => {
    glContext.useProgram(program);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, vertexBuffer);
    glContext.enableVertexAttribArray(attribPositionLocation);
    glContext.vertexAttribPointer(
      attribPositionLocation,
      LEADER_LINE_POSITION_COMPONENT_COUNT,
      glContext.FLOAT,
      false,
      LEADER_LINE_VERTEX_STRIDE,
      0
    );
    glContext.disable(glContext.DEPTH_TEST);
    glContext.depthMask(false);
    glContext.uniform2f(
      uniformScreenToClipScaleLocation,
      screenToClipScaleX,
      screenToClipScaleY
    );
    glContext.uniform2f(
      uniformScreenToClipOffsetLocation,
      screenToClipOffsetX,
      screenToClipOffsetY
    );
    active = true;
  };

  const currentColor = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  const applyColor = (color: RgbaColor): void => {
    const [r, g, b, a] = color;
    if (
      currentColor[0] !== r ||
      currentColor[1] !== g ||
      currentColor[2] !== b ||
      currentColor[3] !== a
    ) {
      glContext.uniform4f(uniformColorLocation, r, g, b, a);
      currentColor[0] = r;
      currentColor[1] = g;
      currentColor[2] = b;
      currentColor[3] = a;
    }
  };

  const drawLine = (
    from: Readonly<SpriteScreenPoint>,
    to: Readonly<SpriteScreenPoint>,
    color: RgbaColor,
    lineWidth: number
  ): void => {
    if (!active) {
      return;
    }
    if (!Number.isFinite(lineWidth) || lineWidth <= 0) {
      return;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length <= 0) {
      return;
    }
    applyColor(color);
    const halfWidth = lineWidth / 2;
    const nx = (-dy / length) * halfWidth;
    const ny = (dx / length) * halfWidth;

    const v0 = { x: from.x + nx, y: from.y + ny };
    const v1 = { x: to.x + nx, y: to.y + ny };
    const v2 = { x: to.x - nx, y: to.y - ny };
    const v3 = { x: from.x - nx, y: from.y - ny };

    let offset = 0;
    const emitVertex = (pt: { x: number; y: number }) => {
      LEADER_LINE_VERTEX_SCRATCH[offset++] = pt.x;
      LEADER_LINE_VERTEX_SCRATCH[offset++] = pt.y;
      LEADER_LINE_VERTEX_SCRATCH[offset++] = 0;
      LEADER_LINE_VERTEX_SCRATCH[offset++] = 1;
    };

    emitVertex(v0);
    emitVertex(v1);
    emitVertex(v2);
    emitVertex(v0);
    emitVertex(v2);
    emitVertex(v3);

    glContext.bufferSubData(
      glContext.ARRAY_BUFFER,
      0,
      LEADER_LINE_VERTEX_SCRATCH
    );
    glContext.drawArrays(glContext.TRIANGLES, 0, LEADER_LINE_VERTEX_COUNT);
  };

  const end = (): void => {
    if (!active) {
      return;
    }
    currentColor[0] = Number.NaN;
    currentColor[1] = Number.NaN;
    currentColor[2] = Number.NaN;
    currentColor[3] = Number.NaN;
    glContext.disableVertexAttribArray(attribPositionLocation);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, null);
    active = false;
  };

  const release = (): void => {
    end();
    glContext.deleteBuffer(vertexBuffer);
    glContext.deleteProgram(program);
  };

  return {
    begin,
    drawLine,
    end,
    release,
  };
};

//////////////////////////////////////////////////////////////////////////////////////

/** List of acceptable minification filters exposed to callers. */
const MIN_FILTER_VALUES: readonly SpriteTextureMinFilter[] = [
  'nearest',
  'linear',
  'nearest-mipmap-nearest',
  'nearest-mipmap-linear',
  'linear-mipmap-nearest',
  'linear-mipmap-linear',
] as const;

/** List of acceptable magnification filters. */
const MAG_FILTER_VALUES: readonly SpriteTextureMagFilter[] = [
  'nearest',
  'linear',
] as const;

/** Minification filters that require mipmaps to produce complete textures. */
const MIPMAP_MIN_FILTERS: ReadonlySet<SpriteTextureMinFilter> =
  new Set<SpriteTextureMinFilter>([
    'nearest-mipmap-nearest',
    'nearest-mipmap-linear',
    'linear-mipmap-nearest',
    'linear-mipmap-linear',
  ]);

const filterRequiresMipmaps = (filter: SpriteTextureMinFilter): boolean =>
  MIPMAP_MIN_FILTERS.has(filter);

export const resolveTextureFilteringOptions = (
  options?: SpriteTextureFilteringOptions
): ResolvedTextureFilteringOptions => {
  const minCandidate = options?.minFilter;
  const minFilter: SpriteTextureMinFilter = MIN_FILTER_VALUES.includes(
    minCandidate as SpriteTextureMinFilter
  )
    ? (minCandidate as SpriteTextureMinFilter)
    : DEFAULT_TEXTURE_FILTERING_OPTIONS.minFilter!;

  const magCandidate = options?.magFilter;
  const magFilter: SpriteTextureMagFilter = MAG_FILTER_VALUES.includes(
    magCandidate as SpriteTextureMagFilter
  )
    ? (magCandidate as SpriteTextureMagFilter)
    : DEFAULT_TEXTURE_FILTERING_OPTIONS.magFilter!;

  let generateMipmaps =
    options?.generateMipmaps ??
    DEFAULT_TEXTURE_FILTERING_OPTIONS.generateMipmaps!;
  if (filterRequiresMipmaps(minFilter)) {
    generateMipmaps = true;
  }

  let maxAnisotropy =
    options?.maxAnisotropy ?? DEFAULT_TEXTURE_FILTERING_OPTIONS.maxAnisotropy!;
  if (!Number.isFinite(maxAnisotropy) || maxAnisotropy < 1) {
    maxAnisotropy = 1;
  }

  return {
    minFilter,
    magFilter,
    generateMipmaps,
    maxAnisotropy,
  };
};

const ANISOTROPY_EXTENSION_NAMES = [
  'EXT_texture_filter_anisotropic',
  'WEBKIT_EXT_texture_filter_anisotropic',
  'MOZ_EXT_texture_filter_anisotropic',
] as const;

export const resolveAnisotropyExtension = (
  glContext: WebGLRenderingContext
): EXT_texture_filter_anisotropic | undefined => {
  for (const name of ANISOTROPY_EXTENSION_NAMES) {
    const extension = glContext.getExtension(name);
    if (extension) {
      return extension as EXT_texture_filter_anisotropic;
    }
  }
  return undefined;
};

const resolveGlMinFilter = (
  glContext: WebGLRenderingContext,
  filter: SpriteTextureMinFilter
): number => {
  switch (filter) {
    case 'nearest':
      return glContext.NEAREST;
    case 'nearest-mipmap-nearest':
      return glContext.NEAREST_MIPMAP_NEAREST;
    case 'nearest-mipmap-linear':
      return glContext.NEAREST_MIPMAP_LINEAR;
    case 'linear-mipmap-nearest':
      return glContext.LINEAR_MIPMAP_NEAREST;
    case 'linear-mipmap-linear':
      return glContext.LINEAR_MIPMAP_LINEAR;
    case 'linear':
    default:
      return glContext.LINEAR;
  }
};

const resolveGlMagFilter = (
  glContext: WebGLRenderingContext,
  filter: SpriteTextureMagFilter
): number => {
  switch (filter) {
    case 'nearest':
      return glContext.NEAREST;
    case 'linear':
    default:
      return glContext.LINEAR;
  }
};

const isPowerOfTwo = (value: number): boolean =>
  value > 0 && (value & (value - 1)) === 0;

export interface EnsureTexturesParams {
  readonly glContext: WebGLRenderingContext | undefined;
  readonly atlasQueue: AtlasOperationQueue;
  readonly atlasManager: AtlasManager;
  readonly atlasPageTextures: Map<number, WebGLTexture>;
  readonly atlasNeedsUpload: boolean;
  readonly resolvedTextureFiltering: ResolvedTextureFilteringOptions;
  readonly anisotropyExtension: EXT_texture_filter_anisotropic | undefined;
  readonly maxSupportedAnisotropy: number;
  readonly images: ReadonlyMap<string, RegisteredImage>;
  readonly imageHandleBuffersController: ImageHandleBufferController;
  readonly atlasPageIndexNone: number;
  readonly shouldUploadAtlasPages: (
    pageStates?: readonly AtlasPageState[]
  ) => boolean;
}

/**
 * Creates or refreshes WebGL textures for registered images.
 * Processes only queued entries to avoid unnecessary work.
 * Intended to run just before drawing; returns immediately if the GL context is unavailable.
 * Ensures registerImage calls outside the render loop sync on the next frame.
 * @returns {boolean} Updated atlas upload requirement flag.
 */
export const ensureTextures = ({
  glContext,
  atlasQueue,
  atlasManager,
  atlasPageTextures,
  atlasNeedsUpload,
  resolvedTextureFiltering,
  anisotropyExtension,
  maxSupportedAnisotropy,
  images,
  imageHandleBuffersController,
  atlasPageIndexNone,
  shouldUploadAtlasPages,
}: EnsureTexturesParams): boolean => {
  if (!glContext) {
    return atlasNeedsUpload;
  }
  atlasQueue.flushPending();
  if (!atlasNeedsUpload) {
    return atlasNeedsUpload;
  }

  const pages = atlasManager.getPages();
  const activePageIndices = new Set<number>();
  pages.forEach((page) => activePageIndices.add(page.index));

  atlasPageTextures.forEach((texture, pageIndex) => {
    if (!activePageIndices.has(pageIndex)) {
      glContext.deleteTexture(texture);
      atlasPageTextures.delete(pageIndex);
    }
  });

  pages.forEach((page) => {
    const requiresUpload =
      page.needsUpload || !atlasPageTextures.has(page.index);
    if (!requiresUpload) {
      return;
    }

    let texture = atlasPageTextures.get(page.index);
    let isNewTexture = false;
    if (!texture) {
      texture = glContext.createTexture();
      if (!texture) {
        throw new Error('Failed to create texture.');
      }
      atlasPageTextures.set(page.index, texture);
      isNewTexture = true;
    }
    glContext.bindTexture(glContext.TEXTURE_2D, texture);
    if (isNewTexture) {
      glContext.texParameteri(
        glContext.TEXTURE_2D,
        glContext.TEXTURE_WRAP_S,
        glContext.CLAMP_TO_EDGE
      );
      glContext.texParameteri(
        glContext.TEXTURE_2D,
        glContext.TEXTURE_WRAP_T,
        glContext.CLAMP_TO_EDGE
      );
    }
    glContext.pixelStorei(glContext.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    glContext.texImage2D(
      glContext.TEXTURE_2D,
      0,
      glContext.RGBA,
      glContext.RGBA,
      glContext.UNSIGNED_BYTE,
      page.canvas as TexImageSource
    );

    let minFilterEnum = resolveGlMinFilter(
      glContext,
      resolvedTextureFiltering.minFilter
    );
    const magFilterEnum = resolveGlMagFilter(
      glContext,
      resolvedTextureFiltering.magFilter
    );

    let usedMipmaps = false;
    if (resolvedTextureFiltering.generateMipmaps) {
      const isWebGL2 =
        typeof WebGL2RenderingContext !== 'undefined' &&
        glContext instanceof WebGL2RenderingContext;
      const canUseMipmaps =
        isWebGL2 || (isPowerOfTwo(page.width) && isPowerOfTwo(page.height));
      if (canUseMipmaps) {
        glContext.generateMipmap(glContext.TEXTURE_2D);
        usedMipmaps = true;
      } else {
        minFilterEnum = glContext.LINEAR;
      }
    }

    if (
      !usedMipmaps &&
      filterRequiresMipmaps(resolvedTextureFiltering.minFilter)
    ) {
      minFilterEnum = glContext.LINEAR;
    }

    glContext.texParameteri(
      glContext.TEXTURE_2D,
      glContext.TEXTURE_MIN_FILTER,
      minFilterEnum
    );
    glContext.texParameteri(
      glContext.TEXTURE_2D,
      glContext.TEXTURE_MAG_FILTER,
      magFilterEnum
    );

    if (
      usedMipmaps &&
      anisotropyExtension &&
      resolvedTextureFiltering.maxAnisotropy > 1
    ) {
      const ext = anisotropyExtension;
      const targetAnisotropy = Math.min(
        resolvedTextureFiltering.maxAnisotropy,
        maxSupportedAnisotropy
      );
      if (targetAnisotropy > 1) {
        glContext.texParameterf(
          glContext.TEXTURE_2D,
          ext.TEXTURE_MAX_ANISOTROPY_EXT,
          targetAnisotropy
        );
      }
    }

    atlasManager.markPageClean(page.index);
  });

  images.forEach((image) => {
    if (image.atlasPageIndex !== atlasPageIndexNone) {
      image.texture = atlasPageTextures.get(image.atlasPageIndex);
    } else {
      image.texture = undefined;
    }
  });
  imageHandleBuffersController.markDirty(images);
  return shouldUploadAtlasPages(pages);
};
