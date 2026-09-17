# Features — 5.5.3

## Grant Tools to a Group for Direct MCP Access

Groups can now carry a `tools` permission, so an MCP or A2A client can call a tool such as iFinder,
Jira or Entra directly. Until now tool access was derived purely from apps — exposing a tool over
MCP meant enabling an app whose only purpose was to hold the permission, and that app then showed up
in the app list for everyone in the group.

Set it per group in **Admin → Groups**, or in `groups.json`:

```json
"mcp-power-users": {
  "permissions": { "apps": [], "tools": ["iFinder"] }
}
```

Naming the tool itself (`iFinder`) grants all of its functions — `iFinder_search`,
`iFinder_getContent`, `iFinder_getMetadata`, `iFinder_discover`. Naming one function grants only
that function. `["*"]` grants every tool.

Every existing group upgrades to an empty list, so nothing changes until you opt a group in. Grant
it deliberately: a direct grant lets the client call the integration **as the user**, with no app
prompt in between. It does not affect chat, where an app's own `tools` list still decides what the
model may call.
