# Features — Unreleased

## MCP Servers: Catalog of Preconfigured Hosted Servers

Admins can now add a hosted MCP server from a built-in catalog instead of looking up its URL and
authentication by hand. **Admin → MCP servers → Browse catalog** lists 37 servers that iHub can
connect to with one shared credential, grouped into categories such as documentation,
development, productivity, sales and support, data, and finance.

- Picking a server pre-fills the create form with its endpoint, authentication type and tool
  prefix, and shows where to create the key, region-specific URLs and other setup notes.
- Five servers need no key at all: Microsoft Learn, Context7, DeepWiki, Astro Docs and
  Hugging Face. Test the connection and save.
- Servers already configured are marked **Added**.
- A new authentication type, **API key in custom header**, sends the key in the header a vendor
  expects (for example `X-Goog-Api-Key`), with an optional prefix such as `Token token=`.
- HTTP servers accept **Additional headers** for non-secret values a vendor wants next to the
  key, such as a scope or account ID. Credentials are refused there and belong under
  Authentication.
- Servers that only allow each user to sign in with their own account (OAuth) are not in the
  catalog yet, because iHub connects with one shared credential per server.
