# Layout blocks reference

`blocks` is a JSON array, passed to `create_pdf` as JSON text. Blocks render after `markdown`, in order. Each block is an object with **one content key**. A block may also be a plain string (a paragraph) or an array (blocks stacked vertically).

Unknown keys or invalid values are dropped, and each drop is reported in the tool's `warnings`.

## Content keys

| Key         | Value                                                                           | Notes                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markdown`  | string                                                                          | Any Markdown, as in the `markdown` parameter.                                                                                                                                                                             |
| `text`      | string, or an array of strings/text runs                                        | A run is `{ "text": "…", "bold": true, … }`: several styles in one paragraph.                                                                                                                                             |
| `stack`     | array of blocks                                                                 | Vertical group.                                                                                                                                                                                                           |
| `columns`   | array of blocks                                                                 | Side by side. Each column may set `width`: `"*"` (share the rest), `"auto"` (fit the content), a number in points, or `"30%"`. `columnGap` (points) on the block sets the gap.                                            |
| `table`     | object                                                                          | See [Tables](#tables).                                                                                                                                                                                                    |
| `ul` / `ol` | array of blocks                                                                 | Bullet or numbered list. Also `type` (`disc`, `circle`, `square`, `none`, `decimal`, `lower-alpha`, `upper-alpha`, `lower-roman`, `upper-roman`), `start`, `reversed` and `markerColor`. An item may set `listType`.      |
| `callout`   | `{ tone, title, markdown \| text \| content }`                                  | Shaded box with a coloured left edge. `tone` is one of `info`, `success`, `warning`, `danger`, `note`. `fillColor` and `borderColor` override the tone's colours.                                                         |
| `box`       | `{ markdown \| text \| content, fillColor, borderColor, borderWidth, padding }` | Bordered container; `content` is any block.                                                                                                                                                                               |
| `image`     | data URI, or a name from `images`                                               | PNG or JPEG only. Sized to its natural size, never beyond the page. `width`, `height` or `fit: [w, h]` set the size; `alignment` places it. Inside `columns`, always set `width`: an image does not shrink to its column. |
| `svg`       | SVG markup                                                                      | Up to 500 KB. Give the root `width`/`height` (points) or a `viewBox`. `width` or `fit` on the block scale it. No scripts, `foreignObject` or external images.                                                             |
| `canvas`    | array of shapes                                                                 | See [Canvas](#canvas).                                                                                                                                                                                                    |
| `qr`        | string                                                                          | QR code. Also `fit` (size in points), `foreground`, `background` and `eccLevel` (`L`/`M`/`Q`/`H`).                                                                                                                        |
| `toc`       | `{ "title": "…" }`                                                              | Table of contents from the headings (or use the `toc` parameter).                                                                                                                                                         |
| `pageBreak` | `"before"` / `"after"`                                                          | Alone in a block: a page break. On another block: a break before or after that block.                                                                                                                                     |

## Text properties (on any block)

`bold`, `italics`, `fontSize` (3–144), `color`, `background`, `alignment` (`left`, `center`, `right`, `justify`), `lineHeight` (0.5–4), `characterSpacing`, `decoration` (`underline`, `lineThrough`, `overline`), `decorationStyle` (`dashed`, `dotted`, `double`, `wavy`), `decorationColor`, `sup`, `sub`, `font` (`sans`, `serif`, `mono`), `opacity` (0–1), `noWrap`, `preserveLeadingSpaces`, `link` (`https://…` or `mailto:…`), `linkToPage` (page number), `style` (a style name, or a list of names).

A colour is `#rgb`, `#rrggbb` or a CSS colour name.

## Placement properties (on any block)

`margin`: a number, `[horizontal, vertical]` or `[left, top, right, bottom]` in points. Also `pageBreak`, `unbreakable` (keep the block on one page), `width` (inside `columns`), `headlineLevel` and `tocItem` (list the block in the TOC). `absolutePosition` and `relativePosition` take `{ x, y }`; use them sparingly, because positioned content does not flow.

