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

## Skills Read Their Reference Files Reliably

A skill whose instructions pointed at a bundled file (for example `references/brand-guidelines.md`)
sometimes failed to open it: the model searched the web or tried the Web Page Reader on the file's
path and got back `> Invalid URL`, because a skill-relative path is not a web address.

- The note that lists a skill's bundled files now names the `read_skill_resource` tool and the
  skill to pass, and states that these files are neither web pages nor local files — so the model
  reads them with the right tool instead of a web or URL tool.
- This applies when a skill is activated, when it stays active across later messages, and in agent
  runs where the skill was activated by the planner or an earlier step.
