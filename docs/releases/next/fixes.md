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
