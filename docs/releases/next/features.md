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

## Groups: Manage Members, Quotas and Integrations from the Group Page

Admins can now add users to a group from the group, instead of opening every user to add the
group there, and the group page shows only what has been set.

- **A Members section on the group page** lists the users that belong to the group and lets you
  remove one with a click. Search the users by name, username or email, tick the ones you want
  and add them. Changes apply immediately; the group does not need to be saved.
- **After creating a group**, its page opens so you can add the first members right away.
- Removing the last administrator from a group that grants administrator access is refused, as
  it is on the user page. Users who get the group from an external provider through its mappings
  are not listed; the section says so for groups that have mappings.
- **Usage limits show only the limits that are set.** A group without limits shows no input.
  **Add a limit** adds all models together, file storage, one model or all other models as a
  card; **Remove** takes it away. The same applies to the personal limits on the user page.
- **Integrations show only the ones granted.** The group lists the integrations it has been
  given, and **Add an integration** offers the rest. **All integrations** is shown as one entry
  and hides the individual ones.
- **Save and Discard appear at the bottom when you change something**, like on the other
  settings pages, instead of a permanent Save button.
