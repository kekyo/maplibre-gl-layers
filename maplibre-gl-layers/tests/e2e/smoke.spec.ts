// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT
// https://github.com/kekyo/maplibre-gl-layers

import { test, expect } from '@playwright/test';

test.describe('MapLibre overlay demo', () => {
  test('renders the application shell', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/maplibre-overlay/i);
    await expect(page.locator('#app')).toBeVisible();
  });
});
