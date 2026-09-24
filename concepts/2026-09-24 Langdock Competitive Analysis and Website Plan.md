# Langdock Competitive Analysis and iHub Website Plan

_Date: 2026-09-24 · Status: analysis complete, website first draft in `website/`_

This document compares iHub Apps (v5.5.16) with Langdock (langdock.com, docs.langdock.com, crawled 2026-09-24), lists what iHub is missing and what iHub has that Langdock does not, and records the structure used for the new iHub marketing website in `website/`.

Related: `2026-09-15 SaaS Readiness — Multi-Tenant Platform Plan.md` (§4 competitor matrix) and `2026-02-27 iHub Workflows PRD.md` (§8 advantages over Langdock).

---

## 1. Executive summary

Langdock and iHub solve the same problem: one governed AI platform for a whole company, model-agnostic, with a catalogue of task-specific assistants, automation, knowledge access and admin controls. Langdock's **Agents** are iHub's **Apps**. Langdock's **Workflows**, **Skills**, **Prompt Library**, **MCP**, **API**, **Outlook add-in**, **Teams** surface and **model-agnostic chat** all have direct counterparts in iHub.

Where Langdock is ahead:

1. **Breadth of SaaS integrations** (72 native connectors, 754 actions, 20 integration triggers, 75-entry MCP directory) and the **Connections** model (per-user OAuth connections reused by agents and workflows).
2. **Managed knowledge**: Knowledge bases with embeddings, Folder Sync (SharePoint, Drive, OneDrive, Confluence), Company Knowledge federated search, Library, Projects.
3. **Commercial and governance layer**: cost in currency, spend limits at every level, Business/Business Max seats, agent governance (verify, highlight, compliance rules, evals, analytics), SAML, SCIM, ISO 27001, SOC 2 Type II.
4. **Surfaces**: Slack bot, Teams bot, Excel add-in, native desktop app, iOS/Android apps.
5. **Consumer-grade chat polish**: Memory, Scheduled tasks, Deep Research pipeline, Document Editor with code preview, Data Analyst, image models selector, Auto model router.
6. **Docs and go-to-market**: 303-page bilingual docs with three persona tabs, changelog, product tour, case studies, partner programme, AI Adoption Playbook, webinars.

Where iHub is ahead:

1. **Deployment freedom**: single binary, Docker, Windows service, air-gapped, on-prem at any size (Langdock: on-prem only from 5,000 seats, Kubernetes/Helm only). Zero-config first run, no database.
2. **Enterprise identity depth**: LDAP, NTLM, proxy/JWT, ADFS, multiple OIDC providers at once, iHub as OIDC IdP and OAuth authorization server, personal API keys that act as the user.
3. **MCP in both directions** (client and OAuth-gated gateway for Claude, Cursor, VS Code) plus an experimental A2A endpoint; **OpenAPI tool import**; app-as-tool; workflow-as-tool.
4. **Apps as a product**: 24 shipped apps, 43 examples, marketplace, input variables, starter prompts, structured output with custom JSX renderers, app inheritance, iframe/redirect apps, per-group rollout with external group mappings.
5. **Audit-grade document analysis**: quote validation, structured records, templated reports, corpus completeness workflows for public sector and legal.
6. **Observability**: OpenTelemetry with GenAI conventions, run ledger, change history with diffs, audit log, Prometheus.
7. **Enterprise search lineage**: iFinder and iAssistant as first-class knowledge sources with per-user permissions, instead of a bolt-on vector store.
8. **Open source** with a BSD-style licence, IntraFind GPU hosting in German data centres as an option.

Bottom line: iHub is a stronger **platform** (deploy anywhere, identity, protocols, governance of apps by group). Langdock is a stronger **product** (integrations, knowledge, polish, packaging, docs). The gap list in §6 is what closes the product side.

---

## 2. Concept mapping

