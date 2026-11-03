# Office Hosts and Model-Driven Office Tools

**Date:** 2026-11-03
**Status:** Proposal
**Epic:** [#3148](https://github.com/intrafind/ihub-apps/issues/3148)
**Supersedes:** [2026-04-30 Outlook Add-in Word Support Extension](../2026-04-30%20Outlook%20Add-in%20Word%20Support%20Extension.md) (written for the former `ihub-outlook-addin` repository; its paths do not exist here)
**Related:** [Outlook Add-in Rollout Guide](../../docs/outlook-add-in.md), [Agent loop](../../docs/agent-loop.md), [One Agentic Loop](../2026-08-26%20One%20Agentic%20Loop%20—%20Unified%20Runtime%20for%20Chats,%20Workflows%20and%20Agents.md), [Unified Integrations](../2026-10-20%20Unified%20Integrations/), [Tiptap OSS Agentic AI Layer — Option C](../2026-06-16%20Tiptap%20OSS%20Agentic%20AI%20Layer.md)

---

## Problem

The iHub Outlook add-in is **context in, action out**. The task pane sends the open email as `hostContext`. The model answers, and the user then picks an answer action: reply, reply all, forward, new email, or insert into draft. The model can never read a draft it was not given, revise the draft in place, set a subject, add a recipient, or chain those steps. There is no add-in for Word, Excel or PowerPoint at all. The *Office 365 integration* only browses OneDrive, SharePoint and Teams files.

Competing products already do more. One example is DeutschlandGPT, whose manifests and taskpane code were analysed on 2026-11-02:

| | Outlook | Word | Excel | PowerPoint |
|---|---|---|---|---|
| Manifest | MailApp, `ReadWriteMailbox`, Mailbox 1.5, Message only | TaskPaneApp, `ReadWriteDocument`, WordApi 1.5 | ExcelApi 1.9 | PowerPointApi 1.4 |
| Ribbon | Open-pane button only | 4 buttons | 4 buttons | 5 buttons |
| Model tools | `getEmailContent`, `draftReply`, `getDraftBody`, `setDraftBody`, `rewriteSelection`, `prependToBody`, `setDraftSubject`, recipients, attachments, appointment | selection, outline, search, comments, tracked-change insert/replace, styles, tables, footnotes, TOC | outline, ranges, formulas, tables, sort/filter, conditional formats, charts, pivots | slides, notes, deck snapshot → apply as copy or replace, deck generation |

All four of their add-ins load one shared Next.js chat application. Only a small bootstrap and the ribbon `commands.html` differ per host. Their Word ribbon has a "one-shot" path. It reads the bearer token from `localStorage` and replaces the selection without a preview. This design does **not** adopt that path.

iHub is ahead on several points, and the design keeps all of them:
- calendar items
- the narrower `ReadWriteItem` permission
- structured `<content>` blocks with tag escaping and `<context_rules>`
- the start page, chat history and pop-out window
- the admin-provisioned OAuth client
- the Office.js `cdn` / `proxy` / `bundled` / `custom` modes
- iFinder "Add to email"

## Goals

- The model can **read and change** the open Outlook item, Word document, Excel workbook or PowerPoint presentation through tools. Office.js runs in the task pane; the agent loop runs on the server.
- Every change that touches recipients, attachments or whole bodies, or overwrites cells, needs explicit user **approval** in the chat.
- Word, Excel and PowerPoint add-ins reuse the existing pane, sign-in, start page and admin page.
- Content the model reads through a tool is **not stored**, consistent with the documented promise that the open email is not stored.

## Non-goals

- Sending mail. Office.js cannot send, and the add-in must not emulate it.
- The unified JSON (Teams) manifest. This design uses one XML manifest per host.
- Unattended ribbon actions that write without the pane.
- Outlook mobile-specific surfaces.

## Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Tools execute in the pane and return their result to the **same run** (`clientToolSeam` + `InteractionService.waitForAnswer`). The design does not pause and resume. | Multi-step chains (read draft → rewrite → set subject) need one run. The loop's `preTool` seam and the cluster-safe `waitForAnswer` already exist. |
| D2 | A **generic chat approval gate** is built now and used first by the Office write tools. | No per-call approval exists in chat today. Later, #2916 and #2945 plug their policy into the same gate. |
| D3 | **One XML manifest per host**, each with its own add-in GUID. | A MailApp and a TaskPaneApp cannot share one XML manifest. XML manifests also work on volume-licensed Office. |
| D4 | One `taskpane.html` for all hosts; the host is detected at runtime from `Office.context.host`. | One build and one entry; host adapters plug into `EmbeddedHostContext`. |
| D5 | Ribbon buttons only **hand the action to the pane**. | No token in a commands page, and no unattended writes. |
| D6 | Outlook keeps `ReadWriteItem` and gets no send tool. | The tools need no more permission than that. |
| D7 | Word writes are tracked changes by default. An admin setting changes the default, and users can override it. | Changes stay reviewable in Word itself. |

## Documents

| Doc | Content | Phase |
|---|---|---|
| [01 Client-executed tools](01-client-executed-tools.md) | The loop seam, interaction kind, event protocol, redaction, failure modes | P1 |
| [02 Chat approval gate](02-chat-approval-gate.md) | Per-call approval in chat, the approval card, and the Office pane fix | P1 |
| [03 Outlook tools](03-outlook-tools.md) | The Outlook integration, tool set, client registry, admin settings | P2 |
| [04 Host foundation](04-host-foundation.md) | Manifest per host, host adapters, ribbon handoff, `hostContext` types, admin per host | P3 |
| [05 Word](05-word.md) | Word add-in and tools | P4 |
| [06 Excel](06-excel.md) | Excel add-in and tools | P5 |
| [07 PowerPoint](07-powerpoint.md) | PowerPoint add-in and tools | P6 |

## Phases

```
P1 Foundation (client tools + approval gate)
 └─ P2 Outlook tools ──────────────┐
 └─ P3 Host foundation             │  (P2 and P3 can run in parallel after P1)
     ├─ P4 Word
     ├─ P5 Excel
     └─ P6 PowerPoint (last: thinnest Office.js coverage)
```

Each phase ships on its own, behind its own admin switch:
- `officeIntegration.hosts.<host>.enabled` for the add-in
- `…tools.enabled` for the model tools, off by default

## Status

Proposal. Each phase has a sub-issue under #3148.
