# Breaking Changes — Unreleased

## Qwant Is No Longer a Web Search Engine

Qwant blocks requests from most data-centre IP addresses, so it rarely answered. iHub now ships two
web search engines: **Brave Search** and **Staan**. Both need an API key.

Migration V264 runs on the first start and changes what refers to Qwant:

- The installation of `com.intrafind/qwant-search` (`qwant`) is removed from **Admin →
  Integrations**.
- Apps with `websearch.provider: "qwant"` are set to `auto`: the first engine the user may use
  (Brave, then Staan, then any third-party engine).
- Grants of `qwant` or `com.intrafind/qwant-search` are removed from the groups. The grant "All web
  search engines" (`type:web-search`) is not touched.

Nothing replaces it. If an install used Qwant, **install and configure Brave Search or Staan** under
**Admin → Integrations → Catalog → Web search**. Until then an app with web search on searches only
on models with native search (Google, OpenAI, Anthropic).

Also gone:

- The environment variables `QWANT_SEARCH_ENDPOINT` and `QWANT_SEARCH_USER_AGENT`.
- The tool id `qwantSearch`.
- The `blocked` result and its `blockedBy` field of the web search connection test; they only
  reported Qwant's bot protection.

## Projects Keep the Original of an Uploaded File

A file uploaded to a project is now kept next to its extracted text, encrypted the same way, so it
can be downloaded again and handed to an app as the file it was. Until now a project kept only the
text. Projects follow the setting chat uploads already use, **Admin → Chat history → Uploaded
files → What the server keeps** (`platform.uploads.storageMode`), which is `original_and_text` by
default.

- Project storage grows by the size of the uploaded files from now on. Documents uploaded before the
  upgrade stay text only.
- An app's own upload setting does not apply to projects; only the installation's does.
- A project keeps an original as long as the document. `originalRetentionDays` applies to chats only.
- Editing a document's text removes its original.

**Before upgrading:** if your installation must keep no original files (for example because your
compliance statement says so), set **What the server keeps** to "Only the text" (`server_text_only`).
That applies to chat uploads too.

## MCP: Approvals on the Gateway, Stricter Sign-In Discovery

iHub's MCP support moves to version 2 of the MCP SDK. Two behaviors change.

- **Approval-gated tools can run through the MCP gateway.** Until now the gateway refused every
  tool whose approval mode needs a person. It now asks the person through their MCP client and
  runs the call once they approve. A client that cannot ask still gets the refusal. What the
  person sees is up to the client, and a client can be set up to answer on its own.
- **Per-user sign-in checks the authorization server's metadata.** For an MCP server with
  per-user OAuth, metadata whose `issuer` does not match the address it was fetched from is
  refused (RFC 8414), and the user cannot sign in to that server.

**Before upgrading:** if MCP clients should not run an approval-gated action at all, switch the
action off on the installation, or take the integration out of the grants of the groups (or OAuth
clients) that use the gateway, instead of relying on the gateway's refusal. If users cannot sign
in to a per-user OAuth MCP server after the upgrade, ask its operator to fix the `issuer` in the
authorization server's metadata.