| Langdock | iHub | Notes |
| --- | --- | --- |
| Chat | Chat app (`chat`) + any app | iHub has no separate "chat" product; the general chat is an app |
| Agents (formerly Assistants) | Apps | Same idea: instructions, knowledge, tools, sharing, versioning. iHub adds variables, structured output, renderers, inheritance |
| Agent Builder (conversational) | App Creation Wizard with AI generation | Both generate configuration from a description |
| Agent templates library | Marketplace + `examples/apps` | Langdock: 36 templates in 14 categories, searchable in-product |
| Subagents | App-as-tool (`app__<id>`) | iHub forbids app-to-app nesting beyond one level |
| Skills (SKILL.md, System Skills, workspace-mandated) | Skills (agentskills.io standard) | iHub lacks system skills (PDF/DOCX/XLSX/PPTX generation) and mandated skills |
| Workflows (visual builder, 13 nodes, 5 triggers) | Workflows (visual editor, 26 node types, 3 triggers) | iHub lacks form, integration triggers, guardrails, delay, notification, image-gen nodes and cost badges |
| Autonomous scheduled agents | Agent Factory (profiles, inboxes, memory, approvals) | Langdock has no equivalent to the Agent Factory runtime; its "Scheduled tasks" are simpler |
| Integrations + Connections + Actions | Tools (script, OpenAPI, MCP) + Integrations (Jira, O365, Drive, Nextcloud) + Credentials | iHub has the primitives but far fewer ready connectors |
| MCP (client), Langdock MCP server, MCP Apps | MCP client + MCP gateway (OAuth, DCR, CIMD) | iHub gateway is more complete; Langdock has MCP-UI support |
| Knowledge bases / Folder Sync / Library / Projects / Company Knowledge | Sources (filesystem, URL, iFinder, page) | iHub has no embeddings, sync, folders or projects; relies on iFinder for semantic retrieval |
| Prompt Library (folders, variables, sharing) | Prompts (categories, per-app scope, variables) | Parity, minus folders |
| Document Editor (ex Canvas) | Canvas (Quill) | Langdock adds code artifacts with live preview, version history, export to Drive/SharePoint |
| Memory | — | Not in iHub |
| Scheduled tasks (per user) | Workflow cron triggers, Agent Factory schedules | iHub has scheduling for admins/creators, not for end users in chat |
| Deep Research | Web chat with native search + research workflows | Langdock has a productised 3-model pipeline with PDF export |
| Auto mode (model router) | — | Not in iHub |
| BYOK, EU-hosted default models | Providers + per-model encrypted keys, local vLLM | iHub is BYOK by design |
| Business / Business Max seats, Extra Usage, spend limits | Usage reports (tokens), no currency, no limits | Gap |
| Roles (Member/Editor/Admin + 5 custom) | admin, content admin, groups | Gap: custom roles |
| SAML, SCIM, IP restrictions, static IP | OIDC, LDAP, NTLM, proxy, JWT | Gap: SAML, SCIM, IP allowlist |
| Governance add-on (verify, compliance rules, evals) | Groups, change history, audit log | Gap: agent verification, compliance rules, evals |
| Slack bot, Teams bot | Teams tab (no bot) | Gap |
| Excel add-in, Outlook add-in | Outlook add-in | Gap: Excel |
| Desktop app, iOS/Android | PWA, browser extension | Gap: native apps; Langdock lacks a browser extension |
| Analytics (DAU/WAU/MAU, leaderboards, agent analytics, feedback CSV) | Usage reports, feedback page | Partial |
| Get Started guide (gamified onboarding) | Setup wizard, What's New | Gap: end-user onboarding |
| Trust center (Vanta), ISO 27001, SOC 2 Type II, DPA | Security guide, PII handling docs | Gap: certifications, public trust page |

---

## 3. Langdock marketing site structure (what the iHub site mirrors)

Site: Webflow, EN + DE mirror. One nav, one footer, a trust-badge strip and a free-trial CTA block on every page.

**Top navigation**

- Platform (mega menu): Chat, Workflows, Agents, Integrations, API, Models, Watch product tour; "Coming soon": Apps, Meetings, Code, Cloud
- Learn: Documentation, Events, Customer stories, Changelog, Trust center, AI Adoption Playbook
- About: About us, Careers, Blog (placeholder), Press
- Plain links: Security, Enterprise, Pricing
- CTAs: Sign in, Talk to sales, Get started

**Homepage sections, in order**

