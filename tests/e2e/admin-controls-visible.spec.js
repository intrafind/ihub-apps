// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

/**
 * End-to-end: admin form controls are visible, in light and dark (theme 4: AI-B3, ID-B7, ID-B9,
 * CU-B6, PL-B5, PL-B6, SH-B9 = ID-B8 = OB-B17 = PL-B19).
 *
 * What is measured, and why:
 * - Every visible text-like field (input, select, textarea) on the admin pages listed in
 *   STRICT_ROUTES has a border at least 1px wide, at least 8px of left padding (4px for a
 *   select) and a border with at least 3:1 contrast against the background behind it
 *   (WCAG 1.4.11). Tailwind 4 Preflight zeroes border widths, so class strings that only name a
 *   colour (`border-gray-300`) used to render fields with no edge at all.
 * - In dark mode the field's fill is dark (luminance below 0.2): a field with `bg-white` and no
 *   `dark:bg-*` would be a white box on a dark page.
 * - A dark-mode user gets `<html data-theme="dark">` before the app's bundle runs (the inline
 *   pre-paint script in client/index.html), so cold loads never flash light, including the
 *   admin's "Checking authentication…" screen and unknown admin URLs.
 * - The theme choice is shared: after picking Dark in the admin sidebar, an OS switch to light
 *   leaves the admin dark.
 * - The admin's field styling never leaks to end-user pages: after client-side navigation from
 *   /admin to a chat, `<html>` has no `data-surface` and the composer has no `data-surface`
 *   ancestor (App.css scopes the admin rules to `[data-surface='admin']`).
 * - The Cookies "Save" button (/admin/security) has a solid fill with white text (PL-B5).
 *
 * Colours: Chrome reports Tailwind 4 colours as `oklch(...)`, so nothing here parses `rgb()`
 * strings. Each colour is painted on a 1×1 canvas and read back as sRGB bytes.
 *
 * Three theme set-ups run every check: `light` (stored light, OS light), `dark` (stored dark,
 * OS light: an explicit choice beats the OS) and `auto-dark` (nothing stored, OS dark).
 *
 * Signs in as the default local admin (`admin` / `password123`). Under a deployment prefix set
 * CRAWL_BASE_PATH (e.g. `/ihub`), as for route-crawl.spec.js.
 *
 * A failure names the route, theme, a CSS path to the field, the measured values and the
 * field's className, so it can be fixed from the CI log: move the field onto `INPUT_CLASS`
 * (client/src/features/admin/components/formStyles.js) or give it the `admin-control-border`
 * tokens.
 */

const ADMIN = { username: 'admin', password: 'password123' };
const BASE = (process.env.CRAWL_BASE_PATH || '').replace(/\/$/, '');
const DARK_MODE_KEY = 'ih-dark-mode';

/** Admin pages whose fields must meet 3:1. `minFields`: a page that measures fewer fails. */
const STRICT_ROUTES = [
  { path: '/admin/apps/chat', minFields: 5 },
  { path: '/admin/apps/new', minFields: 5 },
  { path: 'FIRST_MODEL', minFields: 3 },
  { path: '/admin/prompts/new', minFields: 3 },
  { path: '/admin/users/new', minFields: 3 },
  { path: '/admin/groups/new', minFields: 2 },
  { path: '/admin/auth', minFields: 3 },
  { path: '/admin/shortlinks/new', minFields: 3 },
  { path: '/admin/pages/new', minFields: 2 },
  { path: '/admin/localization', minFields: 1 },
  { path: '/admin/voice-input', minFields: 1 },
  // The update page shows its text fields only while an update is staged or a file is chosen.
  { path: '/admin/updates', minFields: 0 },
  { path: '/admin/security', minFields: 3 },
  // A DataTable list page: the search box, filter selects and page-size select.
  { path: '/admin/apps', minFields: 1 }
];

const THEMES = [
  { name: 'light', colorScheme: 'light', stored: 'light', dark: false },
  { name: 'dark', colorScheme: 'light', stored: 'dark', dark: true },
  { name: 'auto-dark', colorScheme: 'dark', stored: null, dark: true }
];

/**
 * Runs in the page: measure every visible text-like field in the admin content and in open
 * dialogs. Kept self-contained because page.evaluate serialises it.
 */
