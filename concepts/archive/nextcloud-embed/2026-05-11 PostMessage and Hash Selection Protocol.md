# Selection Protocol — Nextcloud → iHub Embed

This is the wire-level contract between the Nextcloud-side app shell and
the embedded iHub iframe. It is intentionally narrow: a single message
shape that carries the user's current file selection, transported either
through the URL hash (initial navigation) or via `postMessage` (ongoing
updates while the iframe is mounted).

## Goals

- **No secrets cross the boundary.** The protocol carries file paths and
  nothing else. iHub reads file content through its own per-user OAuth
  grant against Nextcloud.
- **One validator, two transports.** The same `sanitizeSelectionPayload`
  function on the iHub side validates both hash and `postMessage`
  payloads. There is no second validation path.
- **Defence in depth.** `event.origin` is checked against an admin
  allowlist before the payload is even inspected.

## Payload shape

```ts
interface NextcloudSelectionPayload {
  // Required for postMessage form; ignored on hash form.
  kind: 'ihub.nextcloud.selection';

  // Matches an iHub cloudStorage Nextcloud provider id.
  // Max 200 chars, no further format constraint (provider ids are admin-controlled).
  providerId: string;

  // 1..50 file paths relative to the user's Nextcloud root.
  // Each path: max 4096 chars, no NUL bytes, no `..` segments.
  paths: string[];
}
```

Constraints (`sanitizeSelectionPayload` in
`client/src/features/nextcloud-embed/utilities/nextcloudSelectionBridge.js`):

| Field | Constraint |
| --- | --- |
| Whole payload | Must be a plain object. |
| `kind` (postMessage form) | Must equal `'ihub.nextcloud.selection'`. |
| `providerId` | Non-empty string, ≤ 200 chars. |
| `paths` | Array, length 1..50. |
| `paths[i]` | Non-empty string, ≤ 4096 chars, no NUL byte, no `..` segment. |

Invalid payloads are dropped silently. Listeners are not notified.

## Transport: URL hash (initial navigation)

The Nextcloud-side file action opens

```
https://<ihub>/nextcloud/full-embed.html#providerId=<id>&paths=<json>
```

where `<json>` is `encodeURIComponent(JSON.stringify(paths))`. The iHub
bridge parses the hash with `URLSearchParams` (so percent-decoding is
robust), then `JSON.parse`s the `paths` value, then runs the result
through `sanitizeSelectionPayload`.

If the parsed value fails validation, the bridge ignores it. The iframe
mounts with an empty selection and the user sees the standard "no
documents selected" empty state.

`hashchange` is also wired: if the parent updates the URL (rare — the
embed normally moves between selections via postMessage instead), the
bridge re-parses and emits.

## Transport: postMessage (ongoing updates)

```js
iframe.contentWindow.postMessage(
  { kind: 'ihub.nextcloud.selection', providerId: '…', paths: [...] },
  '<ihub origin>'   // never '*'
);
```

The iHub bridge installs one `message` listener per embed session:

1. Check `event.origin` against `allowedHostOrigins` from
   `/api/integrations/nextcloud-embed/config`. Drop if absent.
2. Check `event.data?.kind === 'ihub.nextcloud.selection'`. Drop if not.
3. Run `event.data` through `sanitizeSelectionPayload`. Drop if invalid.
4. Replace (not merge) the current selection and notify listeners.

The Nextcloud-side `src/main.js` derives the targetOrigin from the
configured iHub base URL — never `'*'`. iHub's bridge would discard a
`'*'` message anyway, but this keeps the Nextcloud side safe from
information leakage if the bridge's origin checks are ever loosened.

## Origin allowlist

`allowedHostOrigins` is an admin-configured list of canonicalised HTTP/S
origins (e.g. `https://cloud.example.com`). The same list drives:

1. The bridge's `event.origin` check (this document).
2. The CSP `frame-ancestors` directive on `/nextcloud/full-embed.html`
   (see `server/routes/nextcloudEmbedPages.js`).

Both checks must agree on canonical form (scheme + host + port, no
trailing slash). The admin route's `canonicalizeOrigin` and the bridge's
allowlist comparison both treat origins as strings produced by
`new URL(...).origin`, so trailing slashes / paths / fragments are
rejected at save time.

## Why two transports?

A new tab cannot share JS objects with the opener. Encoding selection in
the URL hash is the only way to carry it through a hard navigation —
that's the primary entry point today (file action → new tab).

`postMessage` is for the "host page" variant in
`nextcloud-app/templates/main.php`, where the iframe stays mounted and
the user changes Files selection in another pane.

Both must funnel through one validator so future protocol changes only
need one place to update.

## Non-goals

- **Bidirectional**: the iHub side never posts back. If we want round-
  trips later (e.g. "AI generated a reply, save it as a new Nextcloud
  file"), we add a new outbound message kind — out of scope for v1.
- **Tokens**: explicitly not in the payload. See the design doc for
  why; if a future requirement demands host-injected tokens, add a
  separate, optional field plus a fallback path in
  `useNextcloudEmbedAttachments.js`.
- **File metadata**: only paths cross the boundary. Size, mime, mtime
  are fetched authoritatively by iHub through the existing `/download`
  endpoint headers.
