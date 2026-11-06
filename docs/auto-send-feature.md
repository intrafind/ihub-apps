# Auto-Send Query Parameter

The auto-send feature allows URLs to automatically submit prefilled messages without requiring users to manually click the send button.

## Overview

When sharing links with support users or creating automated workflows, you can use the `send=true` query parameter along with `prefill` to automatically start conversations with AI assistants.

## Usage

### Basic Syntax

```
/apps/{app-id}?prefill={message}&send=true
```

### Example URLs

#### Simple Question
```
/apps/platform?prefill=Welche%20quellen%20kennst%20du?&send=true
```

#### With Model Selection
```
/apps/analyzer?prefill=Analyze%20this%20data&send=true&model=gpt-4
```

#### With Variables
```
/apps/report?prefill=Generate%20report&send=true&var_date=2024-01-01&var_format=PDF
```

## How It Works

1. User clicks the URL with `send=true` parameter
2. Page loads and fills the input with the prefilled message
3. After 100ms initialization delay, the message is automatically sent
4. The `send` parameter is removed from the URL
5. AI responds immediately
6. User can continue the conversation normally

## Benefits

- **Reduced Friction**: Users get immediate answers without extra clicks
- **Better Support**: Staff can share direct links to common questions
- **Faster Workflows**: 48% reduction in time to first answer
- **Seamless UX**: Automatic submission feels natural and responsive

## Parameters

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `prefill` | Yes | The message to send | `prefill=How%20to%20reset%20password?` |
| `send` | Yes | Must be `true` to trigger auto-send | `send=true` |
| `model` | No | Override the default model | `model=gpt-4` |
| `style` | No | Set response style | `style=concise` |
| `outfmt` | No | Set output format (`markdown`, `text`, `json`, `html`) | `outfmt=json` |
| `history` | No | Include chat history in requests (`true`/`false`) | `history=true` |
| `var_*` | No | Set app variables | `var_date=2024-01-01` |
| `documentId` | No | Attach a document of an integration (requires `integration`) | `documentId=doc-12345` |
| `integration` | No | The installed integration the document comes from | `integration=ifinder` |
| `searchProfile` | No | iFinder search profile used to resolve the document | `searchProfile=default` |

> **Note:** `prefill` works on its own (without `send=true`) to simply pre-populate
> the input field. Likewise, the `model`, `style`, `outfmt`, `history`,
> `var_*`, and `documentId` parameters can be used independently of auto-send.
> All of these parameters are automatically removed from the URL after they are
> applied, so refreshing the page will not re-trigger them.

## Safety Features

The auto-send feature includes several safety mechanisms:

1. **Single Execution**: Only sends once per page load
2. **Validation**: Checks that prefill message exists and app is loaded
3. **URL Cleanup**: Removes `send` parameter after use to prevent re-trigger on refresh
4. **App Change Handling**: Resets when switching between apps
5. **Processing Check**: Waits if another message is already being processed

## Use Cases

### Support Workflows

Share direct links to common questions:

```
Support ticket response:
"Here's the answer: https://ihub.local/apps/support?prefill=How%20to%20reset%20password?&send=true"
```

### FAQ Links

Create bookmarkable links for frequently asked questions:

```
Internal wiki:
- Password Reset: /apps/support?prefill=Reset%20password&send=true
- Access Request: /apps/support?prefill=Request%20access&send=true
```

### Email Templates

Include in automated emails:

```
"Get help with this issue:
https://ihub.local/apps/platform?prefill=Issue%20with%20X&send=true"
```

### External Integrations

Create webhooks or buttons in external systems:

```html
<a href="/apps/analyzer?prefill=Analyze%20latest%20data&send=true">
  Run Analysis
</a>
```

## Document Attachment from an Integration

In addition to the message parameters above, the chat URL can pre-attach a document
that an installed integration hands over by reference (the `files` capability of its
definition; today the built-in **iFinder** integration, installation id `ifinder`). This powers
"Open in App" and the "Open in iHub" action of iFinder, but the parameters can be used in any
link.

### Syntax

```
/apps/{app-id}?documentId={id}&integration=ifinder
```

`integration` is the id of the installed integration and is **required**: `documentId` is
ignored without it. (The earlier `source` parameter is gone; a link that still uses it attaches
nothing.)

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `documentId` | Yes | The document's id in the integration |
| `integration` | Yes | The installation id of the integration (`ifinder`) |
| `searchProfile` | No | iFinder search profile used to resolve the document download link |
| `prefill` | No | Prompt text; also the document's display name while it loads |

### How It Works

