# Breaking Changes — 5.5.0

## The Home Route `/` Is Now the Start Page — the Apps List Moved to `/apps`

The root URL shows the new personalized start page (greeting, default-app chat input, featured
apps). The full apps browser with search, categories and sorting lives at `/apps`.

- Bookmarks and links to `/` keep working — they open the start page, which links to the apps
  browser. `appsList` settings (title, subtitle, search, sort) apply to `/apps`.
- Integrations that embed iHub and expect the apps list at the root (custom iframes, portal
  links) should point to `/apps`. The bundled Nextcloud embed does this automatically; Microsoft
  Teams and the Office add-in are unaffected.
- `header.defaultColor` only colours the classic top header, which is still used in embedded
  contexts and with `?sidebar=false`; on regular pages the new sidebar takes over navigation.

**Before upgrading:** Update any external link or iframe that relies on `/` rendering the apps
list to use `/apps` instead. No configuration change is required — migration V090 seeds the new
`startPage` section.
