import { defineConfig } from 'vite';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import prettierMax from 'prettier-max';
import screwUp from 'screw-up';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const COOP_COEP_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: '/maplibre-gl-layers/',
  resolve: {
    alias: {
      // Switch dependency libraries to source references to make HMR and debugging easier
      'maplibre-gl-layers': resolve(__dirname, '../maplibre-gl-layers/src'),
    },
  },
  server: {
    headers: COOP_COEP_HEADERS,
  },
  preview: {
    headers: COOP_COEP_HEADERS,
  },
  plugins: [
    prettierMax(), // Use default settings
    screwUp({
      outputMetadataFile: true,
    }),
  ],
});
