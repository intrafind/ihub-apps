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

## Outlook Add-in: Open a Chat in the Web App

Users can now continue an Outlook conversation in the iHub web app. **Open in web** in the task-pane
menu (☰) saves the conversation as a chat and opens it in the browser, where it is one of the user's
chats like any other — handy when a longer back-and-forth outgrows the narrow pane.

- Available when chat history is enabled on the installation; otherwise the entry is not shown.
- Only what was typed and what the assistant answered is carried over. The open email, the emails
  added as context and all attachments are not stored, so follow-up questions in the web app do not
  see them.
- Nothing is stored until the user chooses it, and choosing it again for an unchanged conversation
  reopens the same chat instead of adding another.
- The user needs access to the app in the web app; the add-in's **Available Apps** limit applies.
- The browser-extension side panel offers the same entry.
- The same handoff is available to other clients as `POST /api/chats/import`; see
  [Chat Persistence](../../chat-persistence.md#importing-a-conversation).
