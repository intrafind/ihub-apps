---
name: web-artifacts
description: Build and change interactive, self-contained HTML web artifacts (.html) — live dashboards, calculators, ROI/pricing simulators, interactive data explorers, clickable UI prototypes, HTML5 Canvas/generative visualizations — and standalone vector graphics (.svg) that render live in the chat's Artifacts panel. Use whenever the user asks for an interactive web app, dashboard, calculator, UI prototype, interactive visualization or standalone SVG graphic, or for a change to one this chat already made. Do not use for static print PDFs/posters (use pdf), multi-file code repositories (use files/create_zip), or quick inline chat flowcharts (use a ```mermaid code block in chat).
metadata:
  author: IntraFind
  version: '1.5'
allowed-tools: create_web_artifact edit_web_artifact
---

# Building interactive web & SVG artifacts

You create live, interactive web artifacts and vector graphics with the `create_web_artifact` tool, and change them with `edit_web_artifact`. The user gets a download card in the chat and can interact with the artifact directly inside the **Artifacts** panel with a **Preview | Code** toggle.

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
2. **Libraries come from the offline library kit, always.** iHub ships a small set of vetted, version-pinned libraries. Load one with an empty marker element, and iHub puts the library itself in its place wherever the file runs or is downloaded (Artifacts panel, shared links and embeds, `.html` and `.zip` downloads). It works without internet access and in air-gapped installations, and the stored file stays small.

   | Library          | Marker                                       | Defines  | Use it for                                                                                                               |
   | ---------------- | -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
   | Chart.js 4.5.1   | `<script data-ihub-lib="chart.js"></script>` | `Chart`  | Standard charts: line, bar, area, pie/doughnut, radar, scatter, bubble, with tooltips and click events                   |
   | D3 7.9.0         | `<script data-ihub-lib="d3"></script>`       | `d3`     | Custom SVG visualizations and diagrams: scales, axes, shapes, hierarchies (tree, treemap, sunburst), force layouts       |
   | Alpine.js 3.17.3 | `<script data-ihub-lib="alpinejs"></script>` | `Alpine` | Declarative state in the markup (`x-data`, `x-model`, `x-show`, `x-for`, `@click`) for calculators, forms, tabs, filters |
   - Put the Chart.js and D3 markers in `<head>` (or anywhere before the script that uses them). Put the Alpine.js marker **last in `<body>`**, after the script that registers `Alpine.data(…)` in a `document.addEventListener('alpine:init', …)` listener.
   - Keep the marker empty: no `src`, no code inside, no version (or exactly the kit's). Your own code goes into a separate `<script>` after it. Each library once.
   - Names are exact: `chart.js`, `d3`, `alpinejs`. Anything else is not in the kit and `create_web_artifact` reports it.
   - A few bars, a sparkline or a KPI strip need no library: draw them as inline SVG (see the reference).
   - **Public CDNs only on request.** Load a library from a CDN only when the user explicitly asks for a CDN, or for a library the kit does not have. Then use one of the hosts this installation allows (by default `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com`), **pin an exact version** (`https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js`, never `@latest`), and tell the user the artifact then needs internet access. If `create_web_artifact` warns that the URL will not load, the host is not allowed here: inline the code instead.
   - **Nothing else reaches the network**: no `fetch`, XHR, WebSocket, remote images or fonts, and no CSS `url()`/`@import` from the network (so no Google Fonts). Only `data:` and `blob:` images and `data:` fonts load.

3. **Sandbox storage safety**: because the preview iframe runs without `allow-same-origin`, accessing `localStorage`, `sessionStorage`, or `document.cookie` throws a `SecurityError` unless guarded. Always keep primary state in memory and wrap any persistence helper in `try { … } catch {}`.
4. **No dead links**: the preview cannot leave the file and opens no new tabs or windows, so a link to anything outside the file does nothing. To let the user ask about something, use `sendPrompt` (next section) instead of a link. Never use `href="#"`, external URLs, file paths, `target="_blank"` or `window.open()` unless the user explicitly asks for a link to a given address. Everything a link, button, menu item, tab, "Sources" / "Quellen" or "Details" control points to must exist **inside the same file**: give it a real in-page target — a `#id` anchor to a section that exists, or a click handler that switches a view, opens a drawer, modal or dialog and shows the content (sample sources, details, a detail page, a help text). Navigation items must switch to a view, even a short one. If something is not part of the prototype, do not render it as a link or clickable control; show it as plain text or disable it.
5. **Complete implementation**: never leave `// TODO` or `// rest of code here` placeholders. Pre-load realistic sample data so the dashboard, calculator, or explorer is immediately useful on first render, and include controls to edit or reset the data.

## Follow-up questions from the artifact: `sendPrompt`

The preview defines `sendPrompt(text)`. Calling it from a click asks the chat a follow-up question: the user sees the text, confirms it, and it is sent as their next message. Use it to make an artifact conversational: a node of a diagram, a bar of a chart, a row of a table or an "Explain this" button asks about exactly that item.

- **Only on a click** the user makes, never on load, on a timer or in a loop. Nothing is sent without the user's confirmation, and a second question is ignored while one waits.
- **Write the question as the user would**, complete and specific, in the user's language, naming the item and its figures: `sendPrompt('Why did revenue in Q3 2026 drop by 12 %?')`, not `sendPrompt('q3')`. At most 2000 characters.
- **Mark what asks**: a short hint ("Click a bar to ask about it") and `cursor: pointer`, and use a `<button>` (or `role="button"` with `tabindex="0"` and an Enter/Space handler) so it works with the keyboard.
- **Guard it**: `sendPrompt` does nothing where no chat is around (a shared link: `sendPrompt.available` is `false`) and does not exist in a downloaded file. Show the ask controls only when `window.sendPrompt && sendPrompt.available`, and never hide information behind it: what an item shows must be readable without asking.
- **Local interaction stays local**: filtering, sorting, tabs and sliders are plain JavaScript in the page. Use `sendPrompt` only when the answer needs the model (an explanation, a deeper analysis, a next artifact).

```html
<button type="button" class="ask" data-q="Explain the drop in Q3 2026 revenue (-12 % vs. Q2).">
  Ask why
</button>
<script>
  const canAsk = Boolean(window.sendPrompt && sendPrompt.available);
  document.querySelectorAll('.ask').forEach(btn => {
    if (!canAsk) btn.hidden = true;
    else btn.addEventListener('click', () => sendPrompt(btn.dataset.q));
  });
</script>
```

## Changing an artifact: `edit_web_artifact`, not a new file

Writing a file costs as long as the file is. Once an artifact exists, change it with `edit_web_artifact`: the `filename`, and `edits`, each an `oldText` copied exactly from the current file (whitespace and quotes included, a few lines around the change so it occurs only once) and its `newText`. All edits apply or none; the result is the file's new version, checked like a new one.

- **After the user asks for a change** to an existing artifact (another colour, one more field, a different label, a fixed bug), edit it. Write a new file with `create_web_artifact` only when most of it changes or the user wants something new.
- **When you do not have the current text** (the file was made in an earlier turn), read it first with `chat_artifacts_read` and copy `oldText` from there.
- **When an edit is refused** (its `oldText` is not in the file, or occurs more than once), nothing was changed: correct that edit, by copying the text again or adding more of its surroundings, and send the call again.

## When the tool reports something

- **`warnings`** are problems that break the preview: a script that does not parse, unguarded `localStorage`, a script or stylesheet that will not load, a library marker that names nothing in the kit (or the kit is switched off on this installation: then draw inline SVG and write the code inline), relative files, a file that was cut off. The user already sees the broken version. Do not answer yet: fix each with `edit_web_artifact`, changing only the faulty lines. A file that was cut off is too long: write a more compact one with `create_web_artifact`, not the same one again.
- **`notes`** are things that work but could be better: a library from a public CDN that the kit has (switch to its marker unless the user asked for the CDN), a dead link, a remote image, a missing `viewBox`, a placeholder comment. Never write the file again for them. Fix one with `edit_web_artifact` when it is a small change, otherwise leave it.

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
- **Light & dark mode**: define semantic surface variables (`--bg`, `--surface`, `--border`, `--text`, `--muted`) on `:root`, and the dark values twice: under `:root[data-theme="dark"]`, and under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }`. The preview sets `data-theme` to iHub's own light/dark choice, which can differ from the operating system's; the media query covers the file opened on its own. Always give `body` an explicit background.

## Standalone `.svg` rules

When creating an `.svg` artifact (`format: "svg"`):

- Always include `xmlns="http://www.w3.org/2000/svg"` and a `viewBox="0 0 W H"` attribute.
- Use explicit `font-family="system-ui, -apple-system, sans-serif"` and explicit `fill` attributes on `<text>` elements.
- Include a background `<rect width="100%" height="100%" rx="12" fill="…" />` so dark text remains readable in both light and dark UI themes.

## Examples

Before writing an artifact, read the complete example closest to the job in `references/examples.md` (`read_skill_resource`, `skill_name` `web-artifacts`, `file_path` `references/examples.md`): a KPI overview with a clickable Chart.js chart, an Alpine.js calculator, a data explorer in plain JavaScript, a clickable D3 diagram, and an `edit_web_artifact` call. Each loads its library from the kit. Keep the structure, the theme tokens and the keyboard handling; replace the content. Its figures are invented: never reuse them.

For ready-to-use patterns (the library kit with Chart.js, D3 and Alpine.js in light and dark mode, interactive calculators, KPI dashboards, sortable tables, inline SVG charts, and seeded HTML5 `<canvas>` generative visuals), read `references/ui-and-charts.md` with `read_skill_resource` (`skill_name` `web-artifacts`, `file_path` `references/ui-and-charts.md`).

## Answer

After `create_web_artifact` runs, answer briefly: name the artifact, summarize its interactive controls (and which elements ask a follow-up question), and let the user know they can interact with it in the **Artifacts** panel (**Preview | Code**). Do not paste the HTML/SVG source into the chat and do not add a link.
