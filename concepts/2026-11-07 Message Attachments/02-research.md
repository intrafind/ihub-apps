# Attachments on sent chat messages: evidence report

> Written 2026-11-07 from web research. Claims are tagged V (page fetched), V* (search-result
> summary only) or M (from memory, unverified). Treat M as a hint, not as evidence.

**Legend.** V[n] = page fetched (source n; fetched pages were summarised by a small model). V*[n] = seen only in a search-result summary, page not read. M = from memory, unverified. Code claims for Open WebUI and LibreChat come from raw GitHub source. help.openai.com returned 403 and claudeissues.com is blocked, so no first-party page describing the sent-file card of ChatGPT, Claude, Gemini, Perplexity, Le Chat or Copilot Chat was reachable. Their layouts are therefore mostly M.

## (a) Comparison (dimensions: 1 placement, 2 card, 3 click, 4 multi-file, 5 media, 6 states, 7 reload/share, 8 edit)

| Product | 1, 2, 5: placement, card, media | 3, 4: click, multi-file | 6, 7, 8: states, persistence, edit |
|---|---|---|---|
| ChatGPT | M: cards/thumbnails above and outside the user bubble, right-aligned; coloured type icon, name, type label; images as thumbnails | M: image lightbox, document preview. V*[7]: preview beside the conversation with citations for Box/Dropbox/SharePoint files (Sep 2026). V*[7]: 20 files per upload (was 10) | V*[7]: long pastes become an attachment, "Show in text field" reverses it; files saved to a Library; Jun 2026 fix for "editing messages with attachments". V*[8]: forum posts quote "files you've previously uploaded have expired"; retention follows the chat |
| Claude.ai | M: card with type badge/thumbnail in or above the user message | M: preview. V[4]: 20 files/chat, 500 MB each | V[4]: PDF up to 100 pages read as text+visuals, 101–1000 text only, over 1000 rejected ("Uploaded file is too large"); other documents text only, embedded images unread. V*: Jun 2026 bug reports of empty, non-clickable sent chips (Windows) and of a pasted-text attachment reaching the model empty |
| Gemini | M: chips/thumbnails above the input, outside the bubble | M. V[5]: 10 files/prompt, 100 MB (video 2 GB) | V[5]: errors "Delete data to upload file", "reached your limit for chats with files", "uploads may be too large for the best results", "failed to analyze… re-upload"; no expiry stated, counts against Gemini Apps storage. V[6]: in-chat preview and full-screen expand for generated files (29 Oct 2026; PDF on mobile+web, rest web-only) |
| M365 Copilot Chat | Not found. V[9]: "will appear as an attachment in your chat session" | V[9]: 20 files/conversation, 50 MB | V[9]: kept no longer than 18 months. V*: stored in OneDrive folder "Microsoft Copilot Chat Files". Copilot Studio agents: V[10] a failed attachment is skipped and the message still sends; deleted 28 days after last activity. V[11] generated-file card below the reply: name, type, preview or icon, Download |
| Perplexity | M: chip in thread | V*[15]: "+ Attach" | V*[15]: short files read in full, long files reduced to relevant parts; thread files deleted after 7 days (older page: 30), not saved to a Space |
| Le Chat | M | V*[16]: drag or "+" | V*[16]: PDF/DOCX/PPTX/CSV/TXT/MD/XLSX; no preview feature found; Libraries answer "with direct references" |
| Open WebUI | V[1]: block above the text bubble (hidden in edit mode), aligned to sender; images via `Image` max-h-96; other files as small `FileItem`: icon, name, type label, size [2] | V[2]: click opens `FileItemModal` or `/content` in a new tab. V[1]: flex-column, wraps, overflow-x scroll, no "+N" | V[2]: loading spinner only, no error state, no `aria-busy`. V[32]: deleted image shows "Image unavailable"; no expiry. V[1]: edit copies files into an editable list (remove shown, add not shown). V[32]: per-file Full Context vs Focused Retrieval, citations |
| LibreChat | V[3]: non-images first (`FileContainer`, full width), then images right-aligned | V[3]: file click opens `FilePreviewDialog`; images have no click | V[3]: share view skips the live file map (`shareId` branch). V*: "Upload as Text" vs "Upload to Provider" |
| LobeChat | M for card. V*[17]: PDF/Excel/Word/PPT/TXT previews, chunk fragment preview | – | – |
| Slack | V[13]: preview "as part of your message"; image previews only under 25,000 px/45 MP; Office files over 50 MB get none. M: file card under text | V[13]: up to 10 files per message, reorder before send, "Download N files" in the message menu | V[14]: Block Kit file block is read-only, for remote files |
| Teams | V[12]: files stored in OneDrive/SharePoint, shown as file cards; FileInfoCard = name + fileType + uniqueId | V[12]: open from the card | V[12]: bot download URL expires, so "attach the file again"; a 403 can mean no access or nonexistent |
| WhatsApp, iMessage, Telegram | M: document bubble with icon, name, size, page count; photos as grid with "+N" overlay; Telegram albums up to 10 (V*) | M | M |
| GitHub Copilot Chat | V[30]: "Used n references" dropdown above the reply; paperclip, `#` mentions | – | – |

