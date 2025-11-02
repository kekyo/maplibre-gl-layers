import { defineConfig } from 'vite';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import prettierMax from 'prettier-max';
import screwUp from 'screw-up';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  base: '/maplibre-gl-layers/',
  resolve: {
    alias: {
      // Switch dependency libraries to source references to make HMR and debugging easier
      'maplibre-gl-layers': resolve(__dirname, '../maplibre-gl-layers/src'),
    },
  },
  optimizeDeps: {
    exclude: ['maplibre-gl-layers'],
  },
  build: {
    rollupOptions: {
      external: ['maplibre-gl-layers'],
    },
  },
  plugins: [
    prettierMax(), // Use default settings
    screwUp({
      outputMetadataFile: true,
    }),
  ],
});
