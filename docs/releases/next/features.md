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

## Models: Connect a Provider in One Guided Flow

**Add provider**, the **Set up your models** strip and the empty Models list now open a guided
flow (**Admin → Models → Providers → Add provider**):

1. Pick where your models run: OpenAI, Azure OpenAI, Anthropic, Google, Mistral, AWS Bedrock,
   OpenRouter, an OpenAI-compatible gateway, a self-hosted server (vLLM, LM Studio, Ollama) or
   the iFinder Model Gateway.
2. Enter the address and the key, or use the named environment variable instead.
3. **Test the connection.** It shows the host and how many models it found, or why it failed and
   what to fix, for example a link to the SSL whitelist when the server uses a private
   certificate authority.
4. Pick the models, choose the default model (nothing is preselected), and decide who can use
   them: everyone who signs in, or only some groups.

The models use the provider's key, and a one-prompt test at the end shows that they answer.
**Create an app with this model** leads on to the app builder.

## Models: What Still Uses a Model or App, and the Default in Your Hands

- **Deleting a model or an app shows what still uses it** before you confirm: the apps, prompts,
  workflows and groups that name it, and for a model whether it is the default and which model
  takes over. A copy stays in the change history, and the page of a deleted model or app offers
  **Restore from History**.
- **Make default** in a model's row sets the platform default directly, and a switch in each row
  turns a model on or off.
- **When iHub picks a default model by itself**, for example after you disable or delete the
  current default, the Models page tells you which model it chose.
- **The app editor offers every chat model**, also disabled ones (marked "disabled"), so you can
  choose a model for an app before switching it on for everyone.
- **The model editor has a Test button**, and the API key help names the order in which iHub
  looks for a key: the model's key, the provider's key, then the environment variables.
- The **Set up your models** strip counts a self-hosted endpoint that needs no key as connected.

## Access: See Who Can Use an App or a Model, and Why

- **Access through "all" is explained in words.** The group card on apps, prompts, skills and
  workflows says when a group gets the item through "all apps" (or "all prompts", …) and from
  which group it inherits that.
- **Models get a "Who can use this model" card** in the editor, with each group and why it has
  access.
- **"Why can't someone see this?"** on the app and model pages checks a group or a user and gives
  the reasons: the item is disabled, a feature is off, the group does not grant it, or the user
  may use no model the app allows.
- **Restrict access** replaces "all" in the groups you pick with an explicit list without this
  item, shows who keeps access before you apply, and records the change in each group's history.
  Items added later then no longer appear in those groups by themselves.

The access check and **Restrict access** are for administrators with full admin rights.

## Documentation: Help Links and Guides for the Admin UI

- The Models, Providers, Apps and Prompts pages have a **?** next to the title that opens the
  matching section of the documentation.
- New guides: **Set up models in the admin UI** (connect a provider, import, test, choose the
  default, what a failed test means) and **Who can use apps, models and prompts** (groups,
  wildcards, limiting an app or a model to some groups).