function measureFields() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  /** Any CSS colour (oklch, color-mix, rgb, named) as [r, g, b, a] with a in 0..1. */
  const toRgba = color => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };

  const over = (top, bottom) => {
    const a = top[3];
    return [0, 1, 2].map(i => top[i] * a + bottom[i] * (1 - a)).concat(1);
  };

  /** The opaque colour behind an element: composite ancestor fills until one is opaque. */
  const backgroundBehind = element => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const fill = toRgba(getComputedStyle(node).backgroundColor);
      if (fill[3] > 0) layers.push(fill);
      if (fill[3] >= 1) break;
    }
    let color = [255, 255, 255, 1];
    if (layers.length && layers[layers.length - 1][3] >= 1) color = layers.pop();
    for (let i = layers.length - 1; i >= 0; i--) color = over(layers[i], color);
    return color;
  };

  const luminance = ([r, g, b]) => {
    const channel = v => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const cssPath = element => {
    const parts = [];
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter(n => n.tagName === node.tagName)
        : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };

  const FIELD =
    "input:not([type='checkbox'], [type='radio'], [type='range'], [type='color'], [type='file'], [type='hidden'], [type='button'], [type='submit'], [type='reset'], [type='image']), select, textarea";
  const roots = [
    ...document.querySelectorAll("#admin-main-content, [role='dialog'], [role='alertdialog']")
  ];
  const fields = new Set();
  roots.forEach(root => root.querySelectorAll(FIELD).forEach(field => fields.add(field)));

  const results = [];
  for (const field of fields) {
    if (field.closest("[data-surface='app'], [data-bare], .monaco-editor, .cm-editor, .react-flow"))
      continue;
    if (field.hasAttribute('data-bare')) continue;
    const rect = field.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    if (field.checkVisibility && !field.checkVisibility({ visibilityProperty: true })) continue;
    const style = getComputedStyle(field);
    const border = toRgba(style.borderTopColor);
    const behind = backgroundBehind(field.parentElement || document.body);
    const fill = backgroundBehind(field);
    results.push({
      path: cssPath(field),
      tag: field.tagName.toLowerCase(),
      className: typeof field.className === 'string' ? field.className : '',
      disabled: field.disabled,
      borderWidth: Number.parseFloat(style.borderTopWidth),
      borderStyle: style.borderTopStyle,
      paddingLeft: Number.parseFloat(style.paddingLeft),
      borderColor: style.borderTopColor,
      contrast: Math.round(contrast(over(border, behind), behind) * 100) / 100,
      fillLuminance: Math.round(luminance(fill) * 1000) / 1000
    });
  }
  return results;
}

/** Problems with one field, as readable strings (empty when it passes). */
function fieldProblems(field, { dark }) {
  const problems = [];
  if (!(field.borderWidth >= 1) || field.borderStyle === 'none') {
    problems.push(`border ${field.borderWidth}px ${field.borderStyle}`);
  }
  const minPadding = field.tag === 'select' ? 4 : 8;
  if (!(field.paddingLeft >= minPadding)) problems.push(`padding-left ${field.paddingLeft}px`);
  // Disabled fields are exempt from 1.4.11; they only have to read as fields.
  if (!field.disabled && field.contrast < 3) {
    problems.push(`border contrast ${field.contrast}:1 (${field.borderColor})`);
  }
  if (dark && field.fillLuminance >= 0.2)
    problems.push(`light fill in dark (${field.fillLuminance})`);
  return problems;
}

async function signIn(context) {
  const login = await context.request.post(`${BASE}/api/auth/local/login`, { data: ADMIN });
  expect(login.ok(), 'sign in as the default admin').toBeTruthy();
}

/** The admin path of the first model, for the model editor route. */
async function firstModelPath(context) {
  const response = await context.request.get(`${BASE}/api/admin/models`);
  expect(response.ok(), 'list models').toBeTruthy();
  const body = await response.json();
  const items = Array.isArray(body) ? body : body.items || [];
  expect(items.length, 'a fresh install ships models').toBeGreaterThan(0);
  return `/admin/models/${encodeURIComponent(items[0].id)}`;
}

/** Record `data-theme` the moment <body> exists: only the inline pre-paint script has run then. */
function recordThemeAtBody() {
  const record = () => {
    if (!document.body || '__themeAtBody' in window) return;
    window.__themeAtBody = document.documentElement.getAttribute('data-theme');
    observer.disconnect();
  };
  const observer = new MutationObserver(record);
  observer.observe(document, { childList: true, subtree: true });
}

