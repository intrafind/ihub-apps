# Fixes — Unreleased

## Admin rate limit now covers `POST /api/completions`

`POST /api/completions`, which administrators and content admins use to test prompts, called a
model without any rate limit. It now shares the admin rate limit under
**Platform → Security → Rate Limits** with the other admin requests.

## Group and OAuth client pages open with an app that has no English name

The app picker on the page of a group with an explicit app list, and on an OAuth client page,
could fail with an error when an app had its name in one language other than English, for example
only in German. The picker expected an English name for every app.

- The picker now shows and searches the name in the language of the user interface, then in
  another language the app has, then the app's ID.
- The header of the app editor shows such an app by its name instead of its ID.
