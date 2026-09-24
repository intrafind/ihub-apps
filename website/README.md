# iHub Apps website

Static marketing site for iHub Apps. Structure mirrors the product pages of comparable enterprise AI platforms (home, Chat, Apps, Workflows & Agents, Integrations, API, Models, Security, Enterprise, Pricing, Docs, Changelog). Every screenshot is a real capture of iHub Apps running locally.

Background and the competitive analysis behind the structure: `concepts/2026-09-24 Langdock Competitive Analysis and Website Plan.md`.

## Layout

```
website/
  *.html                 generated pages — do not edit by hand
  assets/css/site.css    design tokens and layout
  assets/js/site.js      menus, tabs, lightbox, copy buttons
  assets/img/            logo and favicon (copied from client/public)
  assets/fonts/          Inter (self-hosted, no CDN)
  assets/screenshots/    WebP captures of the product (1600 px wide, 2× for phone)
  _src/build.mjs         static site generator
  _src/pages/*.mjs       one module per page: title, description and a list of sections
  _src/screenshots/      scripts to re-capture and optimise the screenshots
```

## Build

```bash
npm run website:build      # renders _src/pages/*.mjs → website/*.html, changelog from docs/releases/
npm run website:serve      # serves website/ on a local port
```

Pages are described as data. Each page module exports `{ file, title, description, sections }`; sections are rendered by the generator (`hero`, `stats`, `cards`, `features`, `tabs`, `bento`, `table`, `steps`, `faq`, `crosssell`, `cta`, `trust`, `html`). Navigation, footer, trust strip and the final call to action are shared partials in `build.mjs`.

`changelog.html` is generated from `docs/releases/<version>/{breaking-changes,features,fixes}.md`, the same files that power **Admin → What's New**.

## Deploy

The output is plain HTML, CSS, JS and images with relative links, so it can be served from any static host (GitHub Pages, S3, nginx). Copy the `website/` folder without `_src/`.

## Re-capturing screenshots

The screenshots were taken from a local development instance with a mock model, so no API keys were needed and the answers are deterministic:

```bash
npm run install:all
node website/_src/screenshots/mock-llm.mjs &                   # OpenAI-compatible mock on :8080
node website/_src/screenshots/prepare-contents.mjs            # points text models at the mock, enables preview flags
(cd server && WORKERS=1 OPENAI_API_KEY=sk-mock node server.js) &   # API on :3000
(cd client && npx vite --host --port 5173) &                   # UI on :5173
node website/_src/screenshots/capture.mjs                     # writes PNGs to website/_src/screenshots/out/
node website/_src/screenshots/optimize.mjs                    # converts to WebP into assets/screenshots/
```

`capture.mjs` logs in as the default local admin (`admin` / `password123`), pre-seeds the disclaimer acknowledgement and walks every admin and user page. Chromium is taken from Playwright's browser directory (`PLAYWRIGHT_BROWSERS_PATH` or `CHROME_PATH`).

## Copy rules

- No invented customers, logos, quotes or certifications.
- Numbers come from the repository (apps shipped, provider adapters, node types, languages).
- Preview features (Workflows, Agents, Skills, Marketplace, Durable Chats, Compare Mode) are labelled as such.
