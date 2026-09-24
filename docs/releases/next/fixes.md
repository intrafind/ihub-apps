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