## (b) Distilled patterns

1. **Attachments are a block separate from the text flow**, above the text (Open WebUI V[1], LibreChat V[3], ChatGPT M) or below a reply for generated files (Copilot Studio V[11]).
2. **Two render classes**: image = thumbnail, everything else = compact row card (Open WebUI V[1], LibreChat V[3], GOV.UK V[19]).
3. **Name + type + size is the minimum card** (Open WebUI V[2], GOV.UK V[19], Carbon V[18]). Page count appears only in messengers (M).
4. **Click opens preview first, download second**: dialog (V[2], V[3]), side or full-screen view (ChatGPT cloud files V*[7], Gemini V[6]).
5. **Remove is its own target** with `stopPropagation` (V[2]); Material 3 asks 48 dp with 8 dp spacing (V*[20]).
6. **Overflow**: wrap or stack (Carbon stacks vertically V[18]); horizontal scroll is the overflow fallback (Open WebUI V[1], Siemens iX V*[21]). A "+N" collapse appears only in messengers (M). Count caps cluster at 10–20 (V[4],[5],[9],[13]).
7. **Lifecycle states are distinct**: selected / uploaded / processed / sent (V[22]); loading, success, uploaded, error (V[18]).
8. **Expiry is real**: 18 months, 28 days, 7 days (V[9], V[10], V*[15]). Guidance says show an unavailable state, not a stale thumbnail (V[22]); Open WebUI shows "Image unavailable" (V[32]).
9. **Disclose what the model can read, by type and size**: Claude PDF page tiers (V[4]), Gemini "too large for best results" (V[5]), Perplexity "relevant parts" (V*[15]), Open WebUI Full Context vs Focused Retrieval toggle (V[32]).
10. **Provenance after the answer**: "Used n references" (V[30]), page-level citations (`page_location`, V*[31]), Le Chat Library references (V*[16]). V[22] warns a successful upload does not prove the whole document was read.
11. **Large paste becomes an attachment with a way back to text** ("Show in text field", V*[7]). The generic name `pasted.txt` is a known complaint (V[8]).
12. **Files may live outside the chat** (OneDrive/SharePoint V[9], V[12]), so permission and deletion states differ from "expired".

## (c) Anti-patterns

- Silent skip: Copilot Studio drops a failed attachment and sends anyway (V[10]). Fine only if the user is told.
- Card visible but model received nothing (Claude paste bug, V*).
- Error surfaced far from the control and missed (NN/g V[23]).
- Spinner with no error state or live region (Open WebUI V[2]).
- Stale thumbnail implying permanence (V[22]); empty or dead chips (Claude bug, V*).
- Remove control revealed on hover only (Open WebUI default V[2]).
- Colour-only status (WCAG 1.4.1 V[25]).
- Inference, not sourced: horizontal scroll for attachments conflicts with reflow at narrow widths; tooltip-only full filenames fail on touch.

Not found: NN/g, Apple HIG, Fluent 2, Atlassian and IBM Carbon have no chat-attachment-card guidance I could retrieve. Nearest are Carbon file uploader V[18], Material 3 chips V*[20], SAP Joule and Siemens iX V*[21], GOV.UK attachment V[19]. Slack Block Kit and Teams cards V[14], V[12] are API-level, not design guidance.

## (d) Accessibility checklist

- [ ] List: `<ul>`/`<li>` for the cards. `list-style:none` removes list semantics in Safari/VoiceOver, so add `role="list"` (V*[27]).
- [ ] Opens an in-app preview: `<button>`. Navigates or downloads: `<a href>` (M, APG). Remove is a second, separate button (4.1.2).
- [ ] Name starts with the visible text: "report.pdf, PDF, 2.3 MB". Keep type and size in the name or description (V[19]); visible label must be contained in the name (2.5.3, V[25]). Put the action ("opens preview") in `aria-describedby`, not in a different name.
- [ ] Thumbnail and icon are `aria-hidden`/empty alt; GOV.UK hides thumbnail and its wrapping link (V[19]).
- [ ] Emoji icons are read by their Unicode name (V*[29]). Do not use them as the only icon; hide them or label them.
- [ ] Status (uploading, failed, unreadable, expired): text, not colour alone (1.4.1). Announce via `role="status"`, polite; `alert` only for urgent errors (4.1.3, V[25]). Set `aria-busy` while loading. A stale "Processing" must not stay announced.
- [ ] Contrast: text 4.5:1 (1.4.3, M); icons, borders and focus ring 3:1 (1.4.11, V[25]).
- [ ] Focus visible (2.4.7) and not obscured by sticky composer (2.4.11, new in 2.2). Focus returns to a sensible element after a dialog closes (Carbon V[18]).
- [ ] Target at least 24x24 CSS px (2.5.8 AA, V[25]); aim for 44–48. Separate spacing or equivalent control for the remove button.
- [ ] Forced colors: inline SVG with `currentColor`; no `background-image` for essential icons; keep a real border on cards (V*[28]).
- [ ] Dark mode: tokenised colours, re-check 1.4.11 on thumbnails and badges.
- [ ] Reflow at 320 CSS px, text spacing, 200% zoom: filenames wrap or truncate with the full name reachable by keyboard and touch (1.4.10, V[25]).
- [ ] Legal baseline: BITV 2.0 points to EN 301 549. V3.2.1 (WCAG 2.1 AA) is still the cited harmonised version; V4.1.1 (WCAG 2.2 AA) was published 2 Sep 2026 (V*[26]). BFSG applies since June 2025. Target WCAG 2.2 AA now.