1. Hero: "The Platform for AI Adoption", two CTAs, product-tour link, hero screenshot of chat
2. Logo bar: "Trusted by over 10,000 companies"
3. Customer testimonial with video link
4. Product grid (5 cards): Chat, Workflows, Agents, Integrations, API
5. Platform pillars (6 cards): Model agnostic, Security-first, Customizable, Enterprise-ready, Deployable anywhere, Interoperability built-in
6. Resources (2 cards): AI Adoption Handbook, product tour
7. Customer video stories (5 cards)
8. Final CTA: free trial, talk to sales
9. Trust strip: ISO 27001 & SOC 2 Type II, Deployable anywhere, GDPR / EU deployment
10. Footer: Platform, Learn more, Company, Languages, Legal

**Product page template**: eyebrow → "Langdock [Product]" H1 → subline → 2 CTAs → logo bar → alternating feature sections (heading, 1-2 sentence copy, screenshot) → FAQ accordion → cross-sell grid of the other products → free-trial CTA → trust strip.

**Per product page**

- Chat: department tabs (Sales, Marketing, HR, Finance, Engineering, Operations) → 4 bento cards (model agnostic, company knowledge, files, image generation) → web search & deep research → voice → canvas, `@` references, spreadsheets → mobile → FAQ
- Agents: hero (builder with live preview) → template library grid → 4 cards (instructions, capabilities, knowledge, trigger options) → collaborate (share, Slack & Teams) → FAQ
- Workflows: department tabs with templates → 7 cards (AI-native builder, agent block, 50+ integrations, field modes, deploy, versioning, run history) → FAQ
- Integrations: "57 integrations, 754 actions" → 3 pillars (native, custom, MCP) → alphabetical catalogue with actions/triggers → FAQ
- API: "One API. All models." → 4 cards (Completion, Embedding, Agent, Knowledge folder) → model price table → FAQ
- Models: provider filter tabs, table of model, price in/out, region flag
- Security: certifications → deployment options (multi-tenant, single-tenant, BYO cloud, on-prem) → data foundations → architecture → compliance → BYOK → governance → legal → FAQ
- Enterprise, Pricing (users slider, monthly/annual, models included vs BYOK; Chat & Agents base, Workflows add-on, Governance add-on, API usage), Desktop, Mobile, Case studies, Partners, Events, Changelog, About, Careers, Press, Brand kit, Contact

---

## 4. Langdock documentation structure

Platform: Mintlify. EN and DE with full parity, 303 pages per language. Three persona tabs instead of persona cards on the landing page.

| Tab | Groups | Pages |
| --- | --- | --- |
| Using Langdock | Get Started, Chat (+ Tools), Skills, Library, Agents, Workflows (Fundamentals, Node Types, Triggers, Guides), Integrations (+ MCP), Desktop app, Microsoft Add-ins, Models & Limits, Guides (Use cases, Agents, Knowledge, Integrations, Skills, Library, Chatbots, Prompt Engineering), Account, Resources, Troubleshooting/FAQ | 129 |
| Developer | Overview, Completion API, Embedding API, Agents API, Integrations API, Skills API, Knowledge Folder API, Prompt Library API, Usage Export API, Workflow Run Export API, User Management API, Audit Logs API | 79 |
| Admin | Workspace, Manage Agents, Manage Workflows, Manage Integrations (setup guides, Microsoft scopes, chatbots, add-ins), Manage Usage, BYOK, Governance, Compliance & Governance, AI Adoption & Rollout, Security (SAML, SCIM), Billing | 95 |

Presentation conventions worth copying: every page has a one-sentence description; most end with an FAQ accordion; admin pages start with an "available to workspace admins" info box; API pages are generated from an OpenAPI spec with method badges; screenshots in frames; step lists; tabs for Mac/Windows and Cloud/Dedicated; short videos for workflow basics; a Feature Overview page; a Dictionary; a Cheat Sheet; a full prompt-engineering curriculum; an AI Adoption & Rollout section for admins.

**iHub docs today**: one mdBook with a single flat sidebar (Getting Started, Configuration, Authentication & Security, Features, Operations, Development & Deployment, Accessibility, FAQ), ~110 pages, English only for most pages, no per-page description, no FAQ blocks, no videos, a Swagger UI at `/api/docs` that is not linked from the docs. Strong on operations and auth, weak on end-user "how do I" content and on task-oriented guides.

**Recommended restructuring** (proposal, not implemented in this change):

