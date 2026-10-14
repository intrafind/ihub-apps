# Features — Unreleased

## Workflows: Chat Integration Is Set on the Workflow Page

The workflow page (**Admin → Workflows → a workflow**) has a **Chat integration** section. It
sets whether the workflow is available in chat, which output is shown as the answer, the output
format and the description the app's model sees — settings that until now could only be changed
in the JSON.

- **Available in chat** lets users start the workflow with `@` in the apps it is assigned to and
  lets the app's model call it as a tool. It also offers the workflow to MCP and A2A clients whose
  groups may run it. The section lists the apps the workflow is assigned to.
- **Result shown in chat** offers exactly what the end step passes on. Under the list, the page
  explains what **Automatic** shows for this workflow: an output named like `report`, `content` or
  `result`, otherwise the whole output as JSON.
- In the web chat, a workflow answer made of all outputs follows the output format: **Markdown**
  shows a section per variable, **Text** a line per variable, **JSON** a code block. The stored
  answer and what the inference API, MCP and A2A return stay JSON.
- Warnings point out a workflow that is assigned to apps but not available in chat, a result the
  end step does not pass on, an end step whose format makes the selection ignored, an Automatic
  answer that would repeat the workflow's own input, and an answer that would be shown as JSON.
- New workflows start with chat integration switched off, as before, now visible in their JSON.
