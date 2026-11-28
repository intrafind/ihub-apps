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

## Document Templates Take Their Design From the Word and PowerPoint Files

A document template now holds a name, the company name, the brand colours (read from the Word and
PowerPoint files unless set), the margins of PDFs and the fields of its Word template. The design
itself lives in the company's Word and PowerPoint templates, so the settings that described it a
second time are gone.

- **Gone from a template:** the logo, the heading and body fonts and the font size, uploaded font
  files, page size, orientation, margins of Word and PowerPoint, header, footer, page numbers, logo
  position, the PDF base design (`default`, `professional`, `minimal`), both letterhead PDFs, the
  PowerPoint layout choices, extra text slots, footer text, slide numbers and slide format.
  Fonts are read from the themes of the files and cannot be edited.
- **PDFs** are still made by iHub's own PDF engine, not from the Word file: they follow the brand
  colours, the Word template's page and margins, and carry a footer with the company name and
  "Page X of Y". They no longer print a letterhead or a logo.
- **PowerPoint** finds its layouts by itself; a text slot is a placeholder named like `Kicker` or
  `Lead`. Footer text comes from the model and slide numbers from the layout's placeholders.
- **The chat export** keeps its built-in `default`, `professional` and `minimal` designs for
  installations without a template; a document template no longer chooses one of them.
- **Migration:** on the first start, every `contents/document-templates/<id>/template.json` is
  rewritten (a margin set under `document.margins` moves to `pdf.margins`), the logo, font and
  letterhead files are deleted, and the `{{placeholders}}` of the Word template become fields. The
  names that do not fit in the 50 fields a template may have are written to the server log.
  Template files with the removed settings are refused afterwards.

**Before upgrading:** put the logo and the letterhead of your documents into the Word template (the
first-page header) and the PowerPoint template (master and layouts), and check what the Word
template's page setup gives your PDFs. The migration deletes the logo, font and letterhead files of
your templates: keep copies of them if you still need them.


## Telemetry: Users Are Pseudonymised on Spans, Content Capture Has a New Format

Telemetry spans no longer name the user in clear text, and captured prompts and answers use the
current OpenTelemetry format. Dashboards, trace queries or collector rules built on the old
attribute names need updating.

- The LLM span carries `user.hash`, a keyed hash of the user, instead of `user.id`. The new
  setting `telemetry.spans.userIdMode` (**Admin → Telemetry → User on spans**) chooses
  `pseudonymised` (default), `off` or `clear`; only `clear` exports `user.id`. `user.groups` is no
  longer exported. `gen_ai.conversation.id` is hashed unless the mode is `clear`.
- Captured content moves from the `gen_ai.content.prompt` / `gen_ai.content.completion` events to
  the span attributes `gen_ai.input.messages` / `gen_ai.output.messages`. It is redacted (e-mail
  addresses, phone numbers, IBANs, keys) and capped at 4096 characters whatever
  `events.maxEventSize` says; a larger stored value is lowered to 4096. The `gen_ai.choice` event
  is gone.
- `telemetry.autoInstrumentation` now instruments HTTP, `fetch` and Express only. DNS, network
  socket and file-system spans are no longer produced, URLs are exported without query string,
  inbound spans without the caller's IP address, and winston no longer sends log records.
- In Prometheus mode every series carries a `cluster_worker_id` label, and `service.instance.id`
  is `<host>-w<worker>` instead of a random id per process.
- `process.runtime.nodejs.event_loop.delay` is gone; use `nodejs.eventloop.delay.*` (with
  percentiles) and `nodejs.eventloop.utilization` instead.
- `process.runtime.nodejs.memory.usage` is `process.memory.usage` (resident set size); heap
  figures are `v8js.memory.heap.*`.
- `gen_ai.provider.name` uses the semantic-convention values: `gcp.gemini` for Google,
  `aws.bedrock` for Bedrock, `openai` for the OpenAI Responses API.
- The resource attribute `deployment.environment` is `deployment.environment.name`; the
  migration renames it in `telemetry.resource`.
- A new installation binds the Prometheus endpoint to `127.0.0.1` instead of `0.0.0.0`;
  existing configurations keep their value.
- A missing or unknown `telemetry.provider` exports nothing (with a warning) instead of writing
  spans and metrics to the container log.
- `ihub.auth.events` reports an unknown `auth.provider` or `auth.event` as `other`.

**Before upgrading:** if dashboards or queries filter on `user.id`, `user.groups` or the
`gen_ai.content.*` events, switch them to `user.hash` and `gen_ai.input.messages` /
`gen_ai.output.messages`, or set `userIdMode` to `clear` where your works agreement allows it.
Aggregate Prometheus series across workers with `sum` (or `max` for the active-user gauges).
