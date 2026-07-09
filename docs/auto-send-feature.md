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
| `temp` | No | Set temperature (0-2) | `temp=0.7` |
| `style` | No | Set response style | `style=concise` |
| `outfmt` | No | Set output format (`markdown`, `text`, `json`, `html`) | `outfmt=json` |
| `history` | No | Include chat history in requests (`true`/`false`) | `history=true` |
| `var_*` | No | Set app variables | `var_date=2024-01-01` |
| `documentId` | No | Attach an iFinder document (requires `source=ifinder`) | `documentId=doc-12345` |
| `source` | No | Document source; must be `ifinder` to trigger attachment | `source=ifinder` |
| `searchProfile` | No | iFinder search profile used to resolve the document | `searchProfile=default` |

> **Note:** `prefill` works on its own (without `send=true`) to simply pre-populate
> the input field. Likewise, the `model`, `temp`, `style`, `outfmt`, `history`,
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

## iFinder Document Attachment

In addition to the message parameters above, the chat URL can pre-attach an
iFinder document to the conversation. This powers the "Open in App" flow from
iFinder, but the parameters can be used in any link.

### Syntax

```
/apps/{app-id}?documentId={id}&source=ifinder
```

The `source=ifinder` parameter is **required** to trigger the attachment — the
`documentId` is ignored unless `source` is exactly `ifinder`.

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `documentId` | Yes | The iFinder document identifier to fetch and attach |
| `source` | Yes | Must be `ifinder` to trigger the document attachment |
| `searchProfile` | No | iFinder search profile used to resolve the document download link |

### How It Works

1. The page loads and shows a loading placeholder in the attachment area.
2. The document is fetched server-side via the iFinder proxy
   (`/api/integrations/ifinder/document`), which resolves the download link and
   streams the binary. If the binary fetch fails, the text content is fetched as
   a fallback.
3. The document is processed through the same pipeline as an uploaded file and
   attached to the chat.
4. The `documentId`, `source`, and `searchProfile` parameters are removed from
   the URL to prevent re-fetching on refresh.

When sent to the backend, the attached document is passed as a `documentIds`
array, so the chat request always carries the document context.

### Examples

#### Attach a document and pre-fill a prompt

```
/apps/chat?documentId=doc-12345&source=ifinder&prefill=Summarize%20this%20document
```

#### Attach a document, pre-fill, and auto-send

```
/apps/chat?documentId=doc-12345&source=ifinder&prefill=Summarize%20this%20document&send=true
```

#### Attach a document using a specific search profile

```
/apps/chat?documentId=doc-12345&searchProfile=default&source=ifinder
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
- [Concept Document](../concepts/archive/auto-send-feature/2026-02-02%20auto-send-query-parameter.md)
- [Implementation Summary](../concepts/archive/auto-send-feature/IMPLEMENTATION_SUMMARY_AUTO_SEND.md)

## Related Features

- [Prefill Parameter](./user-guide.md#prefill-parameter) - Pre-populate the input field
- [Short Links](./user-guide.md#short-links) - Create shareable links
- [Variables](./apps.md#variables) - Pass data to apps via URL parameters
- [iFinder Integration](./iFinder-Integration.md) - Enterprise document management and the "Open in App" flow