## Tables

```json
{
  "table": {
    "headerRows": 1,
    "widths": ["*", 80, 80],
    "body": [
      ["Item", { "text": "Qty", "alignment": "right" }, { "text": "Price", "alignment": "right" }],
      [
        "Consulting",
        { "text": "12", "alignment": "right" },
        { "text": "1,440.00 €", "alignment": "right" }
      ],
      [
        { "text": "Total", "colSpan": 2, "bold": true },
        {},
        { "text": "1,440.00 €", "bold": true, "alignment": "right" }
      ]
    ]
  },
  "layout": "ihubTable"
}
```

- `body` is a list of rows. A cell is a string or any block.
- `headerRows` rows repeat on every page and get the header style.
- `widths` has one entry per column: `"*"`, `"auto"`, points or `"30%"`. The default is `"*"` for every column.
- Cell extras:
  - `colSpan` / `rowSpan`. Put an empty `{}` in each cell the span covers.
  - `fillColor`, `fillOpacity`.
  - `border: [left, top, right, bottom]` (booleans), `borderColor` (four colours).
- Table extras: `dontBreakRows`, `keepWithHeaderRows`, `heights`.
- `layout`:
  - Named layouts:
    - `ihubTable` (theme default: shaded header and zebra rows)
    - `ihubGrid` (all lines)
    - `ihubPlain` (no lines; good for aligning label/value pairs)
    - `noBorders`
    - `headerLineOnly`
    - `lightHorizontalLines`
  - Or a declarative object: `{ "hLineWidth", "vLineWidth", "hLineColor", "vLineColor", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "headerFill", "stripeFill", "outerBorderOnly" }`.

## Canvas

Vector shapes in a block's own coordinate space. The origin is the block's top-left; units are points.

```json
{
  "canvas": [
    { "type": "rect", "x": 0, "y": 0, "w": 515, "h": 4, "color": "#1d4ed8" },
    {
      "type": "line",
      "x1": 0,
      "y1": 12,
      "x2": 515,
      "y2": 12,
      "lineWidth": 0.5,
      "lineColor": "#9ca3af",
      "dash": { "length": 3 }
    },
    { "type": "ellipse", "x": 20, "y": 40, "r1": 10, "r2": 10, "color": "#10b981" },
    {
      "type": "polyline",
      "points": [
        { "x": 0, "y": 60 },
        { "x": 40, "y": 50 },
        { "x": 80, "y": 65 }
      ],
      "lineWidth": 2,
      "lineColor": "#f59e0b"
    }
  ]
}
```

Shape properties:

- Position and size: `x`, `y`, `w`, `h`, `r` (corner radius), `r1`/`r2` (ellipse radii), `x1`/`y1`/`x2`/`y2` (lines), `points` (polyline).
- Stroke and fill: `lineWidth`, `lineColor`, `color` (fill), `fillOpacity`, `strokeOpacity`, `dash: { length, space }`, `lineCap`.
- Other: `closePath`, `linearGradient` (a list of colours).

Use canvas for rules, colour bands and simple decoration; use SVG for charts.

## Named styles and images

Two more `create_pdf` parameters work with blocks. Like `blocks`, both are passed as JSON text:

- `styles`: `{ "badge": { "fontSize": 8, "bold": true, "color": "#ffffff", "background": "#0f766e" } }`. Refer to one with `"style": "badge"`.
  - Built-in styles: `h1`–`h6`, `paragraph`, `caption`, `small`, `muted`, `quote`, `code`, `title`, `subtitle`, `tableHeader`, `tableCell`.
- `images`: `{ "logo": "data:image/png;base64,…" }`. Refer to one with `{ "image": "logo", "width": 90 }` and reuse it as often as needed.

## Limits

- Images: PNG/JPEG data URIs, 5 MB each, 15 MB in total.
- SVG: 500 KB.
- Size: 50,000 layout elements, 5,000 table rows, 4 MB of content per call, 500 pages.
- Rendering stops after about 45 seconds.