- Three top-level parts: **Using iHub** (end users), **Admin** (configuration, governance, rollout), **Developer** (API, SSE v2, MCP gateway, tools, renderers, React pages, migrations).
- Move end-user content out of `user-guide.md` into per-feature pages: Chat basics, Files & uploads, Voice, Canvas, Compare mode, Prompt library, Chat history, Export, Sharing (short links), Outlook add-in, Browser extension, Nextcloud, Teams.
- Add an **AI Adoption & Rollout** section (use-case identification, department playbooks, internal comms) — iHub has the material in `concepts.md` and the FAQ.
- Add a **Feature Overview**, a **Dictionary** (Provider, Model, App, Skill, Source, Tool, Prompt, Group, Workflow, Agent) and a **Cheat Sheet**.
- Generate the API section from the existing Swagger specs and link it.
- Add a one-sentence description and an FAQ block per page; add German for the user tab first.

---

## 5. Feature comparison by area

Legend: ✅ available · ⚠️ partial or preview/off by default · ❌ not available.

### 5.1 Chat

| Capability | Langdock | iHub |
| --- | --- | --- |
| Model switcher per chat, mid-conversation | ✅ + Auto mode router | ✅ (no router) |
| Thinking / reasoning levels visible | ✅ | ✅ |
| File upload (PDF, Office, images, audio, video) | ✅ up to 256 MB, 50 files | ✅ browser-side parsing, Office, MSG/EML, VTT, video audio extraction |
| Cloud file pickers | via integrations | ✅ Google Drive, Office 365, Nextcloud |
| Web search with citations | ✅ | ✅ native (Google, OpenAI, Anthropic) + Brave, Staan, Qwant |
| Deep Research pipeline with PDF export | ✅ | ⚠️ research workflows, no productised pipeline |
| Company Knowledge federated search | ✅ 11 sources | ⚠️ iFinder / iAssistant only |
| Image generation with model selector | ✅ several image models | ⚠️ Gemini / Nano Banana only |
| Vision | ✅ | ✅ |
| Voice input | ✅ | ✅ browser, Azure Speech, vLLM realtime (Voxtral) |
| Voice output / speech-to-speech | ❌ | ❌ |
| Document Editor / Canvas | ✅ docs + code with live preview, versions, export to Drive/SharePoint | ⚠️ Quill canvas with AI actions |
| Data analyst (charts from spreadsheets) | ✅ | ❌ |
| Mermaid diagrams | ✅ | ✅ + SVG/PNG/PDF export |
| Structured output + custom renderers | ❌ | ✅ unique |
| Magic prompt (rewrite input) | ❌ | ✅ |
| Compare two models side by side | ❌ | ✅ (preview flag) |
| Memory | ✅ | ❌ |
| Projects / folders | ✅ | ❌ |
| Scheduled tasks from chat | ✅ | ❌ (workflow cron only) |
| `@` mentions of agents, integrations, skills, prompts, workflows | ✅ | ⚠️ workflows and prompts only |
| Share chat by link | ✅ workspace + support | ❌ (short links share the app, not the chat) |
| Chat history, server-side, resume after tab close | ✅ | ✅ Durable Chats (preview flag) |
| Incognito / ephemeral chats | ⚠️ retention policy | ✅ per app and per chat |
| Feedback on answers | ✅ thumbs | ✅ star rating + comment, admin review |
| Export | PDF, docs export | ✅ PDF (3 templates, watermark), DOCX, PPTX, XLSX, MD, HTML, JSON |
| Ask-user clarification UI | ❌ | ✅ chips, dropdowns |
| Context-window indicator | ✅ | ✅ |
| Keyboard command palette | ✅ Cmd+K | ✅ Cmd+K (admin), search |
| Dark mode, mobile responsive, PWA | ✅ | ✅ |

### 5.2 Agents (Langdock) vs Apps (iHub)

