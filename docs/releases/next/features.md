# Features — Unreleased

## Uploads: Teams Transcripts (.vtt) and Any Text File

Users can now attach WebVTT files (`.vtt`) — the format Microsoft Teams exports meeting transcripts
in — to chats in any app that accepts plain text files. Admins can also allow "Any text file" for
an app, so logs, YAML, subtitle files and other plain-text formats can be uploaded without listing
each one.

- Existing apps that accept `.txt` accept `.vtt` automatically after the upgrade.
- "Any text file" is off by default. Enable it under **Admin → Apps → Upload → Supported File
  Formats**. The file picker then shows all files; binary files are rejected on upload, and formats
  such as PDF or Word are only extracted when they are selected explicitly.

## App Editor: Open the App, Save Without Leaving, and Test Next to the Editor

Admins can now tweak an app and try it without leaving the app editor.

- **Save** stores the app and keeps the editor open (also with Ctrl+S / Cmd+S). **Save & Exit**
  returns to the app list, as saving did before. A new app saved with **Save** stays open for
  further editing.
- **Open app** in the editor and a new open icon in **Admin → Apps** open the app's chat page in a
  new tab.
- **Test** shows the app's chat next to the editor (full screen on small screens), so you can
  check the start screen and chat with the app. It runs the saved version and starts over with a
  new chat after every save; test chats are ordinary chats of your account.
- Testing works for chat apps. Disabled apps can't be opened or tested until they are enabled.

## Prompt Caching: Per-Model Switch and Cache Metrics

Providers serve the start of a prompt they have seen recently from a cache, billed at a steep
discount and answered faster. Admins can now switch prompt caching on or off per model and see how
much input the cache serves. The switch is under **Admin → Models → Prompt Caching** for OpenAI,
Anthropic and Bedrock models. The new **Prompt caching** panel on **Admin → Usage Reports** shows
the cache hit ratio, cached input tokens and cache write tokens, with a breakdown by model, app and
provider.

- **Defaults:** on for OpenAI models on `api.openai.com`, which cache automatically — the switch
  adds a cache key per app that raises the hit rate. Off for Anthropic and Bedrock, where writing
  to the cache costs 25 % more than normal input, and for OpenAI-compatible servers, which may
  reject the parameter. Other providers cache on their own and have no switch.
- The shipped platform context and the iAssistant and iFinder search apps now tell the model the
  date only, no longer the user's timezone. The timezone differed per user, so every prompt
  started differently and could not be cached. Texts an admin has changed are left as they are;
  the `{{timezone}}` and `{{time}}` variables keep working.
- **Timeline** adds cached vs. uncached input tokens over time, cache columns in the app and model
  breakdowns, and a new **Providers** breakdown.
- Cache writes are shown next to reads: when a model writes to the cache more than it reads from
  it, the tile turns amber. On Anthropic and Bedrock, where writes cost extra, caching then costs
  more than it saves.
- Captured for Anthropic, Bedrock, OpenAI (Chat Completions and Responses), Google Gemini, Mistral
  and vLLM, together with reasoning tokens where the provider reports them.
- The event CSV export has new columns after the existing ones: `provider`, `cacheReadTokens`,
  `cacheWriteTokens`, `reasoningTokens`, `webSearchRequests`. OpenTelemetry spans carry the
  cache counts as `gen_ai.usage.cache_read.input_tokens` and
  `gen_ai.usage.cache_creation.input_tokens`.
- Only usage recorded after the upgrade has cache counts.

## Chat Links Show Where They Lead

Hovering a link in a chat answer now shows its destination as a tooltip, so a user can see which
site or file a linked title opens before clicking. Links that already carry a title — such as the
source and folder the iFinder Search app now puts on every document link — keep it. The "Read …"
rows of the tool activity panel show their address the same way.

## Chat Sharing: Read-Only Links to Stored Chats

Users can now share a stored chat as a read-only link — with specific users, with anyone who is
signed in, or publicly without a sign-in. The recipient sees the conversation as it was when it
was shared and can view and download the images it generated. They cannot continue, edit or rate
it. Off by default: turn on **Chat Sharing** under
**Admin → Features** (it requires **Durable Chats**).

- **Share chat** in the header of a stored chat opens the dialog. **Specific users** are picked by
  name or e-mail from the user database and find the chat under **Shared with me** on the chats
  page (no notification is sent). **Anyone signed in** needs the link and an account. **Public**
  links open for anyone with the link, also when anonymous access is off; the owner has to
  acknowledge a warning first, and can choose whether viewers see their name.
- A link is a **copy of the chat at the time of sharing**. Later messages and edits are not part
  of it; uploaded files are never part of it — the viewer sees the file name only.
- Every link can carry an **expiry** and a **maximum number of opens**. Opens are counted, and
  for links to specific users the owner sees per recipient whether and when they opened it.
- **Revoke** closes a link immediately; the chat itself is unchanged. Deleting the chat removes
  its links. A closed, expired, used-up or unknown link shows the same "no longer available" page.
- Admins configure sharing under **Admin → Observability → Chat History → Chat sharing**: which
  audiences are offered (public links can be switched off), a default and a longest expiry, and a
  cap on opens per link. The same page counts shares, lists the newest ones and lets an admin
  revoke any of them. Creating and revoking shares is written to the audit log.
- New settings block `platform.json → chats.sharing`; the upgrade writes the defaults (all
  audiences allowed, no expiry, no cap).
