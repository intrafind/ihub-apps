# Visual Posters, Certificates & One-Pagers (`canvas-design` Guide)

Use this workflow when the user asks for a **poster, event flyer, certificate, architectural one-pager, or visual infographic PDF**.

## 1. Choose a Design Philosophy First

Before writing `blocks`, commit to a single aesthetic direction and a disciplined 3-colour palette (background/surface, primary ink, and 1 focal accent):

| Aesthetic Direction             | Palette Example                                                        | Geometry & Typography                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Swiss Grid Precision**        | `#f8fafc` surface, `#0f172a` ink, `#dc2626` crimson accent             | Asymmetric column grid, crisp `1pt` horizontal rules, oversized numeric callouts (`28–42pt`), sans-serif (`font: "sans"`).            |
| **Editorial Monochrome & Gold** | `#ffffff` surface, `#18181b` ink, `#b45309` warm gold                  | Centered ceremonial hierarchy (ideal for certificates & invitations), serif display headings (`font: "serif"`), double-ruled borders. |
| **Dark Technical Blueprint**    | `#0f172a` hero SVG canvas, `#38bdf8` cyan vector lines, `#f8fafc` text | Deep navy hero SVG banner (`width="539" height="280"`), monospace metadata badges (`font: "mono"`), high-contrast KPI cards.          |
| **Warm Architectural Geometry** | `#fafaf9` warm stone, `#1c1917` charcoal, `#0f766e` deep teal          | Overlapping geometric circles/arcs in SVG, generous negative space, balanced 2-column bottom grid.                                    |

## 2. Document Settings for Visual Canvas Layout

Always configure `create_pdf` so the default report header does not collide with your poster composition:

```json
{
  "filename": "architecture-summit-poster.pdf",
  "title": "Enterprise Architecture Summit 2026",
  "showTitle": false,
  "pageNumbers": false,
  "pageSize": "A4",
  "orientation": "portrait",
  "margins": [28, 28, 28, 28]
}
```

- With `pageSize: "A4"` (`595.28 × 841.89 pt`) and `margins: [28, 28, 28, 28]`, your usable canvas width is **`539 pt`** (`595 - 56`) and usable height is **`785 pt`**.
- Keep all content on **1 page** unless the user asks for a multi-page brochure.

## 3. Composing the Visual Hierarchy

1. **Hero Vector Artwork (`svg` block, 35–50% of page height):**
   - Build a layered `<svg width="539" height="300" viewBox="0 0 539 300" xmlns="http://www.w3.org/2000/svg">` with:
     - Background rectangle (`<rect width="539" height="300" rx="10" fill="#0f172a"/>`)
     - Geometric grid lines, concentric circles, isometric blocks, or data curves with explicit `stroke`, `stroke-width`, and `opacity`
     - Category eyebrow tag, main display title, and subtitle positioned with generous padding (`x="32"`, `y` spaced by at least `1.3×` font size)
2. **Structured Middle Band (`columns` of `box` cards):**
   - Use 2 or 3 equal-width `box` blocks (`"width": "*"`, `"columnGap": 12`) for key dates, speaker highlights, or KPI figures.
3. **Bottom Details & QR Call-to-Action:**
   - Combine a left column (`width: "*"`) for venue/registration details and a right column (`width: "auto"`) with `{ "qr": "https://…", "fit": 76 }`.

## 4. Visual QA (`preview_pdf`)

Always call `preview_pdf` on page `1` after generating a poster or certificate:

- Verify the content did not spill onto a stray page 2 (if `pages > 1`, reduce the hero SVG height or vertical margins by `15–25 pt` and regenerate).
- Verify no `<text>` inside the `<svg>` is clipped at the right edge (`x + textWidth < 515`).