| Capability | Langdock | iHub |
| --- | --- | --- |
| Instructions, icon, name, description, starters | ✅ | ✅ + greeting, styles, temperature, output format |
| Form input with typed fields | ✅ 9 field types | ✅ variables (string, text, select, predefined values) |
| Knowledge attachment | ✅ files, folders, sync, knowledge bases, vector DBs | ⚠️ sources (files, URLs, iFinder, pages), prompt or on-demand |
| Tools / actions | ✅ 754 actions, MCP, skills, sub-agents, workflows | ✅ script tools, OpenAPI import, MCP, skills, app-as-tool, workflow-as-tool |
| Conversational builder | ✅ | ✅ wizard with AI generation |
| Templates in product | ✅ 36 | ⚠️ marketplace (preview), 43 examples in repo |
| Sharing | users, groups, workspace; view/edit | ✅ groups with inheritance and external mappings; content admins |
| Draft/publish versioning with release notes | ✅ | ⚠️ change history with diffs, no draft/publish |
| Analytics per agent | ✅ | ⚠️ usage by app |
| Evals | ✅ | ❌ |
| Verified badge, highlight, pin, labels, archive | ✅ | ⚠️ enabled flag, order, category, favourites |
| Per-agent monthly limit | ✅ | ❌ |
| Structured output schema + renderer | ❌ | ✅ |
| App inheritance (parent/child) | ❌ | ✅ |
| Iframe / redirect apps | ❌ | ✅ |
| Portable as JSON | via API | ✅ download/upload JSON |
| Distribution | Langdock UI, Slack, Teams, API, MCP server, A2A | iHub UI, Outlook, browser extension, Nextcloud, Teams tab, OpenAI-compatible API, MCP gateway, A2A (experimental) |

### 5.3 Workflows and autonomous agents

| Capability | Langdock | iHub |
| --- | --- | --- |
| Visual editor | ✅ + conversational builder, import from other tools | ✅ xyflow editor, loop containers, variables panel |
| Node types | 13 (Agent, Action, Web Search, File Search, HTTP, Condition, Loop, Code JS/Python, Guardrails, Delay, Notification, Image Gen, Output) | 26 (start, end, prompt, tool, decision, parallel, join, human, transform, memory, planner, verifier, loop, http, code JS, query-plan, corpus-search, structured-record, quote-validator, template-render, progress, inbox/memory nodes) |
| Triggers | Manual, Form (public), Webhook, Scheduled, Integration events (~20 apps) | Manual, cron with timezone, HMAC webhook |
| Field modes (manual / AI / auto) | ✅ | ⚠️ per-node prompts |
| Human in the loop | ✅ approvals from Monitor | ✅ human node, approvals queue, ask-user |
| Versioning | ✅ draft + published | ✅ draft/published, version list |
| Run history, replay, per-node test | ✅ | ✅ executions, export, restart, cancel, crash resume |
| Cost per node/run, spend limits, alerts | ✅ | ❌ |
| Composable workflows (sub-workflows, multiple triggers) | ✅ (Sep 2026) | ⚠️ workflow-as-tool |
| Guardrails node (PII, jailbreak, hallucination) | ✅ | ❌ |
| Autonomous agents with memory, inboxes, budgets, verifier, operator steering | ❌ | ✅ Agent Factory (preview) |
| Run as chat tool / `@` mention | ✅ | ✅ |
| Public form trigger | ✅ | ❌ |

### 5.4 Knowledge

| Capability | Langdock | iHub |
| --- | --- | --- |
| Embedding search / knowledge bases | ✅ up to 1,000 files | ❌ (delegated to iFinder / iAssistant) |
| Folder sync from SharePoint, Drive, OneDrive, Confluence | ✅ daily | ❌ (file pickers only) |
| External vector DBs (Qdrant, Pinecone, Milvus, Azure AI Search, Vertex) | ✅ | ❌ |
| Enterprise search with per-user permissions | via Company Knowledge connectors | ✅ iFinder (JWT/OIDC identity), iAssistant grounded RAG |
| URL sources with cleaning and TTL | ⚠️ | ✅ |
| Prompt vs on-demand exposure of a source | ❌ | ✅ |
| Library (templates, recent files, folders) | ✅ | ❌ |
| Knowledge folder API | ✅ | ❌ |

### 5.5 Integrations, protocols and surfaces

