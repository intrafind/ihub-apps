# Fixes — Unreleased

## Several Icons No Longer Show as Broken Images

The disclaimer note below the chat input, model hint banners, the Image Generator app's icon, the
Forbidden error page, workflow cards, and a number of admin screens showed a broken-image icon
instead of the intended one, logging errors like `/icons/informationCircle.svg: 404` in the
browser console. These icon names were never registered in the app's built-in icon set, so the UI
fell back to requesting a standalone SVG file that was never shipped.

- About thirty icon names across chat, workflows, error pages, and admin screens are affected,
  including the info, lock, photograph, workflow, and close-icon variants.
- No configuration change is needed — the icons are now resolved from the app's existing icon
  library instead of a missing file.

## Reopening a Chat No Longer Fetches Every Generated Image at Once

Reopening a chat that had produced several generated images fetched all of them immediately, even
the ones further up in the conversation, and showed an empty gap in the chat bubble for however
long each fetch took.

- A generated image is now only fetched once it scrolls near the visible area, so a long,
  image-heavy chat no longer pulls every picture it ever produced the moment it is opened.
- A loading placeholder appears in its place until the image arrives, instead of empty space.
