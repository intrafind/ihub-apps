# Fixes — Unreleased

## My Skills: Version History Only for Owners and Editors

Anyone a personal skill was shared with could read all of its earlier versions, including text
the owner had removed before sharing it. The history is now limited to the owner and to people
the skill is shared with for editing, as it already was for prompts. Everyone else can still use
the current version.

## Tool Approval: the Page Reader Counts as an External Tool

The page reader (`read_url`) was treated as an internal tool, so the platform default for external
tools (`toolApproval.defaults.external`, **Admin → Security → Tool approval**) did not apply to it,
and its approval card said "Internal". A page address can carry data from the chat to any host, so
it is now external: with the external default set to `always`, every page read is asked for. With
no external default, nothing changes.

## Answers Can No Longer Load Images or Styles from Other Sites

A model answer could contain an image, a video poster, a background or a stylesheet on another host, and the browser
fetched it as soon as the answer appeared — no click needed. Text planted in a project document, a fetched web page,
an MCP result or an upload could make the model write such markup with chat content in its URL, and so send that
content out. A `<style>` in an answer could also restyle the whole app, for example hide the buttons of a tool
approval. Answers and everything else iHub did not write itself are now rendered with a stricter sanitizer:

- An image from another site is shown as a link to it (its alt text and host) and loads only when someone opens it.
  Images from iHub itself and inline `data:` images still show, as do generated images and uploaded files.
- Media, frames, `srcset`, backgrounds, SVG references to other documents, `<style>` and `style` attributes are
  removed. Answers cannot borrow the app's own CSS classes either.
- Mermaid diagrams that would load an image or stylesheet from another site are not drawn; their source is shown.
- The same rules apply to the Markdown and workflow viewers, artifact previews (an SVG artifact is now shown as an
  image), uploaded-file previews, the canvas, chat exports and the Outlook add-in's insert, reply and forward.

Content an admin writes — pages, usage guides, app texts — and the shipped documentation keep external images and
styles. An app whose prompt has the model embed images from an external service (a chart or image URL) now shows them
as links.
