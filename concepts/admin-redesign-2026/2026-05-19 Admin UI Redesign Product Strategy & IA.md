# Admin UI Redesign — Product Strategy & Information Architecture

**Document type:** PRD-style strategy brief
**Author:** Product Strategy
**Date:** 2026-05-19
**Status:** Draft for review (to be combined with UX wireframe proposal)
**Audience:** Product, Design, Engineering leads on iHub Apps platform

---

## 0. Executive Summary

iHub Apps' admin surface has organically grown to 30+ top-level pages crammed into a flat tab nav with a 20-item "More" dropdown. Admins of all experience levels — from first-time platform owners to seasoned content curators — share the same monolithic role and the same unstructured home screen. The platform has effectively outgrown its navigation.

This proposal redefines the admin as a **task-oriented workspace** rather than a list of CRUD pages. We recommend:

1. **Consolidating** 30+ routes into **6 top-level sections** organized by what admins are trying to accomplish, not how the data is stored.
2. **Replacing** the launcher-style dashboard with a true **operations home** that surfaces health, alerts, recent activity, and a setup checklist for fresh instances.
3. **Phasing** the work in three releases — nav restructure (4 weeks), flow consolidation (8 weeks), and sub-roles + enterprise table-stakes (10 weeks) — so we ship perceived value within a month.
4. **Deferring** sub-admin roles to Phase 3, because splitting permissions before stabilizing IA risks fragmenting the user model twice.
5. **Adding** five table-stakes capabilities expected by enterprise buyers: command palette, admin audit log, global search, dry-run for risky changes, and bulk import/export.

Backend endpoints already cover every use case described here. This is a UI/IA initiative, not a platform refactor.

---

## 1. Admin Personas

We propose five working personas. They are **role archetypes** that real users blend in different proportions — the platform should accommodate the blend without forcing the split.

| # | Persona | Primary mission | Top tasks | Frequency |
|---|---------|-----------------|-----------|-----------|
| 1 | **Platform Owner** | Stand up and steward the instance | 1. Initial install: providers, auth, first apps<br>2. Major version upgrades & backup verification<br>3. Feature-flag rollouts<br>4. License/SSL/encryption hygiene<br>5. Capacity planning | Weekly at first, then monthly |
| 2 | **Identity & Security Admin** | Control who can do what | 1. Onboard a business unit (users + groups)<br>2. Configure/rotate SSO (OIDC, NTLM, OAuth)<br>3. Rotate compromised API keys/secrets<br>4. Audit privileged access<br>5. Respond to access incidents | Daily/weekly |
| 3 | **Content & AI Admin** | Curate the AI app catalog | 1. Create and publish new AI apps<br>2. Tune prompts/variables<br>3. Manage models, tools, sources<br>4. Manage prompt library + global variables<br>5. Promote/retire apps across groups | Daily |
| 4 | **Integrations Admin** | Connect iHub to external systems | 1. Connect Office365 / GDrive / Nextcloud / Jira<br>2. Provision OAuth clients for downstream apps<br>3. Install/configure browser extension and Outlook add-in<br>4. Configure CORS for embedding | Project-based (bursty) |
| 5 | **Observability / SRE** | Keep it running, prove its value | 1. Investigate failed chats or auth errors<br>2. Pull monthly usage reports for finance/leadership<br>3. Tune log levels during incidents<br>4. Monitor token spend by app/user<br>5. Verify telemetry pipeline | Daily during incidents, weekly otherwise |

### Are these realistic separations today?

**No — and that's important.** In current iHub Apps installations the same human typically wears 3–5 of these hats. The personas guide **information architecture and dashboard widgets**, not (yet) role assignments. We recommend treating personas as a **lens for grouping pages** and a **future basis for sub-roles** (Phase 3), not as a permission system to ship immediately.

---

## 2. Job-to-be-Done Analysis

The top 10 admin JTBDs, ranked by combined frequency × business criticality. The "Click cost" column is rough today vs. target; the "Crosses pages" column is the critical signal for redesign.

