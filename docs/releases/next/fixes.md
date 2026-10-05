# Fixes — Unreleased

## Office 365: Files in OneDrive, SharePoint and Teams Can Be Listed

Opening a OneDrive, SharePoint or Teams library in the Office 365 file picker failed with an
HTTP 400 error instead of showing its files. iHub rejected the drive IDs Microsoft uses, which
contain an exclamation mark (`b!…`). Browsing and attaching files from these libraries now works.
