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
