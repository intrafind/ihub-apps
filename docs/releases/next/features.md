# Features — Unreleased

## iFinder Search App

A new app, **iFinder Search**, does for the iFinder index what Web Chat does for the web. It
answers questions from internal documents and finds documents on request, such as "show my latest
tickets" or "presentations about project X from last month". It ships disabled: enable it under
**Admin → Apps** once iFinder is configured.

- Searches several times with different wording, reads only the documents it needs to answer, and
  links every statement to its document.
- For document searches it filters by person, date range, type, source or status, sorts by date
  when asked for the latest, and lists the hits with link, date and the relevant fields.
- Understands "my" and "I": it looks up how the signed-in user's name is stored in iFinder and
  filters on it.
- The documents each iFinder search found now appear in the chat's tool activity, like web search
  results, linked to their iFinder deep link.