| Capability | Langdock | iHub |
| --- | --- | --- |
| Native connectors | 72 (CRM, PM, comms, docs, BI, dev, HR, ITSM, RPA, vector DBs) | Jira, Microsoft Entra people search, iFinder, iAssistant, Office 365 files, Google Drive files, Nextcloud files, web search providers, screenshots |
| Custom connectors | JS sandbox actions/triggers, Action Builder Agent, Integrations API | OpenAPI import (any spec), script tools, MCP |
| Per-user OAuth connections reused by agents | ✅ | ⚠️ Jira OAuth per user, central credentials store |
| MCP client | ✅ + MCP Apps UI, directory of 75 servers | ✅ |
| MCP server | ✅ 3 tools (find/ask agent) | ✅ full gateway: tools, apps, workflows, resources; OAuth, DCR, CIMD, per-client approval |
| A2A | ✅ | ⚠️ experimental |
| Slack bot / Teams bot | ✅ / ✅ | ❌ / ❌ (Teams personal tab only) |
| Outlook add-in / Excel add-in | ✅ / ✅ | ✅ / ❌ |
| Browser extension | ❌ | ✅ Chrome, Edge, Firefox |
| Nextcloud app | ❌ | ✅ |
| Desktop app / mobile apps | ✅ / ✅ | ❌ / PWA |
| Zapier | via MCP | ❌ |

### 5.6 Models and API

| Capability | Langdock | iHub |
| --- | --- | --- |
| Providers | OpenAI, Anthropic, Google, Meta, Mistral, DeepSeek, Flux; BYOK for Azure, Bedrock, Gemini, Mistral, DeepSeek, Perplexity, Vercel, OpenAI-compatible | OpenAI (Chat + Responses), Anthropic, Google, Mistral, AWS Bedrock (Claude, Nova, Llama, Mistral, Cohere, Jamba, DeepSeek), Azure OpenAI, any OpenAI-compatible (vLLM, LM Studio, Jan, Ollama, llama.cpp), iAssistant |
| EU-hosted managed models | ✅ default | ⚠️ IntraFind-hosted GPUs in German data centres as a service, or self-host |
| Model auto-discovery | ❌ | ✅ `/v1/models` |
| Model hints (data classification banners) | ❌ | ✅ |
| Embeddings API | ✅ | ❌ |
| OpenAI-compatible completions API | ✅ + Anthropic, Google, Mistral compatible | ✅ OpenAI-compatible, permission-filtered |
| Agent/App API | ✅ create, update, publish, chat | ✅ apps chat API, runs API, SSE v2 |
| Knowledge, Prompts, Skills, Integrations, Usage export, Audit log, User management APIs | ✅ | ⚠️ prompts, skills, workflows, agents, admin APIs exist; no usage-export or user-management public API documented |
| Swagger / OpenAPI published | ✅ | ✅ `/api/docs` (3 specs) |
| Rate limits per key/user | ✅ 500 RPM, 150k TPM | ⚠️ per IP |
| Cookbook repository | ✅ | ❌ |

### 5.7 Admin, governance, security, compliance

