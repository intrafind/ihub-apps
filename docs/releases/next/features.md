# Features — Unreleased

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

## Library: Tidier Search and Filter Bar

The top of the library (`/prompts`) is cleaner: search, sort and the "New" button line up at the
same height, and all filters sit together in one row instead of stacked lanes.

- Type (All, Prompts, Skills) and scope (All, Mine, Shared with me, Global, Favorites) are matching
  segmented controls side by side.
- Prompt categories are a "Category" dropdown in the same row; the selected category shows its
  configured color as a dot. The dropdown always offers "All categories", so
  `promptsList.categories.showAll` no longer has an effect on the library.
- On phones, sort and "New" share a row and the filters wrap instead of scrolling out of view.

## Skills: Skill Builder App

iHub now ships a **Skill Builder** app. Users describe a task they keep repeating, or paste a
prompt, Gem or custom GPT instructions, answer a few questions and save the drafted skill with
**Save as skill**. Admins no longer need to create an app and assign the **skill-builder** skill
for **New → Create skill with AI** in the library to work.

- The app runs **skill-builder** from the first message on, so users do not have to type
  `/skill-builder`. **Create skill with AI** opens it directly.
- Existing installations get the app on upgrade; an app of your own saved under the id
  `skill-builder` is kept as it is. It is available to the groups whose app permissions include
  it. To take it away, disable it under **Admin → Apps**.
- Users only see the app while **Agent Skills** is on under **Admin → Features**. Until then,
  **Admin → Apps** lists it as hidden from users.
- New app settings, also for other apps: `requiredFeatures` hides an app from users while one of
  the listed features is off, and `skillSettings.autoActivate: true` runs the app's skills on
  every message without `/name`.
- The interview now wraps up after a couple of rounds and writes a full draft instead of asking
  on indefinitely, asks closed questions (who it is for, the format, the language) as clickable
  choices, and flags up front when a task needs more than a skill can do on its own (generating a
  PowerPoint or other binary file, running code), offering what it can still produce — the slide
  content as text, or a brand-styled PDF.

## Outlook Add-in: Chat in a Larger Window

The chat in the Outlook task pane can move into a window of its own that users can move and
resize. In Outlook on the web and the new Outlook for Windows the task pane has a fixed width that
add-ins cannot change; **Open in a larger window** (⤢) in the chat's header now opens the same
chat at 70 % × 85 % of the screen.

- The window works like the pane: the open email goes along with every message, and reply,
  forward, insert into the draft and attaching documents act on the email in Outlook.
- The pane stays open behind the window, which reaches Outlook through it — users should pin the
  pane so it stays open when they select another email.
- **Back to the Outlook pane** (⤡), or closing the window, brings the chat back with everything
  that happened in the window. Shown in Outlook clients with DialogApi 1.2 (not in
  volume-licensed Outlook 2016/2019).

## Outlook Add-in: Open in Web App for Every Chat

**Open in web app** now also works for chats that are not stored on the server — with durable
chats switched off, or in an app marked `ephemeral`. The pane hands the chat to the browser, which
continues it as a new chat, together with the email the conversation was about.

- The hand-off lives in the server's memory for at most ten minutes, can be opened once, and only
  by the user who started it; nothing is written to disk.
- Opened by another account, the web app says so and leaves the chat for its owner.

## Microsoft 365 Copilot Agent

iHub can now be an agent in Microsoft 365 Copilot. Users pick it in Copilot Chat or in Copilot's
pane in Outlook, Teams and Word, and Copilot runs iHub's apps for them, signed in with their own
iHub account and limited to the apps their groups allow.

- Set it up under **Admin → Integrations → Microsoft 365 Copilot**: enabling creates the OAuth
  client Copilot signs in with and turns on the OAuth server and the MCP gateway; the page lists
  the values to register in the Teams Developer Portal and builds the agent package to upload in
  the Microsoft 365 admin center.
- Copilot discovers iHub's apps at runtime, so apps added or changed later need no new package.
- Off by default; see `docs/microsoft-365-copilot-agent.md`.
