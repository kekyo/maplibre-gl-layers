#!/usr/bin/env node
// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = resolve(__dirname, '..');
const repositoryRoot = resolve(projectRoot, '..');
const wasmSourceDir = resolve(projectRoot, 'wasm');
const wasmOutputDir = resolve(projectRoot, 'src/wasm');
const sourceFile = resolve(wasmSourceDir, 'projection_host.cpp');
const outputFile = resolve(wasmOutputDir, 'projection_host.wasm');

if (!existsSync(sourceFile)) {
  throw new Error(`Missing WASM source file: ${sourceFile}`);
}

if (!existsSync(wasmOutputDir)) {
  mkdirSync(wasmOutputDir, { recursive: true });
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\"'\"'`)}'`;

const findLocalEmsdkDir = () => {
  const candidates = [
    process.env.EMSDK,
    resolve(repositoryRoot, 'emsdk'),
    resolve(projectRoot, 'emsdk'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const findWasmOptExecutable = (emsdkDir) => {
  const wasmOptBinary =
    process.platform === 'win32' ? 'wasm-opt.exe' : 'wasm-opt';

  if (emsdkDir) {
    const candidate = resolve(emsdkDir, 'upstream', 'bin', wasmOptBinary);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  if (process.env.WASM_OPT) {
    return process.env.WASM_OPT;
  }

  return null;
};

const args = [
  sourceFile,
  '-O3',
  '-msimd128',
  '-std=c++17',
  '-o',
  outputFile,
  '-s',
  'ENVIRONMENT=web,webview,worker,node',
  '-s',
  'EXPORTED_FUNCTIONS=["_fromLngLat","_malloc","_free"]',
  '-s',
  'ALLOW_MEMORY_GROWTH=1',
  '-s',
  'ERROR_ON_UNDEFINED_SYMBOLS=0',
];

const wasmOptArgs = [
  '--enable-nontrapping-float-to-int',
  '--enable-simd',
  outputFile,
  '-Oz',
  '-o',
  outputFile,
];

const emsdkDir = findLocalEmsdkDir();

let result = null;

if (emsdkDir) {
  const envScript = resolve(emsdkDir, 'emsdk_env.sh');
  const emccPath = resolve(emsdkDir, 'upstream', 'emscripten', 'emcc');
  if (existsSync(envScript) && existsSync(emccPath)) {
    const command =
      `. ${shellQuote(envScript)} >/dev/null 2>&1 && ` +
      [emccPath, ...args].map(shellQuote).join(' ');
    result = spawnSync('bash', ['-lc', command], {
      stdio: 'inherit',
      cwd: projectRoot,
    });
  }
}

if (!result) {
  const emcc = process.env.EMCC || 'emcc';
  result = spawnSync(emcc, args, {
    stdio: 'inherit',
    cwd: projectRoot,
  });
  if (
    result.error &&
    (result.error.code === 'ENOENT' || result.status === 127)
  ) {
    throw new Error(
      `Emscripten compiler "${emcc}" not found. Install emsdk under ${repositoryRoot}/emsdk or set the EMCC environment variable.`
    );
  }
}

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const wasmOptExecutable = findWasmOptExecutable(emsdkDir) ?? 'wasm-opt';

let wasmOptResult = null;

if (emsdkDir) {
  const envScript = resolve(emsdkDir, 'emsdk_env.sh');
  if (existsSync(envScript)) {
    const command =
      `. ${shellQuote(envScript)} >/dev/null 2>&1 && ` +
      [wasmOptExecutable, ...wasmOptArgs].map(shellQuote).join(' ');
    wasmOptResult = spawnSync('bash', ['-lc', command], {
      stdio: 'inherit',
      cwd: projectRoot,
    });
  }
}

if (
  !wasmOptResult ||
  (wasmOptResult.error && wasmOptResult.error.code === 'ENOENT') ||
  wasmOptResult.status === 127
) {
  wasmOptResult = spawnSync(wasmOptExecutable, wasmOptArgs, {
    stdio: 'inherit',
    cwd: projectRoot,
  });
}

if (wasmOptResult.error) {
  if (wasmOptResult.error.code === 'ENOENT') {
    console.warn('wasm-opt not found; skipping optimization.');
  } else {
    throw wasmOptResult.error;
  }
} else if (wasmOptResult.status !== 0) {
  process.exit(wasmOptResult.status ?? 1);
}
