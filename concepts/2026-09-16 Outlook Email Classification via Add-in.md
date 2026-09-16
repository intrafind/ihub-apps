# Outlook Email Classification via the Add-in

**Date:** 2026-09-16
**Status:** Proposal
**Related:** [Outlook Add-in Rollout Guide](../docs/outlook-add-in.md), [Custom Response Renderers](../docs/custom-renderers.md), [Outlook M365 Personal Tab Integration](outlook-personal-tab/2026-05-19%20Outlook%20M365%20Personal%20Tab%20Integration.md)

---

## Problem

A customer asked whether the Outlook add-in can add metadata to emails. The goal is AI classification: an iHub app reads the mail, proposes categories and a few extracted fields, and the recipient checks the suggestion and confirms it. The confirmed result should live on the mail item in Outlook so that the user, Outlook rules and search, and downstream systems can use it.

Two questions decide the design:

1. Where can an add-in write metadata on a received mail, and what does each surface cost in permissions?
2. How close to "runs automatically" can we get, given that the add-in is a task pane the user opens?

## Goals

- Classify the open email with a configurable iHub app. The taxonomy is customer-specific.
- Show the suggestion in the pane; let the user adjust and confirm it.
- Persist the confirmed result on the mail item, in a form Outlook itself understands (color categories) and in a richer form for the add-in and downstream systems (custom properties).
- Ask the M365 tenant for no permission the add-in does not already have, unless the admin opts in.
- Never classify the same mail twice.

## Non-goals (phase 1)

