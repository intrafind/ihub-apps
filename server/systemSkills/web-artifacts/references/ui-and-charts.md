# UI, Chart & Canvas Patterns for `web-artifacts`

## 1. Base HTML shell with corporate brand tokens & safe storage

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Interactive Artifact</title>
    <style>
      :root {
        --bg: #f8fafc;
        --surface: #ffffff;
        --border: #e2e8f0;
        --text: var(--brand-text, #0f172a);
        --muted: #64748b;
        --primary: var(--brand-primary, #1e3a8a);
        --accent: var(--brand-accent, #0f766e);
      }
      /* Dark: follow iHub's switch (data-theme), else the OS setting. */
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme='light']) {
          --bg: #0b0f19;
          --surface: #111827;
          --border: #1e293b;
          --text: #f1f5f9;
          --muted: #94a3b8;
        }
      }
      :root[data-theme='dark'] {
        --bg: #0b0f19;
        --surface: #111827;
        --border: #1e293b;
        --text: #f1f5f9;
        --muted: #94a3b8;
      }
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      body {
        font-family: var(--brand-font, system-ui, -apple-system, sans-serif);
        background: var(--bg);
        color: var(--text);
        line-height: 1.5;
        padding: 24px;
      }
      .num {
        font-variant-numeric: tabular-nums;
      }
    </style>
  </head>
  <body>
    <main id="app"></main>
    <script>
      // Safe storage wrapper for <iframe sandbox="allow-scripts">
      const store = (() => {
        const mem = new Map();
        return {
          get(key, fallback) {
            try {
              const raw = window.localStorage.getItem(key);
              return raw !== null ? JSON.parse(raw) : mem.has(key) ? mem.get(key) : fallback;
            } catch {
              return mem.has(key) ? mem.get(key) : fallback;
            }
          },
          set(key, value) {
            mem.set(key, value);
            try {
              window.localStorage.setItem(key, JSON.stringify(value));
            } catch {}
          }
        };
      })();
    </script>
  </body>
</html>
```

## 2. Libraries from the kit (offline)

iHub ships Chart.js, D3 and Alpine.js with the product. Load them with their markers; iHub inlines the library wherever the file runs or is downloaded, so nothing is fetched from the internet. Use a public CDN only when the user asks for one.

```html
<head>
  <script data-ihub-lib="chart.js"></script>
  <!-- defines Chart -->
  <script data-ihub-lib="d3"></script>
  <!-- defines d3 -->
</head>
<body>
  …
  <script>
    document.addEventListener('alpine:init', () => {
      /* Alpine.data(…) */
    });
  </script>
  <script data-ihub-lib="alpinejs"></script>
  <!-- defines Alpine; always last in <body> -->
</body>
```

- **Chart.js** draws on a `<canvas>`, which cannot read CSS variables. Read the theme once and pass colours in: `const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();` then `backgroundColor: css('--primary')`, `ticks: { color: css('--muted') }`, `grid: { color: css('--border') }`. Wrap the canvas in a box with a fixed height (`position:relative; height:240px`) and set `maintainAspectRatio: false`. Give the canvas `role="img"` and an `aria-label`, and offer the click targets (`onClick`) as buttons too, for the keyboard.
- **D3** builds SVG from data: `d3.select('#chart').selectAll('rect').data(rows).join('rect')`. Style with CSS classes that use the theme variables, so light and dark mode work without redrawing. Make clickable marks focusable (`tabindex="0"`, `role="button"`) with a keydown handler for Enter and Space.
- **Alpine.js** keeps state in the markup: `x-data="calc"`, `x-model.number="amount"`, `x-text="eur(total)"`, `@click="reset()"`. Register components with `Alpine.data('calc', () => ({ … }))` inside an `alpine:init` listener, and put the Alpine marker after that script, last in `<body>`.

## 3. Interactive SVG charts (zero dependencies)

For a handful of bars, a sparkline or a donut, render responsive SVG charts directly from state rather than loading a library:

- Map data values to SVG coordinates inside a fixed `viewBox="0 0 640 240"`.
- Add `<g>` hover targets or `<title>` tooltips on bars and points.
- Re-render the SVG innerHTML whenever sliders, filters, or scenario buttons change.

## 4. HTML5 `<canvas>` & generative visuals (`algorithmic-art`)

When building interactive simulations, particle systems, flow fields, or generative art:

- **High-DPI scaling**: scale the canvas backing store by `window.devicePixelRatio || 1` so lines and typography stay razor-sharp on Retina displays:
  ```js
  function setupCanvas(canvas, width, height) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return ctx;
  }
  ```
- **Seeded randomness**: use a deterministic PRNG (e.g. Mulberry32) driven by a seed input in the UI so users can explore, reproduce, and export specific variations:
  ```js
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  ```
- **Interactive parameter bar**: pair the canvas with live sliders (seed, density, speed, palette, export PNG button via `canvas.toDataURL('image/png')`).
