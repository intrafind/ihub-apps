# Fixes — Unreleased

## An Absolute Contents Directory Is Used Where It Points

When the `CONTENTS_DIR` environment variable held an absolute path (for example
`/srv/ihub/contents`), much of the server treated it as a folder inside the installation directory
instead: configuration, users, encryption keys, usage data, short links and installed marketplace
content were written to and read from a copy under the installation directory, while other parts
used the configured location.

- An absolute `CONTENTS_DIR` is now used as given everywhere. A relative value still resolves
  against the installation directory, as before.
- Installations that set an absolute `CONTENTS_DIR` should check whether such a nested copy exists
  under the installation directory and move any configuration or data they want to keep into the
  configured location before upgrading.
  
## Prompt Editor: Placeholders Are Typed, Not Inserted

**Insert variable** in the prompt editor did not add the variable to the prompt text. The button
is gone; a hint below the text explains that typing `{{mytext}}` adds a placeholder, which becomes
a field to fill in when the prompt is used.

## Sharing a Prompt: One Search for People and Groups

The share dialog offered groups twice — in the search box and in a separate list — and with many
groups the dialog kept growing. Groups are now found through the search box only, at most ten per
search, and the results and the **Shared with** list scroll instead of growing.

## Skills and Marketplace Previews Read Front Matter as YAML Only

The metadata block at the top of a `SKILL.md` file — its front matter — is now always read as
YAML, as the Agent Skills format specifies. A block that names another format after the opening
`---` (for example `---json`) is no longer interpreted.

- A skill whose front matter names another format is skipped when skills load, and the server log
  names the file. Importing such a skill in **Admin → Skills** fails with "Failed to parse
  SKILL.md".
- In the marketplace, the preview of such an item is shown as plain text instead of a metadata
  table.
- Skills with plain YAML front matter, including every skill shipped with iHub, are unaffected.
- 
## Diagram Rendering Is Stricter About Untrusted Content

Mermaid diagrams in chat answers, pages and other Markdown content now render with Mermaid's
strict security level. The drawn diagram, its fullscreen view and the error shown for a diagram
that cannot be drawn are sanitized before they appear in the page; diagram source in the error
view is shown as plain text. Only diagrams written as Mermaid code blocks are drawn, and markup in
the content that merely looks like a diagram is left as it is. Diagrams look the same as before.

## Themed Mermaid Diagrams Render for Every Diagram Type

Pie charts, Gantt charts, mind maps and several other diagram types showed "Incomplete diagram
code." instead of the diagram when they started with Mermaid theme settings (a `config:` front
matter block or an `%%{init: ...}%%` directive). These diagrams now render with their colors, so
an app's system prompt can ask the model to apply a corporate color palette to any diagram type.

## Sign-In Returns Only to Pages of This Installation

After signing in, users are sent back only to a page of this iHub installation. A return address
that points anywhere else — another site, or a link that is not a web page — now opens the home
page instead.

- Applies to the login page, single sign-on (OIDC, NTLM) and signing in again after a session
  expired.
- On installations served under a subpath (for example `/ihub/`), the return address must also
  lie under that path.

## Integrations: Connecting Office 365, Google Drive, Jira or Nextcloud Works Reliably

Connecting an integration failed at random with an "invalid state" error on servers running
more than one worker process, which is the default: the sign-in started on one worker and
Microsoft, Google, Atlassian or Nextcloud sent the user back to another worker that did not know
about it. Any worker can now finish the sign-in.

When connecting still fails, Settings → Integrations now explains why instead of showing a
technical code such as `callback_failed`, and a declined consent returns users to the page they
started from.

- Declined consent or required admin approval: asks the user to have an administrator grant
  consent for the app.
- Expired or wrong client secret in the Entra app registration: tells the user to contact their
  administrator. The server log contains the Microsoft error (for example `AADSTS7000222`).
- An expired or unverifiable sign-in asks the user to try again.

## Single Sign-On (OIDC) Works Reliably on Servers With Several Workers

Signing in with an OIDC provider (Entra ID, Keycloak, Google and others) failed at random on
servers running more than one worker process, which is the default. Users came back from the
provider to an error such as:

> Unable to verify authorization request state.

The sign-in started on one worker and the provider sent the user back to another that did not know
about it. Any worker can now finish the sign-in.

- A sign-in must still finish in the browser that started it, and within 15 minutes.
- When users pick Windows sign-in (NTLM) on a server that also offers other sign-in methods,
  every worker now remembers that choice until they log out.
- iHub no longer sets the `oidc.session`, `integration.session`, `oauth.session` and
  `app.session` cookies. It sets a short-lived `oidcLoginNonce` cookie during an OIDC sign-in,
  and an `ntlmRequested` cookie after a Windows sign-in.