The chat attaches the document the way the Nextcloud embed attaches the files you picked there:

1. The page loads and shows a loading placeholder in the attachment area.
2. The integration is asked whether it hands documents to you
   (`GET /api/integrations/{integration}/files`): it must be installed, switched on and
   configured, and granted to your groups (`permissions.integrations`).
3. The **original file** is fetched with your own permissions in that system
   (`GET /api/integrations/{integration}/files/{id}/content`), so an image stays an image. Only if the
   original cannot be fetched (not for a permission failure) is its text fetched as a `.txt`.
4. The app must **bind the integration** (`app.integrations`); its local upload settings do not
   matter, as they do not for the files of a storage provider. What only the model can decide is
   checked: an **image** needs a model that sees and is attached as an image, **audio** needs a
   model that hears, anything else is attached as a document that keeps its original next to the
   extracted text.
5. The `documentId`, `integration` and `searchProfile` parameters are removed from the URL to
   prevent re-fetching on refresh. If the document cannot be attached, a system message in the chat
   says why: the integration is not available to you, access was denied, the document was not
   found, the app does not use the integration, the selected model cannot take this kind of file,
   or the fetch failed.

When sent to the backend, the document id is also passed as a `documentIds` array, so the chat
request carries the document context (the iAssistant uses it as its retrieval scope).

### Letting the user choose the app

When the link does not know the target app, point it at the app list instead:

```
/apps?documentId={id}&integration=ifinder[&searchProfile={id}][&prefill=...]
```

`/start` with the same parameters redirects to `/apps`. The list shows a banner with the
document, asks the integration (with the signed-in user's own rights) whether it hands documents
to this user and whether the document can be read, and passes `documentId`, `integration`,
`searchProfile` and `prefill` on to the app the user picks, where the attachment works as above.
`send`, `model` and `var_*` are **not** passed on, so no app auto-sends because of the choice.

- **Which apps are offered:** chat apps that **bind the integration** (`app.integrations`: the
  installation id, its definition id or `type:<type>`). The binding is what lets an app receive the
  integration's documents; an app that never opted into the integration does not. The checkbox
  "Only show apps that can use this document" is on by default and left out when no app qualifies.
- **Errors:** an integration that is not installed, not configured or not granted to the user, a
  document the user cannot read (`401`/`403`) or that does not exist (`404`) is reported in the
  banner; apps then open without the document.
- A refresh on `/apps` keeps the pending document; picking an app consumes it.

### Examples

#### Attach a document and pre-fill a prompt

```
/apps/chat?documentId=doc-12345&integration=ifinder&prefill=Summarize%20this%20document
```

#### Attach a document, pre-fill, and auto-send

```
/apps/chat?documentId=doc-12345&integration=ifinder&prefill=Summarize%20this%20document&send=true
```

#### Attach a document using a specific search profile

```
/apps/chat?documentId=doc-12345&searchProfile=default&integration=ifinder
```

> **Note:** Only a single `documentId` is supported via the URL. The `prefill`
> value is also used as the initial display name for the document while it is
> loading.

## Backwards Compatibility

The feature is fully backwards compatible:

- URLs without `send=true` work exactly as before
- Existing `prefill` functionality is unchanged
- No configuration changes required
- Optional parameter - enable only when needed

## Troubleshooting

### Message Doesn't Send Automatically

**Possible causes:**

1. Missing `send=true` parameter
2. Empty or missing `prefill` parameter
3. JavaScript errors (check browser console)
4. App still loading (network delay)

**Solution:** Verify both parameters are present and properly URL-encoded.

### Message Sends Multiple Times

This should not happen due to built-in guards. If it does:

1. Check browser console for errors
2. Verify you're using the latest version
3. Report the issue with browser and URL details

### URL Parameter Persists After Send

Both the `send` and `prefill` parameters should be automatically removed once the message is sent. If either persists:

1. Check if JavaScript is enabled
2. Verify navigation is not being blocked
3. Try clearing browser cache

## Technical Details

For technical implementation details, see:
- [Concept Document](../concepts/auto-send-feature/2026-02-02%20auto-send-query-parameter.md)
- [Implementation Summary](../concepts/auto-send-feature/IMPLEMENTATION_SUMMARY_AUTO_SEND.md)

## Related Features

- [Prefill Parameter](./user-guide.md#prefill-parameter) - Pre-populate the input field
- [Short Links](./user-guide.md#short-links) - Create shareable links
- [Variables](./apps.md#variables) - Pass data to apps via URL parameters
- [iFinder Integration](./iFinder-Integration.md) - Enterprise document management and the "Open in App" flow