| Capability | Langdock | iHub |
| --- | --- | --- |
| SSO | SAML 2.0 (Entra, Google, Okta), domain join, magic link | OIDC (multi-provider), LDAP, NTLM, proxy/JWT, ADFS, Teams SSO, local |
| SCIM provisioning | ✅ | ❌ |
| Roles | Member, Editor, Admin, 5 custom roles, group roles | admin, content admin, groups with inheritance |
| Product access control per product | ✅ | ⚠️ feature flags global, permissions per app/model/prompt/skill/tool/workflow per group |
| IP allowlist, static egress IP, force logout | ✅ | ⚠️ outbound proxy, SSRF allowlist; no IP allowlist |
| Usage analytics | DAU/WAU/MAU, leaderboards, per-agent, CSV exports, API | tokens by app/model/user, CSV/JSON, pseudonymous mode |
| Cost in currency, spend limits, fallback model on cap | ✅ | ❌ |
| Audit log | ✅ API, 90 days | ✅ JSONL, filters, retention, Winston mirror |
| Change history with diffs | ❌ | ✅ |
| Backup & restore, self-update with rollback | – SaaS | ✅ |
| OpenTelemetry / Prometheus | ❌ | ✅ |
| Data retention controls | ✅ 7d to forever | ✅ chats, audit, usage, feedback |
| Encryption of secrets at rest | ✅ | ✅ AES-256-GCM |
| Certifications | ISO 27001, SOC 2 Type II, pen tests, Vanta trust center, DPA | ❌ (software; runs inside the customer's certified environment) |
| Agent governance (verify, compliance rules, evals, auto-archive) | ✅ add-on | ❌ |
| In-product changelog | ❌ (website) | ✅ What's New |
| Accessibility statement | ❌ | ✅ WCAG 2.2 AA target, axe in CI |
| White-label branding | colour, logo, background, disclaimers, 4 nav links | ✅ full ui.json, theme CSS, pages, PWA, error pages |
| Localization | EN/DE UI, docs EN/DE | EN/DE UI with overrides; docs mostly EN |

### 5.8 Deployment and commercial

| | Langdock | iHub |
| --- | --- | --- |
| Delivery | SaaS (Azure EU); single-tenant from 2,000 seats; BYO cloud and on-prem (Helm) from 5,000 | Binary, Docker, npm, Windows service, Kubernetes notes; any size |
| Database | managed | none (JSON under `contents/`), pluggable storage interface |
| Scaling | managed | multi-worker cluster, multi-server with sticky LB and shared volume |
| Pricing | Trial; Business €25 or Business Max €99 per user/month; Workflows €539/€1,199 per month; Governance €2.80–3.50 per user; API per token; Enterprise custom | Open source, free; IntraFind support, hosting and services on request |
| Trial | 7 days, no card | run locally in 60 seconds |

---

## 6. Gap list for iHub

Prioritised by expected impact on the buying decision in iHub's market (German mid-market and public sector) and by how far the existing runtime already carries the feature.

### P0 — closes the biggest visible gaps

1. **Cost and limits**: price per model, cost per run/chat/app in currency, spend limits per group/user/app/workflow, alerts, fallback model on cap. The run ledger already has the raw data.
2. **Knowledge bases with embeddings and folder sync** for customers without iFinder: upload, index, semantic search, SharePoint/OneDrive/Google Drive/Confluence sync, per-source permissions. Keep iFinder as the enterprise tier.
3. **Connections model and a connector catalogue**: per-user OAuth connections (Microsoft 365 Graph, Google Workspace, Atlassian, Slack, GitHub, HubSpot, Salesforce, ServiceNow, SAP), reusable by apps and workflows; an in-product integrations directory with actions and triggers. OpenAPI import and MCP already cover the long tail.
4. **Share a chat by link** (workspace and support), plus **projects/folders** for chats and files.
5. **SAML 2.0 and SCIM 2.0**, custom admin roles, IP allowlist.
6. **Slack and Teams bots** (message-based access to apps), **Excel add-in**.

### P1 — product polish Langdock sells hard

7. Workflow additions: form trigger (public forms), integration event triggers, guardrails node (PII, jailbreak, hallucination), delay, notification, image-generation node, per-node cost badges, conversational workflow builder.
8. App lifecycle: draft/publish with release notes, per-app analytics and feedback export, verified/highlighted badges, labels, archive, per-app usage limits, evals with test sets.
9. Chat polish: memory, scheduled tasks for end users, deep-research pipeline with PDF export, data analyst (charts from spreadsheets), image model selector, Auto model routing, `@` mentions for apps/tools/sources/skills.
10. Document Editor upgrade: code artifacts with live preview, version history, export to SharePoint/OneDrive/Google Drive, LaTeX.
11. System skills that generate DOCX/XLSX/PPTX/PDF, workspace-mandated skills, skill creator.
12. End-user onboarding: Get Started guide, prompt recommendations, info boxes, department playbooks.

### P2 — go-to-market and packaging

13. Public website (this change), trust page, certifications roadmap (ISO 27001 for the hosted offer), DPA template, sub-processor list.
14. Docs: three persona tabs, German user docs, FAQ blocks, videos, Feature Overview, Dictionary, Cheat Sheet, API reference from Swagger, Rollout playbook, cookbook repo.
15. Native desktop and mobile apps (PWA covers most of it today).
16. Templates and case studies in product and on the website; partner directory; events/webinars.

### What not to copy

- Per-seat SaaS pricing as the only model; iHub's open-source and on-prem story is the differentiator.
- A separate "Governance add-on"; ship governance in the core.
- Dropping the browser extension, Nextcloud app or LDAP/NTLM; Langdock has none of them and mid-market customers ask for them.

---

## 7. Claims to fix before publishing marketing copy

Found while cross-checking README and docs against the code:

1. README lists **DuckDuckGo** search; the code has Brave, Qwant, Staan and native provider search (Tavily removed in migration V063).
2. README lists **DALL-E / Stable Diffusion**; only Gemini / Nano Banana image generation is implemented.
3. `docs/web-tools.md` documents `deepResearch`, `researchPlanner`, `evaluator`, `answerReducer`, `queryRewriter`, which no longer exist (V086).
4. "30+ apps" is 24 shipped (15 enabled) + 43 examples + marketplace. The website says "30+ ready-made apps and examples".
5. README badge says **MIT**; `LICENSE` is BSD 3-Clause with mandatory attribution. The website says "open source (BSD-3-Clause with attribution)".
6. Headline features that are preview flags and off by default: Workflows, Agents, Skills, Marketplace, Durable Chats, OCR, Compare Mode, Run Ledger. The website marks them as "preview".
7. `ui.json` footer still says "© 2025".

---

## 8. iHub website plan (`website/`)

Static HTML/CSS, no build step, deployable to GitHub Pages or any web server, EN only for the first cut (DE toggle reserved). Structure mirrors Langdock one-to-one; every screenshot is a real capture of iHub 5.5.16 running against a mock OpenAI-compatible model (see §9).

| Langdock page | iHub page | Hero screenshot |
| --- | --- | --- |
| `/` | `index.html` | Chat with a streamed answer |
| `/products/chat` | `chat.html` | Chat, model selector, email composer, summariser, research answer, mermaid, canvas, dark mode, mobile |
| `/products/agents` | `apps.html` | App editor, apps catalogue, marketplace, share modal, email composer form |
| `/products/workflows` | `workflows.html` | Workflow editor, workflows list, executions, agents, approvals |
| `/products/integrations` | `integrations.html` | Integrations hub, MCP servers, MCP gateway, tools, sources, Outlook, browser extension, Nextcloud |
| `/products/api` | `api.html` | Swagger UI, OAuth server, OAuth clients |
| `/models` | `models.html` | Models list, providers, model editor |
| `/security` | `security.html` | Authentication, groups, security settings, audit log, telemetry, usage |
| `/enterprise` | `enterprise.html` | Admin overview, backup, updates, features |
| `/pricing` | `pricing.html` | – |
| `/changelog` | `changelog.html` | – (generated from `docs/releases/`) |
| `docs.langdock.com` | `docs.html` | – (7 product cards linking into the mdBook) |

Shared elements on every page: sticky nav with a Platform mega menu, Learn menu, Security, Enterprise, Pricing, GitHub and "Get started" CTA; a trust strip (open source, deploy anywhere, GDPR / EU); a final CTA block ("Run iHub in 60 seconds"); footer with Platform, Learn, Company, Legal columns.

Copy rules: no invented customers, logos, numbers or certifications. Numbers come from the repo (24 shipped apps, 43 examples, 8 provider adapters, 26 workflow node types, 18 tools, 124 config migrations, EN + DE). Preview features are labelled.

---

## 9. How the screenshots were produced

- `npm run install:all`, server on :3000, Vite client on :5173.
- A 90-line mock OpenAI-compatible server on :8080 streams canned Markdown answers (email, summary, research with citations, Mermaid, overview). All text models in `contents/models/` were pointed at it with `provider: "openai"`, `OPENAI_API_KEY` set to a dummy value.
- Preview flags enabled in `contents/config/features.json`: skills, workflows, marketplace, agentFactory, appAsTool, runLog, chatPersistence, compareMode.
- `platform.setup.configured = true` to skip the first-run wizard; disclaimer acknowledgement pre-seeded in `localStorage`.
- Playwright (server's `playwright` package, Chromium from `/opt/pw-browsers`) at 1440×900 @2x and 390×844 @3x, logged in as `admin` / `password123`.
- Images are stored under `website/assets/screenshots/` as optimised PNG.

---

## Sources

- https://www.langdock.com (homepage, `/products/*`, `/models`, `/pricing`, `/security`, `/enterprise`, `/case-studies`, `/changelog`, `/partners`, `/about-us`, sitemap)
- https://docs.langdock.com (`llms.txt`, `llms-full.txt`, `openapi.yaml`, rendered pages)
- https://europe.langdock.com, https://trust.langdock.com
- iHub repository at v5.5.16: `README.md`, `docs/`, `server/defaults/`, `server/featureRegistry.js`, `server/adapters/`, `client/src/features/`, `concepts/`