| # | Job to be done | Today: pages involved | Clicks today | Crosses pages | Phase 2 target |
|---|----------------|----------------------|--------------|----------------|-----------------|
| 1 | **Onboard a new business unit** (create group, map external IdP, set app/model permissions, invite users) | Groups → Users → Authentication (mappings) → Apps (allowedGroups) → Models | 30+ | Yes (5) | Guided "Onboard Group" wizard |
| 2 | **Rotate a leaked API key** (rotate at provider, update in iHub, verify all dependent apps still work) | Providers → Models (per affected model) → Apps (smoke check) → Logs | 20+ | Yes (4) | "Rotate Key" flow with affected-resource preview + dry-run |
| 3 | **Publish a new AI app to all users** (create app, attach model, attach tools/sources, set permissions, test, enable) | Apps → Models → Tools → Sources → Prompts → Groups | 25+ | Yes (6) | Single "Publish App" wizard with side-panel for tools/sources/perms |
| 4 | **Audit who used GPT-4 this month** | Usage Reports → (manually filter) | 6–10 | No (1) but data is shallow | Saved report + drilldown to user/app |
| 5 | **Set up enterprise SSO** (e.g., OIDC) | Authentication → OAuth Hub → OAuth Server → OAuth Clients → Groups (mappings) → Users (test) | 25+ | Yes (5+) | "Connect SSO" wizard; OAuth hub absorbs subpages |
| 6 | **Connect a new integration** (e.g., Office365) | Integrations Hub → Office365 page (also reachable directly) → Authentication (if OAuth needed) → Sources (knowledge base) | 15+ | Yes (3–4) | One canonical integrations card-detail pattern, no legacy direct routes |
| 7 | **Diagnose a chat failure** | Logging → (filter by app/user) → Usage Reports → Apps (config check) → Models (provider status) | 15+ | Yes (4) | Unified "Monitoring" tab with cross-linked timelines |
| 8 | **Backup before a risky change** | System (Backup section) → execute → verify | 5–8 | No, but buried | Promote to Platform → Backups; add restore-test |
| 9 | **Toggle a feature flag** (e.g., enable Workflows for a pilot group) | Features → Groups (assign) | 5–10 | Yes (2) | Inline flag toggle on Group detail; flags also remain in Platform → Features |
| 10 | **Bulk update apps** (e.g., switch 12 apps to a new model) | Apps (one by one) | 24+ | No (1) but no bulk action | Bulk-select + bulk-edit in Apps |

**Insight:** 7 of the top 10 JTBDs cross 3+ pages today. Three of them (onboard BU, rotate key, publish app) are good candidates for **dedicated guided flows** even if the underlying CRUD pages remain unchanged. The remaining four collapse naturally into the proposed IA.

---

## 3. Proposed Top-Level Information Architecture

We recommend **6 top-level sections**, plus a contextual help/utility rail. Six is the upper bound of what a horizontal nav can hold without spilling; further consolidation would make labels generic ("Settings") and unhelpful.

### Proposed sections

| # | Section | Includes | What changes |
|---|---------|----------|---------------|
| 1 | **Overview** | New dashboard, setup checklist, "needs attention" feed, recent activity, quick links | Replaces today's launcher tile grid |
| 2 | **AI Workspace** | Apps, Prompts, Models, Tools, Sources, Skills (FF), Workflows (FF), Marketplace (FF) | Merges all "what users interact with" content. Pages and Short Links demoted (see below) |
| 3 | **Access & Identity** | Users, Groups, Authentication, OAuth (with merged sub-pages), Providers | Absorbs all auth/identity. Providers move here because they are credential management. OAuth Hub absorbs Server + Clients sub-pages as tabs within OAuth detail |
| 4 | **Integrations** | Office365, Google Drive, Nextcloud, Nextcloud Embed, Jira, Outlook add-in, Browser extension | Single Integrations index using a card-per-provider pattern. **Legacy direct routes are removed** (breaking change — see note) |
| 5 | **Monitoring** | Usage Reports, Logging, Telemetry, plus new "Activity feed" view | Merges three siblings into one observability surface with sub-tabs |
| 6 | **Platform** | UI Customization, Features, Backups, Updates/Version, Security (Encryption, SSL, CORS), System Info | Replaces System "junk drawer". Security becomes its own sub-section. Backups promoted to first-class sub-nav item |

### Pages to merge

- **Logging + Telemetry + Usage Reports → Monitoring.** All three answer "what is the platform doing?" Splitting them creates artificial walls between cause (logs), effect (telemetry traces), and outcome (usage). One section, three tabs.
- **Authentication + OAuth + Users + Groups → Access & Identity.** A single mental model: "who can sign in, what are they grouped as, and through which protocol?" Providers also belong here because they are credential storage, even though they're LLM-facing.
- **OAuth Hub + Server + Clients → OAuth (single page with tabs).** The split into three routes is an artifact of incremental development, not a user need.
- **System encryption + SSL + CORS → Platform → Security.** Keep system info (version, updates) separate from security knobs.

