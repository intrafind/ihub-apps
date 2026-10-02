# Fixes — Unreleased

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
