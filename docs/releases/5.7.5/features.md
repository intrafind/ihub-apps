# Features — 5.7.5

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

## Apps: Change an App in a Conversation (Preview), and Improve Instructions with AI

People who edit an app can now tell an AI model in their own words what to change, instead of
editing the form. This works in the admin app editor and in the editor of personal apps, where
everyone who may change the app gets it, also people who may not create personal apps themselves.

- **Conversation (preview):** under **Edit with**, choose **Conversation**. The test chat opens
  beside it. The builder asks a question when it needs to, or proposes one change at a time as a
  card that shows every added and removed line and who gets the change. **Apply** saves it and
  restarts the test chat; **Undo** saves the earlier version again. The builder changes texts,
  input fields, conversation starters and the look only: never who can use the app, the AI
  model, web search, connected systems or the status. After an app is created from a description,
  the editor opens with the conversation. Switch it on under **Admin → Platform → Features →
  Change apps in a conversation**; it is off by default and needs **App Drafts with AI**.
- **Improve with AI:** the **Instructions** field has a button that rewrites the instructions on
  request (shorter, more formal, clearer steps, what to do if unsure). **Use this text** changes
  the form only; save to keep it. It is available wherever **App Drafts with AI** is on.
- Each request is a model call that counts against the usage limit of the person who asked. A
  person can send 60 per hour.
- How well the builder works depends on the model; it has not yet been measured with real
  models. Read each change before you apply it.

## App Editor: Saves No Longer Overwrite Another Admin's Changes

When two administrators edited the same app, the later save replaced the earlier one without a
word. The admin app editor now saves only if the app has not changed since it was opened.
Otherwise it says **Changed by someone else**, saves nothing and keeps your edits; **Reload**
loads the current version. **Publish** and **Unpublish** in the editor follow the same rule. For
scripts: `GET /api/admin/apps/{appId}` returns an `ETag`; send it as `If-Match` with
`PUT /api/admin/apps/{appId}` or `POST /api/admin/apps/{appId}/_toggle` to get `412` instead of
overwriting a newer change. Both answer with the new `ETag`. Without `If-Match` they work as
before.

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

- **AWS Bedrock** asks for the AWS region (for example `eu-central-1`, or `global`) instead of an
  address, lists the models that region offers, and goes through the same steps. Models that
  Bedrock only serves through a cross-region inference profile are offered under the profile of
  the region (`eu.anthropic.claude-…`); embedding and image models are shown but cannot be picked.
  Each imported model keeps the region it was listed in, so adding models from a second region
  does not move the ones you added before. The region field starts with the region the server
  uses today, and the AWS Bedrock provider gets it only when it has none yet.
- **The AWS Bedrock provider page has an AWS region field.** It applies to every Bedrock model
  that sets no region of its own; left empty, `AWS_REGION` on the server (default
  `eu-central-1`) applies as before. A region that is set but is not a region (for example
  `us-east1`) now stops the model call with a message that names it, instead of sending the
  data to another region; saving a model with such a region is refused.

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

**Restrict access** is for administrators with full admin rights. The access check is too, except
on an app's page: there content admins can check the groups they manage (not users or other groups).

## Documentation: Help Links and Guides for the Admin UI

- The Models, Providers, Apps and Prompts pages have a **?** next to the title that opens the
  matching section of the documentation.
- New guides: **Set up models in the admin UI** (connect a provider, import, test, choose the
  default, what a failed test means) and **Who can use apps, models and prompts** (groups,
  wildcards, limiting an app or a model to some groups).

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
- **After a refused save the bar stays**, even if you put the field back to its stored value, because the save may have reached the server. An edit made while a save is running stays unsaved.
- **Pages with several sections have one bar for the whole page.** Security, Logging, the EU AI Act cards, Scheduled Tasks, the Integration Builder, the Installation page of an integration, the visual workflow editor and a new project no longer have a Save button per section. **Save Changes** stores every section with changes, in the order of the page; if one is refused, the ones before it stay saved and a second **Save** sends only the rest. **Discard** puts every section back.
- **The cards inside list pages** (usage limits, LLM timeouts, project sharing, personal apps, user prompts and skills) use the bar too. A value that is out of range no longer greys the button out: **Save** names the problem in the bar.
- **The app order** on the Apps list is saved with the bar. **Done** leaves the order mode and keeps your draft, and the bar saves or discards it.
- **Prompt variables** on the Prompts list are saved with the bar.
- **Provenance settings** still ask for confirmation before a change that needs it; **Cancel** in the confirmation ends the save and keeps your edits.
- **Logging: the privacy settings** no longer write the whole logging block when you save them.
- **The instructions for the model** on an installation's Overview are saved with the same bar as its Settings and the approval, in that order. **Edit instructions** no longer has its own Save; **Cancel** closes the editor, and the text survives a switch to another tab. **Use the integration’s own** still acts at once.
- **The Installation page** keeps a pending approval edit when you save the Settings with Enter. Discard no longer jumps back to the Overview tab.
- **Unsaved settings survive a tab switch.** The settings of Personal apps, User prompts and User skills, and the settings cards on Providers and Projects, no longer drop your edits when you switch tabs, and leaving the page asks first. The tab stays open in the background and the bar at the bottom saves it from either tab.
- Credentials (a dialog) and the translation overrides keep their own Save.

## Embed Mode: Sign In to iHub Inside Another Site with Microsoft Entra ID and Other OIDC Providers

iHub shown in a frame of another product, such as iFinder or a portal, can now sign people in
through OpenID Connect. Identity providers like Microsoft Entra ID refuse to be shown in a frame,
so the frame used to end in an error page. The sign-in now opens in a popup, and the frame gets
its own session without a token ever reaching a script.

- **Opt-in, set up in the admin.** Open **Admin → Integrations → iHub in another site** (also in the
  **Clients** section), switch it on and add the origins of the sites that may show iHub, for
  example `https://ifinder.example.com`. Saved settings apply at once. Until then, nothing changes.
- **Only those sites can frame iHub.** While the list is set, iHub's pages carry a
  `frame-ancestors` policy for iHub itself and the listed origins. List every other site that
  shows iHub in a frame too.
- **The session is an `HttpOnly` cookie of the frame** (`HttpOnly; Secure; SameSite=None;
  Partitioned`). Current Chrome, Edge and Firefox support partitioned cookies, so it does not
  depend on third-party cookies. It needs HTTPS and is only sent while iHub is shown by the same
  site. iHub accepts it only for requests that the iHub page itself made.
- **People allow the pop-up** and click **Sign in**. When they are already signed in at the
  identity provider, the window opens and closes by itself.
- **Signing out** in the frame ends that session.

See [Embed Mode](../../embed-mode.md#signing-in-inside-a-frame).
