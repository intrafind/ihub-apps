# Fixes — Unreleased

## Office 365: Files in OneDrive, SharePoint and Teams Can Be Listed

Opening a OneDrive, SharePoint or Teams library in the Office 365 file picker failed with an
HTTP 400 error instead of showing its files. iHub rejected the drive IDs Microsoft uses, which
contain an exclamation mark (`b!…`). Browsing and attaching files from these libraries now works.

## Integrations: Connected Cloud Storage Shows as Connected

After connecting Office 365, Google Drive or Nextcloud, Settings → Integrations kept showing the
account as not connected, and Disconnect there left the connection in place. The page did not say
which provider it meant, so it looked for connections in the format used before iHub 5.3.13.
The page now checks and disconnects the right provider.

## Office 365: File Picker Shows Only Enabled Sources and Opens OneDrive Directly

The Office 365 file picker offered SharePoint Sites and Microsoft Teams even when an administrator
had switched these sources off for the provider. It now lists only the enabled sources and refuses
to load a disabled one. Opening OneDrive also no longer asks the user to choose between their files
and a hidden system library ("PersonalCacheLibrary"); it goes straight to their OneDrive files.

## Admin → Skills Is Translated Again

Parts of **Admin → Skills** — the tab names, the **User skills** list and its settings — showed
English text in the German interface, because a second set of skill texts replaced the first. Both
sets are now combined, so the page is fully translated.
