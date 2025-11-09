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
const sourceFiles = [
  resolve(wasmSourceDir, 'projection_host.cpp'),
  resolve(wasmSourceDir, 'calculation_host.cpp'),
];
const wasmVariants = [
  {
    name: 'simd',
    outputFile: resolve(wasmOutputDir, 'offloads-simd.wasm'),
    enableSimd: true,
  },
  {
    name: 'nosimd',
    outputFile: resolve(wasmOutputDir, 'offloads-nosimd.wasm'),
    enableSimd: false,
  },
];

for (const sourceFile of sourceFiles) {
  if (!existsSync(sourceFile)) {
    throw new Error(`Missing WASM source file: ${sourceFile}`);
  }
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

const emsdkDir = findLocalEmsdkDir();

const wasmOptExecutable = findWasmOptExecutable(emsdkDir) ?? 'wasm-opt';

const runEmcc = (args) => {
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
};

const runWasmOpt = (args) => {
  let wasmOptResult = null;

  if (emsdkDir) {
    const envScript = resolve(emsdkDir, 'emsdk_env.sh');
    if (existsSync(envScript)) {
      const command =
        `. ${shellQuote(envScript)} >/dev/null 2>&1 && ` +
        [wasmOptExecutable, ...args].map(shellQuote).join(' ');
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
    wasmOptResult = spawnSync(wasmOptExecutable, args, {
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
};

const createEmccArgs = (variant) => {
  const args = [
    ...sourceFiles,
    '-O3',
    '-std=c++17',
    '-o',
    variant.outputFile,
    '-s',
    'ENVIRONMENT=web,webview,worker,node',
    '-s',
    'EXPORTED_FUNCTIONS=["_malloc","_free", "_fromLngLat","_project","_calculatePerspectiveRatio","_unproject","_projectLngLatToClipSpace","_calculateBillboardDepthKey","_calculateSurfaceDepthKey","_prepareDrawSpriteImages"]',
    '-s',
    'ALLOW_MEMORY_GROWTH=1',
    '-s',
    'ERROR_ON_UNDEFINED_SYMBOLS=0',
    '-mbulk-memory',
  ];
  if (variant.enableSimd) {
    args.push('-msimd128', '-DSIMD_ENABLED=1');
  }
  return args;
};

const createWasmOptArgs = (variant) => {
  const args = ['--enable-nontrapping-float-to-int', '--enable-bulk-memory'];
  if (variant.enableSimd) {
    args.push('--enable-simd');
  }
  args.push(variant.outputFile, '-Oz', '-o', variant.outputFile);
  return args;
};

for (const variant of wasmVariants) {
  console.log(`Building ${variant.name} wasm...`);
  runEmcc(createEmccArgs(variant));
  runWasmOpt(createWasmOptArgs(variant));
}
