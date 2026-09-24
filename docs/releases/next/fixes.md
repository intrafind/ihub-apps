# Fixes — Unreleased

## MCP Servers: External Servers Connect Over HTTP

Connecting iHub to an external MCP server over Streamable HTTP or SSE failed: **Test connection**
reported errors such as

> Unable to read the request as JSON because the request content type '' is not a known JSON
> content type.

or never finished. Requests went out without the headers the MCP protocol requires, and responses
could not be streamed. Both are fixed, so tools from external MCP servers now show up in the tool
catalog. SSE message requests now also go through the same private-address protection as
the rest of the connection.
