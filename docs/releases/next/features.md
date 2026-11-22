# Features — Unreleased

## Apps: Create an App on One Page and Test It Before Anyone Sees It

**Admin → Apps → New app** replaces the creation wizard and the template window with one page of
two steps. The new app starts as **Not published**, opens in its editor with a test chat beside
it, and becomes visible to users when its author clicks **Publish**. Only administrators and
content admins can build apps, as before. The guide
[Build your first app](../../app-quickstart.md) walks through the page.

### Creating

- **Start** offers a description box, six templates, **Start empty** and, under
  **Other ways to start**, **Copy an existing app**, **Create a link app** and the Marketplace.
- **Describe the app and get a draft.** An AI model prepares the name, the short description, the
  instructions and, where useful, input fields and conversation starters. The page names the
  model the description is sent to.
- **The draft no longer switches on web search or connected systems by itself.** It lists them
  as unticked suggestions, and only what the author ticks is stored. The server builds the app
  from the model's answer, checks it and refuses an answer it cannot use, with a message that
  says what to do next.
- **Essentials** asks for name, short description and instructions. The App ID is derived from
  the name and can be changed under **More details** until the app is created. A new app is
  written in the language of the author's user interface.
- **Clone** is now **Duplicate**. A copy is independent and no longer records a parent
  (`parentId`). It takes over everything except group access and starts not published. A copy
  keeps every language of its source, but a text the author rewrites while creating the copy
  loses its other language versions, so that no user gets the old text.
- The quality of AI drafts was not yet measured with real models. Read a draft before creating
  the app.

### Testing and publishing

- **Apps created in the UI start not published.** Administrators and content admins can open and
  test such an app in the chat if one of their groups may use it. For everyone else, and for
  scheduled tasks, apps used as tools, workflows and the inference API, it does not exist. A
  `POST /api/admin/apps` without `enabled` still creates a published app, and an uploaded file
  keeps its `enabled` value.
- **Publish** in the editor header opens a confirmation that says who will see the app, for
  example "Everyone who signs in can use this app." **Unpublish** is under **More**. Publish
  saves unsaved changes first; if that save fails, for example because a field has an error,
  nothing is published. Unpublish does not save the form, so it also works while a field has an
  error.
- The status reads **Published** / **Not published** instead of Enabled / Disabled. The
  **Enabled** checkbox is gone from the form.
- **"Publish all" now also publishes unfinished apps.** An app that is not published may have
  been switched off on purpose or may be unfinished. The confirmation of **Publish all** and
  **Unpublish all** therefore lists every app that changes, and only those apps are changed.
  With a search or filter active the buttons read **Publish shown** / **Unpublish shown**.

### The editor

- The settings are sorted into groups. **Basics** and **Instructions and inputs** are open; the
  others are collapsed and show a one-line summary and a **changed** marker. **Expand all**
  opens every group.
- The **App ID** is shown in the header and is no longer an input. App type and position in the
  app list are under **More details**.
- **Save & Exit** is gone. **Save Changes** (or `Ctrl+S` / `Cmd+S`) keeps the editor open; the
  bar says how many fields need attention and, for a published app, that users get the change at
  once.
- New names, with the JSON field names unchanged: **Instructions** (`system`),
  **Message template** (`prompt`), **Input fields** (`variables`), **Conversation starters**
  (`starterPrompts`), **Short description** (`description`), **AI model** (`preferredModel`),
  **Answer format** (`preferredOutputFormat`), **Connected systems** (`integrations`).
- A text with one language shows one input without a language code. In every admin form, the
  button to add a language now reads **Add a translation** and the list shows language names.
- An input field whose placeholder no text uses is marked "This field is not used yet", with
  the button **Add to message template**. A new field's placeholder follows its field name.

### For administrators

- **Platform → Features → App Drafts with AI** switches the description box off. It is on by
  default.
