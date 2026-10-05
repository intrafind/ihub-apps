# Features — Unreleased

## Skills: Users Pick Ready-Made Skills From the Marketplace

Users no longer have to write their first skill from scratch, and admins no longer have to install
every skill for everyone. With the marketplace switched on, users browse the skills of the enabled
registries in the library and add the ones they want to their own skills.

- **New → Skill from the marketplace** in the library lists the skills with search (in every
  language the catalog has), category and source filters, and a preview of each skill's
  instructions, license and files.
- Users without skills of their own see a **Browse the marketplace** prompt on the **Skills** tab.
- An added skill is a private copy: it can be renamed, edited, shared and promoted like any user
  skill and is invoked with `/name`. Files a user skill cannot hold (images, PDFs, nested folders)
  or that exceed the limits are left out, and the user is told.
- It is on while the **Marketplace** feature is on and a registry has been refreshed. Switch it off
  under **Admin → Skills → User skills → Settings** ("Users may add skills from the marketplace").
  
## Settings → Integrations: easier to scan with many connected apps

The Integrations page now shows its information on demand instead of all at once, so it stays
readable when a user has connected many AI clients such as several Claude Code installations.

- Each connected app is a single row with its last use, connection date and number of permissions;
  the permission list opens when the row is clicked.
- Apps connected before iHub stored display names now show the application's registered name
  instead of a technical client ID such as `client_claude_code_ihub_1eef9d16`. This applies to
  the admin connections list too.
- Connected apps are listed by most recent use. The five most recent show by default, the rest
  behind **Show all**, and a search box appears once there are more than five.
- The personal API key endpoints are folded behind an **Endpoints** toggle below the keys.
- The page is grouped into **Your accounts** (Jira, cloud storage, MCP servers) and **Access to
  iHub** (connected apps, personal API keys, Outlook add-in).
- The note that an issued access token stays valid for a while after disconnecting now appears
  in the disconnect confirmation, where it matters, and the "More integrations coming soon"
  placeholder is gone.

## Skills: Create a Skill With AI

Users can describe a skill in a chat instead of writing it. **New → Create skill with AI** in the
library opens a chat with the **skill-builder** skill, which asks a few questions and drafts the
skill. **Save as skill** under the answer opens the skill editor with the name, description,
instructions and reference files filled in, ready to review and save.

- `skill-builder` now ships with iHub as a global skill and is assigned to the **Chat** app, also
  on existing installations. The entry is offered when the Agent Skills feature and user skills
  are on and the skill is granted to the user's groups.
- **Save as skill** appears under any finished answer that contains a drafted `SKILL.md`, in every
  app.
- To hide the entry, remove `skill-builder` from every chat app it is assigned to under
  **Admin → Apps** (on a new installation, that is Chat); assign it to other apps to offer it there.

## Skills: Skills Stay Active for the Whole Chat

A skill now stays active for the rest of the chat once it is loaded, whether the user named it with
`/name` or the model chose it. Follow-up messages are answered with its instructions without naming
it again, so interview skills such as **skill-builder** keep asking their questions instead of
forgetting them after the first answer.

- Access is checked again on every turn: a skill whose grant, app assignment or share is removed
  is no longer active. At most `skillSettings.maxActiveSkills` (default 3) skills are active at
  once, the ones named in the current message first, then the most recently activated ones.
- `skills.maxSkillBodyTokens` in `platform.json` now applies: an active skill with longer
  instructions stays active by its description, and the model reads the instructions when it needs
  them. All active skills together take at most a quarter of the model's context window.
- New `skills.maxCatalogTokens` (default 3000) caps the list of skills the model is offered in
  every message. Apps with many skills get shortened descriptions, then names only, and the model
  searches the skills with a new **Find Skill** tool. Existing installations get the setting on
  upgrade.
- A global skill whose `SKILL.md` sets `disable-model-invocation: true` is started only by users
  with `/name`: the model is not offered it and agents do not use it.
