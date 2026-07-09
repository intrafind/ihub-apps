# Workflow UI Multi-Perspective Review

**Date:** 2026-05-19
**Scope:** End-user workflow UI (not the admin editor)
**Files reviewed:**

- `client/src/features/workflows/pages/WorkflowsPage.jsx`
- `client/src/features/workflows/pages/WorkflowListTab.jsx`
- `client/src/features/workflows/pages/MyExecutionsTab.jsx`
- `client/src/features/workflows/pages/WorkflowExecutionPage.jsx`
- `client/src/features/workflows/components/WorkflowCard.jsx`
- `client/src/features/workflows/components/ExecutionCard.jsx`
- `client/src/features/workflows/components/HumanCheckpoint.jsx`
- `client/src/features/workflows/components/ExecutionProgress.jsx`
- `client/src/features/workflows/components/StartWorkflowModal.jsx`
- `client/src/features/workflows/components/WorkflowPreview.jsx`
- `server/defaults/workflows/research-assistant.json` (sample)

---

## 1. TL;DR — One-View Summary

| Persona | Headline Verdict | Top Pain Point |
| --- | --- | --- |
| **Product Manager** | "Functional but undifferentiated; we're shipping a developer tool, not a product." | No discovery, no analytics, no template gallery, no notifications. |
| **Non-technical user** | "I don't know what to start, when it'll finish, or what just happened." | Internal jargon leaking (nodes, tokens, execution IDs, JSON dumps). |
| **UX Designer** | "Information architecture is flat; the checkpoint—the one moment of interaction—competes for space with status panels." | When the workflow needs me, that moment isn't the focus of the page. |
| **UI Designer** | "It's a Tailwind moodboard. Five accent colors, three gradient styles, no token system." | No consistent visual hierarchy or spacing system. |
| **UX Researcher** | "We have no idea where users drop off, and the page isn't accessible." | Zero instrumentation, color-only status indicators, no aria coverage. |

**The 5 changes that move the needle most:**

1. **Make checkpoints the page** when one is pending — modal/hero treatment, not a sidebar card.
2. **Strip developer language from the UI** (rename "Execution" → "Run", drop tokens/IDs/node-type badges by default).
3. **Add a real progress bar** with elapsed/estimated time, instead of node-by-node status as the only signal.
4. **Discoverability layer:** category chips, search, "Recently used", "Starter workflows" section.
5. **Adopt a token-based design system** (4 button variants, 1 status badge, 1 spacing scale) and apply ruthlessly.

---

## 2. The Current User Journey

```
[/workflows]
   ├── Tab: Available Workflows          ← grid of cards, gradient header per card
   │      └── click "Start Workflow"
   │            └── StartWorkflowModal opens (inputs + model picker + raw JSON toggle)
   │                  └── POST /workflows/:id/execute
   │                        └── navigate to /workflows/executions/:id
   │
   └── Tab: My Executions                ← list of execution cards, status pills, filter pills
          └── click "Join" / "View"
                └── /workflows/executions/:id
                      ├── Left column:  ExecutionProgress timeline
                      ├── Right column: Status panel OR HumanCheckpoint
                      └── Bottom (when done): Output (markdown / accordion / JSON)
```

What works:

- Tab structure is clear at a high level.
- Inputs in the start modal are typed (string/textarea/select/file/date/number/boolean) — good.
- SSE streaming + connected indicator works for live executions.
- "Chat with Results" is a great cross-feature continuation.
- Workflow Output handles markdown rendering nicely.

---

## 3. Five Reviewers Speak

### 3.1 Product Manager — *"What are we shipping?"*

**Verdict:** Functionally complete, strategically thin. We have engineering, not product.

**What's missing for it to be a product, not a feature:**

