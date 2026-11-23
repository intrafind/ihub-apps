# Features — Unreleased

## Personal Apps: Blocked Owners Are Locked Out, and Other Changes

Changes to the preview feature **Personal apps** since 5.7.4:

- **A blocked owner can no longer change their apps.** When an administrator switches off all
  apps of one person, that person can no longer edit, share or delete them, and the people the
  apps are shared with as **Can edit** cannot edit them either. The editor shows the app
  read-only with the reason. Administrators keep every ability they had.
- **Changes by people with Can edit count like the owner's.** The owner's tool approval settings
  apply to the app whoever saved its current content.
- **A published app remembers its personal app.** The company app that publishing writes records
  the personal app it came from (`sourceUserAppId`). Only a company app with that entry counts as
  the published version of the personal app; if the file is replaced by another app, the
  personal app becomes editable again. Apps published with 5.7.4 get the entry on the first
  start after the update, so they stay published.
- **Copy an existing app** on the personal **New app** page no longer lists apps connected to
  the iAssistant, because a copy would lose the connection.

## App Drafts with AI: Choose the Model That Prepares Drafts

Admins can now choose which AI model prepares app drafts, for admin apps and personal apps:
**Admin → Platform → Features → Model for drafts**, below the switch **App Drafts with AI**.

- **Automatic (recommended)** keeps the previous behaviour: the standard chat model among the
  models the author may use. The option names the model it currently picks.
- A chosen model is used only for authors whose groups may use it; everyone else keeps preparing
  drafts with the automatic choice. A chosen model that is disabled or deleted is marked as not
  available, and drafts use the automatic choice until another model is picked.
- The **New app** page names the model the description is sent to, as before.
