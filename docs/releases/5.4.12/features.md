# Features — 5.4.12

## iHub Support Bot Can Now Answer Questions About the Platform

The bundled **iHub Support Bot** app now references the built-in iHub Documentation source, so it
can look up and cite the full platform documentation on demand instead of only the short FAQ.

- The documentation is exposed as a tool the model calls on demand, so ordinary questions are not
  slowed down by loading the full document.
- Existing installations receive the updated app configuration automatically on upgrade via the
  configuration migration system; no manual action is required.

## Tools Are Now Managed as Individual Files

Tool configurations now live as individual JSON files under `contents/tools/`, matching how apps,
prompts, and models are already stored, instead of as entries in one shared `config/tools.json`
array. See [Breaking Changes](breaking-changes.md#configtoolsjson-is-removed) for the upgrade path.

- Creating, editing, toggling, or deleting a tool in the admin UI reads and writes its own file,
  making it easy to add or remove a single tool without touching the others.

## Outlook Add-in: Attached Emails and Meeting Invites Are Now Included

Forwarding an email or meeting invite as an attachment now actually sends its content to the
model. Previously these fetched successfully and showed as "attached" in the review banner, but
were silently dropped when the message was sent — the model never saw them and the user had no
indication anything was missing.

- Attached/forwarded emails (`.eml`) are parsed into their subject, sender, recipients, and body
  text.
- Meeting invites (`.ics`) are parsed into a short summary: subject, time, location, and organizer.
- OneDrive/SharePoint attachments (share links, not the file itself) now include the link as a
  reference instead of being dropped without a trace.
- Attachments larger than 20 MB are skipped up front instead of being downloaded into the task
  pane, which could previously stall the pane on a large attachment.
- On Outlook hosts older than Mailbox 1.8 (which can't fetch attachment content at all), the
  banner now shows one explanation instead of repeating the same error on every attachment.

## Restrict Which Models an App Can Use

The App Editor now has an "Allowed Models" picker, so admins can limit a specific app to a chosen
set of AI models instead of only being able to set a single preferred one.

- Search and add models to the allow-list, same picker used for group and OAuth-client
  permissions; leave it empty to keep the app open to every available model.
- Users can no longer pick or be switched to a model outside the app's allow-list — chat requests
  fall back to a compatible model automatically.

## Group Management: Admin Lockout Prevention

The admin Groups API's protected-group list previously checked for `admin`/`user`, but the
built-in groups are shipped as `admins`/`users`. This meant the real administrator group could be
deleted, or have its administrative access removed via an update, silently locking every admin out
of the platform until `groups.json` was hand-edited.

- Deleting or updating a group is now blocked whenever it would leave the platform with zero
  groups granting administrative access, in addition to the built-in `admins`, `users`,
  `anonymous`, and `authenticated` groups remaining non-deletable.
- The group create/update endpoints now also accept the documented `inherits` field.

## Fixed Cross-Chat Tool-Call Mixups Under Concurrent Load

Streaming tool calls for OpenAI-, Anthropic-, and vLLM/local-backed apps are now tracked per
conversation instead of in one shared bucket. Previously, two users streaming tool calls at the
same time — or a user whose stream was cancelled mid-flight — could have their pending tool-call
data overwritten or merged with another user's, occasionally causing a tool to run with the wrong
or corrupted arguments.

- Each conversation's in-flight tool-call data is now isolated by chat.
- A cancelled or errored stream can no longer leave stale tool-call data behind to be picked up by
  a later, unrelated conversation.

## Stellungnahmen (iFinder) Review Now Covers the Whole Corpus

The iFinder-backed **Stellungnahmen Review** workflow now analyses every matching document instead
of only the first 25 hits per search. Previously, when a search reported many more results than it
returned (e.g. 155 total but only the first 25 retrieved), the remaining documents were never
loaded or reviewed — so the audit report silently missed most of the corpus.

- Each search now pages through all of its hits, bounded only by an overall document ceiling
  (raised from 200 to 500).
- Existing installations are updated automatically on upgrade via the configuration migration
  system; no manual action is required.
- Corpus-search nodes in custom workflows can opt into this behaviour by setting `maxPerTopic: 0`
  (unlimited per query). A positive value keeps the previous top-N-per-query limit.
- Very large corpora may need a higher `maxTotalDocs` and, since each document is fetched and
  analysed individually, a longer `maxExecutionTime`.

## Workflows and Other Paths Now Work with OpenAI-Compatible Models

AI apps that run **workflows** with a model on the **OpenAI adapter** — including self-hosted
vLLM, LM Studio, and Jan.ai endpoints, and Mistral/Ministral models served over an
OpenAI-compatible URL — could fail with `Unsupported URL scheme: <model-id>` (for example
`Unsupported URL scheme: ministral`). The model's configured API URL was correct; the request was
being built before the model's endpoint had finished resolving, so the model's id leaked through as
the URL.

- Affected the workflow query-plan/agent steps, the OpenAI-compatible proxy endpoint, the session
  test-chat, OCR, and tool follow-up calls. The standard streaming chat path was not affected.
- No configuration change is required — existing OpenAI-adapter models work as configured.
- When a request URL genuinely cannot be resolved, the error now names the offending URL (with any
  embedded secrets redacted) so misconfiguration is easier to diagnose.

## Chat No Longer Crashes When a Response Finishes

Chat responses now complete cleanly instead of failing with an "Add-in Error" (`setSearchStatus is
not defined`) the moment the model finished answering. The crash surfaced in the Outlook add-in but
came from the shared chat used across the platform, so any app could be affected.

- Fixes the error thrown at the end of every response, so answers now display and finalize normally.
- Also fixes a related crash for iFinder-backed apps that emit a response message id (used for
  answer feedback), which previously interrupted the reply the same way.
- No configuration or admin action required.