- **Discoverability is zero.** No search, no categories, no filters by type, no tags, no recommendations. With more than ~10 workflows the grid becomes unusable. (`WorkflowListTab.jsx:78`)
- **No analytics surfaced.** Users can't see "this workflow has been run 240 times this month, 92% success rate, average 2m 14s". Admins can't either, from this UI.
- **No ratings / feedback.** No 👍/👎 after a run. We have no idea which workflows are useful.
- **No template gallery / starter workflows.** Empty state for new users (`WorkflowListTab.jsx:59-74`) is just "No Workflows Available" with an inbox icon. First impression is a void.
- **No notifications.** Long-running workflows: user has to keep the tab open or come back manually. No browser notifications, no email, no Slack hook surface.
- **No "Re-run with same inputs"** on a completed execution. This is the most-requested feature in any workflow tool.
- **No favorites / pinning.** "Most-used by you" would be one of the most-used widgets.
- **Cost is hidden in tokens.** Business users want € / $ amounts, not "3,481 tokens". (`WorkflowExecutionPage.jsx:631`)
- **"Chat with Results" is buried.** It's a fantastic affordance but lives as the 3rd button on the right (`WorkflowExecutionPage.jsx:498-510`). It should be the headline next step.
- **No sharing.** No "copy link to this run", no "share output as a public read-only link".
- **No workflow categorization** in the data model exposed to the UI. The cards just dump node-type badges.
- **Permissions visibility is silent.** Users don't know what workflows exist that they *can't* access; they just see less.

**One-sentence PM brief:**
> "Add a discovery layer (search, categories, recents), a feedback loop (rating + analytics), and a continuation layer (re-run, share, notify) before adding any more node types."

---

### 3.2 Non-technical user — *"I just want it to do the thing."*

**Verdict:** I'm intimidated. Every screen reminds me a developer made this.

**Walking the journey as Sarah from Marketing:**

1. **Landing page:** "Manage and run automated workflows." OK. "+ New Workflow" — that button is hidden for me (admin-only) so I don't see it. The cards look fine but each one has a sticker that says "3 Agents", "1 Tool", "2 Checkpoints" — *I don't know what an Agent is.* (`WorkflowCard.jsx:44-67`)

2. **Picking a workflow:** No way to find one by what I'm trying to do (e.g. "research a competitor"). I have to read each card. There's no preview of what it produces, no example inputs.

3. **Starting:** Modal appears with a "Workflow Structure" tree (`WorkflowPreview.jsx`) — start → planner → searcher → synthesizer → end. *I'm filling in a form, why am I being shown a flowchart?* It looks like a debug view.

4. **Filling in:** "Model" dropdown — I don't care which model. Why am I being asked? At the bottom: "Advanced: Raw JSON" — that tells me this whole screen was designed for someone like a developer.

5. **Running:** I land on a two-column page. Left: "Execution Progress" with rows like "Research Planner — Set 'researchPlan' — 1,247 tokens — 4.2s". *What is researchPlan? Why am I seeing tokens?* (`ExecutionProgress.jsx:485-511`)

6. **Status panel on the right:** "Executed: 2 / Active: 1 / Failed: 0" tiles. OK that's understandable, but no progress bar, no "about 1 minute remaining". (`WorkflowExecutionPage.jsx:578-604`)

7. **Checkpoint appears:** The right column is suddenly a yellow "Action Required" card. Under "Relevant Data" there's a JSON dump. I have no idea what to do with `{"queries": ["..."], "approach": "..."}`. (`HumanCheckpoint.jsx:90-101`)

8. **It finishes:** I see "Workflow Output". Mostly readable Markdown. Good. But there's also "Additional Data" with `chars`, `{4}`, `[3]` annotations and accordion panels of JSON. Lost again. (`WorkflowExecutionPage.jsx:400-407`)

