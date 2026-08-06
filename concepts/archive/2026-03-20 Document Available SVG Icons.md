# 2026-03-20 Document Available SVG Icons

## Summary

Created comprehensive documentation for the icon system used in iHub Apps.

## Problem

There was no single place where developers or administrators could discover which SVG icons are
available, what icon library is used, or how to add their own custom icons.

## Solution

Added `docs/icons.md` — a full icon reference documenting:

- The icon library used (**Heroicons v2**, `@heroicons/react` v2.2.0)
- All built-in icon short names grouped by category, including their underlying Heroicon component
  names and descriptions
- Available icon sizes (`xs` through `2xl`)
- How to use custom SVG icons via `public/icons/`
- How to upload and reference icons via the admin panel's Assets tab
- A note about the interactive icon picker in the Admin UI

## Files Changed

- **`docs/icons.md`** — new comprehensive icon reference
- **`docs/SUMMARY.md`** — added Icons entry to the Configuration section
- **`docs/apps.md`** — replaced incomplete icon list with a summary table and a link to `icons.md`
- **`docs/ui.md`** — added link to `icons.md` in the Icons Configuration section

## Icon Component Location

The `Icon` React component lives at `client/src/shared/components/Icon.jsx`. It maps short
kebab-case names to Heroicon components via `iconMap`. The `IconPicker` component at
`client/src/shared/components/IconPicker.jsx` exposes the subset of icons shown in the admin UI
picker via the `AVAILABLE_ICONS` constant.
