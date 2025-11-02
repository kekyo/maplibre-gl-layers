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

import type { SpriteAnchor, SpriteScreenPoint } from './types';
import { DEG2RAD, UV_CORNERS } from './math';

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
uniform vec4 u_surfaceClipCenter;
uniform vec4 u_surfaceClipBasisEast;
uniform vec4 u_surfaceClipBasisNorth;
uniform float u_surfaceDepthBias;
varying vec2 v_uv;
vec2 computeBillboardCorner(vec2 uv) {
  vec2 base = vec2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  vec2 anchorShift = vec2(u_billboardAnchor.x * u_billboardHalfSize.x, u_billboardAnchor.y * u_billboardHalfSize.y);
  vec2 shifted = vec2(base.x * u_billboardHalfSize.x, base.y * u_billboardHalfSize.y) - anchorShift;
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
  vec4 clip = u_surfaceClipCenter
    + (corner.x * u_surfaceClipBasisEast)
    + (corner.y * u_surfaceClipBasisNorth);
  clip.z += u_surfaceDepthBias * clip.w;
  return clip;
}
void main() {
  v_uv = a_uv;
  vec4 position;
  if (u_billboardMode > 0.5) {
    vec2 screenPosition = computeBillboardCorner(a_uv);
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
