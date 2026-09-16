# Breaking Changes — Unreleased

## Outlook Add-in: email context is sent as tagged blocks

Messages from the Outlook task pane and the browser extension now wrap the source material in
tagged blocks — `<current_email>`, `<pinned_emails>`, `<current_meeting>`, `<current_page>` —
and the user's own note in `<user_instruction>`. The `--- Current email ---`,
`--- Pinned emails ---` and `--- Current meeting ---` headings are gone.

**Before upgrading:** nothing for the shipped apps — migration V108 rewrites the two meeting apps'
prompts. Custom app prompts that quote one of the old headings should be changed to the tag names
listed under "What the model receives" in the Outlook add-in guide.
