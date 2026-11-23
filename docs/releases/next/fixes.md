# Fixes — Unreleased

## The Admin Area Is Fully Translated into German

The admin area is fully translated into German. Many labels, hints, breadcrumbs, dialogs and
messages still appeared in English when the admin language was German, including the "History"
button of the model editor and the user, group and authentication settings.

- German text uses one term per concept, matching the admin navigation: "Anbieter" for model
  providers, "Tool" for the functions a model calls, "Benutzer" for users.
- These texts can now also be changed under **Admin → Customization → Localization**, which only
  offers keys that exist in the built-in translations.

## Chat: A Long Answer Also Survives a Failed Status Check

When the browser gets no reply to a chat message, because the answer takes longer than five minutes
or a reverse proxy answers 502 or 504 first, it asks the server whether the answer is still being
worked on. If that one check failed too, the answer ended in the browser with an error, although
the server went on and finished it: "Request timed out. The operation may have taken longer than
expected." after five minutes, "A server error occurred. Please try again later." after a 502 or
504.

- The check is now repeated after 1, 2 and 4 seconds before an error is shown. A check that gets no
  answer within 5 seconds counts as failed, so the error appears after 27 seconds at the latest.
- An answer whose start the browser has already received is kept on screen whatever the check says.
- The text "Request timed out. …" follows the language of the user interface; it was English in
  every language.

No action is needed after the upgrade.
