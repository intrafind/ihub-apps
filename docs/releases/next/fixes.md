# Fixes — Unreleased

## iHub Support Bot: Documentation Available in Docker and Production Builds

In Docker images, the iHub Support Bot had no iHub documentation to answer from, and installations
built with `npm run prod:build` could ship the documentation of an earlier build or none at all —
the documentation source was generated after the server files were packaged, or not at all. Every
build now generates it before packaging, so the bot answers from the documentation of the version
it runs.

## MCP Servers Using Streamable HTTP Connect Reliably

Connecting to an MCP server over Streamable HTTP often failed with `406 Not Acceptable`, or the
connection test and tool calls timed out. iHub dropped the request headers the protocol requires
and could not read streamed (`text/event-stream`) replies. Both now work. Message requests over
the legacy SSE transport now also go through the same private-address protection as the rest of
the connection.

## External MCP Servers No Longer Receive iHub User Details

Tool calls to external MCP servers included iHub's internal context — the signed-in user's
profile, the app configuration and the chat id — alongside the model's arguments. Only the tool's
own arguments are sent now.

## Chat Tools Menu Shows One Entry Per MCP Server, Not Every Tool It Exposes

The **+** menu next to the chat input listed every tool an MCP server exposes as its own toggle,
by its internal name (for example `excalidraw__read_me` and `excalidraw__create_view` as two
separate, cryptic entries). It now shows a single toggle named after the server (**Excalidraw**),
which enables or disables all of its tools together. A server contributes no entry at all when an
app has none of its tools selected.
## Outlook Add-in: The Task Pane Follows the Email You Click

The task pane could get stuck on one email: clicking another message in the list changed nothing
in the **Email context** header, and the assistant then answered about a different email than the
one on screen — asking for a summary summarised the wrong message. Outlook can keep naming the
previously open email for a moment after the switch, and the pane's attempt to compensate for that
with id comparisons and a timed re-check could decide that no read was ever trustworthy enough to
show, leaving the previous email in place indefinitely while the chat was built from a fresh read
of the live one.

- The pane now shows whatever it read, every time the open item changes, with no id comparison
  deciding whether a read may be shown.
- Which email is open is read in one place. The context header, the token estimate, the
  "Add this email" control and the automatic new chat all follow it, so they can no longer
  disagree about which email the answer is about.
- The automatic new chat now happens for exactly the email the pane displays, instead of lagging
  one message behind it. Re-selecting the open email or a refresh of the message list still
  changes nothing, and removed attachments and the body opt-out survive both.
- The chat input is unavailable for the moment the pane spends reading a newly opened email,
  rather than accepting a question it would answer from a different message.
  
## Marketplace: Installs No Longer Overwrite Local Content or Accept Broken Items

Installing an item from the marketplace silently replaced an app, model, prompt, workflow or skill
of the same ID that was already on the instance — including the shipped defaults — and a replaced
model lost its API key and could change which model was the system default. Installs also skipped
validation, so items with keys the current release rejects were installed without an error.

- Items that exist on the instance but were not installed from the marketplace are marked
  **Local copy**. Replacing one takes an explicit confirmation, and the status filter can show
  them.
- Installing or updating a model keeps the API key and default setting of the model it replaces.
  A newly installed model never becomes the system default.
- Apps, models, prompts and workflows are checked against the same rules the server applies when
  loading them, and an item whose ID differs from its marketplace name is refused. The error lists
  every problem found.

## Apps: Variable Descriptions and Placeholders Show in Chat

The `description` and `placeholder` of an app variable were dropped when the app was loaded, so
the chat showed neither the help text nor the custom placeholder — including on shipped apps such
as the Translator. Both now appear as configured.

## Chat: Thinking Is Readable Again Instead of One Bullet Per Word

Opening **Show thinking** on a reasoning model produced a bulleted list with a single word on each
line — "The", "user", "is", "asking" — which was unreadable. Providers stream reasoning one token
at a time, and every token was kept as its own entry rather than being joined into the text it came
from. The thinking now reads as continuous text and keeps its own line breaks, while named steps
such as workflow phases stay separate entries.

## iHub Support Bot Answers From the Whole Documentation

The iHub Support Bot could not answer most questions about iHub: of the ~2 MB iHub Documentation
it only ever saw the first few pages — the title page and table of contents. A source exposed as a
tool returned its whole content, and anything above the 64 KB a tool result may hold was cut to a
short preview. The whole documentation (~500,000 tokens) would not fit most models anyway.

- Filesystem, URL and page sources exposed as tools still return small content whole. Larger
  content is searched: the tool returns the sections that match the model's keywords (up to about
  10,000 tokens), one section it asks for by id, or an outline to pick from.
- The Support Bot's system prompt now tells the model to search the documentation, with English
  keywords whatever the question's language. An upgrade updates the prompt only in the languages
  you have not changed.
- A filesystem tool source always reads the file configured on the source; the model can no
  longer ask it for another file.
