# Unified Integrations: one place to find, install, enable, connect and use them

**Date:** 2026-10-20
**Status:** Proposal
**Tickets:** Jira [IPD-641](https://intrafind.atlassian.net/browse/IPD-641) · GitHub epic [intrafind/ihub-apps#2911](https://github.com/intrafind/ihub-apps/issues/2911)
**Related:** [Third-party integrations issue drafts](../third-party-integrations/README.md) (connection framework and per-connector drafts, 2026-09-24), [Preconfigured MCP Server Catalog](../2026-09-24%20Preconfigured%20MCP%20Server%20Catalog.md), [MCP Per-User OAuth Implementation Notes](../2026-09-27%20MCP%20Per-User%20OAuth%20Implementation%20Notes.md), [Langdock Cookbook Gap Analysis](../2026-09-25%20Langdock%20Cookbook%20Gap%20Analysis%20—%20MCP,%20A2A%20and%20Agent%20API.md), [iHub Marketplace PRD](../2026-02-23%20iHub%20Marketplace%20PRD.docx), [Marketplace](../../docs/marketplace.md), [MCP Integration](../../docs/mcp-integration.md), [Building an Integration](../../docs/integration-development.md), Jira IPD-618 (iFinder MCP server), IPD-554 (business-user admin for connectors)

---

## Requirement

> We have several integrations and we should streamline them. Many are MCP based, others are API based. Right now every integration is special. The goal is a central place for all integrations: a common way to install them, to activate and configure them, and a common way for a user to interact with them. Similar to skills, prompts and the marketplace: a central place to search for integrations, add them, configure them, and on the user side decide which ones to use, connect the ones that need it.

## Summary

iHub reaches external systems in fifteen different ways today (MCP servers, A2A agents, OpenAPI tools, script tools, web search providers, Jira, three cloud storage providers, Entra, iFinder, sources, and the inbound channels), configured in five places, with four per-user OAuth stacks and three ways to store a secret. Users meet them in three different connect cards and two unrelated lists.

We propose one **integrations platform** with three layers, the shape every competitor has converged on: an **integration** (a versioned catalog entry, distributable through marketplace registries), an **installed integration** (the admin's instance: endpoint, auth mode, groups, action policy), and a **connection** (one user's or one group's credential). Protocols (MCP, OpenAPI, native code, A2A, HTTP, script, storage, web search) become adapters behind one model, and every tool belongs to an integration. Admins get one sidebar section with a catalog, an install wizard generated from typed fields, group permissions and tool policy tiers. Users get one settings page that lists everything they may use with its true identity state, one picker in the chat composer, one connect card and one confirmation card for writes. The marketplace gains the item type `integration`, so IntraFind can ship the systems public directories lack (SharePoint on-prem, Jira and Confluence Data Center, DMS systems, SAP, Nextcloud, openDesk) as installable packages.

## How to read this folder

| Document | Answers |
| --- | --- |
| [01 · Current state](01-current-state.md) | What exists, where it diverges, what already points the right way |
| [02 · Market research](02-market-research.md) | How Langdock, Open WebUI, LibreChat, Dify, Claude, ChatGPT, Microsoft, Gemini, Glean, Perplexity and the managed-auth vendors do it; which standards fix the data model |
| [03 · Product concept](03-product-concept.md) | Vocabulary, personas, principles, admin and user journeys, chat UX, wireframes, decisions requested |
| [04 · Architecture](04-architecture.md) | Definition and instance formats, adapters, auth modes, approval gate, routes, client components, marketplace, migrations |
| [05 · Roadmap](05-roadmap.md) | Phases, risks, open questions |
| [06 · Implementation kickoff](06-implementation-kickoff.md) | The prompt and model recommendations to start one issue per session |
| [07 · Types and built-in configuration](07-types-and-built-in-configuration.md) | Integration types, one admin page with dedicated editors, web search per engine, storage providers, people directories, the iHub integration (decided 2026-11-01) |
| [2026-11-01 · Admin integrations page and installation editors](2026-11-01%20Admin%20integrations%20page%20and%20installation%20editors.md) | Implementation notes: the one admin page, groups, tiles, the installation page, the editor registry and how to add an editor |
| [2026-11-01 · Storage provider contract](2026-11-01%20Storage%20provider%20contract.md) | Design for third-party storage providers: the `files` connector contract, generic routes, browser and project kind, and the issue text to file |
| [2026-11-01 · iHub integration: chat tools only](2026-11-01%20iHub%20integration%20chat%20tools%20only.md) | Implementation note: which iHub tools are integration actions, which belong to projects, workflows and agents, and how they are loaded |
| [2026-11-02 · Web search engines](2026-11-02%20Web%20search%20engines.md) | Implementation notes: one integration per engine, Auto's order, native search without an engine, the page reader as a platform tool, migration V204, the engine contract |
| [2026-11-02 · Marketplace integration facts and stdio rejection](2026-11-02%20Marketplace%20integration%20facts%20and%20stdio%20rejection.md) | Implementation notes: the four facts on marketplace cards and detail (derived server-side from the definition at catalog load), stdio items dropped at catalog load with a logged reason |
| [2026-11-02 · People directories and the LDAP browser](2026-11-02%20People%20directories%20and%20the%20LDAP%20browser.md) | Implementation notes: People directory (LDAP), the LDAP browser as its own integration, migration V205, the dedicated directory, browser and Entra editors |
| [2026-11-02 · Storage providers as installations](2026-11-02%20Storage%20providers%20as%20installations.md) | Implementation notes: several installations per provider (installation id = provider id), migration V206, the per-app binding, the base-path-aware redirect URI, the storage editor |
| [2026-11-02 · Connection service and OAuth client](2026-11-02%20Connection%20service%20and%20OAuth%20client.md) | Implementation notes (#2914): one OAuth client with strategies, the connection index, server-side sign-in state, the one callback and its aliases, the re-index, `INTEGRATION_AUTH_REQUIRED`, the public interface #2917 builds on |
| [2026-11-02 · Tool approval](2026-11-02%20Tool%20approval.md) | Implementation notes for #2945: resolver, shared approval seam, how a paused chat turn continues (spike), workflow parking, what #2916 adds |
| [2026-11-02 · Action approval and fingerprints](2026-11-02%20Action%20approval%20and%20fingerprints.md) | Implementation notes for #2916: action fingerprints, `approval.newOrChanged`, new/changed badges and review, install preselection, `dataFlow` override |
| [2026-11-02 · Example apps and chat test for integrations](2026-11-02%20Example%20apps%20and%20chat%20test%20for%20integrations.md) | Definitions ship example apps as companion files; the installation page creates one bound to the installation with one click and tests it in a chat panel beside the page |
| [2026-11-02 · One connect flow and connect card](2026-11-02%20One%20connect%20flow%20and%20connect%20card.md) | Implementation notes (#2917): `GET /api/integrations` and its shape, `POST …/connect`, `…/reconnect`, `…/disconnect`, the one Connect card, the retry once after connecting, what was removed |
| [2026-11-02 · Chat picker and server-side defaults](2026-11-02%20Chat%20picker%20and%20server-side%20defaults.md) | Implementation notes (#2923): the picker rows from the server (`refs`, `coveredBy`), the per-user default per app and its one-time import, connect in a new tab |
| [2026-11-02 · Action detail and test runner](2026-11-02%20Action%20detail%20and%20test%20runner.md) | Implementation notes for #2974: action detail drawer, guidance in the system prompt, the test runner with redaction and server-side confirmation, per-action usage counter |
| [2026-11-02 · Built-ins own the shipped tools](2026-11-02%20Built-ins%20own%20the%20shipped%20tools.md) | Implementation notes for #2973: the tool ownership test, the side-effect/data-flow snapshot, the tool-id regression fixture and the iAssistant `ask` action |
| [mockups/integrations.html](mockups/integrations.html) | Clickable low-fidelity mockup of the admin catalog, install wizard, installed list, instance page with action detail and test, user settings page and chat picker |

## Goals

- One catalog, one install flow, one enable/configure model, one user-side list, one chat picker, one connect card, one confirmation card. Everything else is an adapter.
- Delegated identity by default; shared credentials explicit and visible.
- Admin enables, user connects, user picks: three decisions, three owners.
- Approval follows [intrafind/ihub-apps#2945](https://github.com/intrafind/ihub-apps/issues/2945): `never`, `writes` or `always` per integration and action, with a platform floor by data flow (external data: ask on writes; internal: never). Admins may also require approval for external reads; apps can only tighten.
- Integrations are files: installable from a registry, updatable, detachable, auditable.
- Standards first: MCP authorization and registry, MCPB config fields, MCP Apps, tool annotations.

## Non-goals

- Rewriting the output side (Answer Sources, citations, preview, download already share one contract).
- Building every connector from the epic. This is the platform; connectors follow demand.
- Replacing models, providers or iAssistant (a model adapter) with integrations.
- Turning inbound channels (Outlook add-in, extension, Copilot agent, gateway) into outbound integrations; they get a tab in the same section, not the same model.

## The one picture

```
            Catalog (registries + built-in + optional MCP registry)
                 │  install  (wizard from typed fields, test before save)
   Admin ──────► Installed integration  ── groups · auth mode · action policy · health
                 │  enable
                 │                           ┌──────── Apps bind: which actions, whose connection
   User ───────► Connection (connect / reconnect / disconnect)        │
                 │                                                   │
   Chat ───────► Picker (on / off per chat) ──► Model calls action ──► Approval gate ──► Adapter ──► System
                                                                       (never · writes · always, per #2945)
```

## Decisions

See [03 · Product concept → Decisions](03-product-concept.md#10-decisions-this-concept-asks-for). Taken: vocabulary (Integration, Connection, Action), server-side chat state, marketplace type `integration`, clean break for the admin MCP and A2A routes (2026-10-20); approval per [#2945](https://github.com/intrafind/ihub-apps/issues/2945) (2026-10-22, replaces "ask on every write by default"); integrations own their tools and the Tools page folds in (2026-10-23); clean break for the Tools admin routes, no shared OAuth connections, web search as a picker row, the public MCP registry only as an opt-in registry (2026-10-31, [05 · Roadmap → Open questions](05-roadmap.md#open-questions-for-the-team)); versioning, compatibility, release notes and migrations per [Integration Versioning and Migrations → Decisions](../2026-10-31%20Integration%20Versioning%20and%20Migrations/README.md#7--decisions) (2026-10-31).

## Revision 2026-11-01

Testing the merged stack led to [07 · Types and built-in configuration](07-types-and-built-in-configuration.md), all decided the same day: definitions declare a **type** (`people-directory`, `web-search`, `storage`) that groups them and that apps bind as a whole (`type:<type>`); **one admin page** with grouped tiles, a page per installation and **dedicated editors** for the built-ins (the route `/admin/integrations/installed` goes); **web search per engine** (Brave, Staan, Qwant as separate integrations, native search without any; supersedes the 2026-10-31 "web search as a picker row" for the admin side); **storage providers** installable several times and bound per app; **People directory** as the name, Entra included, and the **LDAP browser** as its own integration; the **iHub** integration reduced to asking the user and scheduled tasks, project knowledge with projects; **group access** through `permissions.integrations` on groups (#3093, option B).

## Revision 2026-10-31

- **Integrations get a version, a compatibility range, release notes and their own migrations**, so an admin updates one integration from the marketplace without updating iHub and the update brings the installation along: [Integration Versioning and Migrations](../2026-10-31%20Integration%20Versioning%20and%20Migrations/README.md). Decided the same day: declarative-first, manual recovery after a failed migration (re-run, restore, uninstall), release notes as Markdown companion files per category referenced from `releases[]`, numbered config migrations stay for non-installation config, semver range.
- **An app binding can be optional.** `app.integrations[<id>].required` (default `true`) says whether the app is hidden while the installation is missing or disabled, as iFinder and Jira apps are, or stays available without that integration's actions, as an assistant with web search does. The web search binding defaults to optional; the check is the same `missingAppIntegrations` for every integration.
- **Remaining built-ins decided:** people directories become one installation per directory of a `com.intrafind/ldap-directory` definition, keeping the directory ids, with a binding by definition id replacing the `peopleDirectories` wildcard ("every installation, including later ones"); iHub's internal tools move into an always-installed `com.intrafind/ihub` singleton; cloud storage gets one singleton definition per provider configured through the generic wizard, and the dedicated editor goes.
- **Review decisions:** V193 writes skipped MCP servers to an unmigrated side file like V194; the Jira redirect URI stays derived from the request; migrated web search apps keep the model's native search; CKAN ships `strict: false` in iteration 1; the marketplace SSRF policy (a guard that admits the registry's own hosts and requires a public target otherwise) is follow-up [#3087](https://github.com/intrafind/ihub-apps/issues/3087).

## Revision 2026-10-30

- **CKAN Open Data Portal is the first catalog integration** and the walking skeleton for the platform: [concept, tests and draft definition](../2026-10-30%20CKAN%20Open%20Data%20Integration/README.md). It exercises definition with companion files, the `openapi` adapter (array parameters, envelope mapping, action defaults), scopes from an action, declarative Answer Sources, a declared health probe, the install wizard, the app binding and the marketplace type, without OAuth or migrations.

## Revision 2026-10-23

- **An integration owns its tools.** One Integrations page lists built-in integrations (iFinder, iAssistant, Web, Microsoft 365, Jira, iHub), integrations from the catalog and custom ones. Each action has a detail: what it does as the model sees it, side effect, data flow, approval, usage guidance, example prompts, and a test runner ([03 §6.5a, §6.8, §6.9](03-product-concept.md)).
- **Custom integrations replace the Tools page**: built from OpenAPI, MCP, A2A, an HTTP request template or a script, like Langdock's integration builder.
- **Approval follows #2945**: judged by side effect *and* data flow, opt-in at upgrade, admin floor, grants per call and per chat ([03 §7.4](03-product-concept.md), [04 §3](04-architecture.md)).
- **Projects** replaced sources on 2026-10-22; integrations feed them through `files` and `search`.
- New tickets: [#2973](https://github.com/intrafind/ihub-apps/issues/2973), [#2974](https://github.com/intrafind/ihub-apps/issues/2974), [#2975](https://github.com/intrafind/ihub-apps/issues/2975); #2945 joined the epic; #2916 rescoped.