### Pages to promote

- **Backups.** Today buried inside System. Should be a top sub-nav item under Platform with last-backup timestamp visible from Overview. Backup hygiene is the #1 thing auditors check.
- **Users.** Currently a sibling of 30 other pages. Promote into Access & Identity as the default landing tab. Most "I need to do something with a person" tasks start here.
- **Features (flags).** Today buried in More. Flags govern feature rollout; they should sit prominently under Platform with a per-group filter view.

### Pages to demote or hide

- **Pages (custom embeddable pages).** Niche; keep accessible under AI Workspace → Pages, but don't pin to top-nav.
- **Short Links.** Useful but low-frequency. Move under AI Workspace → Short Links, or fold into App detail ("share link") if usage is dominantly app-share.
- **Skills + Workflows + Marketplace** (currently feature-flagged). Keep gated. When enabled, they appear in AI Workspace as siblings to Apps.

### Why six and not five or seven?

We tested mental models for collapsing further:

- **5 sections** (folding Monitoring into Platform): rejected, because incident response is a distinct daily workflow for Observability personas. Burying it under "Platform" puts it behind clicks where seconds matter.
- **7 sections** (splitting Security out of Platform): rejected, because Security would only own 3 pages and create a top-nav item where most clicks lead to one screen.

### Breaking changes flag

Per `CLAUDE.md` guidance: removing legacy direct integration routes (e.g., `/admin/office365` as a top-level route) is a breaking change for anyone bookmarking those URLs. **We recommend a clean break with redirects from old paths for 1 minor version, then removal.** This decision should be confirmed with the user before implementation.

---

## 4. Dashboard Redesign Principles

### Is it a dashboard or a launcher?

**It should be a dashboard with launcher affordances**, not a launcher pretending to be a home page. Enterprise admins arrive at the home page asking one of three questions:

1. *Is everything okay?* (health)
2. *Is there something I need to do?* (actions)
3. *Where do I go to start a task?* (navigation)

The current tile grid only answers #3. The new home should answer all three, top-down.

### Proposed Overview layout (zones, not pixels)

1. **Status banner** (top): instance health badge ("All systems operational" / "1 issue detected"). One sentence. Links to incidents/alerts.
2. **Needs attention** (above the fold, left): an ordered list of actionable items, e.g.:
   - "Provider OpenAI: API key returned 401 in last 5 calls"
   - "Backup has not run for 4 days"
   - "12 users in unmapped IdP group 'contractors'"
   - "App 'Sales Coach' references deprecated model gpt-3.5-turbo"
   Each item has a primary action button (e.g., "Update key", "Run backup now").
3. **Key metrics** (above the fold, right): 4–6 KPI cards. Tap to drill into Monitoring with the same filter.
   - Active users (last 30d)
   - Chats this month
   - Tokens this month (and trend vs. last month)
   - Active apps (and total)
   - Failed auth attempts (last 7d)
   - Platform version + update available indicator
4. **Setup checklist** (conditional, shown until 100% complete): for fresh installs, a 6-step checklist:
   - [ ] Configure at least one LLM Provider
   - [ ] Configure Authentication
   - [ ] Create at least one Group
   - [ ] Invite at least one user
   - [ ] Publish at least one App
   - [ ] Run first backup
   Hidden once dismissed or fully completed. Re-surfaces if any item regresses (e.g., backup deleted).
5. **Recent activity** (below the fold): last 10 admin actions — who did what, when. Doubles as a low-fidelity audit trail until the full audit log lands in Phase 3.
6. **Quick launch grid** (below the fold or in a collapsible drawer): the existing tile grid, but **grouped** by the same 6 top-level sections, so admins can still launch a task in one click.

### KPIs to surface (recommended set)

- **Platform health**: provider status, auth status, backup status, version status. Roll up into a single banner.
- **Usage**: chats this month, tokens this month (+ trend), distinct active users last 30d.
- **Inventory**: # active apps, # active users, # groups, # integrations connected.
- **Security**: failed auth attempts (7d), admin actions (7d), expiring secrets (next 30d).

### Patterns we recommend adopting

- **"Things needing attention"** — borrowed from GitHub/Stripe dashboards. Every item is actionable; nothing is decorative.
- **Setup checklist with progress** — borrowed from Vercel/Auth0. Sets expectations for first-time admins and reduces drop-off during onboarding.
- **Drill-everything** — every metric on the home page must link to a filtered view in Monitoring or the relevant section. Numbers without drill-down are decoration.

