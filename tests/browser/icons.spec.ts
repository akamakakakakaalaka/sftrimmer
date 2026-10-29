import { test, expect } from '@playwright/test';

// A native-rendered alpha mask is the UIKit -> web boundary. No synthesizer mock.
const nativeMask = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJ0lEQVR4nGNkYGD4z0BDwERLw0ctGLVg1IJRC0YtGLVg1IJRC6gHAO7LAS/EbsRTAAAAAElFTkSuQmCC';

test('reference icons remain visible and labelled when switching between panels and the MIDI player', async ({page}) => {
  await page.goto('/');
  const gear = page.locator('#tab-settings .reference-icon');
  const notes = page.locator('#tab-player .reference-icon');
  await expect(gear).toHaveAttribute('data-icon-source', 'authored-svg');
  await expect(notes).toHaveAttribute('data-icon-source', 'authored-svg');
  await expect(gear).toHaveAttribute('aria-hidden', 'true');
  const rect = await gear.boundingBox();
  expect(rect!.width).toBeCloseTo(20.74, 1);
  expect(rect!.height).toBeCloseTo(20.74, 1);
  expect(await gear.evaluate(el => getComputedStyle(el).maskImage)).not.toBe('none');
  await page.getByRole('tab', {name:'MIDI file player'}).click();
  await expect(page.locator('#view-player')).toBeVisible();
  await page.locator('#tab-player').click();
  await expect(notes).toHaveAttribute('data-icon-source', 'authored-svg');
  await page.getByRole('tab', {name:'Preferences'}).click();
  await expect(page.locator('#view-settings')).toBeVisible();
});

test('iOS masks survive tab replacement and reload while tinting with the selected theme', async ({page}) => {
  await page.addInitScript(mask => {
    Object.defineProperty(window, 'project128NativeIcons', {value:{gear:mask, music:mask}});
  }, nativeMask);
  await page.goto('/');
  await expect(page.locator('#tab-settings .reference-icon')).toHaveAttribute('data-icon-source', 'ios-system');
  await expect(page.locator('#tab-player .reference-icon')).toHaveAttribute('data-icon-source', 'ios-system');
  await page.locator('#tab-player').click();
  await page.locator('#tab-player').click();
  await expect(page.locator('#tab-player .reference-icon')).toHaveAttribute('data-icon-source', 'ios-system');
  await page.locator('#tab-settings').click();
  await page.locator('[data-theme-choice="dark"]').click();
  const tint = await page.locator('#tab-settings .reference-icon').evaluate(el => ({color:getComputedStyle(el).color, fill:getComputedStyle(el).backgroundColor}));
  expect(tint.fill).toBe(tint.color);
  expect(tint.fill).not.toBe('rgb(0, 0, 0)');
  await page.reload();
  await expect(page.locator('#tab-settings .reference-icon')).toHaveAttribute('data-icon-source', 'ios-system');
});

test('invalid native image payloads retain the offline SVG fallback', async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'project128NativeIcons', {value:{gear:'https://example.com/gear.png', music:'data:image/svg+xml,<svg onload="alert(1)"/>'}});
  });
  await page.goto('/');
  await expect(page.locator('#tab-settings .reference-icon')).toHaveAttribute('data-icon-source', 'authored-svg');
  await expect(page.locator('#tab-player .reference-icon')).toHaveAttribute('data-icon-source', 'authored-svg');
});
