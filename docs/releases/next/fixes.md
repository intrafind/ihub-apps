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

## A Question or Approval Card No Longer Takes the Focus While You Type

When the assistant asked a question or asked for approval of a tool call while you were typing
somewhere else, for example in the app search (Ctrl+K), the card moved the keyboard focus to itself
and the next keys landed in the card. At the end of an answer the chat input also took the focus
back from wherever it was.

- A card that appears while you type, or right after you pressed a key or clicked, leaves the focus
  where it is. A screen reader announces it instead ("Approval needed: …", "The assistant asks:
  …"). When you are not typing, the card takes the focus as before.
- Enter in the chat input never answers a card.
- At the end of an answer the chat input takes the focus back only when nothing else has it.
- The question card is part of the chat, not a dialog: Tab moves on past its last control instead
  of going round inside the card.
- The notice of a scheduled run that waits for your approval stays until you close it; the other
  notices still close by themselves after 12 seconds.

## Chat: A Finished Answer Is Stored Before the Chat Says It Is Done

Right after an answer finished, the chat could briefly have no answer stored: opening the chat
again at that moment, or a browser that had lost the reply to the message and caught up with the
answer, could show the question without its answer until the chat was opened once more.

- The server now stores the answer first and only then tells the browser that the answer is
  complete.

No action is needed after the upgrade.
