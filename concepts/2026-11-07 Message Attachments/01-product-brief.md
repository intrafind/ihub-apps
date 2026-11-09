# Product brief: attachments on sent messages

> Status: written before the build (2026-11-07). The decisions it asks for are recorded in the
> [README](README.md#decisions): variant A was chosen and the remaining ones were settled with the
> defaults named there.

## 1. Is issue #1786 still relevant?

**Yes — but it is mis-framed, and the proposed fix would polish the wrong thing.**

Evidence (checked 2026-11-07 against `main`):

| Check | Result |
| --- | --- |
| Is the code still there? | Yes. `AppChat.handleSubmit` still builds the badges (`AppChat.jsx` L2493–2557) and the three `imageData`/`audioData`/`fileData` IIFEs (L2640–2681). |
| Did it get better or worse? | Worse. `AppChat.jsx` grew from 1 983 to 3 617 lines since the issue was filed. |
| Was it fixed? | No. PR #1933 is still an open **draft** (opened 2026-07-09, last touched 2026-09-22, based on a July `main`). It only extracts helpers that keep emitting the same HTML. |
| Did the product move on? | Yes, a lot. The durable chat-files epic (#3156) and #3352 shipped: server-stored files, composer chips that say what the assistant receives, a Files drawer, and — on a *reopened* chat — structured `message.attachments` chips that open the drawer. |

**What changed in meaning.** In July this was a "duplicated code" finding. Today it is a product inconsistency: the live message is the *only* place that still shows an attachment as a pasted HTML string. The approved chat-files concept (`concepts/chat-files/README.md` §3.4) already says *"compact, clickable file chips in the bubble — never dump raw file info into the message text."* The implementation stopped halfway.

**Recommendation.** Re-scope #1786 from "extract helpers" to "attachments on a sent message are structured data rendered by one component; no HTML in message content". Close #1933 as superseded, but keep its idea for the *other* half of the issue (the three IIFEs → `classifyFiles` / `toApiFileField`), which is still valid and tiny.

## 2. The problem, as a user and an admin meets it

1. **The same message looks different before and after a reload.** Live: a grey pill with an emoji. Reopened: a paper-clip chip with size, clickable. Users read that as "something broke".
2. **Information vanishes at the moment it matters.** The composer chip said "12 400 characters read" / "scan: 3 page images" / "only the text is kept". After Send, the badge shows a file name and nothing else. Nobody can later answer *"what did the assistant actually get from my file?"*
3. **The live badge is dead.** It cannot open the file even though a Files drawer exists.
4. **Not accessible, not themable, not translatable.** Hard-coded `#4b5563`/white, an emoji as the only icon, no list semantics, no accessible name. Accessibility (BITV 2.0 / BFSG / EN 301 549) is a stated customer requirement for this product.
5. **Images travel as base64 inside the message text** — large strings in React state, repeated on every re-render.
6. **Three renderings, two sources of truth** (badge in `content`, `attachments` chips, an audio card). Every new attachment kind — iFinder stubs, e-mails, meetings, pages from the Office add-in, the Office tools epic #3148 — has to be taught to each.
7. **Security smell.** `fileName` is interpolated unescaped into HTML; only DOMPurify at render time stands between a hostile file name and the DOM.

## 3. Why now

- More attachment kinds are coming (Office tools epic). Each one multiplies the cost of the current shape.
- The Files drawer, the composer chips and the stored descriptors already exist — the redesign is mostly *connecting* what is built, so it is cheap relative to its value.
- It is a visible trust feature: "show what the AI read" is the thing enterprise buyers ask for.

## 4. Goals and how we know

| Goal | Check |
| --- | --- |
| One look per attachment on every surface (live, reopened, shared, compare, Office pane, embedded) | Visual tests / screenshots of the same fixture on each surface |
| No HTML in `message.content` | A unit test fails if any producer returns markup; `splitUserMessageContent` and the `hasHTMLContent` branch are deleted |
| Keyboard and screen-reader complete | axe baseline stays green; manual NVDA/VoiceOver pass; name = "report.pdf, PDF, 2.3 MB, opens in Files panel" |
| A user can see what the assistant got from a file | Card shows the same facts as the composer chip |
| Cheap to extend | A new attachment kind touches one mapping function |
| Smaller `handleSubmit` | −150 lines; behaviour of `apiMessage` byte-identical |

## 5. Scope

**In:** how attachments are displayed on *sent user messages* on all surfaces; the data shape that feeds it; deleting badge generation; making live and reopened identical.

**Out:** the composer chips and `AttachedFilesList` (already redesigned in `concepts/attached-files-list-collapse/`), Files-drawer internals, server storage and quotas, what is sent to the model (payload must stay byte-identical), assistant-*generated* files (a follow-up may align their look).

## 6. Decisions for the product owner (answered in the README)

1. **"It shouldn't be there at all" — which reading?** I assume *both*: (a) not in the message **data** (`content` stays plain text), and (b) not **inside the bubble's text** — attachments become their own block attached to the message. If you meant only (a), the visual result is smaller.
2. **Old data.** If any stored or in-flight message contains the old HTML, is it acceptable that it shows as plain text with the markup stripped? (CLAUDE.md: we ask before adding compatibility shims.) The architect checks whether this even exists.
3. **Images.** Thumbnails in the attachment block vs. today's large inline picture.
4. **Audio.** Keep an inline player for the user's own audio, or treat audio like any other file card?

## 7. Risks

- Regression in surfaces nobody opens daily (Compare mode, shared chats, Office pane, Nextcloud embed) — mitigated by one shared view-model and one component.
- Edit-and-resend relies on files held in memory (`message.fileData`); the change must not drop them.
- Visual change is user-visible: needs a release note (`docs/releases/next/`) and both German and English strings.
