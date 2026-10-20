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

We propose one **integrations platform** with three layers, the shape every competitor has converged on: an **integration** (a versioned catalog entry, distributable through marketplace registries), an **installed integration** (the admin's instance: endpoint, auth mode, groups, action policy), and a **connection** (one user's or one group's credential). Protocols (MCP, OpenAPI, native code, A2A, storage, web search) become adapters behind one model. Admins get one sidebar section with a catalog, an install wizard generated from typed fields, group permissions and tool policy tiers. Users get one settings page that lists everything they may use with its true identity state, one picker in the chat composer, one connect card and one confirmation card for writes. The marketplace gains the item type `integration`, so IntraFind can ship the systems public directories lack (SharePoint on-prem, Jira and Confluence Data Center, DMS systems, SAP, Nextcloud, openDesk) as installable packages.

## How to read this folder

| Document | Answers |
| --- | --- |
| [01 · Current state](01-current-state.md) | What exists, where it diverges, what already points the right way |
| [02 · Market research](02-market-research.md) | How Langdock, Open WebUI, LibreChat, Dify, Claude, ChatGPT, Microsoft, Gemini, Glean, Perplexity and the managed-auth vendors do it; which standards fix the data model |
| [03 · Product concept](03-product-concept.md) | Vocabulary, personas, principles, admin and user journeys, chat UX, wireframes, decisions requested |
| [04 · Architecture](04-architecture.md) | Definition and instance formats, adapters, auth modes, approval gate, routes, client components, marketplace, migrations |
| [05 · Roadmap](05-roadmap.md) | Phases, risks, open questions |
| [mockups/integrations.html](mockups/integrations.html) | Clickable low-fidelity mockup of the admin catalog, install wizard, instance page, user settings page and chat picker |

## Goals

- One catalog, one install flow, one enable/configure model, one user-side list, one chat picker, one connect card, one confirmation card. Everything else is an adapter.
- Delegated identity by default; shared credentials explicit and visible.
- Admin enables, user connects, user picks: three decisions, three owners.
- Writes are confirmed by a human unless an admin relaxes it per integration; read actions never ask.
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
                                                                       (read: run · write: ask · destructive: ask)
```

## Decisions

The five product decisions in [03 · Product concept → Decisions](03-product-concept.md#10-decisions-this-concept-asks-for) were taken on 2026-10-20: vocabulary (Integration, Connection, Action), ask-by-default for writes, server-side chat state, marketplace type `integration`, clean break for the admin MCP and A2A routes. The team-level questions in [05 · Roadmap → Open questions](05-roadmap.md#open-questions-for-the-team) remain open.
