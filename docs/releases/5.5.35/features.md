# Features — 5.5.35

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
