# Customization: UI Customization, Localization, Pages, Document templates, Short links — admin UI review

**Date:** 2026-11-12 · **Panel:** Product manager, UX designer, UI designer, Technical writer, iHub admin
**Pages in scope:** `/admin/ui` (8 tabs: Header, Start Page, Footer, Assets, Styles, Content, Error Pages, PWA), `/admin/localization`, `/admin/pages`, `/admin/pages/:pageId` (including `new`), `/admin/document-templates`, `/admin/document-templates/:templateId`, `/admin/shortlinks`, `/admin/shortlinks/:code` (`client/src/App.jsx:779-816`).

All five panel notes were delivered. Eight panels shared one instance and one IP, so the admin API limit (100 requests/min) and the login limit often answered 429. One `/admin/ui` load makes about 13 admin calls, so some write tests were proven in code rather than run. Those are marked "(code)". How pages *behave* after a failed load is reported as a finding, because an admin behind a NAT or a flaky proxy hits the same thing. Every `zz-customization-*` entity the panel created (pages, short links, templates, an asset, a footer link and two translation overrides) was deleted. No shared config was left changed: `contents/locales/en.json` and `de.json` are back to `{}`. The lead re-checked every disputed fact in code. That settled five conflicts and found one new bug: the short-link expiry field shows UTC as local time, so every edit of it shifts the stored time by the time-zone offset (CU-B19). An adversarial verifier then re-checked every finding (appendix): one was refuted (CU-B26), one narrowed (CU-B19), one upgraded to Confirmed (CU-B10) and one downgraded to Suspected (CU-B27).

## Summary

This part is where an admin makes iHub "theirs": product name, logo, colours, start page, header and footer, wording, legal pages, the corporate design of generated documents, and share links into apps. It is **not intuitive** for the main job, which is branding. Brand identity is spread over 5 tabs and 3 pages: the product name is set in 3 places and the brand colour in 4. Every image is uploaded in one tab and pasted as a URL into another. Nothing can be previewed: Save publishes to every user at once.

The biggest problems:
- **Short links fail their main job.** A link "to an app with a prefilled prompt" silently drops the prompt, edits never change where a link points, and the admin Copy/Test buttons ignore the base path (CU-B1, CU-B2, CU-B9).
- **/admin/ui loses work.** It has no unsaved-changes guard, and a stale tab overwrites the whole `ui.json`, which also holds the Pages registry, so saving it can delete pages (CU-B3, CU-B4).
- **Three editors have invisible, borderless inputs** (CU-B6).
- **Translation search dead-ends on first use** (CU-B7).

Wins to build on:
- **Document templates** (4/5): upload a Word or PowerPoint file, see the placeholders and layouts it detected, and download a sample. This is the model for "test before you rely on it".
- The **Start Page** tab, with good help text and full German.
- The **translation override** editor, a differentiator once fixed.

## 1. What this part does

- **UI Customization** (`/admin/ui`, [AdminUICustomization.jsx](../../client/src/features/admin/pages/AdminUICustomization.jsx)). One page with 8 emoji tabs, all stored in `contents/config/ui.json`, and one **Save Changes** at the top that writes the whole file:
  - Header: logo, favicon, title light/bold part, header colour, header links.
  - Start Page: home route, greeting, default chat app, default apps.
  - Footer: text and links.
  - Assets: an uploader.
  - Styles: theme colours, custom CSS and CSS variables, with 3 sub-tabs.
  - Content: browser-tab title, disclaimer and apps-list text, with 3 sub-tabs.
  - Error Pages: error and empty-state texts.
  - PWA: the install manifest.

  Used heavily on day 1, then a few times a year.
- **Localization** (`/admin/localization`). A default-language card, plus a search-and-edit list of the built-in i18n keys. Each key has its own Save and writes `contents/locales/{lang}.json`. Used when a customer wants different wording, typically "Assistant" instead of "App", in EN and DE.
- **Pages** (`/admin/pages`, `/admin/pages/:id`). Markdown or React (JSX) pages served at `/pages/{id}`, with an auth flag and allowed groups. The metadata lives in `ui.json` → `pages` and the bodies in `contents/pages/{lang}/{id}.md|jsx` (`server/routes/admin/pages.js:107-131`). Used for Imprint, Privacy, Terms and FAQ, set up once and edited rarely.
- **Document templates** (`/admin/document-templates`, `/:id`). The corporate design for generated PDF, Word, PowerPoint and Excel files: brand colours, fonts, page header and footer, and uploaded `.docx/.dotx/.pptx/.potx` files with placeholder and layout detection. It also offers sample downloads. Set up once per brand.
- **Short links** (`/admin/shortlinks`, `/:code`). `/s/{code}` redirects to an app, a path or an allow-listed URL, with optional params (`prefill`, `send`, `var_*`) and expiry. End users create most links from an app's Share panel. The admin page is for oversight and for admin-made campaign links.

## 2. Is it intuitive? — verdict

Panel median, persona range in brackets.

| Page | Score (1–5) | Why |
|---|---|---|
| UI Customization | 2 (2) | Organised by JSON section, not by task. One Save for 8 tabs, with no dirty marker and no leave guard. The product name appears in 3 places, and two fields are both labelled "Site Title". Logo, favicon and PWA icons are pasted paths. There is no preview. The Start Page tab alone scores 4 (TW). |
| Localization | 3 (2–4) | The copy is clear and fully German (TW: 4). But the search returns nothing on first use because "Changed only" is on (UX, admin: 2). It shows one language at a time, keys have no context, and the inputs have no border. |
| Pages list | 3 (2–3) | Standard DataTable. "Access: None" means *public* but reads as "nobody", and there is no URL column and no search. |
| Page editor | 2 (1–3) | No H1, and the inputs have no border. A whole legal page goes into a ~4-row textarea with no preview. Content Type comes *after* the content. Allowed Groups is free text with a wrong example, and the page URL is never shown. |
| Document templates list | 4 (3–4) | Good description, an honest empty state ("Documents use the built-in design until you add one"), and badges. The primary button is blue, unlike the rest of the admin. |
| Document template editor | 4 (3–4) | Sectioned cards, file slots, placeholder and layout detection, and sample PDF/DOCX/PPTX. Weak points: an empty colour shows a black swatch, Preview sits 2,900px below Save, and there is no leave guard. |
| Short links list | 2 (1–4) | Visually solid, with filters and mobile collapse (UI: 4). But there is no Target column, Copy/Test build the wrong URL under a base path, and the empty state contradicts the "Add New Link" button above it. |
| Short link editor | 1 (1–2) | Borderless inputs and unbound labels. Three overlapping targets (App / Path / Redirect URL) with no stated precedence, a prompt entered as raw JSON, an "Include Params" checkbox that is off by default and silently drops it, and edits that don't change the redirect. |

**Overall verdict.** An admin who knows `ui.json` can do everything here. An admin who doesn't will:
- not find the "real" product-name field;
- paste asset URLs between tabs;
- publish without seeing the result;
- lose edits by clicking the sidebar;
- give up on short links.

The part was built storage-first: one page per file. The admin's mental model is task-first: brand it, write the legal bits, point people to the right app. Document templates, the newest page, shows that the team already knows how to build the task-first version.

## 3. Task walkthroughs

The admin persona ran the tasks live; step counts are theirs. PM and UX re-walked tasks 1, 3, 4 and 6.

**T1 · Rebrand: logo, colours, product name, favicon, footer, preview before publish.** ~21 steps over 5 tabs. **Partial.**
- Assets → Add New Asset → choose file → Copy URL → Header → paste into Logo URL. Then the same again for the favicon. Then Styles → primary colour, Header → Light/Bold title, Content → Site Title, Footer links, Save.
- Pasting a URL shows no thumbnail (`img[src*=zz-customization-logo]` count 0, `admin/t1-header-logo-filled.png`).
- The Header Colour help itself says the default sidebar layout ignores the colour, so the first field set was wasted.
- "Which Site Title is real?" was only answered by reading `Layout.jsx`.
- The footer still said "iHub Apps", because that comes from the `product.name` locale key on another page.
- **Preview was impossible:** Save writes `ui.json` and calls `refreshUIConfig()` for everyone (`AdminUICustomization.jsx:57-67`).

