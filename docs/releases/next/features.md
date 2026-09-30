# Features — Unreleased

## Prompt Library: Your Own Prompts, Sharing and Variables

Signed-in users can now write prompts of their own and share them, and every prompt can ask for
the details it needs. Admin-curated global prompts work as before.

- **My prompts:** create a prompt with **New prompt** on the Prompts page, or hover a message you
  sent and choose **Save as prompt**. Prompts are private until you share them. You can duplicate
  any global or shared prompt into your own prompts to adapt it.
- **Sharing:** share a prompt with specific users, with groups, or with everyone signed in, as
  **Can use** or **Can edit**. People with **Can edit** can change the prompt and share it
  further; only the owner and admins can delete it. Removing a share takes the prompt away at once.
- **Variables:** write `{{tone}}`, `{{recipient}}` or any other name in the prompt text. When the
  prompt is used, a short form asks for the values, checks required fields and shows a preview.
  The final text is put into the chat input, not sent. `{{user_name}}`, `{{date}}` and the other
  global variables fill in by themselves, and `{{content}}` marks where your own text goes. Each
  variable can get a label, help text, type, default value and options.
- **Using prompts:** clicking a prompt on the Prompts page opens a chat in its app, or in the
  default app, with the text ready. The page filters by **My prompts**, **Shared with me**,
  **Global** and **Favorites**, and each card shows whether a prompt is global, yours or shared,
  and by whom. The `/` search in the chat lists favorites, recent prompts, your own, shared and
  global prompts.
- **History:** every save is kept as a version that can be viewed and restored.
- **Favorites and recents** are stored with your account and follow you to other browsers and
  devices. What this browser remembered is carried over the first time.
- **Admins:** **Admin → Prompts → User prompts** lists the prompts shared with groups or with
  everyone. Admins can edit, re-share, delete or promote them to a global prompt, which keeps the
  author's name. The same tab holds the settings: turn user prompts off (admins can still look
  after the existing ones), limit the prompts per user and the versions kept, and choose whom users may share with — optionally only members of
  certain groups may share with groups or everyone. Every change is written to the audit log.
- If the account of a prompt's owner is deleted or deactivated, the prompt stays available to
  everyone it was shared with, read-only.

## EU AI Act: AI Disclosure, Content Marking and Detection

iHub now implements the transparency duties of Article 50 of the EU AI Act. People see that they
are talking to an AI before their first message, generated images and exports carry signed,
machine-readable marks, and every installation can detect its own marks. A new page,
**Admin → EU AI Act**, shows whether the installation conforms and where to fix it. The feature
flag **EU AI Act Transparency** is on by default. See [EU AI Act Transparency](../../eu-ai-act.md).

- **Disclosure:** a notice in the empty chat, an "AI" badge at the input, an "AI generated" chip
  on every answer with model, time and marking status, reminders in apps marked as sensitive, and
  a system-prompt rule that the model always says it is an AI when asked. Jira comments written
  by the Jira tool, Outlook inserts, workflow HTTP requests and shared chats carry an AI label.
  Only admins can switch the disclosure off for an app, with a reason that is kept in the app and
  the audit log.
- **Images:** every generated image gets a signed C2PA manifest, an invisible TrustMark watermark
  and XMP metadata before it is shown, stored or downloaded. Google SynthID is kept.
- **Exports:** all exports are now made on the server — PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown,
  HTML, JSON, JSONL. Users choose the messages to export; files carry a visible AI label, an
  optional "AI" icon and signed provenance metadata. The browser print dialog is gone.
- **Signing certificate:** each installation creates its own CA and signing certificate on first
  start. Admins can install their own certificate (PEM or PKCS#12), generate a CSR, rotate and
  switch back; old certificates keep verifying.
- **Models:** each model declares how it marks its output. Models that do not mark text are
  flagged "Not marked" and stay non-conforming; switching one on asks for a justification.
  Self-hosted vLLM models can be watermarked with iHub-managed keys that several installations
  can share through an encrypted key bundle.
- **Detection:** `/verify` (and `POST /api/provenance/verify`) checks files and text, names the
  technique that found the mark and offers a signed report. Nothing submitted is stored. The iHub
  binary verifies files offline with `ihub verify <file>`. `/.well-known/ai-provenance` tells
  verifiers which detector to use.
- **Provenance:** a record per answer (hash, model, time — never the content), also without chat
  persistence; API and MCP responses carry `ihub_provenance` / `_meta.provenance`.
- **Oversight:** admins see a start-page banner when something does not conform; model and
  certificate warnings can be dismissed with a justification without changing the status. The
  page exports a signed compliance report and runs a marking robustness self-test.