- Classifying mail nobody has opened. The add-in cannot do this; see [Phase 2](#phase-2-background-classification-via-microsoft-graph).
- Moving mails to folders, setting flags, importance or sensitivity labels. Read mode has no APIs for these.
- Classifying outgoing mail at send time (Smart Alerts). Possible later as a separate feature.

## What exists today

| Piece                                                                                                                           | Where                                                                                                                       | Relevance                                                 |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Mail context reader: subject, body, file attachments; serialized under a mailbox lock; re-read on `ItemChanged`                 | `client/src/features/office/utilities/outlookMailContext.js`                                                                | Input to the classifier                                   |
| Host adapter: mail reading, auth dialog, "Insert into email" action                                                             | `client/src/features/office/contexts/EmbeddedHostContext.jsx`, `client/office/taskpane-entry.jsx`                           | Extension point for a metadata read/write action          |
| Structured output: `preferredOutputFormat: "json"` plus `outputSchema`, passed to every adapter as `responseSchema`             | `server/validators/appConfigSchema.js`, `server/services/chat/RequestBuilder.js`                                            | Validated classification result                           |
| Custom response renderers for JSON output (`customResponseRenderer`, `rendererConfig`)                                          | `client/src/shared/components/CustomResponseRenderer.jsx`                                                                   | Alternative for a bespoke card                            |
| Starter prompts with `autoSend`, start-page handoff                                                                             | `client/src/features/office/utilities/officeStarterPrompts.js`, `client/src/features/chat/startChatHandoff.js`              | One-tap run                                               |
| Live mail snapshot hook with a `generation` counter bumped on item change                                                       | `client/src/features/office/hooks/useOutlookMailContextSnapshot.js`                                                         | Trigger for auto-classification                           |
| Manifest: permission `ReadWriteItem`, Mailbox 1.3 / 1.5 minimum, pinning and multi-select enabled                               | `server/routes/integrations/officeAddin.js`                                                                                 | Categories and custom properties need no new permission   |
| Admin config pattern: sanitize for the pane, validate for the admin API, seed by migration                                      | `server/utils/officeStartPage.js`, `server/migrations/V107__add_office_start_page_config.js`                                | Template for the classification settings                  |
| Office 365 provider: delegated Graph OAuth per user, Files / Sites / Teams scopes only                                          | `server/services/integrations/Office365Service.js`                                                                          | Basis for phase 2                                         |

Write-back today is reply-only (`client/src/features/office/utilities/replyForm.js`: reply form, prepend into a draft, new message). Nothing in the codebase touches categories or custom properties yet.

## Where metadata can live on a mail item

Checked against the Office.js reference in September 2026.

| Surface                    | API                                                                      | Min. Mailbox set                        | Min. permission                                                 | Notes                                                                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color categories on the item | `item.categories.getAsync` / `addAsync` / `removeAsync`                | 1.8                                     | read item for `getAsync`, **read/write item** for add / remove  | Each category must already exist in the mailbox master list, otherwise `InvalidCategory`. Visible in the message list, searchable, usable by rules, exposed via Graph `message.categories`. Not manageable in compose mode on Outlook on the web and the new Outlook, irrelevant for read mode. |
| Master category list       | `mailbox.masterCategories.getAsync` / `addAsync` / `removeAsync`         | 1.8                                     | **read/write mailbox**                                          | Even reading the list needs the highest permission level. Delegates cannot add or remove.                                                                                                                                                                                                  |
| Custom properties          | `item.loadCustomPropertiesAsync`, then `get` / `getAll` / `set` / `remove` / `saveAsync` | 1.1 (`getAll` 1.9)      | read item                                                       | Add-in-private JSON, max 2500 characters, not transmitted to recipients on forward. Readable by other systems as a MAPI named property (`cecp-<add-in id>`) through EWS or Graph extended properties. `set` / `remove` are not supported on items loaded through multi-select.               |
| Notification bar           | `item.notificationMessages.addAsync` / `replaceAsync`                    | 1.3 (`InsightMessage` with actions 1.10) | read item                                                       | Info line on the mail: "Classified as Invoice, Urgent".                                                                                                                                                                                                                                     |
| Internet headers           | `item.internetHeaders`                                                   | 1.8                                     | read/write item                                                 | **Compose only.** Not usable for received mail.                                                                                                                                                                                                                                             |

Consequences:

- Applying categories and saving custom properties works with the manifest as it is. No new consent in the M365 admin center.
- Creating categories, or even listing them, needs `ReadWriteMailbox`. That is a manifest change the M365 admin has to approve again. Keep it optional.
- The manifest's current minimums are 1.3 / 1.5; categories need 1.8. Attachments already need 1.8 in practice, so feature-detect at runtime (`Office.context.requirements.isSetSupported('Mailbox', '1.8')`) instead of raising the manifest floor and falling back to custom properties on old clients.

## Why the add-in cannot run on arrival

Event-based activation fires for compose, send and appointment-edit events only. The two "on message read" events (`OnMessageReadWithCustomHeader`, `OnMessageReadWithCustomAttachment`) are preview and limited to classic Outlook on Windows. There is no "on message received" event at all. Anything that must happen without the user selecting the mail has to run server-side against Microsoft Graph (phase 2).

The closest the add-in gets: the pane is pinnable (`SupportsPinning` is already set), `ItemChanged` fires for every selection, and the pane can classify on selection when the user has opted in.

## Options considered

### A. Classify in the pane, confirm, write back (recommended, phase 1)

Uses the existing add-in, structured output and `ReadWriteItem`. Human in the loop by design, which is what the requester described as the ideal. Limited to mails the user selects.

### B. Background classification via Microsoft Graph (phase 2)

The server subscribes to the inbox, runs the same app, and patches categories plus an extension onto the message. Zero-touch, but needs `Mail.ReadWrite` consent per user (or application permissions with admin consent), a public webhook, subscription lifecycle management, and it sends mail content to the model without the user present.

### C. Event-based activation

Rejected for incoming mail: no event exists. Kept in mind for outgoing mail (`OnMessageSend`, Mailbox 1.12) as a separate feature.

---

## Phase 1 design

### User flow

1. The admin creates a classifier app (below) and points **Admin → Office Integration → Classification** at it.
2. The user selects a mail. The pane shows a **Classification** card above the chat.
   - If the item already carries a confirmed classification: show it read-only, with **Change**.
   - Else if it carries a suggestion (from an earlier run, or from phase 2): show the suggestion.
   - Else: a **Classify** button, or run immediately when the user's auto-classify setting is on.
3. The app runs with the mail as context and returns JSON. The card renders every taxonomy value as a checkable chip with the suggested ones pre-checked, the confidence as a subtle hint, the summary, and the extracted fields as editable rows.
4. The user adjusts and taps **Confirm**. The pane writes
   - the categories through `item.categories.addAsync` (and `removeAsync` for previously applied ones the user unticked),
   - the full record into the custom property `ihub.classification`,
   - optionally an informational notification bar.
5. The card switches to the confirmed state. Reopening the mail shows that state without a model call.

```
Outlook (read mode)                     iHub task pane                                iHub server
┌──────────────────────┐  ItemChanged   ┌────────────────────────────────┐  chat API   ┌───────────────────┐
│ selected mail item   │ ─────────────► │ useItemClassification          │ ──────────► │ classifier app    │
│  subject / body /    │   Office.js    │  1. loadCustomPropertiesAsync  │  mail as    │  outputSchema →   │
│  attachments         │ ◄────────────► │  2. run app if no record       │  context    │  responseSchema   │
│  categories          │ categories.add │  3. card: chips + fields       │ ◄────────── │                   │
│  customProperties    │ customProps.   │  4. confirm → write back       │  JSON       └───────────────────┘
│  notificationMessages│   saveAsync    │                                │
└──────────────────────┘                └────────────────────────────────┘
```

No change to the chat pipeline: the classifier is an ordinary app call with the same context enrichment `useOfficeChatAdapter` performs today.

### The classifier app

The app config is the single source of truth for the taxonomy. The `outputSchema` constrains the model through structured output **and** gives the pane the list of allowed categories (the `enum`). The existing `rendererConfig` passthrough field carries display metadata. No app-schema change is needed.

```json
{
  "id": "email-classifier",
  "name": { "en": "Email Classifier", "de": "E-Mail-Klassifizierer" },
  "description": { "en": "Suggests categories and key facts for the open email" },
  "icon": "tag",
  "preferredOutputFormat": "json",
  "system": {
    "en": "You classify business emails. Pick only categories from the schema. Extract the fields when they are explicitly present; otherwise leave them empty. Never invent values."
  },
  "outputSchema": {
    "type": "object",
    "required": ["categories", "summary", "confidence"],
    "properties": {
      "categories": {
        "type": "array",
        "items": { "type": "string", "enum": ["Invoice", "Complaint", "Order", "Internal", "Newsletter"] }
      },
      "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
      "summary": { "type": "string", "maxLength": 200 },
      "fields": {
        "type": "object",
        "properties": {
          "customer": { "type": "string" },
          "ticketId": { "type": "string" },
          "dueDate": { "type": "string", "format": "date" }
        }
      }
    }
  },
  "rendererConfig": {
    "officeClassification": {
      "categories": {
        "Invoice": { "color": "Preset0", "label": { "en": "Invoice", "de": "Rechnung" } },
        "Complaint": { "color": "Preset1", "label": { "en": "Complaint", "de": "Beschwerde" } }
      },
      "fields": {
        "customer": { "label": { "en": "Customer", "de": "Kunde" } },
        "ticketId": { "label": { "en": "Ticket", "de": "Ticket" } },
        "dueDate": { "label": { "en": "Due", "de": "Fällig" }, "type": "date" }
      }
    }
  }
}
```

Contract the card relies on: `categories: string[]` (required), `summary?: string`, `confidence?: number`, `fields?: Record<string, string | number | boolean | null>`. Other properties are ignored by the card and kept in the custom property as long as the record fits the size limit.

Outlook category names are literal strings per mailbox. Use language-neutral `enum` values as the Outlook category name and put localized labels in `rendererConfig`. Otherwise German and English users of the same taxonomy end up with two different categories for the same class.

A generic `email-classifier.json` ships in `server/defaults/apps/` for fresh installs. Existing installations do not receive new default apps; the admin section offers **Create default classifier app** which copies the default into `contents/apps/` and selects it.

### Admin settings

New block `officeIntegration.classification` in `platform.json`:

```json
"classification": {
  "enabled": false,
  "appId": "email-classifier",
  "autoClassifyDefault": false,
  "includeAttachments": false,
  "writeCategories": true,
  "writeCustomProperties": true,
  "showNotification": true,
  "manageMasterCategories": false
}
```

- `enabled`, `appId`: the card appears only when both are set and the signed-in user may access the app (OAuth client allow-list and group permissions apply as everywhere else).
- `autoClassifyDefault`: initial value of the per-user "classify when I select an email" setting.
- `includeAttachments`: classification normally needs the body only. Attachments cost tokens and time; off by default.
- `writeCategories`, `writeCustomProperties`, `showNotification`: which surfaces the confirm action writes to.
- `manageMasterCategories`: when true, the generated manifest emits `ReadWriteMailbox` and the pane creates missing categories with the configured colors. The admin UI must warn that this changes the manifest and requires re-approval in the M365 admin center.

Implementation follows `officeStartPage.js`: `sanitizeOfficeClassification` for the public `/api/integrations/office-addin/config` endpoint (never throws), `validateOfficeClassification` for the admin save, a mirrored client util. Migration `V108` seeds `classification.enabled = false` only for installations that already have an `officeIntegration` block, the same rule V107 uses.

### Client changes

- **Host adapter** (`EmbeddedHostContext`): two optional members, `readItemMetadata()` → `{ categories: string[], classification: object | null }` and `writeItemMetadata({ addCategories, removeCategories, classification, notification })`. The Outlook adapter implements them with the APIs from the table, gated through `officeCapabilities.js` (`isSetSupported('Mailbox', '1.8')` for categories). The browser extension and Nextcloud adapters leave them undefined; the card does not render without them.
- **`useItemClassification` hook**: keyed by the `generation` counter of `useOutlookMailContextSnapshot`. On item change it loads the stored record, decides between `confirmed`, `suggested`, `idle`, and, with auto-classify on, runs the app. It runs the app through `useAppChat` with a dedicated `chatId` per item (`classify-<itemId>`), sending the mail context the way `useOfficeChatAdapter` does, and parses the JSON handed to `onMessageComplete`. States: `unsupported | idle | loading | suggested | confirmed | error`.
- **`OfficeClassificationCard`**: rendered by `OfficeChatPanel` next to `OfficeContextStrip`, and on the start page above the default app's input. Chips, fields, **Confirm**, **Re-classify**; collapses to one line once confirmed.
- **Settings dialog**: "Classify automatically when I select an email", stored like language and appearance (Outlook local storage), defaulting to the admin's value.
- **Error handling**: `InvalidCategory` → still save the custom property, show "Category X does not exist in your mailbox" with the names to create (Outlook: **Categorize → Manage categories**). A failed `saveAsync` while offline keeps the suggestion in memory and retries on the next confirm.
- **Multi-select**: with Mailbox 1.15 `loadItemByIdAsync`, a bulk **Classify selected** could apply categories but not custom properties (`set` is unsupported on loaded items). Phase 1 scopes to the open item; bulk is a follow-up.

Why a native card instead of a custom response renderer: renderers receive `data`, `t`, `rendererConfig` and hooks, but no access to the host adapter, so a renderer would have to touch `window.Office` directly and could not read the stored record before deciding whether to run the model. If customers later need bespoke cards, `CustomResponseRenderer` can pass the host adapter as an extra prop and the native card becomes the default renderer.

### The custom property record

Key `ihub.classification`, value a JSON string of at most 2500 characters:

```json
{
  "v": 1,
  "appId": "email-classifier",
  "model": "gpt-4.1",
  "suggestedAt": "2026-09-16T09:12:00Z",
  "suggested": { "categories": ["Invoice"], "confidence": 0.86, "fields": { "customer": "ACME" } },
  "confirmedAt": "2026-09-16T09:12:30Z",
  "confirmedBy": "user@example.com",
  "confirmed": { "categories": ["Invoice", "Internal"], "fields": { "customer": "ACME GmbH" } }
}
```

The summary is stored truncated; the model's reasoning is never stored. Keeping `suggested` next to `confirmed` yields an evaluation dataset for free (agreement rate per category), should we later collect it server-side.

Downstream systems read the record through Graph `singleValueExtendedProperties` (the add-in's custom properties are one MAPI named property, `cecp-<add-in id>`, in the public strings property set) or, more simply, rely on `message.categories`.

### Server changes

- `server/routes/integrations/officeAddin.js`: expose the sanitized `classification` block on `/config`; make `<Permissions>` in the generated manifest conditional on `manageMasterCategories`.
- `server/routes/admin/officeIntegration.js`: validate and persist `classification`; a **Create default classifier app** action that copies `server/defaults/apps/email-classifier.json` into `contents/apps/`.
- `server/utils/officeClassification.js`: sanitize / validate, mirrored on the client.
- `server/migrations/V108__add_office_classification_config.js`.
- Confirm that the public apps endpoint the pane already calls exposes `outputSchema`. It already exposes `rendererConfig` (the web chat reads it for custom renderers); the card needs both.

### Tests

- Unit (`tests/unit/client/`): the metadata adapter against a mocked `Office` (add / remove categories, custom property round trip, `InvalidCategory` fallback, capability gating), the hook's state machine, the card's states, the sanitize / validate pair, the manifest permission switch.
- Server (`server/tests/`): migration V108, config endpoint output, admin validation errors.
- Manual in Outlook on the web and the new Outlook for Windows: classify, confirm, verify the category in the message list and the record via Graph Explorer; reopen and confirm no model call; an old client without Mailbox 1.8 falls back to custom properties.

### Documentation and release note

- `docs/outlook-add-in.md`: new section "Email classification" (admin setup, category provisioning, permission implications of `manageMasterCategories`).
- `docs/custom-renderers.md` or `docs/apps.md`: the `rendererConfig.officeClassification` contract.
- Release note via `/document-feature`.

---

## Phase 2: background classification via Microsoft Graph

Only if the customer needs mails classified before anyone opens them. Sketch, to be detailed in its own concept:

- Add the delegated `Mail.ReadWrite` scope to `Office365Service._buildScopes` behind a new source flag. Users connect their Microsoft account as they do today for OneDrive. Delegated `Mail.ReadWrite` is user-consentable unless the tenant policy requires admin consent. Application permissions (`Mail.ReadWrite` app-only, scoped with Exchange application access policies) avoid per-user connection but need admin consent and a data-protection review.
- Subscribe to change notifications on the inbox (webhook on iHub's public URL, subscription lifetime up to seven days for messages, renewal job), or start simpler with a delta query poll.
- A server job runs the same classifier app through the server-side loop and issues `PATCH /me/messages/{id}` with `categories: ["AI: Invoice"]` plus an open extension `com.intrafind.ihub.classification` holding the suggestion.
- The pane reconciles: categories prefixed `AI:` are treated as a suggestion; on confirm it removes them, adds the plain category and writes the custom property. The `AI:` categories must exist in the master list too: provision via Graph `POST /me/outlook/masterCategories` (`MailboxSettings.ReadWrite`) or tenant-wide via Exchange PowerShell.
- Costs and risks: mail content leaves the mailbox to the model without a user action; token cost per mail (mitigate with folder and sender filters, body only); a public webhook endpoint; a renewal job and long-lived per-user Graph tokens.

## Open questions

1. **Taxonomy scope.** One classifier app tenant-wide, or per group? Phase 1 supports one `appId`; per-group taxonomies are possible with several apps but need a group-to-app mapping in the settings.
2. **Category naming.** Are language-neutral English names acceptable in the customers' mailboxes? Otherwise we need a per-locale mapping, and mixed-language teams see different names on the same mail.
3. **Appointments.** The reader already supports them. Hide the card for appointments in phase 1, or classify them with the same app?
4. **Downstream consumer.** Which system reads the metadata (iFinder indexing, a DMS, a ticket system), and does it prefer categories, extended properties, or a record on the iHub server? This decides whether phase 1 should also post confirmations to a new iHub endpoint.
5. **Retention.** The custom property lives as long as the mail. Is a **Clear classification** action needed for deletion requests?
6. **Quality loop.** Do we collect suggested / confirmed pairs server-side for agreement metrics? That would be the first piece needing a new server endpoint.

## Rough sizing

| Work package                                                                                | Size                |
| ------------------------------------------------------------------------------------------- | ------------------- |
| Host adapter metadata read / write, capability gating, tests                                | S                   |
| Classification hook, card, settings toggle, i18n                                            | M                   |
| Admin settings block, sanitize / validate, config endpoint, migration V108, admin UI section | M                   |
| Default classifier app, docs, release note                                                  | S                   |
| Optional master-category management with manifest switch                                    | S                   |
| Phase 2 Graph job                                                                            | L, separate concept |

## References

- [Office.Categories](https://learn.microsoft.com/en-us/javascript/api/outlook/office.categories), [Office.MasterCategories](https://learn.microsoft.com/en-us/javascript/api/outlook/office.mastercategories), [Office.CustomProperties](https://learn.microsoft.com/en-us/javascript/api/outlook/office.customproperties)
- [Understanding Outlook add-in permissions](https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/understanding-outlook-add-in-permissions)
- [Activate add-ins with events](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/event-based-activation)
- [Get and set add-in metadata for an Outlook add-in](https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/metadata-for-an-outlook-add-in)
- Microsoft Graph: `message` resource, `outlookCategory`, change notifications for Outlook resources