- A person can prepare 30 drafts per hour; failed drafts count. Each draft is a model call that
  counts against that person's usage limit. Every draft request is written to the audit log with
  the model and the token usage, without the description text.
- **An unchanged "App Generator" prompt in the prompt library no longer steers drafts.** iHub
  uses its own instructions for drafts until an administrator changes that prompt. A changed
  prompt is named in the draft notice and in the audit entry.
- API, all additive: `POST /api/admin/apps/_generate` (prepare a draft),
  `GET /api/admin/app-templates`, the optional query parameter `origin` on
  `POST /api/admin/apps` (recorded in the audit entry), and `audience` plus `implicit` in the
  answer of `GET /api/admin/content-access/{type}/{id}`.

## Personal Apps (Preview, Off by Default)

Users without admin rights can build apps of their own, share them with colleagues, publish them
as company apps and hand them over to another person. The feature is a preview and stays off
until an administrator switches it on under **Platform → Features → Personal apps**. With it
off, nothing changes for users. [Personal apps](../../personal-apps.md) describes the feature
for users and administrators.

- **Who can build.** Signed-in users whose group has the permission **Personal apps**. An
  upgrade gives it, and **Sharing personal apps**, to the built-in groups of signed-in users
  (`admins`, `users`, `authenticated`); other groups of your own get neither. A person can own 20
  personal apps. Anonymous visitors, OAuth clients and agents cannot hold one.
- **Creating and editing.** **New app** on the apps page opens the two steps of the admin app
  builder, without App ID and category. A personal app holds texts, input fields, conversation
  starters and a few switches. Website apps, HTML answers, custom answer views, linked projects,
  workflows and apps as tools cannot be stored in one.
- **Interactive chat only.** Scheduled tasks, workflows, apps as tools, the inference API, MCP
  and A2A do not see personal apps. A personal API key runs only the apps of its own user. A
  personal app cannot use a document collection.
- **Web search, skills and connected systems are off until you allow them** under **Admin → Apps
  → Personal apps → Personal app settings**. Connected systems are allowed one by one, with the
  functions personal apps may use. A preferred AI model and file attachments are allowed by
  default. A capability works only when the installation allows it and both the owner and the
  person chatting may use it; this is checked on every chat request.
- **A shared app asks before every tool call.** The owner shares with people, groups or, if you
  allow it, everyone signed in, as **Can use** or **Can edit**. In the chat of an app someone
  else owns, a notice names the owner and says that administrators have not checked it. Every
  tool call asks the person chatting, reads included, and cannot be allowed for the whole chat.
  Web search and connected systems are off in each new chat until the person switches them on.
- **Publishing is off until you allow it** with **Publishing as a company app** in the same
  panel. The owner then publishes with one click: iHub writes an ordinary app file that
  administrators manage, and the owner cannot take it back. A published app with web search,
  skills or a connected system starts **Not published** until an administrator or content admin
  publishes it in the app editor; one setting makes every published app start that way. A line
  above the admin app list names the apps that wait.
- **Handing over** is an offer. The other person reads the app and becomes the owner by
  accepting; everyone with **Can edit** then gets **Can use**.
- **For administrators.** The tab **Personal apps** under **Admin → Apps** lists every personal
  app. Full administrators can open, switch off, delete and take over an app, offer it to a new
  owner, read its earlier versions and switch off all apps of one person. They cannot edit one.
  Content admins have no access to personal apps.
- **Owners from an identity provider.** A change of the owner's groups reaches a shared app at
  the owner's next visit, and at the latest after 30 days. When someone leaves, deactivate the
  iHub account; that takes effect at once. Deleting a user deletes their personal apps, so offer
  them to someone or take them over first.
- New settings block `userApps` in `platform.json`, new group permissions `userApps` and
  `userAppSharing`, new API under `/api/apps` and `/api/admin/user-apps`. `GET /api/apps`
  without the new parameter `scope` is unchanged.
