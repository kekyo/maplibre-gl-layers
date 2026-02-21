// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
import dts from 'vite-plugin-dts';
import prettierMax from 'prettier-max';
import screwUp from 'screw-up';
import emsdkEnv from 'emsdk-env/vite';

// simd-mt: Maximum thread pool size (thread count)
const MAX_THREAD_POOL_SIZE = 8;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = resolve(__dirname, '..');
const imagesSourceDir = resolve(projectRoot, 'images');
const imagesDestDir = resolve(__dirname, 'images');
const imageFiles = ['demo1.png', 'demo2.png', 'maplibre-gl-layers-120.png'];

const parsePositiveInteger = (
  value: string | undefined,
  fallback: number
): number => {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const maxThreadPoolSize = Math.max(
  1,
  parsePositiveInteger(process.env.WASM_PTHREAD_POOL_SIZE, MAX_THREAD_POOL_SIZE)
);

const pthreadMemoryMegabytes = Math.max(
  16,
  parsePositiveInteger(process.env.WASM_PTHREAD_MEMORY_MB, 512)
);

const pthreadMemoryBytes = pthreadMemoryMegabytes * 1024 * 1024;

const wasmExports = [
  '_getConfiguredMaxThreadPoolSize',
  '_malloc',
  '_free',
  '_fromLngLat',
  '_project',
  '_calculatePerspectiveRatio',
  '_unproject',
  '_projectLngLatToClipSpace',
  '_calculateBillboardDepthKey',
  '_calculateSurfaceDepthKey',
  '_prepareDrawSpriteImages',
  '_evaluateDistanceInterpolations',
  '_evaluateDegreeInterpolations',
  '_evaluateSpriteInterpolations',
  '_processInterpolations',
  '_setThreadPoolSize',
];

const wasmCommonCompileOptions = ['-O3', '-std=c++17', '-mbulk-memory'];

const wasmCommonLinkOptions = [
  '-s',
  'ENVIRONMENT=web,webview,worker,node',
  '-s',
  'ERROR_ON_UNDEFINED_SYMBOLS=0',
  '-s',
  'EXPORTED_RUNTIME_METHODS=["wasmMemory"]',
];

const wasmSimdCompileOptions = ['-msimd128', '-DSIMD_ENABLED=1'];
const wasmSimdLinkOptions = ['-msimd128'];

const copyImagesPlugin = (): Plugin => ({
  name: 'copy-static-images',
  apply: 'build',
  buildStart() {
    if (!existsSync(imagesDestDir)) {
      mkdirSync(imagesDestDir, { recursive: true });
    }

    for (const imageFile of imageFiles) {
      const src = resolve(imagesSourceDir, imageFile);
      const dest = resolve(imagesDestDir, imageFile);

      if (!existsSync(src)) {
        throw new Error(`Missing image asset: ${src}`);
      }

      copyFileSync(src, dest);
    }
  },
});

const copyWasmArtifactsPlugin = (): Plugin => ({
  name: 'copy-wasm-artifacts',
  apply: 'build',
  writeBundle() {
    const wasmSourceDir = resolve(__dirname, 'src/wasm');
    const wasmDestDir = resolve(__dirname, 'dist/wasm');
    if (!existsSync(wasmSourceDir)) {
      return;
    }
    if (!existsSync(wasmDestDir)) {
      mkdirSync(wasmDestDir, { recursive: true });
    }
    const allowedSuffixes = ['.wasm', '.js', '.worker.js'];
    for (const entry of readdirSync(wasmSourceDir)) {
      if (!allowedSuffixes.some((suffix) => entry.endsWith(suffix))) {
        continue;
      }
      const src = resolve(wasmSourceDir, entry);
      const dest = resolve(wasmDestDir, entry);
      copyFileSync(src, dest);
    }
  },
});

export default defineConfig({
  plugins: [
    emsdkEnv({
      common: {
        options: wasmCommonCompileOptions,
        linkOptions: wasmCommonLinkOptions,
        exports: wasmExports,
        wasmOpt: {
          enable: true,
          args: [
            '-Oz',
            '--enable-nontrapping-float-to-int',
            '--enable-bulk-memory',
          ],
        },
      },
      targets: {
        'simd-mt': {
          outFile: 'offloads-simd-mt.js',
          options: [...wasmSimdCompileOptions, '-pthread'],
          defines: {
            MAX_THREAD_POOL_SIZE: maxThreadPoolSize, // to getConfiguredMaxThreadPoolSize()
          },
          linkOptions: [
            ...wasmSimdLinkOptions,
            '-pthread',
            '-s',
            'USE_PTHREADS=1',
            '-s',
            `PTHREAD_POOL_SIZE=${maxThreadPoolSize}`, // Configured.
            '-s',
            `INITIAL_MEMORY=${pthreadMemoryBytes}`,
            '-s',
            'ALLOW_MEMORY_GROWTH=0',
            '-s',
            'MODULARIZE=1',
            '-s',
            'EXPORT_ES6=1',
          ],
          // wasm-opt runs on outFile; disable for JS output.
          wasmOpt: { enable: false },
        },
        simd: {
          outFile: 'offloads-simd.wasm',
          options: wasmSimdCompileOptions,
          linkOptions: [...wasmSimdLinkOptions, '-s', 'ALLOW_MEMORY_GROWTH=1'],
          wasmOpt: { args: ['--enable-simd'] },
        },
        nosimd: {
          outFile: 'offloads-nosimd.wasm',
          linkOptions: ['-s', 'ALLOW_MEMORY_GROWTH=1'],
        },
      },
    }),
    dts({
      rollupTypes: true,
    }),
    prettierMax(),
    screwUp(),
    copyImagesPlugin(),
    copyWasmArtifactsPlugin(),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'maplibre-gl-layers',
      fileName: (format, entryName) =>
        `${entryName}.${format === 'es' ? 'mjs' : 'cjs'}`,
      formats: ['es', 'cjs'],
    },
    target: 'es2018',
    sourcemap: true,
    minify: false,
    emptyOutDir: true,
  },
});