---

## 5. Sub-Permissions Recommendation

### The question

Should we introduce sub-admin roles (Content Admin, Identity Admin, Observability Reader) alongside the IA redesign?

### Recommendation: **No, not in Phase 1 or 2. Defer to Phase 3.**

### Reasoning

| Factor | Now (with redesign) | Later (after redesign) |
|--------|----------------------|------------------------|
| User impact | High disruption: IA changes AND permission model changes hit the same admins simultaneously | Stable IA, isolated permission model change |
| Migration risk | Existing single-admin model is well understood. Splitting it requires a migration plan and rollback story | Migration is a one-axis change; rollback is per-user |
| Demand evidence | We have **no** concrete enterprise asks for sub-roles in current backlog | If demand materializes, Phase 3 ships on solid IA |
| Engineering scope | Doubles Phase 1 (IA + roles) into a multi-quarter release | Each phase ships in 4–10 weeks |
| Customer message | "We rebuilt the admin AND changed who can do what" — confusing | "We rebuilt the admin. Next, finer access control" — clear |

### Pros and cons of introducing sub-roles

**Pros**
- Aligns with enterprise expectations (separation of duties)
- Reduces blast radius of mistakes by a junior content admin
- Enables delegation (e.g., business unit owns its own apps but cannot touch SSO)
- Satisfies SOC2 / ISO27001 audit narratives around least privilege

**Cons**
- Adds permission matrix complexity (today: 1 axis. After: N axes)
- Requires UI affordances for every page to render in read-only or hidden mode
- Migration story: existing admins keep "super admin", but how do we encourage adoption of narrower roles?
- Risk of mis-scoping (e.g., what role can rotate provider keys vs. just view them?)
- Group inheritance already exists — adding role inheritance on top doubles the cognitive load

### Recommended Phase 3 design (preview)

- **Three predefined sub-roles** layered on top of the existing `admin` group: `content-admin`, `identity-admin`, `observability-admin`. Each is implemented as a real group in `groups.json` that inherits from `users` (not `admin`) and gets scoped permissions.
- **Top-level admin (`super-admin`) remains** as a separate group for full access.
- Reuse existing group inheritance + permission system rather than building a new ACL.
- Read-only mode (`observability-admin`) is the simplest first slice — implement it as a feature spike before rolling out write-scoped roles.

---

## 6. Phasing Plan

### Phase 1 — Restructure & Refresh (target: 4 weeks)

**Goal:** Ship perceived progress fast. No backend changes. No page-level rewrites.

**Scope:**
- Implement the 6-section top nav with sub-nav routing
- Migrate all 30+ existing pages under the new nav (no content changes)
- Replace dashboard with the new Overview (status banner + needs-attention + KPIs + setup checklist + recent activity + collapsible launcher)
- Move System → Security and System → Backups sub-sections
- Merge OAuth Hub + Server + Clients into a single tabbed page
- Add redirects from old routes for 1 minor version

**Non-goals:** Sub-roles, wizards, bulk actions, audit log, command palette.

**Success criteria:**
- Admin survey (n≥10): "find a setting" task drops from average 30s to <10s
- Reduction in "where is X?" support tickets by 50%
- Zero increase in broken links (verified via redirects)

### Phase 2 — Flow Consolidation & Table Stakes (target: 8 weeks)

**Goal:** Collapse the highest-cost JTBDs into guided flows.

