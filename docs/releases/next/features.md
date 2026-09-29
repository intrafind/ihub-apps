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

## Outlook Add-in: Chat History

With chat history enabled (**Admin → Platform → Features → Durable Chats**), the Outlook add-in
now lists your recent chats, so a discussion from earlier can inform the email you are answering
or writing. Pick a chat and it opens in the task pane with its full conversation; the next message
goes out with the email that is open now.

- **Chat history** in the pane's menu lists your chats by date, with search and **Show older
  chats**. The start page shows the three most recent under **Recent chats**.
- The list holds chats started in the browser and in Outlook alike: chats in the add-in are now
  saved like chats in the web app, and show up in the web app's history too.
- Only chats whose app the add-in offers are listed, since a chat continues in its own app.
- The browser extension's side panel gets the same history.
- Without chat history enabled, the add-in keeps its chats in the pane as before.
