# Features — Unreleased

## Uploads: Teams Transcripts (.vtt) and Any Text File

Users can now attach WebVTT files (`.vtt`) — the format Microsoft Teams exports meeting transcripts
in — to chats in any app that accepts plain text files. Admins can also allow "Any text file" for
an app, so logs, YAML, subtitle files and other plain-text formats can be uploaded without listing
each one.

- Existing apps that accept `.txt` accept `.vtt` automatically after the upgrade.
- "Any text file" is off by default. Enable it under **Admin → Apps → Upload → Supported File
  Formats**. The file picker then shows all files; binary files are rejected on upload, and formats
  such as PDF or Word are only extracted when they are selected explicitly.

## App Editor: Open the App, Save Without Leaving, and Test Next to the Editor

Admins can now tweak an app and try it without leaving the app editor.

- **Save** stores the app and keeps the editor open (also with Ctrl+S / Cmd+S). **Save & Exit**
  returns to the app list, as saving did before. A new app saved with **Save** stays open for
  further editing.
- **Open app** in the editor and a new open icon in **Admin → Apps** open the app's chat page in a
  new tab.
- **Test** shows the app's chat next to the editor (full screen on small screens), so you can
  check the start screen and chat with the app. It runs the saved version and starts over with a
  new chat after every save; test chats are ordinary chats of your account.
- Testing works for chat apps. Disabled apps can't be opened or tested until they are enabled.

## Chat Links Show Where They Lead

Hovering a link in a chat answer now shows its destination as a tooltip, so a user can see which
site or file a linked title opens before clicking. Links that already carry a title — such as the
source and folder the iFinder Search app now puts on every document link — keep it. The "Read …"
rows of the tool activity panel show their address the same way.
