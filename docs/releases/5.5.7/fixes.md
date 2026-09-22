# Fixes — 5.5.7

## Image Models No Longer Fail as "Endpoint Unreachable"

Generating an image with **Nano Banana Pro (Gemini 3 Pro Image)** failed after ten seconds with a
network error that named the wrong culprit:

> The google endpoint for model gemini-3-pro-image could not be reached: it did not answer the
> connection attempt. Check that the server is running and reachable from iHub (VPN, firewall,
> hostname).

Nothing was unreachable. iHub bounds the phase before a provider's first response byte so that a
genuinely dead endpoint fails in seconds instead of holding a browser connection for the full
five-minute request deadline. That measures reach for a text model, whose headers arrive the moment
the provider accepts the request — but Google's image models send nothing at all until the picture
is rendered, headers included. A 4K image with thinking on high was being cut off mid-render and
reported as a network fault.

The installation-wide ceiling is now 30 seconds instead of 10, which also covers gateways that
authenticate before forwarding, and image models carry 60 seconds of their own. Both are editable:
**Admin → Models** now has **Connect Timeout** and **Stream Idle Timeout** fields, so neither needs
a hand-edited JSON file, and **Admin → Platform Configuration** still holds the installation
default. An operator who already tuned either value keeps it.

## Image Models Can Be Saved From the Admin Form Again

The model editor offered an **Image Size** dropdown (1K / 2K / 4K) that no longer matched what the
server accepts, so saving any image model failed validation:

> Line 19: Property imageSize is not allowed

Image size moved from Google's own units to a provider-neutral **Image Quality** of Low / Medium /
High, which the Google adapter translates back into 1K / 2K / 4K, but the form was never updated —
it wrote a key the server rejects, and existing model files still carried it. The form now offers
Image Quality, and migration `V103` converts stored configs (`1K`→`Low`, `2K`→`Medium`, `4K`→`High`).
The aspect-ratio dropdown also gained `3:4`, `4:3` and `21:9`, which were valid but not offered.

## Gemini 3 Models Show Their Thinking Again

Models configured with `thinking.level` — every Gemini 3.x model iHub ships — stopped returning
thought summaries, so the thinking panel stayed empty while the reasoning tokens were still billed.

The request builder sent the reasoning level alone. The flag that asks for thought summaries,
`includeThoughts`, is a separate field that pairs with the level perfectly well — it was simply
never included. It is now sent whenever thinking is enabled, and defaults on. Set
`thinking.thoughts: false` on a model to keep its reasoning hidden.

(Gemini's older `thinkingBudget` shape is retired in the same release — see
[Breaking Changes](breaking-changes.md).)
