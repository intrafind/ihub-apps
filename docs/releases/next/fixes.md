# Fixes — Unreleased

## Prompt Editor: Placeholders Are Typed, Not Inserted

**Insert variable** in the prompt editor did not add the variable to the prompt text. The button
is gone; a hint below the text explains that typing `{{mytext}}` adds a placeholder, which becomes
a field to fill in when the prompt is used.

## Sharing a Prompt: One Search for People and Groups

The share dialog offered groups twice — in the search box and in a separate list — and with many
groups the dialog kept growing. Groups are now found through the search box only, at most ten per
search, and the results and the **Shared with** list scroll instead of growing.
