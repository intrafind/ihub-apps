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
