// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import dts from 'vite-plugin-dts';
import prettierMax from 'prettier-max';
import screwUp from 'screw-up';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = resolve(__dirname, '..');
const imagesSourceDir = resolve(projectRoot, 'images');
const imagesDestDir = resolve(__dirname, 'images');
const imageFiles = ['demo1.png', 'demo2.png', 'maplibre-gl-layers-120.png'];

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

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
    }),
    prettierMax(),
    screwUp(),
    copyImagesPlugin(),
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
