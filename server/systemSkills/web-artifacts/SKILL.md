---
name: web-artifacts
description: Build interactive, self-contained HTML web artifacts (.html) — live dashboards, calculators, ROI/pricing simulators, interactive data explorers, clickable UI prototypes, HTML5 Canvas/generative visualizations — and standalone vector graphics (.svg) that render live in the chat's Artifacts panel. Use whenever the user asks for an interactive web app, dashboard, calculator, UI prototype, interactive visualization or standalone SVG graphic. Do not use for static print PDFs/posters (use pdf), multi-file code repositories (use files/create_zip), or quick inline chat flowcharts (use a ```mermaid code block in chat).
metadata:
  author: IntraFind
  version: '1.0'
allowed-tools: create_web_artifact
---

# Building interactive web & SVG artifacts

You create live, interactive web artifacts and vector graphics with the `create_web_artifact` tool. The user gets a download card in the chat and can interact with the artifact directly inside the **Artifacts** panel with a **Preview | Code** toggle.

## Choose the right format

- **A dashboard of figures** that a tool or the user's data produced (KPI tiles, ranked bars, trends, tables, method and sources): activate the **`dashboard`** skill, if it is available, and let the server lay the page out from a JSON spec. Write HTML yourself only for what that cannot do.
- **`.html` (`create_web_artifact`, `format: "html"`)**: interactive dashboards, calculators, financial/engineering simulators, sortable/filterable data explorers, clickable UI prototypes, games, and interactive HTML5 `<canvas>` / generative visualizations.
- **`.svg` (`create_web_artifact`, `format: "svg"`)**: standalone scalable vector illustrations, architecture diagrams, custom infographics, and badges.
- **Inline ` ```mermaid ` block in chat**: quick flowcharts, sequence diagrams, ER diagrams or state machines when the user has not asked for a downloadable file or custom visual styling.
- **Print-ready posters, flyers, certificates, or multi-page reports**: use the `pdf` skill (`create_pdf`).
- **Source code files, config files, `.drawio`/`.excalidraw`, `.ipynb`, or multi-file `.zip` projects**: use the `files` skill (`create_file` / `create_zip`).

## The single-file output contract

Every `.html` artifact renders inside `<iframe sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc="…">`. Follow these rules strictly:

1. **One self-contained file**: put all CSS inside `<style>` and all JavaScript inside `<script>`. Never reference relative sibling files (`<script src="./app.js">` or `<link href="./styles.css">`) — `srcDoc` has no base URL and relative paths fail.
2. **Offline only**: use vanilla HTML5, modern CSS (Grid, Flexbox, custom properties), inline SVG, and HTML5 `<canvas>`. The preview blocks every network request (no `fetch`, WebSocket, external scripts, stylesheets, fonts or remote images); only `data:` and `blob:` images and `data:` fonts load. Inline everything, with no CDNs.
3. **Sandbox storage safety**: because the preview iframe runs without `allow-same-origin`, accessing `localStorage`, `sessionStorage`, or `document.cookie` throws a `SecurityError` unless guarded. Always keep primary state in memory and wrap any persistence helper in `try { … } catch {}`.
4. **No dead links**: the preview has no network and opens no new tabs or windows, so a link to anything outside the file does nothing. Never use `href="#"`, external URLs, file paths, `target="_blank"` or `window.open()` unless the user explicitly asks for a link to a given address. Everything a link, button, menu item, tab, "Sources" / "Quellen" or "Details" control points to must exist **inside the same file**: give it a real in-page target — a `#id` anchor to a section that exists, or a click handler that switches a view, opens a drawer, modal or dialog and shows the content (sample sources, details, a detail page, a help text). Navigation items must switch to a view, even a short one. If something is not part of the prototype, do not render it as a link or clickable control; show it as plain text or disable it.
5. **Complete implementation**: never leave `// TODO` or `// rest of code here` placeholders. Pre-load realistic sample data so the dashboard, calculator, or explorer is immediately useful on first render, and include controls to edit or reset the data.

If `create_web_artifact` returns `warnings` (such as a relative script/link, a dead link, unguarded `localStorage`, or missing `viewBox`), fix the issue and call `create_web_artifact` again.

## Corporate brand tokens & anti-"AI slop" design

`create_web_artifact` automatically injects CSS custom properties from the app's corporate document template (or the tool's brand parameters) into `<head>`:

- `--brand-primary` (corporate primary colour, default `#1e3a8a`)
- `--brand-accent` (corporate accent colour, default `#0f766e`)
- `--brand-text` (body text colour, default `#0f172a`)
- `--brand-font` (corporate font family)

Use them in your stylesheet (`color: var(--brand-primary); font-family: var(--brand-font), system-ui, sans-serif;`) so the artifact matches the company's identity automatically.

### Design rules (`frontend-design`)

- **Avoid generic "AI slop"**: never use generic purple-to-blue gradients on white cards, overused glassmorphism, or decorative buttons that do nothing.
- **Commit to a clear visual direction**:
  - _Swiss Editorial Grid_: crisp 1px borders (`#e2e8f0`), generous whitespace, bold typographic hierarchy, high-contrast accent indicators.
  - _Financial / Engineering Workbench_: dense, scannable KPI strip, interactive sliders with live delta badges, tabular numerals, clean comparison tables.
  - _Studio / Dark Canvas_ (for generative art or media tools): deep slate background (`#0b0f19`), subtle hairline borders (`rgba(255,255,255,0.08)`), luminous data series.
- **Numeric discipline**: always set `font-variant-numeric: tabular-nums` on KPI cards, tables, counters, and slider readouts so numbers never jitter when sliders move.
- **Light & dark mode**: define semantic surface variables (`--bg`, `--surface`, `--border`, `--text`, `--muted`) with `@media (prefers-color-scheme: dark)` support.

## Standalone `.svg` rules

When creating an `.svg` artifact (`format: "svg"`):

- Always include `xmlns="http://www.w3.org/2000/svg"` and a `viewBox="0 0 W H"` attribute.
- Use explicit `font-family="system-ui, -apple-system, sans-serif"` and explicit `fill` attributes on `<text>` elements.
- Include a background `<rect width="100%" height="100%" rx="12" fill="…" />` so dark text remains readable in both light and dark UI themes.

For ready-to-use patterns (interactive calculators, KPI dashboards, sortable tables, inline SVG charts, and seeded HTML5 `<canvas>` generative visuals), read `references/ui-and-charts.md` with `read_skill_resource` (`skill_name` `web-artifacts`, `file_path` `references/ui-and-charts.md`).

## Answer

After `create_web_artifact` runs, answer briefly: name the artifact, summarize its interactive controls, and let the user know they can interact with it in the **Artifacts** panel (**Preview | Code**). Do not paste the HTML/SVG source into the chat and do not add a link.
