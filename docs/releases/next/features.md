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

## App Drafts with AI: Choose the Model That Prepares Drafts

Admins can now choose which AI model prepares app drafts, for admin apps and personal apps:
**Admin → Platform → Features → Model for drafts**, below the switch **App Drafts with AI**.

- **Automatic (recommended)** keeps the previous behaviour: the standard chat model among the
  models the author may use. The option names the model it currently picks.
- A chosen model is used only for authors whose groups may use it; everyone else keeps preparing
  drafts with the automatic choice. A chosen model that is disabled or deleted is marked as not
  available, and drafts use the automatic choice until another model is picked.
- The **New app** page names the model the description is sent to, as before.

## Admin Edit Pages: The Save Bar Shows Only When Something Changed

When you change something on an admin edit page, a bar at the bottom of the screen now offers **Save Changes** and **Discard**. It is gone when nothing changed. Until now only a few pages worked this way, and most others had a Save button that was always there.

- **The edit pages of** prompts, models, users, agents, agent inboxes, workflows, document templates, providers, short links, OAuth clients, CIMD clients, custom pages and skills use the bar, as apps and groups already did.
- **A new item** says **Create** instead of **Save Changes**. An item made from a template or a copy can be created at once.
- **Discard** puts the page back to what is saved, including the JSON view and the fields next to the form.
- **The CIMD client editor** now asks before you leave it with unsaved changes.
- **The settings pages** Authentication, Features, Feedback, Chat History, Localization, Telemetry, Voice Input, MCP Gateway, OAuth Server, Nextcloud Embed, Browser Extension, Copilot Agent and Office Integration use the bar too, and it is only offered once the settings have loaded. A refused save is named in the bar.
- **The Copilot Agent page** has one Save for the reference ID and the agent settings together. An invalid agent field now also blocks saving the ID, which used to save on its own.
- **The OAuth Server page** now asks before you leave it with unsaved changes. After a save conflict, **Reload and discard my changes** shows the stored values and ends your edits instead of mixing them in.
- **The translation overrides** on the Localization page keep their own Save for each text.
- **Pages with several sections have one bar for the whole page.** Security, Logging, the EU AI Act cards, Scheduled Tasks, the Integration Builder, the Installation page of an integration, the visual workflow editor and a new project no longer have a Save button per section. **Save Changes** stores every section with changes, in the order of the page; if one is refused, the ones before it stay saved and a second **Save** sends only the rest. **Discard** puts every section back.
- **The cards inside list pages** (usage limits, LLM timeouts, project sharing, personal apps, user prompts and skills) use the bar too. A value that is out of range no longer greys the button out: **Save** names the problem in the bar.
- **The app order** on the Apps list is saved with the bar. **Done** leaves the order mode and keeps your draft, and the bar saves or discards it.
- **Prompt variables** on the Prompts list are saved with the bar.
- **Provenance settings** still ask for confirmation before a change that needs it; **Cancel** in the confirmation ends the save and keeps your edits.
- **Logging: the privacy settings** no longer write the whole logging block when you save them.
- **The Installation page** keeps a pending approval edit when you save the Settings with Enter. Discard no longer jumps back to the Overview tab.
- Credentials (a dialog) and the translation overrides keep their own Save.
