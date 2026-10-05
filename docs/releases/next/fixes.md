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