**T2 · Start page greeting and app order.** ~8 steps. **Success** (checked up to Save; not published, to protect other panels).
- Clear controls and placeholders (`{{greeting}}`, `{{name}}`).
- The Heading field starts with "No languages configured" while Subtitle shows EN/DE.
- "Add Language" offers ~120 codes, including Gothic, Old Norse and Sumerian.
- The order of the *other* apps is edited on a different page (Apps → Reorder, or each app's `order` field).

**T3 · Change one label in EN and DE.** 11 steps. **Partial → success** after workarounds.
- Following the empty-state hint "Search above to find a label to change" returned "No matching translations" until "Changed only" was unticked (CU-B7).
- "New chat" matched 17 keys with no context; the sidebar key was identified by grepping `AppSidebar.jsx`.
- The EN draft appeared in the DE field after switching language (CU-B8).
- It needed two passes: pick en → search → edit → save → pick de → search again → edit → save.

**T4 · Imprint page plus a footer link.** 15 steps, 2 pages. **Success**, with a data-loss trap.
- Pages → Create → ID, title, content → Save. The URL `/pages/{id}` is never shown; it was guessed from the existing `/pages/privacy` footer link.
- Then UI Customization → Footer → Add Link. The new link is pre-filled as "New Link" → `/new-page`, enabled. Type the URL → Save.
- The list shows "Access: None" for the new public page.
- If `/admin/ui` was already open in another tab while the page was created, its Save erases the page (CU-B3).

**T5 · Word/PowerPoint document template.** 8 steps. **Success** for the template. The chat export could not run without an LLM (environment).
- Upload `.docx` → "Placeholders: {{content}}, {{title}}". Upload `.pptx` → layouts mapped to slide kinds.
- Sample DOCX header read "ACME GmbH — Sample report".
- Small issues: the upload is renamed to `word-template.docx`, and empty colours look black.

**T6 · Short link to an app with a prefilled prompt.** 9 steps plus a docs hunt. **Failed** (reproduced by UX, TW and admin).
- The `prefill` key had to be found in `docs/auto-send-feature.md`, which nothing links to.
- Created with `{"prefill":"…"}`: `/s/code` → `302 /apps/chat` (Include Params off by default).
- Edited to tick Include Params: still `302 /apps/chat` (edits never rebuild the target).
- The only working route is hand-typing `/apps/chat?prefill=…&send=true` into Redirect URL.

## 4. What is broken

P0 = data loss or lockout in a normal flow · P1 = blocked core task, silent wrong outcome or data loss in a plausible flow · P2 = wrong or misleading with a workaround · P3 = polish.

| ID | Status | What happens | Evidence | Severity |
|---|---|---|---|---|
| CU-B1 | Confirmed (repro ×4; verifier re-ran it) | **Editing a short link never changes where it points.** The editor loads the built `url` into "Redirect URL" and sends it back. The server rebuilds only when `url` is empty, so changing App, Path, Params or Include Params does nothing. The list shows the new App while `/s/code` still opens the old one. (UX, TW, admin.) | [AdminShortLinkEditPage.jsx:68-77, 107-113](../../client/src/features/admin/pages/AdminShortLinkEditPage.jsx); [shortLinkManager.js:231](../../server/shortLinkManager.js) `if (!next.url) next.url = buildTarget(next)`. Verifier: PUT `appId=email-composer, includeParams=true` with the stored `url` → `/s/zz-customization-v1` still 302 `/apps/chat`. TW repro: PUT `appId=email-composer` → `GET /s/zz-customization-tw-1` 302 `/apps/chat`. | **P1** |
| CU-B2 | Confirmed (repro) | **The prefilled prompt is silently dropped on create.** "Include Params" defaults to off, and `buildTarget` ignores params unless it is on. Save gives no warning and doesn't show the resulting URL. (All five.) | `AdminShortLinkEditPage.jsx:38`; `shortLinkManager.js:110`; admin `s21.out` (`RESOLVE /s/: 302 /apps/chat`); verifier: POST `{appId:"chat", params:{prefill:"Hello there"}}` → stored `url: "/apps/chat"`, `includeParams: false`. | **P1** |
| CU-B3 | Confirmed (code; not run, to protect shared data) | **Lost update on `ui.json` deletes pages.** `/admin/ui` POSTs the whole object it loaded, and the server writes it blindly (no ETag or version check). Pages create, update and delete do a read-modify-write of the same file from disk. Open `/admin/ui`, create a page in another tab (or a second admin does), then Save on `/admin/ui`: the page entry is gone, its `.md` is orphaned and footer links 404. The same applies to any two admins editing different tabs. (PM, UX, admin.) | [ui.js:238-262](../../server/routes/admin/ui.js) `writeJson('config/ui.json', config)`; [pages.js:151-177](../../server/routes/admin/pages.js); `AdminUICustomization.jsx:57-63`. | **P1** |
| CU-B4 | Confirmed (repro) | **No unsaved-changes guard on `/admin/ui`** (8 tabs, one Save), on the Translation overrides editor, or on the Document template editor. That editor tracks `dirty` to enable Save (`:183, :334`) but doesn't block navigation. UX and admin edited the Logo URL, clicked a sidebar item, got no prompt, and the edit was gone. `docs/admin-ui.md:513-517` promises a dialog on every edit page. Pages and Short links do have the guard. | `grep useUnsavedChanges`: in this part only `AdminPageEditPage.jsx:39`, `AdminShortLinkEditPage.jsx:50`; UX `s2.js`, admin `s5`; verifier re-ran it (edited the first Header field, clicked sidebar Overview → `/admin`, no dialog). | **P1** |
| CU-B5 | Confirmed (repro + lead code check) | **A failed load still offers Save.** If `GET /admin/ui/config` fails, the page shows the raw error and fills the forms from the public `/api/configs/ui`, with Save enabled. That config adds `version`, `computedRefreshSalt`, `defaultLanguage` and `admin.pages` (`dataRoutes.js:694-700`), and `validateUIConfig` only checks that `title`, `header` and `footer` exist. Saving therefore writes platform fields into `ui.json`, and can write a stale cached copy. TW marked it Suspected; the lead confirmed the code path. | `AdminUICustomization.jsx:36-43`; [ui.js:299-307](../../server/routes/admin/ui.js); PM screenshot `pm/shots/ui-header.png` (429 banner, Save active). | P2 |
| CU-B6 | Confirmed (screenshots, lead viewed `ui/sl-new.png`; verifier measured computed `border-top-width: 0px`, `padding-left: 0px` on the short link editor's first input) | **Invisible form controls.** The class lists carry `border-gray-300` but no `border` width, and there is no forms plugin (`client/src/features/admin/components/formStyles.js:5-6`). Text inputs, the date input, selects and textareas render with no border or padding. Affected: the short link editor, page editor, translation overrides and the default-language select. | `AdminShortLinkEditPage.jsx:170,194,206,218,252,263`; `AdminPageEditPage.jsx:135,158,203`; `TranslationOverridesEditor.jsx:118,138,195`; `AdminLocalizationPage.jsx:180`; `ui/sl-new.png`, `ui/pages-new.png`, `ui/F-loc-search.png`. | **P1** |
| CU-B7 | Confirmed (repro) | **Translation search dead-ends.** "Changed only" defaults to on, and the server filters on it. The empty state says "Search above to find a label to change", and following that hint returns "No matching translations." A first-time admin concludes the label can't be changed. (UX, admin.) | [TranslationOverridesEditor.jsx:23](../../client/src/features/admin/components/TranslationOverridesEditor.jsx) `useState(true)`, `:236-246`; `server/routes/admin/translations.js:157`; `GET /api/admin/translations/en?q=Send&changedOnly=true` → `{"total":0}`. | **P1** |
| CU-B8 | Confirmed (repro) | **Translation drafts leak across languages.** Drafts are keyed by `entry.key` only and survive the language switch. An EN draft shows in the DE row as dirty, and one Save writes English into `de.json`. (UX, admin.) | `TranslationOverridesEditor.jsx:28, 113-116, 193` (the language `onChange` resets only `limit`); admin `s15.out`. | P2 |
| CU-B9 | Confirmed (code; lead) | **Admin Copy/Test and the details popup drop the base path.** Under `/ihub/` they copy or open `https://host/s/abc`. The end-user share panel uses `buildPath()` correctly. Pages "View" has the same bug. (PM Confirmed; UX and TW Suspected; settled in code.) | [AdminShortLinks.jsx:90,99](../../client/src/features/admin/pages/AdminShortLinks.jsx) `${window.location.origin}/s/${code}`; `shared/components/ShortLinkDetailsPopup.jsx:17` `window.open('/s/…')`; vs `features/apps/components/AppLinkSharePanel.jsx:21`; `AdminPagesPage.jsx:88`. | **P1** (short links) / P2 (View) |
| CU-B10 | Confirmed (verifier repro of the header) | **Short-link redirects leave the base path.** The target is stored as `/apps/{id}` and redirected verbatim. The server learns its prefix per request (`X-Forwarded-Prefix`), but `res.redirect(link.url)` doesn't prepend it, unlike other redirects (`staticRoutes.js:79` uses `buildServerPath`). Verifier: with `X-Forwarded-Prefix: /ihub`, `GET /s/<code>` → `Location: /apps/chat`, while `GET /docs/` → `Location: /ihub/admin/docs`. A proxy that strips the prefix and doesn't rewrite `Location` sends the user out of `/ihub/`. | `shortLinkManager.js:107`; [shortLinkRoutes.js:173](../../server/routes/shortLinkRoutes.js); `server/utils/basePath.js:27-29`. | P1 (subpath deployments) |
| CU-B11 | Confirmed (code; lead) | **"Enabled" and "Same Page/New Page" on header and footer links do nothing.** The editors write `enabled` and `target`, but the footer (both layouts) and sidebar filters check only feature flags and page access, and `target` is derived from `url.startsWith('http')`. Footer → Add Link also pre-fills a live link "New Link" → `/new-page`, so an accidental Save publishes a 404, and unticking Enabled doesn't hide it. (PM, admin.) | `FooterCustomization.jsx:11-28`; `HeaderCustomization.jsx:324-333`; [Layout.jsx:182-197, 457-476](../../client/src/shared/components/Layout.jsx); `AppSidebar.jsx:568-579`; admin `s11.out`. | P2 |
| CU-B12 | Confirmed | **The Pages "Allowed Groups" example names groups that don't exist.** The placeholder is `admin, user or *`; the ids are `admins` and `users`, matched exactly. Copying the example locks everyone out. (UX, TW, admin.) | `AdminPageEditPage.jsx:202`; `contents/config/groups.json`; `utils/pageAccess.js:30-35`. | P2 |
| CU-B13 | Confirmed | **The Pages "Access" column is wrong.** Public pages show "None". `allowedGroups` is shown only when `authRequired` is set, although client and server enforce groups either way. (TW, UX, UI, admin.) | [AdminPagesPage.jsx:73-79](../../client/src/features/admin/pages/AdminPagesPage.jsx) vs `pageRoutes.js:34-38`, `pageAccess.js:24-38`; `tw/shots/de-pages.png`. | P2 |
| CU-B14 | Confirmed | **Deleting a page or asset in use breaks links without warning.** The footer and disclaimer link `/pages/privacy` and `/pages/terms`, yet the delete dialog says only "Delete this page?". Asset delete uses native `confirm()`. Neither checks references on the server. (UX.) | `contents/config/ui.json:77,86,108` (and the header link to `/pages/faq` at `:48`); `routes/admin/pages.js:182-215`; `AssetManager.jsx:99`; `ux/pages-delete-confirm.png`. | P2 |
| CU-B15 | Confirmed | **Misleading field help.** Footer Text says "You can use basic HTML tags", but the footer renders plain text, so tags show literally. Content → Site Title says "appears in the browser tab and header", but it only sets `document.title` (and the export title); the header uses Header → Light/Bold. (TW, admin.) | `FooterCustomization.jsx:102` vs `Layout.jsx:176`; `ContentEditor.jsx:98-102` vs `DocumentTitle.jsx:50`, `BrandTitle.jsx:14`. | P2 |
| CU-B16 | Confirmed (screenshot) | **Raw `$t(…)` tokens appear as field values.** Header → Tagline shows `$t(product.tagline)` and Footer Text shows `$t(footer.legal)`, with no explanation. An admin "fixes" them and loses the year placeholder. (UI, TW, PM.) | `ui/F-ui-header.png`, `ui/F-ui-footer.png`, `pm/shots/ui-Footer.png`. | P2 |
| CU-B17 | Confirmed (verifier at 390px: tab `nav` 831/358px with `overflow-x: visible`, `<main>` 847/390px, 0 `role="tab"`) | **/admin/ui tabs break at 390px and lack tab semantics.** The tab bar has no `overflow-x-auto`: "Start Page" wraps, Assets is cut off, and `<main>` once scrolled sideways. The StyleEditor sub-tabs have the same bug. There is no `role="tab"` or `aria-selected`; the shared `AdminTabs` has both. (UI.) | `AdminUICustomization.jsx:224`; `StyleEditor.jsx:209`; `AdminTabs.jsx:61-69`; `ui/M2-ui-header.png`. | P2 |
| CU-B18 | Confirmed | **Labels are not bound to their inputs** in the short link and page editors (no `htmlFor`/`id`), so screen readers announce unnamed fields. This is a BITV/WCAG 1.3.1 failure. (UI, admin `s8.out` `lbl=-`.) | `AdminShortLinkEditPage.jsx:162-262` (0 `htmlFor`); `AdminPageEditPage.jsx:126,152,195` (only the checkbox label at `:187` is bound). | P2 |
| CU-B19 | Confirmed (repro, narrowed by verifier) | **Short-link expiry is shown in UTC and saved as local time.** The ISO `expiresAt` (UTC) is shown via `substring(0,16)` in a `datetime-local` input, which treats it as local time; a value the admin types is parsed as local. So the field never round-trips: in Europe/Berlin a link expiring 11:00 local shows "10:00", and typing "10:00" on another day stores `09:00Z`, which reopens as "09:00". Saving an *unrelated* field does **not** move it (the untouched value is still the `Z` string; verifier repro). UX had suspected "expiry shows empty"; it shows the UTC time. Also, editing only the Params JSON doesn't trip the unsaved guard (`paramsText` isn't in `link`; verifier: Cancel left without a dialog). | `AdminShortLinkEditPage.jsx:74, 112, 250`; `:50`. | P2 |
| CU-B20 | Confirmed | **An empty brand colour looks black.** The swatch falls back to `#000000` next to a grey placeholder `#e30613`, so the admin reads the colour as set. (UI, UX, admin.) | `AdminDocumentTemplateEditPage.jsx:83`; `ui/F-dt-edit.png`, `admin/t5-edit-top.png`. | P2 |
| CU-B21 | Confirmed | **Raw transport errors and false empty states.** `/admin/ui` and Assets show "Request failed with status code 429" (`err.message`). Assets shows "No assets uploaded yet — upload your first asset *above*" under the load error, and the upload control is not above. The Pages list shows only a red line with no Retry, while Document templates has one. Pages and Translations already use `getAdminApiErrorMessage`. (All five.) | `AdminUICustomization.jsx:39,73,88`; `AssetManager.jsx:28,91,111`; `pm/shots/ui-Assets.png`, `ui/F-ui-assets-upload.png`; `AdminDocumentTemplatesPage.jsx:139`. | P2 |
| CU-B22 | Confirmed (verifier recount: 196 of 427 keys missing from both files in the 25 page/component files of this part; TW's 206 also counted shared components) | **About 200 admin strings in this part are missing from `en.json` and `de.json`**, so German admins see English. The worst areas are Header, Footer, Assets, Content, PWA, Pages and Short links. Hard-coded literals: the `/admin/ui` success and backup messages, the "Unsaved Changes / Leave / Stay" dialog, and the "Pages / New Page" breadcrumbs. Because the keys are missing, the override editor can't fix them either. The expired short-link page is plain English text. (TW, UI, PM.) | `tw/keys.py`; `AdminUICustomization.jsx:65,84`; `AdminShortLinkEditPage.jsx:283-286`; `AdminPageEditPage.jsx:117-121`; `shortLinkRoutes.js:147-149`. | P2 |
| CU-B23 | Confirmed | **Doc errors that send admins the wrong way:**<br>• `icons.md:242` "Admin → System → Assets" names a page that doesn't exist.<br>• `auto-send-feature.md:280` links `user-guide.md#short-links`, which has no such section.<br>• `ui.md:584-610` shows page `content` inline in `ui.json`; bodies are files.<br>• `admin-ui.md:24` leaves Document templates out.<br>• `admin-ui.md:513` promises a guard that /admin/ui lacks.<br>• The Assets help says to put the favicon "in your HTML head", but Header has a Favicon field (`AssetManager.jsx:282`). | grep (lead re-checked all six). | P2 (docs) |
| CU-B24 | Confirmed | **Native browser dialogs**: `alert('ID is required')` (page editor), `confirm()` (asset delete) and `window.prompt()` (StyleEditor) bypass `ConfirmDialog`. They are unstyled in dark mode and can't be translated. | `AdminPageEditPage.jsx:76`; `AssetManager.jsx:99`; `StyleEditor.jsx:60-65`. | P3 |
| CU-B25 | Confirmed (code) | **Changing a page's Content Type after creation keeps the old file.** JSX is written into `{id}.md` (or Markdown into `.jsx`), because the stored `filePath` wins. | `routes/admin/pages.js:169-174`. | P3 |
| CU-B27 | Suspected (verifier) | Disabled read-only fields (Code, User ID) are near-invisible in dark mode in the short link editor. By code the text is `dark:text-gray-400` on `dark:bg-gray-800` (about 5.8:1), so the text itself passes; what is invisible is the field boundary, which is CU-B6. | `ui/D-sl-edit.png`; `AdminShortLinkEditPage.jsx:194`. | P3 |

## 5. Findings by persona

### Product manager

- **CU-PM1 · Brand identity has no single source.**
  - The name lives in `ui.title`, `header.titleLight/Bold`, `product.name` (which drives "Welcome to …", the footer copyright and share texts; `docs/localization.md:28-50`), `pwa.name` and the template `companyName`.
  - Colours live in `header.defaultColor` (embed layout only, by its own hint `HeaderCustomization.jsx:134`), `theme.*`, `pwa.themeColor` and template `brand.*`.
  - Fix: a Brand tab that writes once and fans out, with the per-surface overrides under "Advanced". See §6.
- **CU-PM2 · No draft, preview or publish.** Save goes live for everyone (`ui.js:247`), and the audit log records only "Updated UI configuration", with no diff (`ui.js:254-259`). Competing products (Copilot Studio, Glean, Dify) show the chat surface next to the branding form.
- **CU-PM3 · Config that is JSON-only.** None of these has a UI:
  - `appsList.categories.list` (category names and colours). Admins can assign a category in the app editor but cannot create one; only the enable toggle exists (`ContentEditor.jsx:367`).
  - All of `promptsList.*`.
  - `appsList.sort`, `appsList.search.*`.
  - `header.languageSelector.enabled` (`AppSidebar.jsx:783`).
  - `icons.assistantMessage/userMessage/errorMessage`.
  - `disclaimer.link/hint`.
  - Adding a UI language beyond en/de (`configCache.js:1026`).

  Fix first: the categories editor and the language-selector toggle.
- **CU-PM4 · Three overlapping "notice to users" features.** The UI → Content → Disclaimer popup, the EU AI Act → AI notice, and the AI acknowledgement (`AiNoticeSettingsCard.jsx:124`). Nothing says which to use or whether they stack. (Also UX9, UI14, TW10.)
- **CU-PM5 · Pages are disconnected from navigation, and no Imprint ships.** Defaults ship privacy, terms, faq and nda-guide (`server/defaults/config/ui.json`), but no Impressum, which is a legal requirement in DE and AT, the core market.
- **CU-PM6 · Short links are a power-user form.** The end-user share panel (`AppLinkSharePanel.jsx:41`, `includeParams` defaults to **true**, built from the live chat) already does this job better. The admin form needs undocumented JSON keys.
- **CU-PM7 · "Backup Config" is half-built.** It writes `backups/ui-config-backup-<ts>.json` on the server and shows that path (`ui.js:267-285`, `AdminUICustomization.jsx:84`). It has no download, restore or list, and a real `/admin/backup` page exists. Replace it with `ChangeHistoryDrawer` (already used by other editors) plus theme export/import.
- **CU-PM8 · The Content tab is a grab-bag.** It holds the site title (which overlaps Header), the disclaimer (which overlaps EU AI Act) and the apps-list text (which belongs with Start Page).
- **CU-PM9 · Sidebar visibility is coupled.** Localization and Document templates are visible only if `showAdminPage('ui')` (`AdminSidebarNavData.js:240,254`). Hiding UI Customization from a delegated admin also hides document templates, which is a different job. Give each its own key.
- **CU-PM10 · Missing enterprise expectations:**
  - an announcement banner (dismissible, time-boxed, per group), which Open WebUI and Glean have;
  - per-group branding or start page;
  - an audit diff for branding changes.
- **CU-PM11 · Document templates don't reuse the UI brand.** A new template starts empty. Add "Start from the iHub brand", which fills colours, logo and company name from `ui.json` and `product.name`.

### UX designer

- **CU-UX1 · Steps per image.** Uploading a logo takes 7 steps across 2 tabs, and the same applies to each of the 6 URL fields (logo, favicon, apps-list logo, 3 PWA icons). The PWA copy says it outright: "Upload via Assets tab, paste URL here". Fix: an inline `AssetPicker` showing a thumbnail, Upload and Choose from library.
- **CU-UX2 · The save model is inconsistent within one part.**
  - `/admin/ui` has one Save for 8 tabs, while Assets uploads and deletes apply immediately.
  - Localization saves per row.
  - The template editor saves silently before an upload (`AdminDocumentTemplateEditPage.jsx:227`).
  - The page editor saves and jumps to the list with no toast.
  - No tab shows a "modified" dot.
- **CU-UX3 · Tabs can't be deep-linked.** `activeTab` is local state (`AdminUICustomization.jsx:26`), so docs, Cmd+K and "fix this" links can't open Footer directly. Fix: `?tab=footer`.
- **CU-UX4 · Cmd+K can't find this part's features.** The palette matches page labels only (`AdminCommandPalette.jsx:11-45`): "logo" → "No results found." (`ux/cmdk-logo.png`). Searches for footer, favicon, imprint, brand, greeting and translation all miss too. Fix: add keywords per nav entry, and add pages, templates and short links to entity search.
- **CU-UX5 · "Content → Page Content" configures the apps list,** not Pages (`ContentEditor.jsx:164-290`).
- **CU-UX6 · Link fields don't know about pages or apps.** Footer and header URLs are free text (`FooterCustomization.jsx:160`, placeholder `/page-url`). Start Page already has a page `<select>` (`StartPageCustomization.jsx:166-190`) that could be reused.
- **CU-UX7 · The page editor is ordered for files, not authors.**
  - Content Type sits below the content.
  - DE content needs "Add Language" on every field, while UI tabs show EN+DE by default (inconsistent `DynamicLanguageEditor` defaults).
  - "Authentication Required" and "Allowed Groups" don't explain how they interact.
  - A duplicate ID fails only on Save (`ux/pages-duplicate.png`); the template editor's inline ID rules are the pattern to copy.
- **CU-UX8 · App order needs another page.** "Order of the remaining apps → Configured order (the app's order field)" (`StartPageCustomization.jsx:410`) sends the admin to each app's editor to type numbers. Fix: a "Reorder all apps" drawer on this tab.
- **CU-UX9 · The template editor is a ~10-screen scroll** with uploads in sections 5–6. Neither the list nor the delete dialog shows which apps use a template. Fix: anchor chips per section and "Used by: N apps".
- **CU-UX10 · Short link edit is buried.** Edit is reachable only via a row click and then a popup button (`ShortLinkDetailsPopup.jsx:106`). There is no Edit row action, and no copy or QR after create.

### UI designer

- **CU-UI1 · Two primary colours in one sidebar group.** Document templates uses `PRIMARY_BUTTON_CLASS` `bg-blue-600` (`formStyles.js:28`), while the rest uses hand-written `bg-indigo-600` (82 indigo vs 48 blue across the admin). Roadmap 3B-3 specifies indigo. Compare `ui/dt-list.png` with `ui/pages-list.png`.
- **CU-UI2 · Five page-header patterns.**
  - H1 is `text-3xl bold` in a full-bleed band on /admin/ui, `text-2xl semibold` on Pages and Short links, and `text-2xl bold` on Localization and Templates.
  - The page editor has no H1.
  - Wrappers range from `max-w-2xl` to `7xl`.
  - Fix: `AdminPageHeader` (title, description, actions, help link).
- **CU-UI3 · Three editor layouts.** The five well-built editors (App, Group, Model, Prompt, User) use `AdminEditPageShell`; Page and Short link don't. The page editor's grey filled Cancel appears nowhere else.
- **CU-UI4 · Emoji tab icons** in three tab bars (`AdminUICustomization.jsx:103-110`, `StyleEditor.jsx:211-216`, `ContentEditor.jsx:55-57`). They render differently per OS and are read aloud by screen readers. Use `AdminTabs` with `Icon`.
- **CU-UI5 · Colour fields.** Styles repeats the same 19 unlabeled swatches under 12 fields, about 228 buttons (`ui/F-ui-styles-theme.png`). Header colour is a text input with 13 more swatches, while PWA uses `type="color"` (`PwaCustomization.jsx:157`). Fix: one `ColorField` with a native picker, hex input, contrast badge and brand-palette popover.
- **CU-UI6 · Previews are in the wrong places.**
  - The Styles preview sits at the bottom of a 2,100px tab.
  - Content → Site Title has its own tab-title mock.
  - Header, Footer and Start Page have no preview at all.
- **CU-UI7 · Walls of text.** Error Pages is 3,854px tall: 6 groups × 3 fields × EN/DE (`ui/F-ui-errorpages.png`). A tab-level language switch with "missing DE" badges, plus an accordion per error, would roughly halve the Header, Footer, Error Pages and Disclaimer tabs.
- **CU-UI8 · Link cards waste space and can't be reordered.**
  - Each link card uses ~165px.
  - It mixes `px-2 py-1 rounded-sm` inputs with `px-3 py-2 rounded-md` ones (`HeaderCustomization.jsx:313,330`).
  - Fix: show them as table rows using `ReorderableList`.
- **CU-UI9 · Assets reinvents components.** It uses a hand-built `<table>` (`AssetManager.jsx:370`) and native `confirm()`. Its empty state points "above" to a collapsed panel.
- **CU-UI10 · Inconsistent empty states.**
  - Short links: `DataTableEmpty` (good).
  - Templates: a blue callout.
  - Assets: a grey box.
  - Start Page → Heading: "No languages configured" although English is the default (`ui/F-ui-startpage.png`).
- **CU-UI11 · The template editor breadcrumb** has no "Admin" root and truncates to "Document temp…" (`AdminDocumentTemplateEditPage.jsx:309-316`, `AdminBreadcrumb.jsx:37` `max-w-[120px]`).
- **CU-UI12 · Shell, for the shell panel.** `AdminDemoAccountsAlert` wraps one word per line at 390px (`ui/M-loc.png`). Also, `colorScheme: 'dark'` alone often left the admin light.

### Technical writer

- **CU-TW1 · No contextual help in the whole part.**
  - Grep finds no `/admin/docs` links in any page or component here.
  - `client/src/features/admin/utils/docsLinks.js` already maps doc paths to `/admin/docs/<file>#<anchor>`, so the plumbing exists.
- **CU-TW2 · One concept, four fields, three names.**
  - "Site Title" (Header).
  - "Site Title (Multi-language)" (Content, with a wrong hint, CU-B15).
  - "App Name" (PWA).
  - `product.name` (Localization).

  Rename the fields "Header title (light / bold part)" and "Browser tab title", and add one "Product name" concept.
- **CU-TW3 · "Default chat app" vs "Default apps"** (`StartPageCustomization.jsx:467`) are different things. The docs call the second "featured apps" (`admin-ui.md:351`, `ui.md:436,469`) and the key is `featuredAppIds`. Call them "Pinned apps" / "Angeheftete Apps" everywhere.
- **CU-TW4 · Short-link microcopy names the data model.** Rewrites:
  - "Code" → "Short code: the part after /s/. Leave empty to generate one."
  - "Redirect URL" → "Custom target (overrides App and Path)".
  - "Include Params" + "Params (JSON)" → "Start the chat with a prompt", "Send automatically" and "Variables", with JSON under Advanced.
  - "Invalid params JSON" → "Params must be a JSON object, e.g. {"prefill": "Summarise this"}."
  - "Delete this link?" → "Delete short link /s/{{code}}? Anyone who opens it will get 'Not found'."
- **CU-TW5 · The page editor omits what task 4 needs.**
  - No `/pages/{id}` address hint.
  - No `UserComponent` rule for React pages.
  - No explanation of how authentication and groups interact.
- **CU-TW6 · Inconsistent names in one nav section.**
  - H1s: "Pages Administration", "Short Links Management", "Asset Management", "Header Configuration", "Style Configuration".
  - Create verbs: "Create Page", "Add template", "Add New Link", "Add Link".
  - "Same Page/New Page" means *tab*.
  - Pages and Templates share `DocumentTextIcon`.
  - Fix: sentence case, H1 = nav label, "New <thing>", "Open in: same tab / new tab".
- **CU-TW7 · "Styles" collides with `docs/styles.md`** (writing styles), and a docs search for "Styles" lands there. Rename the tab "Colours & CSS".
- **CU-TW8 · Docs search misses this part's vocabulary.**
  - "imprint" → 0 results.
  - "logo" → Logout sections first.
  - "assets" → reverse-proxy troubleshooting.
  - "short link" → the `platform.md` config key.
  - "branding" → AUDIO_UI_GUIDE.

  Task guides with these words in their headings fix most of this. Also rank whole-word title matches above prefix matches.
- **CU-TW9 · German is split by screen age.** Start Page, Localization, Document templates and the EU AI Act cards are fully German. Header, Footer, Assets, Content, PWA, Pages and Short links are mostly English, and the short link editor mixes both on one screen (`tw/shots/de-shortlinks-new.png`). See CU-B22.

### iHub admin

- **CU-ADMIN1 · Branding is 21 steps with no preview.** One of the first fields set, Header Colour, has no effect in the default layout. Hide it when the sidebar layout is active.
- **CU-ADMIN2 · Translation keys have no context.** "New chat" matched 17 keys (`pages.appChat.newChat`, `sidebar.newChat`, `projects.chats.newChat`…). Group results by area, hide `admin.*` by default, and show EN | DE in one row. Longer term: an "Edit texts" mode in the end-user UI.
- **CU-ADMIN3 · Pages hide their URL.** Show "URL: /pages/{id}" with Copy, show "Public" / "Signed-in" / groups in the list, and add a JSX starter for React pages.
- **CU-ADMIN4 · Document templates is the model page.** Keep the original filename and upload date (today the upload is renamed to `word-template.docx`). Show an empty swatch as hatched. Add "Use UI theme colours and logo" and "Used by apps".
- **CU-ADMIN5 · The Start Page language picker lists ~120 codes,** including Sumerian (`s6` output). Pre-create rows for the installation's languages and limit the picker to those plus "other…".
- **CU-ADMIN6 · Errors don't help recovery.** When the session lost admin rights mid-edit, the page showed "Admin access requires authentication with admin privileges." with no sign-in link (`s10.out`). Map RATE_LIMITED to "Wait a minute and try again" with Retry, and 401/403 to a re-login link that keeps the draft.
- **CU-ADMIN7 · Short links belong near Apps.** Add a "Share link…" action on each app row. Keep `/admin/shortlinks` for oversight.

## 6. What should be rearranged

The panel converged on re-cutting `/admin/ui` by job, not by `ui.json` section. The proposed Customization sidebar:

1. **Branding** (new tab or page; absorbs Header identity fields, Styles → Theme colours, Content → Site Title and PWA identity):
   - one Product name field (writes `product.name` for each language and offers to fill `title`, `header.title*` and `pwa.name`);
   - tagline;
   - logo and favicon via `AssetPicker`;
   - brand palette via `ColorField`;
   - Advanced: dark-mode colours, the embed header colour, PWA details and icons generated from the logo.

   Reason: the product name exists in 3 places and colours in 4 (CU-PM1, CU-TW2).
2. **Start & apps.** Today's Start Page, plus apps-list title, search and categories (moved from Content → Page Content), plus a "Reorder all apps" drawer. Reason: CU-UX5, CU-UX8.
3. **Navigation & footer.** Header (sidebar) links and footer text and links as reorderable rows, with a shared link-target picker (Content page / App / External URL). The footer text shows the resolved text and offers "Edit copyright text" (a deep link to the `footer.legal` override). Rename it: "Header" is a misnomer in the default sidebar layout (`docs/ui.md:116-135`).
4. **Messages.** Error and empty-state texts, with a tab-level language switch and an accordion.
5. **Advanced.** Custom CSS, CSS variables, the asset library. Rename "Styles" to "Colours & CSS".
6. **Dissolve the Content tab.** Its three sub-tabs go to Branding (title), Start & apps (apps list) and EU AI Act (disclaimer).
7. **Move the Disclaimer** next to the AI notice and AI acknowledgement on the EU AI Act page, renamed "Notices & consent". Until then, cross-link both ways (CU-PM4).
8. **Remove "Backup Config"** in favour of change history plus `/admin/backup` (CU-PM7).
9. **Pages → "Content pages"**, with URL and "Linked from" columns, "Visible to: Everyone / Signed-in users / groups", and search.
10. **Localization:** put the overrides editor first (the frequent task) and default language second.
11. **Short links:** add an entry point from each app row on `/admin/apps`, plus Target and Prefill columns on the list.
12. **Visibility keys:** give Localization and Document templates their own `showAdminPage` keys (CU-PM9).
13. **URL state:** put the tab in the URL (`/admin/ui?tab=footer`) so docs, Cmd+K and error messages can deep-link.
14. **Sidebar label:** "UI Customization" → "Branding & layout" once the re-cut lands. Fix `docs/admin-ui.md:24` at the same time.

## 7. Where another approach fits better

| Today | Proposed | Why |
|---|---|---|
| Logo, favicon, apps-list logo and 3 PWA icons are URL text fields filled by copy-paste from the Assets tab | `AssetPicker` field (thumbnail, Upload, Choose from library, URL fallback), reusing `TemplateFileSlot`'s look | Removes 5 steps per image and the stale "paste in HTML head" advice (CU-UX1, CU-B23) |
| Save writes straight to production for everyone | Server-side **draft** plus "Preview in my session" (split-view iframe of `/` rendering the draft, desktop/mobile, light/dark), then **Publish** with an audit diff | Task 1's "preview before publishing" is impossible today (CU-PM2) |
| Whole-file `POST /admin/ui/config` with no version check | ETag/`If-Match` (409 "Someone changed this: reload or overwrite"), then per-section `PATCH` (`header`, `footer`, `startPage`…) with `pages` moved out of `ui.json` | Fixes CU-B3 and the multi-admin case |
| One global Save at the top for 8 tabs | A sticky "N unsaved changes · Discard · Save" bar with per-tab dots, plus `useUnsavedChanges` | Fixes CU-B4 and the missing feedback |
| 12 colour fields × 19 swatches; text input for header colour | One `ColorField` with derived hover/dark variants and a WCAG contrast badge | 228 buttons → 12 compact fields; brand once, derive the rest |
| Short link: App / Path / Redirect URL plus "Include Params" plus raw JSON | Segmented "Link to: App · Page · External URL", then "Prefilled prompt", "Send automatically", Variables (from the app definition), Model; JSON under Advanced; live "→ /apps/chat?prefill=…" preview; result card with Copy, QR and Test | The task fails today (CU-B1, CU-B2) |
| Footer and header link URLs typed by hand | Link-target combobox (pages, apps, known routes, external URL) | URLs are guessed today (T4) |
| Pages "Allowed Groups" free text, `*` magic value | Visibility radio (Everyone / Signed-in / Specific groups) plus `GroupMultiSelect` | The wrong placeholder locks everyone out (CU-B12) |
| Pages body in a 4-row textarea | Monaco (already a dependency) in Markdown/JSX mode, side-by-side preview via `MarkdownRenderer`/`ReactComponentRenderer`, and a `UserComponent` scaffold | The help text already claims "syntax highlighting" |
| Delete page/asset/template: "Delete this?" | Reference-aware delete: "Imprint is linked from the footer (1) and the disclaimer (1). Remove those links too?" | CU-B14 |
| Translation overrides: one language at a time, search by key or text | One row per key with Built-in / Override columns per enabled language, results grouped by area. Longer term: in-context "Edit texts" mode in the end-user UI | Task 3 takes two passes, and keys have no context (CU-ADMIN2) |
| `alert()` / `confirm()` / `window.prompt()` | Inline validation and `ConfirmDialog` | CU-B24 |
| Per-field previews (tab-title mock, Styles button swatch) | One persistent preview pane | CU-UI6 |

## 8. Wizards to add

**W1 · Brand iHub for your company** (H).
- **Starts from:** the setup wizard's next-steps screen (roadmap 3B-5, `concepts/2026-05-28 Admin UI Phase 3 Roadmap.md:148-151`), a "Make it yours" card on Overview, and a button on the Branding tab.
- **Who needs it:** every new installation, on day 1. All five personas proposed it.
- **Steps:**
  1. Name and tagline: EN/DE side by side; writes `product.name` and `product.tagline`.
  2. Logo: upload once; generates favicon and PWA 192/512/Apple icons; asks for alt text.
  3. Colours: primary suggested from the logo, then accent; dark variant derived automatically; contrast check.
  4. Footer and legal: tick Imprint, Privacy and Terms; creates missing pages from W2 templates and links them in the footer.
  5. Documents (optional): "Use this brand for PDF/Word/PowerPoint" creates or updates the default document template.
  6. Preview: start page, chat and footer, at desktop and mobile, in light and dark.
  7. Diff and **Publish**, or Save draft.
- **What it validates and creates at the end:** contrast ratios, image sizes and types, and that every footer link resolves. It writes `ui.json` (title, header, theme, pwa, footer), the locale overrides, the pages and optionally a document template.
- **What it replaces:** the 21-step tour across 5 tabs and 2 other pages.

**W2 · Add a legal page** (M). A template picker, not a long wizard.
- **Starts from:** "New page" on `/admin/pages`, and step 4 of W1.
- **Who needs it:** every DE/AT customer (Impressum).
- **Steps:**
  1. Type: Imprint, Privacy, Terms, Cookie notice, Blank Markdown or Blank React (with a `function UserComponent` scaffold).
  2. Content: EN and DE skeletons with placeholders (company, address, register number), with a live preview.
  3. Visibility: Everyone, Signed-in users or Groups.
  4. Placement: "Show in footer" (on by default) and/or sidebar, with a label for each language.
- **At the end:** it validates the slug inline, creates the page plus the footer link in **one** server call (no two-tab race), and shows the URL with Copy and View.
- **What it replaces:** the 15-step round trip between Pages and UI → Footer.

**W3 · Share an app (short-link builder)** (M). One guided screen, not multi-step (UI and TW agree).
- **Starts from:** `/admin/shortlinks` "New short link", a "Share link…" action on app rows, and, as the same component, the end-user Share panel.
- **Steps:**
  1. App: a single searchable select.
  2. Start with: prefilled prompt, variables from the app definition, Send automatically, optional model.
  3. Link: code (auto, editable, validated inline) and expiry presets (never / 7 d / 30 d / date).
  4. Result: the short URL *with base path*, the resolved target, Copy, QR and Test.
- **At the end:** it validates that the target resolves and that an external host is allow-listed.
- **What it replaces:** App / Path / Redirect URL / Include Params / JSON.

**Where a wizard would be wrong:**
- **Document templates:** the sectioned editor works. Add a "Start from" choice instead (built-in look / iHub brand / upload Word / upload PowerPoint) on the near-empty "New template" screen.
- **Localization:** finding the key is the hard part, so it needs better search and in-context editing, not steps.
- **Error Pages, PWA, Custom CSS and CSS variables:** power-user screens edited one field at a time.
- **The Short links list:** an oversight table.
- **Start Page:** clear already; it needs a live preview, not a wizard.

## 9. Documentation

**What exists, and how good it is.**
- **Good (UI-led):**
  - `docs/document-templates.md` and `docs/powerpoint-template-guide.md`, which match the UI exactly and include a German brief for marketing.
  - `docs/ui.md` Start Page section (`:416-565`, with a screenshot).
  - `docs/ui.md` error messages (`:222-285`).
  - `docs/localization.md:129-136` (overrides editor, 6 lines, no screenshot, no warning about "Changed only").
- **JSON-only:**
  - `docs/ui.md` (801 lines, "managed through the `config/ui.json` file", line 3): header, logo, colours, footer, disclaimer and PWA.
  - `docs/react-component-feature.md` (file paths only).
- **Outdated:**
  - `docs/customization.md:29-76` teaches label changes by hand-editing `contents/locales/{lang}.json` and never mentions the editor.
  - `docs/content-management.md` (112 lines, 0 admin-UI mentions) shows pages inline in `ui.json` and mixes in RAG "content guidelines".
- **Missing:** Short links (no doc page at all). `includeParams` appears nowhere in `docs/`; `prefill` only in `auto-send-feature.md` and `apps.md`.
- **Wrong:** see CU-B23.
- **Navigation:** `admin-ui.md` has a section only for UI Customization (`:349-355`). In `SUMMARY.md` the customization topics are scattered: Configuration, line 32, line 65 and line 99.

**Gaps: tasks a new admin cannot learn from the docs today.**
- Rebrand through the UI.
- Which "title" field to use.
- Upload an asset and use it.
- Link a page in the footer.
- Restrict a page to groups (with the real group ids).
- Set the default language.
- Create a short link with a prefilled prompt.
- Change a label in EN and DE through the editor.

**Proposed doc pages.**
1. **`branding.md` — "Brand iHub for your company"** (new; task-first, screenshots, UI-only):
   - before you start (SVG/PNG logo, colours, favicon, name in each language);
   - upload assets;
   - logo and favicon;
   - product name (`product.name` vs header title vs browser-tab title: which one shows where);
   - colours (theme vs header colour vs sidebar layout);
   - footer text and legal links;
   - install as app (PWA icons);
   - check light, dark and mobile;
   - undo (change history, backup).
2. **`pages.md` — "Add your own pages"** (replaces the page part of `content-management.md`):
   - create a Markdown page;
   - the address `/pages/{id}`;
   - translations;
   - who can see it (sign-in vs groups, shipped ids `admins`, `users`);
   - **walkthrough: Imprint in the footer**;
   - use a page as the home page;
   - React pages (minimal `UserComponent`, link to `react-component-feature.md`);
   - where files are stored.

   Move the RAG guidelines to `projects.md`.
3. **`short-links.md` — "Short links"** (new):
   - what `/s/{code}` is;
   - who creates links (users via Share, admins here);
   - opening an app with a prompt (`prefill`, `send=true`, `var_*`; link `auto-send-feature.md`);
   - expiry and usage counts;
   - external targets and the SSRF allowlist;
   - editing a link (the CU-B1 caveat until fixed);
   - what visitors see for expired or unknown links;
   - the feature flag.

   Add it to `SUMMARY.md`.
4. **Rewrite `customization.md`** to lead each row with the Admin UI path and give the file path second.
5. **`admin-ui.md`:**
   - add Document templates to line 24;
   - add short sections for Localization, Pages, Document templates and Short links;
   - qualify the Unsaved Changes promise until CU-B4 is fixed.
6. **Fixes:**
   - `icons.md:242` path → "Admin → Customization → UI Customization → Assets".
   - `ui.md:3` → "in Admin → Customization → UI Customization (stored in `contents/config/ui.json`)".
   - `ui.md:584-616` Static Pages → describe `filePath` and files.
   - `auto-send-feature.md:280` → `short-links.md`.
   - "featured apps" → "pinned apps".
   - `localization.md:131`: spell out the menu path and the "Changed only" filter.

**Contextual help in the product.** Use `docsLinks.js` via a `help` slot in the proposed `AdminPageHeader`, or one `DocsHelpLink` per tab or section.

| Page / field | Link to |
|---|---|
| /admin/ui Branding (Header today) | `branding.md` |
| Start Page tab | `ui.md#start-page-configuration` |
| Footer tab | `branding.md#footer-text-and-legal-links`, later `pages.md#imprint-in-the-footer` |
| Error Pages tab | `ui.md#error--empty-state-messages` |
| Styles tab | `ui.md#theme-configuration` (add an "Edit in Admin" paragraph) |
| Localization overrides | `localization.md#editing-overrides-in-the-admin-ui` |
| Page editor, React type | `react-component-feature.md#component-structure` |
| Page editor, header | `pages.md` |
| Template editor, PowerPoint slot | `powerpoint-template-guide.md` |
| Short links list and editor | `short-links.md` |
| Content → Disclaimer | EU AI Act page and `ui.md` disclaimer section (the "when to use which" note) |

**Help text to rewrite (current → proposed).**
- Footer Text (`FooterCustomization.jsx:102`):
  - Current: "You can use basic HTML tags".
  - Proposed: "Shown at the bottom of every page. The default `$t(footer.legal)` is the built-in copyright line with the current year. Change it under Localization (key footer.legal), or type your own text. Plain text only."
- Content → Site Title (`ContentEditor.jsx:100`):
  - Current: "This title appears in the browser tab and header."
  - Proposed: label "Browser tab title", hint "Shown in the browser tab and in exported files. The name in the sidebar is set under Header title."
- Header Light/Bold part (`HeaderCustomization.jsx:208`):
  - Current: the leading-space hint.
  - Proposed: "Header title: shown next to the logo. Split it into a light and a bold part if you like. To rename the product everywhere (welcome text, footer, share messages), change Product name."
- Header Colour:
  - Current: the hint already admits that the sidebar layout ignores it.
  - Proposed: hide the field unless the classic or embedded layout is active.
- Allowed Groups (`AdminPageEditPage.jsx:202`):
  - Current: `admin, user or *`.
  - Proposed: a group picker with the hint "Leave empty for everyone. 'Authentication required' additionally hides it from anonymous visitors."
- Page ID:
  - Current: none.
  - Proposed: "Address: /pages/<id>. Lower-case letters, digits and '-'; cannot be changed later." Add a live link preview.
- React content type:
  - Current: none.
  - Proposed: "Define `function UserComponent(props)`; no import or export. Learn more."
- Assets help (`AssetManager.jsx:282`):
  - Current: "use the URL in your HTML head section".
  - Proposed: "Favicon: upload an .ico or .png, then choose it under Branding → Favicon."
- Short links empty state (`AdminShortLinks.jsx:258`):
  - Current: "Short links will appear here when created by users."
  - Proposed: "No short links yet. Users create them from an app's Share menu, or add one here to send people straight into an app with a prepared prompt."
- Translation overrides empty state:
  - Current: "Search above to find a label to change" (with "Changed only" on).
  - Proposed: search all keys as soon as a query is typed, and make the empty state say "No overrides yet. Search for a word you see in iHub, e.g. 'New chat'."
- Start Page "Default apps": rename to "Pinned apps".
- Rate-limit errors:
  - Current: "Request failed with status code 429".
  - Proposed: "Too many requests. Wait a minute and reload. Your unsaved changes are kept."

## 10. Where the panel disagreed

**Facts the lead settled in code:**
- **Short-link and page base path** (CU-B9). PM: Confirmed; UX and TW: Suspected. **Confirmed.** `AdminShortLinks.jsx:90,99` and `ShortLinkDetailsPopup.jsx:17` build URLs without `buildPath()`, and `AppLinkSharePanel.jsx:21` shows the right pattern. The server redirect (CU-B10) does omit the prefix in `Location`, but whether that 404s depends on the proxy, so it stays Suspected.
- **Saving after a failed load** (CU-B5). PM: Confirmed; TW: Suspected. **Confirmed in code.** The fallback is the public config plus 4 platform fields, and the server validates only 3 keys.
- **"After save the URL is regenerated"** (UI, from `D-sl-edit.png`) vs "edits never rebuild" (UX, TW, admin). Both observations are true. The URL is built on **create** when Include Params is ticked, and **never on update** while a `url` is stored (`shortLinkManager.js:142, 233`).
- **Document template editor guard.** PM: "dirty tracking"; UI: "no guard". Both are true: `dirty` only enables Save, and nothing blocks navigation.
- **Short-link expiry.** UX suspected it "shows empty". It shows the UTC time as local and shifts on save (CU-B19, new).
- **/admin/ui "reload wipes the draft"** (UI, Suspected). No polling refresh exists. The real effect is a double fetch on load (CU-B26), which also explains the admin's count of 13 calls.

**Opinion tensions:**
- **Short links list score.** UI 4 (well-built DataTable) vs TW and admin 1 (the job fails). *Resolution:* score the job (median 2); the component is fine to keep.
- **Localization score.** TW 4 (copy and German are good) vs UX and admin 2 (the dead-end). *Resolution:* the copy is good and the default filter is a bug. After the CU-B7/B8 fixes it is a 3–4.
- **Severity of the missing guard on /admin/ui.** PM, UX and TW: P2; UI and admin: P1. *Resolution:* **P1**. One Save spans 8 tabs, edits are lost silently, and the docs promise the opposite.
- **Save model.** PM: per-section save or autosave; UI: a sticky, dirty-aware global bar; admin: server-side per-section PATCH. *Resolution:* ship the sticky bar plus guard now (S). Move the server to per-section PATCH with ETags (M); the UI can then save per section without a redesign.
- **How to preview.** PM: an iframe with the draft injected via postMessage; UI: a component mock or iframe; admin: "preview as user" in your own session. *Resolution:* a **server-side draft** previewed in the admin's own session. It is the only option that also gives Publish, a diff and an audit entry, and it avoids keeping a mock renderer in sync.
- **Disclaimer placement.** PM: merge with the AI notice into one feature with three modes; UX: a "Legal & notices" hub; UI and TW: cross-link at minimum. *Resolution:* cross-links now (S). Then move the Disclaimer card onto the EU AI Act page renamed "Notices & consent", without merging data models; a merge needs product input on how the features stack.
- **Document template wizard.** UX (W4) and TW proposed one; UI and admin said it is not needed. *Resolution:* no wizard. Add a "Start from" choice plus "Use iHub brand" (§8).
- **Languages in long forms.** PM and UX want side-by-side EN/DE for overrides; UI wants a tab-level "one language at a time" switch to shorten the Header, Footer and Error Pages tabs. *Resolution:* both, in different places. Overrides get columns (values are short). Long multi-language fields get a language switch with completeness badges.
- **Who owns short-link creation.** PM: the end-user share panel is the better tool; admin: move it to the app rows; TW: keep the admin page. *Resolution:* one builder component (W3) used in all three places, with the admin page kept for oversight.

## 11. Top recommendations

| # | Recommendation | Why | Impact H/M/L | Effort S/M/L | Type |
|---|---|---|---|---|---|
| 1 | **Fix short links end-to-end.** Rebuild `url` on every update unless "Custom target" is chosen (CU-B1). Apply params whenever given and drop "Include Params" (CU-B2). Use `buildPath()` in Copy, Test, the popup and Pages View, and prefix the redirect `Location` (CU-B9, B10). Fix the expiry time zone (CU-B19). Then replace JSON with Prefill / Send automatically / Variables fields and a live target preview. | Task 6 fails silently. Links copied under a base path 404. | H | S (fixes) / M (fields) | fix |
| 2 | **Make /admin/ui safe.** Add `useUnsavedChanges` and a sticky "N unsaved · Discard · Save" bar, and guards on Translation overrides and the Template editor (CU-B4). Show no form and no Save after a failed load (CU-B5). Add ETag/`If-Match` on `ui.json`, and have the server keep `pages` from disk, so a stale save can't delete pages (CU-B3). | Silent loss of work and of pages, in normal flows. | H | M | fix |
| 3 | **Ship `AdminInput` / `AdminSelect` / `AdminTextarea` (roadmap 3B-3)** with a border, focus ring and bound labels. Migrate the Short link editor, Page editor and Localization first. Move `/admin/ui` onto `AdminTabs` (overflow, ARIA, no emoji). | Fixes CU-B6, B17, B18 and B27 in one pass. Today the fields are invisible. | H | S–M | UI |
| 4 | **Fix translation overrides.** Search all keys whenever a query is typed (CU-B7). Key drafts by language (CU-B8). Show language names. Then show one row per key with EN/DE columns, grouped by area. | Task 3 dead-ends on first use and can write English into `de.json`. | H | S | fix |
| 5 | **Batch of correctness and copy fixes:**<br>• honour link `enabled`/`target`, and don't pre-fill a live footer link (CU-B11);<br>• correct the Pages Access column, and use `GroupMultiSelect` instead of the wrong placeholder (CU-B12, B13);<br>• Footer and Site Title hints, with an explanation for `$t()` tokens (CU-B15, B16);<br>• empty swatch shown as empty (CU-B20);<br>• `getAdminApiErrorMessage` everywhere, with Retry (CU-B21). | Each is small. Together they remove most of the "guess and check" in tasks 1 and 4. | M | S | fix |
| 6 | **Docs and in-product help.**<br>• Write `branding.md`, `pages.md` (Imprint-in-footer walkthrough) and `short-links.md`.<br>• Rewrite `customization.md` and `content-management.md` UI-first.<br>• Fix the six doc errors (CU-B23).<br>• Add `admin-ui.md` sections.<br>• Add a "Learn more" link per tab and editor via `docsLinks.js`, and put the tab in the URL (`?tab=`). | Today an admin who doesn't know how can only learn JSON. Short links have no doc at all. | H | M | docs |
| 7 | **Branding tab with `AssetPicker`, `ColorField` and one Product name.** Dissolve the Content tab and move the Disclaimer beside the AI notice (§6). | The name is in 3 places, colour in 4, and every image takes 5 copy-paste steps. | H | M–L | IA |
| 8 | **Brand iHub wizard (W1)** on a server-side draft, with preview in the admin's own session and Publish with a diff. Optionally apply the brand to the default document template. | Task 1's "preview before publishing" is impossible today. It is the day-1 job of every install. | H | L | wizard |
| 9 | **Connect pages to navigation.**<br>• W2 legal-page templates (including a shipped Impressum skeleton) with "Show in footer", created in one server call.<br>• A link-target picker in header and footer links.<br>• Show the URL and a save toast.<br>• Reference-aware delete (CU-B14).<br>• Monaco plus preview, with Content Type first. | Task 4 takes 15 steps on 2 pages with guessed URLs. Imprint is a legal must in DE/AT. | M–H | M | UX |
| 10 | **i18n sweep for this part.** Add the 206 missing admin keys to `en.json` and `de.json`, replace the hard-coded literals, and extend the translation-key test to `features/admin` (CU-B22). | German admins see half-English screens, and the override editor can't fix them. | M | M | fix |

Next after the top 10:
- Categories editor and language-selector toggle (CU-PM3).
- Separate visibility keys for Localization and Templates (CU-PM9).
- Cmd+K keywords (CU-UX4).
- One primary colour token and `AdminPageHeader` (CU-UI1, UI2).
- Replace "Backup Config" with change history (CU-PM7).
- Announcement banner (CU-PM10).
