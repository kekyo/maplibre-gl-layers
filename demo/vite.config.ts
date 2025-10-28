import { defineConfig } from 'vite';
import prettierMax from 'prettier-max';
import screwUp from 'screw-up';

export default defineConfig({
  base: '/maplibre-gl-layers/',
  plugins: [
    prettierMax(), // Use default settings
    screwUp({
      outputMetadataFile: true,
    }),
  ],
});
