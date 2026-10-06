# Fixes — Unreleased

## Generated PDFs Print the Title Once and Keep Headings With Their Text

PDFs from the `pdf` skill showed the document title twice at the top when the content opened with
a heading repeating it. Sections were separated by double lines, and a heading could sit alone at
the bottom of a page while its text started on the next one.

- A first heading that only repeats the printed title is left out. With a cover page or a table of
  contents, where the title is not printed above the text, the heading stays.
- Horizontal rules next to a heading that already draws a line under it are left out, as are
  doubled rules and rules at the very start or end.
- A heading now moves to the next page when fewer than two lines of its text would stay with it.
  Very long documents get this for their first headings only, to keep rendering fast.
- Workflow result and agent artifact PDF downloads get the same layout rules.

## The Whole Page Could Scroll the App Away After an Answer With Sources

On the chat, once an answer that cited sources finished and jumped back to the top, the entire page
gained a scrollbar: scrolling it pushed the sidebar and the app header off-screen instead of
scrolling only the message list. Short answers and answers without sources were unaffected, which
made it look intermittent.

- The full-height app shell is now a positioning context, so hidden helper elements inside a tall,
  scrolled answer (such as screen-reader-only labels on citation badges) can no longer stretch the
  document and give the page its own scrollbar.
- Only the message list and the sources panel scroll; the sidebar, header and composer stay put.
