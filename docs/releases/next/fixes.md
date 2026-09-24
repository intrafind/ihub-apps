# Fixes — Unreleased

## Outlook Add-in: Switching emails shows the new email once, and always

Clicking a different email made the task pane refresh twice: first with the previously open email,
then with the new one. Sometimes it stopped at an empty "Email context" header with no email text.
Outlook reports a change in the message list before it opens the new email, and can keep naming the
previous email for a moment after it has switched, so a read at the wrong moment returned the old
email or nothing. The pane now decides from what it actually read: a selection change is read in the
background and only replaces the shown email when the read really returned a different one, and a
read that still returned the previous email, or no email, is checked once more shortly after.
Re-selecting the open email or a refresh of the message list changes nothing on screen.

## iFinder Search: Follow-up questions find the document that was listed

Asking about a document the assistant had listed in an earlier answer ("show me the top 10", "who
wrote the second one?") often failed: the assistant reported the metadata tools as unavailable, or
answered about a different document. Only the text of earlier answers is kept between turns, so the
assistant knew the documents by title alone — and passed those titles as document ids, which the
tools do not accept and which are not even unique when the same file is indexed several times.

- Every document link now carries the source system, the folder and the document id in its
  tooltip, so a follow-up turn takes the id from the earlier answer instead of guessing. The id
  never appears in the visible text.
- A title, file name or link passed as a document id is refused with a hint on how to look the id
  up, instead of a bare error, and a metadata lookup that would return a different document is
  reported as not found.
- Search hits now include authors, owners and the modification date the "newest first" sort uses,
  so document lists show consistent dates without a lookup per document.

Installations that kept the shipped iFinder tool descriptions and the shipped iFinder Search prompt
receive the updated wording on upgrade; edited ones are left as they are.
