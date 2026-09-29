# Features — Unreleased

## Outlook Add-in: Choose Which Apps the Add-in Offers

Admins can now see and change which apps the Outlook add-in offers right on **Admin → Office
Integration**. The new **Available Apps** card shows at a glance whether the add-in offers all apps
or is limited to a selection, and lets you switch between the two and pick the apps without leaving
the page.

- Limits set earlier on the add-in's OAuth client (**Allowed Apps**) show up on the card unchanged —
  it is the same setting, now reachable from the page where you configure the add-in. A link leads
  on to the OAuth client for **Allowed Models** and **Allowed Prompts**.
- Choosing **Only selected apps** with nothing selected cannot be saved: an empty list would mean
  no restriction at all.
- The **Start Page** card warns when its default chat app or a default app is not on the list,
  because the task pane skips apps the add-in does not offer.
- Changes apply to signed-in users right away; no new sign-in or manifest redeploy is needed.

## Opening an App Starts a New Chat

With chat history enabled, clicking an app now always opens a new, empty chat instead of the last
conversation held for that app. The previous chat stays in the chat history and opens from there.

- Once the first message is sent, the address changes to the chat's own link, so reloading the
  page keeps the conversation.
- Without chat history (for example anonymous users), opening an app still restores the
  conversation from the current browser tab, as before.

## Document Actions for Answers From the iFinder Search Tools

Answers researched with the iFinder tools (the **iFinder Search** app, or any app using
`iFinder_search`) now list the documents they found in the **Documents** panel under the answer,
the same way iAssistant answers do. Each document has the full menu: **Preview**, **Download**,
**Details**, **Open in App**, **Open in browser** and, in the Outlook task pane, **Add to email**.

- Documents are fetched with the signed-in user's own iFinder permissions, from the search profile
  the tool searched.
- The documents the answer links to are marked **Referenced** and listed first. Other search hits
  fold away behind **Show N more documents**, so a turn that ran several searches does not bury
  the few documents it used.
- Documents read or looked up with `iFinder_getContent` and `iFinder_getMetadata` are listed too.