## (e) Implications: self-hosted chat in a ~280 px Outlook task pane and embedded hosts

- Microsoft's reference task-pane sizes are 320–350 px wide (Outlook web 320x570, V[24]). 280 px is below WCAG's 320 px reflow reference (V[25]), so the card must work single-column with no horizontal scroll.
- Prefer container queries over viewport queries when the chat is mounted in a host page rather than an iframe (M).
- Open WebUI's horizontal-scroll overflow (V[1]) is the pattern least suited to this width. Carbon-style vertical stacking (V[18]) fits better.
- Previews that need a side panel (ChatGPT V*[7], Copilot Cowork V*) have no room at 280 px; Open WebUI and LibreChat use a modal/dialog (V[2], V[3]).
- Download or open-in-new-window from inside an Office pane may be restricted by host sandboxing (M; test it).
- Self-hosted deployments have admin-defined retention and file deletion, so "expired", "deleted" and "no access" need separate states (V[12] shows 403 is ambiguous). A shared or exported view may lose file metadata (LibreChat V[3]), so decide what a share renders.
- Customers run Open WebUI/LibreChat today. Open WebUI has no card error state or `aria-busy` (V[2]); a gap to beat, not copy.

## (f) Sources

1. https://raw.githubusercontent.com/open-webui/open-webui/main/src/lib/components/chat/Messages/UserMessage.svelte
2. https://raw.githubusercontent.com/open-webui/open-webui/main/src/lib/components/common/FileItem.svelte
3. https://raw.githubusercontent.com/danny-avila/LibreChat/main/client/src/components/Chat/Messages/Content/Files.tsx
4. https://support.claude.com/en/articles/8241126-uploading-files-to-claude
5. https://support.google.com/gemini/answer/14903178
6. https://workspaceupdates.googleblog.com/2026/10/create-preview-and-edit-files-directly-in-the-Gemini-app.html
7. https://help.openai.com/en/articles/6825453-chatgpt-release-notes (search summary only; fetch 403)
8. https://community.openai.com/t/chatgpt-converts-pasted-text-to-file-attachment-pasted-txt/1369685 ; https://community.openai.com/t/it-seems-that-some-of-the-files-youve-previously-uploaded-have-expired/1005280
9. https://support.microsoft.com/en-us/microsoft-365-copilot/file-upload-in-microsoft-copilot
10. https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/attachments-overview
11. https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/created-files-overview
12. https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4
13. https://slack.com/help/articles/201330736
14. https://docs.slack.dev/reference/block-kit/blocks/file-block/
15. https://intercom.help/perplexity-ai/en/articles/10354807-file-uploads (search summary)
16. https://help.mistral.ai/en/articles/347521-how-do-i-upload-images-or-documents-to-le-chat ; https://docs.mistral.ai/le-chat/knowledge-integrations/libraries (search summary)
17. https://lobehub.com/changelog/2024-08-21-file-upload-and-knowledge-base (search summary)
18. https://carbondesignsystem.com/components/file-uploader/usage/
19. https://design-guide.publishing.service.gov.uk/components/attachment
20. https://m3.material.io/components/chips/guidelines (search summary)
21. https://www.sap.com/design-system/fiori-design-android/v26-4/joule/patterns/joule-attachment ; https://ix.siemens.io/docs/components/chat-attachment/guide (search summary)
22. https://screensdesign.com/articles/mobile-ai-chat-file-attachment-ux/
23. https://www.nngroup.com/articles/prompt-controls-genai/
24. https://learn.microsoft.com/en-us/office/dev/add-ins/design/task-pane-add-ins
25. WCAG 2.2 Understanding pages: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html , /status-messages.html , /non-text-contrast.html , /label-in-name.html , /use-of-color.html , /reflow.html
26. https://www.dwt.com/insights/2026/09/european-accessibility-act-ict-standards-update (search summary)
27. https://www.scottohara.me/blog/2019/01/12/lists-and-safari.html (search summary)
28. https://github.com/w3c/aria-practices/pull/1878 (search summary)
29. https://blog.pope.tech/2026/04/01/making-emojis-and-icons-screen-reader-accessible/ (search summary)
30. https://docs.github.com/copilot/using-github-copilot/asking-github-copilot-questions-in-your-ide
31. https://platform.claude.com/docs/en/build-with-claude/citations (search summary)
32. https://docs.openwebui.com/features/chat-conversations/rag/ ; https://docs.openwebui.com/features/chat-conversations/data-controls/files/
