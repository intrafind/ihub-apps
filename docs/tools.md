# Tools

> **This page has moved.**
> All tool documentation, including the built-in tools reference, the tool file field reference, and implementation guides, is now consolidated in the **[Tool Calling Guide](tool-calling.md)**.

## Quick Links

- [Built-in Tools Reference](tool-calling.md#built-in-tools-reference) — braveSearch, read_url, iFinder, entraPeopleSearch (all of them actions of built-in [installed integrations](integrations.md#built-in-integrations) now)
- [iHub's own tools](tool-calling.md#ihubs-own-tools-ask_user-knowledge_-write_artifact-) — `ask_user`, the project knowledge tools, artifacts, agent memory, inboxes and tasks, the evidence tools and the scheduled-task tools: actions of the always-installed **iHub** integration (`ihub`), listed in `app.tools` by their ids as before; no tool files, and the Admin → Tools page lists only custom tools
- [People Directory Search](people-directory-search.md) — LDAP directories (company directory, x500.bund.de) as installations of the LDAP people directory integration, each with its `<directoryId>__search_people` tools; apps bind one installation or the whole definition. The admin LDAP browser (`<directoryId>__browse_*`, `ldapBrowse`) returns raw entries
- [Native Web Search Resolution](tool-calling.md#native-web-search-resolution) — how Google/OpenAI/Anthropic native search is resolved (it's not a tool)
- [Tool Configuration Reference](tool-calling.md#tool-configuration-reference) — tool file field descriptions and `isSpecialTool` explanation
- [Quick Start](tool-calling.md#quick-start) — Enable a tool for your app in under 10 minutes
- [Tool Development Lifecycle](tool-calling.md#tool-development-lifecycle) — Create, implement, test, and integrate a tool
- [Implementation Patterns](tool-calling.md#implementation-patterns) — Simple tools, method-based tools, external service integration