**Scope:**
- **Onboard Group wizard** (JTBD #1)
- **Publish App wizard** with side-panels for tools/sources/perms (JTBD #3)
- **Rotate Key flow** with affected-resource preview + dry-run mode (JTBD #2)
- **Connect SSO wizard** (JTBD #5)
- **Bulk actions** in Apps and Users tables (JTBD #10)
- **Command palette (Cmd+K)** for global navigation and quick actions
- **Global search** across apps/users/groups/prompts/etc.
- **Monitoring unified view** with cross-linked timelines (logs ↔ usage)
- Integrations card-detail pattern; remove legacy direct routes

**Success criteria:**
- JTBD click cost reduces by ≥50% for the 5 covered jobs
- Cmd+K usage by week 4 ≥ 30% of weekly admin sessions
- Bulk-edit used in ≥20% of multi-app changes

### Phase 3 — Sub-Roles & Enterprise Polish (target: 10 weeks)

**Goal:** Unlock enterprise selling motions and harden the admin surface.

**Scope:**
- Sub-admin roles (read-only first, then scoped write)
- **Admin audit log** as a dedicated Monitoring sub-tab with retention and export
- **Change history per config** (diff view, revert)
- **Dry-run mode** generalized for risky changes
- **Bulk import/export** (CSV/JSON) for apps, users, groups
- **Multi-tenant scoping** if/when needed (gated by demand)
- Onboarding for the new IA itself (in-product tour)

**Success criteria:**
- ≥3 customers using sub-roles within 90 days of release
- Audit log queried in ≥40% of admin investigations
- Zero unrecoverable config changes reported in pilot quarter

---

## 7. Enterprise Table-Stakes Gap Analysis

Capabilities expected by enterprise admin buyers that we do not have today, prioritized by impact.

| Capability | Priority | Why it matters | Phase |
|------------|----------|-----------------|-------|
| **Admin audit log** | Must | Required for SOC2/ISO/internal compliance. Today's "recent activity" on Overview is a stop-gap | P3 |
| **Command palette (Cmd+K)** | Must | Power-user expectation. Single biggest IA mitigation — even with 30 pages, Cmd+K makes them findable | P2 |
| **Global admin search** | Must | "I know I named a prompt 'sales coach' but can't find it" — solved in seconds | P2 |
| **Change history per config** | Should | Reverting a bad app/prompt/model edit without a backup | P3 |
| **Dry-run for risky changes** | Should | Rotate-key, delete-app, bulk-disable. Show preview of impact before commit | P2 (rotate key) + P3 (generalized) |
| **Bulk import/export** | Should | Migrations, environment promotion (dev→staging→prod), DR drills | P3 |
| **Multi-tenant separation** | Could | Genuine multi-tenant is a platform-level decision. Soft tenancy via groups already partly addresses this | P3 (gated by demand) |
| **In-product changelog / "what's new"** | Should | Admins resent silent feature flag toggles; surface them | P3 |
| **Health probes & uptime widget** | Must | Surface on Overview. Today admins discover problems from user reports | P1 (banner) + P2 (drilldown) |
| **Configurable email/Slack alerts** | Could | "Notify me when provider key fails" — natural extension of needs-attention feed | P3 |
| **Two-person rule for destructive ops** | Could | Enterprise audit ask; gated by demand | P3 |
| **Session/admin login as user (impersonation)** | Could | Reproduce user-reported bugs without password reset. Sensitive — requires audit log | P3 |

### What we **don't** recommend building

- **Custom dashboard widgets / drag-and-drop layout.** Tempting, but it's a feature in search of a problem. A single, opinionated Overview serves admins better than self-service layout. Revisit only if usage data shows admins want different home views per persona.
- **A separate "Settings" mega-page.** Today's System page is exactly this and exactly the failure mode we're escaping. Decompose, don't recompose.
- **Per-page customization (column choosers, saved filters) in Phase 1.** Defer to Phase 3 unless usage analytics demand it earlier.

---

## 8. Risks & Open Questions

### Risks

1. **Redirects miss.** If a customer has documentation/bookmarks pointing at `/admin/office365`, breaking those without warning will generate support load. Mitigation: maintain redirects for 1 minor version + release-notes communication.
2. **Existing admin muscle memory.** Power users will be slower for 1–2 weeks after Phase 1. Mitigation: ship an in-product "What moved where" reference accessible from the Overview.
3. **Setup checklist false negatives.** If checklist logic is fragile, a working instance might show "incomplete". Mitigation: ship with conservative detection and a manual "mark complete" override.
4. **KPI accuracy on Overview.** Token counts, failed auth counts, etc., must agree with Monitoring drill-down. Mitigation: pull from the same backend endpoints; no client-side aggregation.
5. **Sub-role expectations.** If Phase 1 ships and customers immediately ask for sub-roles, deferring to Phase 3 may cost a deal. Mitigation: track this in CS calls; be ready to pull Phase 3 forward if 3+ enterprise asks land.

### Open questions for stakeholders

1. **Do we want a clean break on legacy integration routes,** or keep them as deprecated redirects indefinitely? (Default recommendation: 1-minor-version redirect, then remove.)
2. **Is the Overview the default landing page for all admins,** or do power users get a setting to land directly on their last-visited section? (Recommendation: Overview default; remember-last-visited as a Phase 2 user preference.)
3. **Should Providers live in Access & Identity** (because they are credential storage) **or in AI Workspace** (because models depend on them)? (Recommendation: Access & Identity, with a cross-link from Models.)
4. **What is our position on customer-visible audit log retention?** (Affects Phase 3 storage decisions.)
5. **For Phase 2 bulk actions, what is the maximum batch size** we want to commit to in UI (e.g., 100, 500, 1000)? (Determines whether bulk operations are sync or async.)

---

## 9. Success Metrics (Aggregate)

| Metric | Baseline (today, estimate) | Phase 1 target | Phase 3 target |
|--------|---------------------------|-----------------|------------------|
| Time-to-find-setting (median) | ~30s | <10s | <5s |
| Clicks to publish a new app | 25+ | 25 (unchanged) | 8–10 (wizard) |
| Clicks to rotate a provider key | 20+ | 20 (unchanged) | 5–7 (flow) |
| New-admin time-to-first-published-app | Unmeasured | <30 min | <15 min |
| Admin NPS | Unmeasured | Baseline | +15 |
| "Where is X?" support tickets | Baseline | -50% | -80% |
| Cmd+K weekly active usage | 0% | 0% | ≥30% |
| Overview "needs attention" items resolved within 24h | N/A | N/A | ≥70% |

---

## 10. Out of Scope

To keep this brief focused, the following are explicitly **not** addressed here and should be handled separately:

- Visual design system, color, typography (designer)
- Mobile/tablet responsiveness specifics (designer)
- Specific component implementation, framework choices (engineer)
- Internationalization of new strings (translation pipeline)
- Backend endpoint changes (none expected — confirm with engineering)
- Accessibility audit (separate WCAG 2.1 AA pass, recommend Phase 1)
- Pricing/packaging implications of sub-roles (separate commercial decision)

---

## 11. Next Steps

1. **Review** this brief with engineering and design leads. Confirm no backend changes required.
2. **Pair with UX designer's wireframe proposal** to produce a unified redesign draft.
3. **Walk through with 2–3 enterprise admins** before Phase 1 build kick-off to validate persona blends and JTBD priorities.
4. **Decide on open questions** in Section 8 (recommend a 30-min stakeholder review).
5. **Commit to Phase 1 scope** with engineering sizing; lock the 4-week target.

---

## Appendix A — Mapping current pages to proposed IA

| Current page | Proposed section | Notes |
|---|---|---|
| Home (dashboard) | Overview | Redesigned |
| Apps | AI Workspace → Apps | |
| Models | AI Workspace → Models | |
| Prompts | AI Workspace → Prompts | |
| Tools | AI Workspace → Tools | |
| Skills (FF) | AI Workspace → Skills | |
| Sources | AI Workspace → Sources | |
| Pages | AI Workspace → Pages | Demoted within section |
| Short Links | AI Workspace → Short Links | Demoted within section |
| Workflows (FF) | AI Workspace → Workflows | |
| Marketplace (FF) | AI Workspace → Marketplace | |
| Providers | Access & Identity → Providers | Moved from "Content & Apps" mental model |
| Authentication | Access & Identity → Authentication | |
| OAuth Hub + Server + Clients | Access & Identity → OAuth (tabbed) | Merged |
| Users | Access & Identity → Users | Promoted as default tab |
| Groups | Access & Identity → Groups | |
| Integrations Hub | Integrations | Becomes the only entry; cards link to detail |
| Office365 | Integrations → Office365 | Direct route removed |
| Google Drive | Integrations → Google Drive | Direct route removed |
| Nextcloud | Integrations → Nextcloud | Direct route removed |
| Jira | Integrations → Jira | Direct route removed |
| Outlook add-in | Integrations → Outlook Add-in | Direct route removed |
| Browser extension | Integrations → Browser Extension | Direct route removed |
| Nextcloud Embed | Integrations → Nextcloud Embed | Direct route removed |
| Logging | Monitoring → Logs | |
| Telemetry | Monitoring → Telemetry | |
| Usage Reports | Monitoring → Usage | |
| (new) | Monitoring → Activity / Audit | Phase 3 |
| UI Customization | Platform → UI | |
| Features (flags) | Platform → Features | Promoted out of "More" |
| System (version, updates) | Platform → System Info | |
| System (encryption, SSL, CORS) | Platform → Security | Decomposed from System |
| System (backup/restore) | Platform → Backups | Promoted |

---

*End of strategy brief. Combine with UX wireframes for the final redesign draft.*
