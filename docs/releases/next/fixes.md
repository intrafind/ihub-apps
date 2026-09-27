# Fixes — Unreleased

## vLLM models respect "Show reasoning" being turned off

On vLLM models (`provider: "local"`), turning off "Show reasoning" in the model settings, or
"Show thinking process" in an app or chat, had no effect: the model's reasoning was still shown.
The model still reasons, but its reasoning text is no longer returned or shown.

- The model setting is the default; an app's thinking settings and the user's toggle override it.
- Needs a vLLM version that supports `include_reasoning`. Older servers ignore it and keep
  showing the reasoning.

## Tools always run as the signed-in user

A direct tool call (`POST /api/tools/<toolId>`) could name another user in its request body, and
tools that act as the caller, such as iFinder, Jira or MCP servers with per-user sign-in, then
ran with that user's identity and access. Tool calls now always run as the signed-in user; user
and chat details in the request body are ignored.

- The same applies to workflows and tools started through the MCP gateway and the A2A endpoint.

## Group tool grants by server or tool family apply to the tool list

A group that granted an MCP server id or a tool family (for example `iFinder` for all
`iFinder_*` tools) did not see those tools in the chat's tool list, although the MCP gateway
already honoured the grant. The tool list now reads group grants the same way as app tool
settings: an exact tool id, a tool family, or an MCP server id.