for (const theme of THEMES) {
  test.describe(`Admin controls (${theme.name})`, () => {
    test.use({ colorScheme: theme.colorScheme });

    test.beforeEach(async ({ context }) => {
      await context.addInitScript(
        ({ key, stored }) => {
          window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
          // Only on the first load of the tab: tests that change the choice keep it.
          if (!window.sessionStorage.getItem('e2e-theme-seeded')) {
            window.sessionStorage.setItem('e2e-theme-seeded', '1');
            if (stored) window.localStorage.setItem(key, stored);
            else window.localStorage.removeItem(key);
          }
        },
        { key: DARK_MODE_KEY, stored: theme.stored }
      );
      await context.addInitScript(recordThemeAtBody);
      await signIn(context);
    });

    test('fields on the P1 admin pages have a visible 3:1 boundary', async ({ page, context }) => {
      test.setTimeout(5 * 60 * 1000);
      const failures = [];
      for (const route of STRICT_ROUTES) {
        const path = route.path === 'FIRST_MODEL' ? await firstModelPath(context) : route.path;
        await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});
        await expect(page.locator('#admin-main-content')).toBeVisible();
        // Pages that load their data after the shell (Localization) render
        // their fields late: wait for them before measuring.
        if (route.minFields > 0) {
          await page
            .locator('#admin-main-content')
            .locator('input:visible, select:visible, textarea:visible')
            .first()
            .waitFor({ timeout: 15_000 })
            .catch(() => {});
        }

        const fields = await page.evaluate(measureFields);
        if (fields.length < route.minFields) {
          failures.push(
            `${path} [${theme.name}]: measured ${fields.length} fields, expected ${route.minFields}+`
          );
        }
        for (const field of fields) {
          const problems = fieldProblems(field, theme);
          if (problems.length) {
            failures.push(
              `${path} [${theme.name}] ${field.path}: ${problems.join(', ')} — class="${field.className}"`
            );
          }
        }
      }
      expect(failures, 'admin fields without a visible boundary').toEqual([]);
    });

    test('the theme is applied before the app starts, through the auth check', async ({ page }) => {
      for (const path of ['/admin', '/admin/users', '/admin/auth', '/admin/does-not-exist']) {
        await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
        const atBody = await page.evaluate(() => window.__themeAtBody);
        expect(atBody, `${path}: data-theme when <body> was parsed`).toBe(
          theme.dark ? 'dark' : null
        );
        await page.waitForLoadState('networkidle').catch(() => {});
        const html = page.locator('html');
        if (theme.dark) await expect(html).toHaveAttribute('data-theme', 'dark');
        else await expect(html).not.toHaveAttribute('data-theme', 'dark');
      }
    });

    test('the Cookies save button is a solid button with white text', async ({ page }) => {
      await page.goto(`${BASE}/admin/security`, { waitUntil: 'domcontentloaded' });
      const section = page.locator('#settings-section-cookies');
      const save = section.getByRole('button', { name: /save/i });
      await expect(save).toBeVisible();
      const colours = await save.evaluate(button => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const toRgba = color => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return [r, g, b, a / 255];
        };
        const style = getComputedStyle(button);
        return { fill: toRgba(style.backgroundColor), text: toRgba(style.color) };
      });
      expect(colours.fill[3], 'the button has an opaque fill').toBe(1);
      const lum = ([r, g, b]) =>
        [r, g, b]
          .map(v => v / 255)
          .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
          .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      const [hi, lo] = [lum(colours.fill), lum(colours.text)].sort((a, b) => b - a);
      expect((hi + 0.05) / (lo + 0.05), 'text contrast on the button').toBeGreaterThanOrEqual(4.5);
    });

    test('leaving the admin removes the admin surface from end-user pages', async ({ page }) => {
      await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-surface', 'admin');

      // Client-side navigation, as a link click would do: no reload clears the attribute.
      await page.evaluate(target => {
        window.history.pushState({}, '', target);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, `${BASE}/apps/chat`);

      const composer = page.getByRole('textbox', { name: /type your message/i });
      await expect(composer).toBeVisible({ timeout: 20000 });
      const htmlSurface = await page.evaluate(() =>
        document.documentElement.getAttribute('data-surface')
      );
      expect(htmlSurface, '<html data-surface> after leaving the admin').toBeNull();
      const surfaceAncestor = await composer.evaluate(el => Boolean(el.closest('[data-surface]')));
      expect(surfaceAncestor, 'the composer sits under no data-surface marker').toBe(false);
    });
  });
}

test.describe('Admin theme choice', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    await context.addInitScript(recordThemeAtBody);
    await signIn(context);
  });

  test('a choice made in the sidebar survives an OS theme change', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    const html = page.locator('html');
    const toggle = page
      .locator('aside:visible')
      .getByRole('button', { name: /^Theme:/ })
      .first();
    await expect(toggle).toBeVisible();

    // Auto -> Light -> Dark.
    for (let i = 0; i < 3 && !(await toggle.textContent())?.includes('Dark'); i++) {
      await toggle.click();
    }
    await expect(toggle).toHaveText(/Dark/);
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => window.__themeAtBody)).toBe('dark');
  });

  test('a stored light choice wins over a dark OS', async ({ page, context }) => {
    await context.addInitScript(key => window.localStorage.setItem(key, 'light'), DARK_MODE_KEY);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => window.__themeAtBody)).toBeNull();
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  });

  test('an embed URL with mode=light wins over a stored dark choice', async ({ page, context }) => {
    await context.addInitScript(key => window.localStorage.setItem(key, 'dark'), DARK_MODE_KEY);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${BASE}/admin?embed=true&mode=light`, { waitUntil: 'domcontentloaded' });
    // The pre-paint script leaves embeds to the app's bootstrap.
    expect(await page.evaluate(() => window.__themeAtBody)).toBeNull();
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  });
});
