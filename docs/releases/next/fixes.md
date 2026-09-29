# Fixes — Unreleased

## Admins' Own Chats Clear Their "New" Badge When Opened

For admins, a chat answered while they were away kept its "new" dot in **Recents** and the chat
list even after they opened it. The server treated an admin reading their own chat like an admin
reading somebody else's, which deliberately leaves the badge alone. It now checks ownership first.
Opening another user's chat as an admin still leaves that user's badge untouched.
