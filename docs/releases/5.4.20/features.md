# Features — 5.4.20

## Apps Can Now Call Other Apps as Tools (Concierge Pattern)

A chat app can delegate to other apps: list app IDs in the new `apps` field and the model
sees each one as a callable tool (`app__<id>`). The called app answers with its own system
prompt, model, tools, and sources — entirely server-side, with no REST round-trip — and the
calling app weaves the answer into its response. This enables a concierge bot that routes
requests to specialist bots.

- Configure via the new **Apps as Tools** section in the admin app editor, or the `apps`
  array in the app JSON.
- Requires the **App-as-Tool** platform feature (Admin → Features; previously agent-only,
  off by default).
- Users can only reach apps their groups permit — the same permission check as opening the
  app directly; apps a user may not access are never offered to the model.
- Delegation is limited to one level: a called app cannot call further apps, so loops
  cannot form.

## iFinder Sources Select Documents Instead of Carrying Connection Settings

iFinder knowledge sources no longer ask for a base URL and API key — the connection comes from
the central iFinder integration (Admin → Providers → iFinder). A source now only defines which
documents it loads, and the admin form can verify the selection against the live iFinder before
saving.

- Pin a source to one document by ID, or give it a search query that loads the top N matching
  documents (configurable, 1–100) as source content — each document arrives clearly delimited
  with its title and link.
- A **Connect** button next to the document ID loads the document's metadata (title, author,
  media type, size, modification date, link) so admins can confirm it is the right document.
- A **Test Query** button shows how many documents match and which ones would be loaded.
- The search profile is optional and falls back to the platform-wide default profile.
- Documents are always fetched with the identity of the current user, so a source never exposes
  content the user could not open in iFinder directly.
- Sources exposed as tools may leave both fields empty; the assistant supplies a query or
  document ID when it calls the tool.
