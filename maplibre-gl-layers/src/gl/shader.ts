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

import type { SpriteAnchor, SpriteScreenPoint } from '../types';
import type {
  PreparedDrawSpriteImageParams,
  Releasable,
  SurfaceShaderInputs,
} from '../internalTypes';
import { DEG2RAD, UV_CORNERS } from '../const';

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

/** Shared vertex shader that converts screen-space vertices when requested. */
export const VERTEX_SHADER_SOURCE = `
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
export const FRAGMENT_SHADER_SOURCE = `
precision mediump float;
uniform sampler2D u_texture;
uniform float u_opacity;
varying vec2 v_uv;
void main() {
  vec4 texel = texture2D(u_texture, v_uv);
  gl_FragColor = vec4(texel.rgb, texel.a) * u_opacity;
}
` as const;

/** Initial vertex data for a unit quad. */
export const INITIAL_QUAD_VERTICES = new Float32Array(
  QUAD_VERTEX_COUNT * VERTEX_COMPONENT_COUNT
);

/** Scratch buffer rewritten for each draw call. */
export const QUAD_VERTEX_SCRATCH = new Float32Array(
  QUAD_VERTEX_COUNT * VERTEX_COMPONENT_COUNT
);

/** Vertex shader for debug hit-test outline rendering using screen coordinates. */
export const DEBUG_OUTLINE_VERTEX_SHADER_SOURCE = `
attribute vec4 a_position;
uniform vec2 u_screenToClipScale;
uniform vec2 u_screenToClipOffset;
void main() {
  vec4 position = a_position;
  position.xy = position.xy * u_screenToClipScale + u_screenToClipOffset;
  gl_Position = position;
}
` as const;

/** Fragment shader emitting a solid color for debug outlines. */
export const DEBUG_OUTLINE_FRAGMENT_SHADER_SOURCE = `
precision mediump float;
uniform vec4 u_color;
void main() {
  gl_FragColor = u_color;
}
` as const;

/** Number of vertices required to outline a quad using LINE_LOOP. */
export const DEBUG_OUTLINE_VERTEX_COUNT = 4;
/** Components per debug outline vertex (clipPosition.xyzw). */
export const DEBUG_OUTLINE_POSITION_COMPONENT_COUNT = 4;
/** Stride in bytes for debug outline vertices. */
export const DEBUG_OUTLINE_VERTEX_STRIDE =
  DEBUG_OUTLINE_POSITION_COMPONENT_COUNT * FLOAT_SIZE;
/** Scratch buffer reused when emitting debug outlines. */
export const DEBUG_OUTLINE_VERTEX_SCRATCH = new Float32Array(
  DEBUG_OUTLINE_VERTEX_COUNT * DEBUG_OUTLINE_POSITION_COMPONENT_COUNT
);
/** Solid red RGBA color used for debug outlines. */
export const DEBUG_OUTLINE_COLOR: readonly [number, number, number, number] = [
  1.0, 0.0, 0.0, 1.0,
];
/** Corner traversal order used when outlining a quad without crossing diagonals. */
export const DEBUG_OUTLINE_CORNER_ORDER = [0, 1, 3, 2] as const;

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

export interface DebugOutlineRenderer extends Releasable {
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
    ]
  ): void;
  end(): void;
}

export const createDebugOutlineRenderer = (
  glContext: WebGLRenderingContext
): DebugOutlineRenderer => {
  const program = createShaderProgram(
    glContext,
    DEBUG_OUTLINE_VERTEX_SHADER_SOURCE,
    DEBUG_OUTLINE_FRAGMENT_SHADER_SOURCE
  );

  const attribPositionLocation = glContext.getAttribLocation(
    program,
    'a_position'
  );
  if (attribPositionLocation === -1) {
    glContext.deleteProgram(program);
    throw new Error('Failed to acquire debug attribute location.');
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
    throw new Error('Failed to acquire debug uniforms.');
  }

  const vertexBuffer = glContext.createBuffer();
  if (!vertexBuffer) {
    glContext.deleteProgram(program);
    throw new Error('Failed to create debug vertex buffer.');
  }
  glContext.bindBuffer(glContext.ARRAY_BUFFER, vertexBuffer);
  glContext.bufferData(
    glContext.ARRAY_BUFFER,
    DEBUG_OUTLINE_VERTEX_SCRATCH,
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
      DEBUG_OUTLINE_POSITION_COMPONENT_COUNT,
      glContext.FLOAT,
      false,
      DEBUG_OUTLINE_VERTEX_STRIDE,
      0
    );
    glContext.disable(glContext.DEPTH_TEST);
    glContext.depthMask(false);
    glContext.uniform4f(
      uniformColorLocation,
      DEBUG_OUTLINE_COLOR[0],
      DEBUG_OUTLINE_COLOR[1],
      DEBUG_OUTLINE_COLOR[2],
      DEBUG_OUTLINE_COLOR[3]
    );
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

  const drawOutline = (
    corners: readonly [
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
      SpriteScreenPoint,
    ]
  ): void => {
    if (!active) {
      return;
    }
    let writeOffset = 0;
    for (const cornerIndex of DEBUG_OUTLINE_CORNER_ORDER) {
      const corner = corners[cornerIndex]!;
      DEBUG_OUTLINE_VERTEX_SCRATCH[writeOffset++] = corner.x;
      DEBUG_OUTLINE_VERTEX_SCRATCH[writeOffset++] = corner.y;
      DEBUG_OUTLINE_VERTEX_SCRATCH[writeOffset++] = 0;
      DEBUG_OUTLINE_VERTEX_SCRATCH[writeOffset++] = 1;
    }
    glContext.bufferSubData(
      glContext.ARRAY_BUFFER,
      0,
      DEBUG_OUTLINE_VERTEX_SCRATCH
    );
    glContext.drawArrays(glContext.LINE_LOOP, 0, DEBUG_OUTLINE_VERTEX_COUNT);
  };

  const end = (): void => {
    if (!active) {
      return;
    }
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