9. **What now?** Three buttons of equal weight: Edit (I'm not admin so hidden), Chat with Results, Export, Refresh. I don't know what "Export" does. (`WorkflowExecutionPage.jsx:511-526`)

**Concrete language fixes (cheap):**

| Today | Tomorrow |
| --- | --- |
| Workflow / Workflows | Automation / Automations *(or: Task / Recipes)* |
| Execution | Run |
| My Executions | My Runs / History |
| Nodes Executed | Steps completed |
| Active | In progress |
| Failed (count tile) | Issues |
| Execution ID: 4f2a-... | *(hidden by default; "Copy link" instead)* |
| 3 Agents · 1 Tool · 2 Checkpoints | *(remove from card; show "About 2 min" + 1-line "What it does")* |
| Output Variable: `researchPlan` | *(hidden by default; toggle "Show technical details")* |
| Total Tokens: 3,481 | *(hidden; show as €0.04 or "Cost: low")* |
| Connected / Disconnected | Live / Reconnecting… |
| Cancel | Stop |

**One-sentence user brief:**
> "Hide everything that isn't an outcome or an instruction. If a developer would understand it but a marketer wouldn't, put it behind 'Show technical details'."

---

### 3.3 UX Designer — *"Where is the focus?"*

**Verdict:** The page is a dashboard when it should be a conversation. The single most important moment — a checkpoint — is the *least* focused moment.

**Specific UX critiques:**

- **Checkpoint placement is wrong.** A pending checkpoint replaces the right-side Status card (`WorkflowExecutionPage.jsx:540-545`). When the workflow is *paused waiting for me*, the page should reflow so the checkpoint dominates — center stage, dimmed background. Right now it sits next to a progress timeline of equal visual weight.

- **No progress bar.** "Execution Progress" is a literal list of nodes (`ExecutionProgress.jsx:417-619`). Users need a horizontal bar: "Step 3 of 5 · about 45s remaining". The information to compute this exists (`completedNodes.length / totalNodes.length`); it isn't surfaced.

- **No live-feel update.** The connected pill (`WorkflowExecutionPage.jsx:441-456`) is the only indicator of liveness. No subtle pulse on the current step, no streaming chunk preview, no "currently searching for…" micro-status. Compare to ChatGPT/Claude streaming where every token feels alive.

- **Two-column grid breaks on the most important info.** Progress on left, status on right, output spanning both — this means the *real deliverable* (the output) is below the fold on a 13" screen.

- **Filters compete with refresh button.** In `MyExecutionsTab.jsx:66-94` filters are pills, refresh is an icon-only button right-aligned with no label. Cognitive load.

- **No empty state for the journey.** First-time user on "My Executions" sees a translated string and an inbox icon (`MyExecutionsTab.jsx:97-115`). Should be a tutorial card: "Start your first workflow → [link to Available]".

- **Modal validation is post-hoc.** Required-field check happens *after* the user clicks Start (`StartWorkflowModal.jsx:222-234`). The Start button doesn't disable, doesn't show inline errors. (`StartWorkflowModal.jsx:462-478`)

- **WorkflowPreview is wrong tool for the job.** Showing a flowchart inside the *start* modal tells the user "you need to understand my structure to use me." Replace with: "About this workflow" copy + estimated time + sample output.

- **No undo / confirm on checkpoint.** Single click submits (`HumanCheckpoint.jsx:21-39`). For an "Approve / Reject" decision this is risky.

- **Cancel is buried among neutral actions.** (`WorkflowExecutionPage.jsx:489-497`) Destructive action should be visually separated (right side, or in an overflow menu).

- **Mobile:** `lg:grid-cols-2` collapses to single column, making the page extremely tall. No sticky checkpoint, no jump-to-checkpoint button.

- **Notification gap.** Long workflow + tab navigation = user has no idea if it's done. Web Notifications API would be a 50-line win.

- **Iteration grouping is technical.** "3 iterations" expansion (`ExecutionProgress.jsx:439-446`) is exposing loop internals. For non-technical: "We tried 3 approaches" is closer.

**Recommended layout (when checkpoint pending):**

```
┌─────────────────────────────────────────────────────────────┐
│  ←  Research Assistant                            Live ⬤    │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐  │
│   │  ⏸  This workflow needs your input                   │  │
│   │                                                      │  │
│   │  We've drafted 3 search queries.                     │  │
│   │  Should we proceed with these, or refine them?      │  │
│   │                                                      │  │
│   │  1. "..."                                            │  │
│   │  2. "..."                                            │  │
│   │  3. "..."                                            │  │
│   │                                                      │  │
│   │  [  ✓ Use these queries  ]   [  ✎ Refine  ]         │  │
│   └──────────────────────────────────────────────────────┘  │
│                                                              │
│   ─── So far ────────────────────────────────────────── ▼   │
│   ✓  Plan research              4.2s                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

The progress timeline moves *below* the checkpoint and becomes collapsible "So far" context.

---

### 3.4 UI Designer — *"This is five visual languages in a trench coat."*

**Verdict:** Tailwind exists, but no design system. Every screen reinvents button styles, spacing, and color usage.

**Concrete inconsistencies:**

- **Five accent colors used semantically:**
  - Indigo (primary actions, links, tabs, buttons)
  - Blue (running status, info tiles)
  - Green (completed, start node)
  - Yellow (paused, checkpoint, human nodes)
  - Orange (rejected, tool node)
  - Red (failed, danger, end node)
  - Purple (decision nodes, planned tasks, agent model badge)
  - Cyan (transform nodes)
  Eight accent colors total. Reduce to: primary (indigo), success, warning, danger, neutral.

- **Three gradient treatments** (`WorkflowCard.jsx:29`, `HumanCheckpoint.jsx:68`, none elsewhere). Either commit to gradients as a brand element or remove them entirely. Currently they feel decorative on the card and demanding on the checkpoint.

- **Button system is ad-hoc.** I counted at least 9 distinct button styles across the files reviewed:
  - `bg-indigo-600 text-white` (primary)
  - `bg-gray-100 text-gray-700` (neutral)
  - `bg-white border border-gray-300` (outlined)
  - `text-red-600 border border-red-300` (danger outline)
  - `text-indigo-600 dark:text-indigo-400 bg-white border-indigo-300` (info outline)
  - `bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700` (subdued)
  - icon-only ghost
  - link buttons
  - tab-pills
  Adopt 4 variants max: `primary`, `secondary`, `ghost`, `danger` — extract to a `<Button variant="..." />`.

- **Status badges drawn three different ways:**
  - As pill with icon + capitalized status (`ExecutionCard.jsx:8-28`)
  - As colored dot + text (`WorkflowExecutionPage.jsx:553-576`)
  - As left border stripe (`ExecutionCard.jsx:53-66`)
  - As capsule in progress header (`ExecutionProgress.jsx:395-413`)
  Same data, four visualizations. Pick one.

- **Status indicator sizes:** `w-2 h-2` (connection), `w-4 h-4` (large dot), `w-8 h-8` (NodeStatus), `w-10 h-10` (header). No system.

- **Typography scale:** `text-3xl`, `text-2xl`, `text-xl`, `text-lg`, `text-sm`, `text-xs` used without hierarchy. Should be: display / h1 / h2 / body / caption — 5 sizes total.

- **Spacing:** `p-3`, `p-4`, `p-6`, `gap-1`, `gap-2`, `gap-3`, `gap-4`, `mb-2/3/4/6` — every component picks fresh values. Define a 4px / 8px / 16px / 24px scale and stick to it.

- **Iconography:** mix of `x-mark` and `x` and `xmark` (`StartWorkflowModal.jsx:304`, `WorkflowExecutionPage.jsx:494`) suggests sourcing inconsistency. Audit and standardize on one set (Heroicons v2 outlined recommended for this aesthetic).

- **Gradient header on WorkflowCard (`indigo-500 → purple-600`) looks 2019.** Modern equivalent: solid surface, prominent icon, generous whitespace, color used sparingly.

- **JSON `<pre>` blocks** (`HumanCheckpoint.jsx:96-99`, `ExecutionProgress.jsx:64-69`, `WorkflowExecutionPage.jsx:84-88`) are the single biggest "this feels unfinished" tell. Either build a proper key/value renderer, or never show them to the user (only to admins).

- **No motion design.** Status changes happen instantly. No FLIP transitions for tab/filter changes. No skeleton states (just spinners).

- **Dark mode is haphazard.** Lots of `dark:bg-gray-700/50` mixed with `dark:bg-gray-900/30`. Define semantic surface tokens.

**One-sentence UI brief:**
> "Strip to 1 primary color, 4 button variants, 1 status badge component, 1 spacing scale. Treat workflow cards like Linear issues, not Trello cards."

---

### 3.5 UX Researcher — *"How do you know any of this is true?"*

**Verdict:** We're flying blind. No instrumentation, no usability data, no accessibility baseline.

**Instrumentation gaps:**

- **No analytics events** visible in any file: `workflow_viewed`, `workflow_started`, `checkpoint_responded`, `workflow_completed`, `workflow_cancelled`, `chat_with_results_clicked` — none.
- **No funnel measurement.** We don't know how many users land on `/workflows`, how many start one, how many complete, how many cancel.
- **No drop-off detection.** Modals especially: how many users open StartWorkflowModal and then close without starting?
- **No time-to-task metrics.** How long does a first-time user take to start their first workflow?

**Accessibility issues (would fail WCAG 2.1 AA):**

- **Color-only status indicators.** The status dot on `WorkflowExecutionPage.jsx:553-571` conveys state with hue alone. Deuteranopia users can't distinguish "approved" (green) from "rejected" (orange) easily, nor "running" (blue) from "completed" (green) when adjacent.
- **No `aria-label` on icon-only buttons.** Refresh (`WorkflowExecutionPage.jsx:519-526`, `MyExecutionsTab.jsx:86-93`), close (`StartWorkflowModal.jsx:299-306`), expand/collapse (`ExecutionProgress.jsx:454-457`). Screen readers will say "button".
- **Modal lacks focus management.** No `inert` on backdrop, no focus trap visible, no return-focus on close. (`StartWorkflowModal.jsx:276-484`)
- **No `aria-live` region for SSE updates.** Screen reader users don't know when a node completes, when a checkpoint arrives, or when the workflow finishes.
- **`<pre>` JSON blocks** are read character-by-character by screen readers. Disastrous in HumanCheckpoint.
- **Status pills lose meaning without icons.** Some statuses repeat color (e.g., paused yellow + checkpoint yellow + warning yellow).
- **Animations have no reduced-motion respect.** `animate-spin`, `animate-pulse` ignore `prefers-reduced-motion`.
- **Keyboard navigation through the node timeline isn't obvious.** All buttons should be reachable via Tab; accordion patterns need `aria-expanded`.

**Research questions we can't answer today:**

1. Which workflows do users actually complete vs. abandon?
2. At which checkpoint do users most often time out / forget to respond?
3. Does "Chat with Results" get clicked? (My PM hypothesis says < 5%.)
4. How many users discover the "Advanced: Raw JSON" toggle and use it?
5. How often is a workflow cancelled mid-run? Why?
6. Does the model picker change behavior, or do people leave it on default?
7. What's the median input-field-count before users give up on a workflow start?
8. How many users return to the same workflow vs. one-shot users?

**Recommended research plan:**

| Activity | Effort | Output |
| --- | --- | --- |
| Add 12 event types (one per CTA + page view + outcome) | 1 day | Funnel + abandonment data |
| Add user feedback widget on execution page | 0.5 day | NPS / qualitative |
| 5 moderated sessions with non-technical users running 3 default workflows | 1 week | Top 5 verified pain points |
| Accessibility audit (axe + manual SR) | 2 days | WCAG gap list |
| Run usage analytics for 2 weeks before any redesign | passive | Baseline to measure improvement against |

---

## 4. Cross-Cutting Issues

Issues that surfaced across multiple personas:

1. **"What is this thing?" branding problem.** Even calling them "Workflows" assumes the user thinks in flowcharts. PM, non-technical user, and UX researcher all flagged this. Recommend renaming to **Automations** or **Recipes** at the surface (keep "workflow" as the developer-facing schema name).

2. **The output is the deliverable, but the output is below the fold.** PM, UX, and UI all noted that the actual *answer* the user came for is the last thing they see.

3. **Tokens / IDs / Node-internals leaking.** Non-technical user, UI designer, and PM all noted that internal model concerns surface in the UI without a "developer mode" toggle.

4. **No notifications / no return-trip support.** PM, UX, and researcher all noted that asynchronous work needs an out-of-page hook.

5. **No design system primitives.** UI designer led, but UX flagged it as the root cause of inconsistency.

---

## 5. Prioritized Roadmap

### P0 — Must do (next sprint, ~5 dev-days)

| # | Change | Owner | Files |
| --- | --- | --- | --- |
| P0-1 | **Checkpoint takes over the page** when pending; collapse progress timeline. | UX + Eng | `WorkflowExecutionPage.jsx:531-712`, `HumanCheckpoint.jsx` |
| P0-2 | **Add progress bar** with `completed / total` count and elapsed time at the top of the execution page. | UX + Eng | `WorkflowExecutionPage.jsx:435-528`, `ExecutionProgress.jsx` |
| P0-3 | **Hide technical fields behind "Show technical details" toggle**: execution IDs, tokens, output variable names, node types, JSON dumps. | All | `WorkflowExecutionPage.jsx`, `ExecutionProgress.jsx`, `HumanCheckpoint.jsx`, `WorkflowCard.jsx` |
| P0-4 | **Disable Start button until required fields valid**; inline error messages. | UX | `StartWorkflowModal.jsx:200-234,462-478` |
| P0-5 | **Add 12 baseline analytics events** so we can measure anything we do next. | Research | New telemetry hook |

### P1 — Should do (next month, ~10 dev-days)

| # | Change | Why |
| --- | --- | --- |
| P1-1 | Promote "Chat with Results" to the primary post-completion CTA | PM hypothesis: < 5% click today |
| P1-2 | Add **search + category filter** on Available Workflows | Discovery is zero |
| P1-3 | Add **"Re-run with same inputs"** button on completed executions | Top-requested workflow feature universally |
| P1-4 | **Browser Web Notifications** when workflow completes/fails while tab is backgrounded | Async UX gap |
| P1-5 | **Rename in UI**: Workflow→Automation, Execution→Run, My Executions→History (i18n keys only — schema stays) | Brand & comprehension |
| P1-6 | **Build a `<Button>` and `<StatusBadge>` component**; replace inline Tailwind across the workflow feature | UI consistency |
| P1-7 | **Add `aria-label`s, focus trap, live regions, reduced-motion respect** to all interactive elements | Accessibility/WCAG |
| P1-8 | Replace JSON `<pre>` blocks with a key-value renderer (or hide for non-admins) | Polish + comprehension |
| P1-9 | **Add `prefers-reduced-motion`** support to spinners/pulses | A11y |
| P1-10 | **Estimated time + "About this workflow" copy** on cards & start modal (replace node-type sticker badges) | Comprehension |

### P2 — Nice to have (this quarter)

| # | Change |
| --- | --- |
| P2-1 | Workflow ratings (👍/👎) post-completion, surfaced in admin analytics |
| P2-2 | "Most-used by you" and "Recently used" sections on the landing page |
| P2-3 | Shareable read-only links to completed executions |
| P2-4 | Favorites / pinning |
| P2-5 | Cost displayed as currency (configurable per provider rate card) |
| P2-6 | Template gallery: starter workflows grouped by use case |
| P2-7 | Streaming-chunk preview inside the currently-executing node card |
| P2-8 | Confirmation step for destructive checkpoint actions (configurable per workflow) |
| P2-9 | Compare two runs side-by-side |
| P2-10 | Email/webhook callback on completion (per-run opt-in) |

---

## 6. Proposed New Design Direction (sketch)

### Landing page (`/workflows`)

```
─────────────────────────────────────────────────────────────────────
   Automations                                       [ + New ]
   Pre-built assistants that do multi-step work for you.

   🔍 Search automations…           [ Category ▾ ] [ Sort ▾ ]
─────────────────────────────────────────────────────────────────────

   ★ Recently used by you
   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
   │ Competitor  │ │ Document    │ │ Email       │
   │ research    │ │ summary     │ │ draft       │
   │ ~2 min      │ │ ~30 sec     │ │ ~1 min      │
   └─────────────┘ └─────────────┘ └─────────────┘

   All automations
   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
   │ ...         │ │ ...         │ │ ...         │
   └─────────────┘ └─────────────┘ └─────────────┘
─────────────────────────────────────────────────────────────────────
   [ Available ]  [ History (2 running ●) ]
```

### Start modal (input-focused)

```
┌─ Run: Research Assistant ──────────────────────────────[ × ]──┐
│                                                                │
│  What is the topic?                                            │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │                                                          │ │
│  └──────────────────────────────────────────────────────────┘ │
│  Try: "competitive analysis of Notion vs Linear"               │
│                                                                │
│  About this automation                                         │
│  ► Searches the web, drafts a research plan, asks you to       │
│    confirm direction, then writes a structured report.         │
│    Typically takes ~2 minutes.                                 │
│                                                                │
│  ▾ Advanced (model, JSON input)                                │
│                                                                │
│                            [ Cancel ]   [ ▶  Start ]  ← disabled│
└────────────────────────────────────────────────────────────────┘
```

### Execution page (running)

```
─────────────────────────────────────────────────────────────────────
   ←  Research Assistant                                Live ●
   "competitive analysis of Notion vs Linear"

   ──────────────────────────────────────────────────────  Step 2 / 5
   Searching the web…                                            45s

   ✓ Plan research                                            4.2s
   ◐ Search the web                            currently searching…
   ○ Review findings
   ○ Synthesize report
   ○ Done

   ▾ Show technical details
─────────────────────────────────────────────────────────────────────
   [ Stop ]                                          ⓘ Notify me ▾
```

### Execution page (checkpoint pending) — fullbleed treatment

```
─────────────────────────────────────────────────────────────────────
   ←  Research Assistant                              Paused ⏸
   "competitive analysis of Notion vs Linear"

   ╔════════════════════════════════════════════════════════════════╗
   ║                                                                ║
   ║   We need your input                                           ║
   ║                                                                ║
   ║   We've drafted 3 search queries to investigate this.          ║
   ║   Should we proceed, or would you like to refine them?         ║
   ║                                                                ║
   ║   1. "Notion vs Linear feature comparison 2026"                ║
   ║   2. "Linear pricing and enterprise plans"                     ║
   ║   3. "Notion AI capabilities vs Linear automation"             ║
   ║                                                                ║
   ║   [ ✓  Use these queries ]    [ ✎  Refine ]                    ║
   ║                                                                ║
   ╚════════════════════════════════════════════════════════════════╝

   ▾ So far  ─ Plan research (4.2s)
─────────────────────────────────────────────────────────────────────
```

### Execution page (completed)

```
─────────────────────────────────────────────────────────────────────
   ←  Research Assistant                              ✓ Completed
   "competitive analysis of Notion vs Linear"
   Took 2m 14s · ~€0.04

   ┌────────────────────────────────────────────────────────────────┐
   │  # Notion vs Linear: 2026 Comparison                           │
   │                                                                │
   │  Linear and Notion serve overlapping but distinct…             │
   │  (markdown-rendered report — the deliverable, full-width)      │
   │                                                                │
   └────────────────────────────────────────────────────────────────┘

   [ 💬 Continue in chat ]   [ ⟳ Re-run ]   [ ⬇ Download ]   ⋯

   ▾ How it ran  · 5 steps · ~3.5K tokens · Show technical details
─────────────────────────────────────────────────────────────────────
```

The "How it ran" section collapses by default. The deliverable is the headline.

---

## 7. Quick Wins (ship this week)

Fifteen small fixes, each < 1 hour:

1. Rename `t('workflows.title', 'Workflows')` and ~20 related keys (i18n only).
2. Hide execution ID by default; add "Copy link" button instead.
3. Hide token counts unless `Show technical details` toggle is on.
4. Disable "Start Workflow" button when required fields empty (currently shows error on click).
5. Add `aria-label` to all icon-only buttons (refresh, close, expand).
6. Add `prefers-reduced-motion` media query around `animate-spin` / `animate-pulse`.
7. Use single button component for primary actions in this feature (extract `<WorkflowButton>` while you're cleaning up).
8. Add empty-state CTA for first-time users on `MyExecutionsTab`: "Run your first automation →".
9. Add elapsed-time display in the status panel.
10. Add `<title>` updates so browser tab shows current status ("● Running: Research Assistant").
11. Add favicon pulse / badge when workflow runs in background.
12. Remove the "Workflow Structure" preview from start modal — replace with prose "About this automation".
13. Confirm dialog on checkpoint "Reject" / destructive options (`HumanCheckpoint.jsx`).
14. Single status component (`<StatusBadge status="…" />`) — extract and reuse.
15. Drop the gradient header on `WorkflowCard` — flat surface, prominent icon, more whitespace.

---

## 8. Open Questions for the Team

1. **Naming**: Are we open to renaming "Workflows" → "Automations" in the UI? (Schema/code stays.)
2. **Developer mode**: Is the right pattern a global toggle ("Show technical details"), or a per-user setting, or admin-only visibility?
3. **Notifications**: Web Notifications first, or invest in email/Slack hooks?
4. **Analytics destination**: Where do events go? (We need to know before instrumenting.)
5. **Design system priority**: Build workflow-feature primitives now, or wait for a platform-wide design system effort?
6. **Mobile**: Is mobile use a real scenario for workflows? It changes the layout investment.
7. **Backwards compatibility**: Are we OK with breaking the current `/workflows/executions/:id` page in favor of `/runs/:id` (or are we keeping URLs)?
8. **i18n**: Do we have German translators to update DE strings if we rename concepts?

---

## 9. What to do next

If this review resonates, the suggested next steps are:

1. **Validate** with 3–5 non-technical users running the current UI (1 day).
2. **Ship the P0 items** behind a feature flag, A/B against current (1 sprint).
3. **Instrument** before redesigning further — every redesign decision should be measurable.
4. **Establish design tokens** for the workflow feature, then expand to the rest of the platform.
5. **Build one starter workflow + a great empty state** as the new first-impression hero.

The current UI is *capable*. With ~10 days of focused work it could be *intuitive*. With ~30 days of focused work it could be *shiny*.
