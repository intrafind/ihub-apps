# Breaking Changes — Unreleased

## Outlook Add-in: email context is sent as tagged blocks

Messages from the Outlook task pane and the browser extension now wrap the source material in
tagged blocks — `<current_email>`, `<pinned_emails>`, `<current_meeting>`, `<current_page>` —
and the user's own note in `<user_instruction>`. The `--- Current email ---`,
`--- Pinned emails ---` and `--- Current meeting ---` headings are gone.

**Before upgrading:** nothing for the shipped apps — migration V108 rewrites the two meeting apps'
prompts. Custom app prompts that quote one of the old headings should be changed to the tag names
listed under "What the model receives" in the Outlook add-in guide.

## Admin → Feedback is a page of its own

The feedback review moved out of **Admin → Usage Reports → Feedback** into the new
**Admin → Feedback** page, which also carries the feedback settings. The Usage Reports tab is gone;
its average-rating tile links to the new page.

**Before upgrading:** nothing, unless your `contents/config/ui.json` hides Usage Reports with
`admin.pages.usage: false` to keep feedback entries out of the admin UI. That switch no longer
covers them — add `admin.pages.feedback: false` alongside it. Admin API access is unchanged either
way: both switches only decide what the admin UI shows.
