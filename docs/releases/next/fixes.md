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
