# Fixes — Unreleased

## MCP Servers Using Streamable HTTP Connect Reliably

Connecting to an MCP server over Streamable HTTP often failed with `406 Not Acceptable`, or the
connection test and tool calls timed out. iHub dropped the request headers the protocol requires
and could not read streamed (`text/event-stream`) replies. Both now work.

## External MCP Servers No Longer Receive iHub User Details

Tool calls to external MCP servers included iHub's internal context — the signed-in user's
profile, the app configuration and the chat id — alongside the model's arguments. Only the tool's
own arguments are sent now.
