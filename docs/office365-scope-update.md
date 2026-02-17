# Office 365 Scope Update - Teams Channel Access

**Date:** 2026-02-17
**Issue:** Missing permissions for Teams channel access

## Problem

The Office 365 integration was missing required scopes to access Teams channels, causing API errors:

```
Missing scope permissions on the request. API requires one of
'ChannelSettings.Read.All, Channel.ReadBasic.All, ChannelSettings.ReadWrite.All,
Group.Read.All, Directory.Read.All, Group.ReadWrite.All, Directory.ReadWrite.All'
```

## Solution

Added two additional scopes to the Office 365 integration:

1. **`Channel.ReadBasic.All`** - Read Teams channel information
2. **`Group.Read.All`** - Read group/team membership

### Updated Scopes

**Before:**
```javascript
const scopes = [
  'User.Read',
  'Files.Read.All',
  'Sites.Read.All',
  'Team.ReadBasic.All',
  'offline_access'
];
```

**After:**
```javascript
const scopes = [
  'User.Read',
  'Files.Read.All',
  'Sites.Read.All',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',  // NEW
  'Group.Read.All',         // NEW
  'offline_access'
];
```

## Required Actions for Users

### For Existing Connected Accounts

Users who are already connected to Office 365 will need to **reconnect** to grant the new permissions:

1. Go to **Settings → Integrations**
2. Click **Disconnect** for Office 365
3. Click **Connect Office 365 Account** again
4. Review and approve the additional permissions in the Microsoft consent screen
5. Complete the OAuth flow

### For New Connections

New users connecting their Office 365 account will automatically be prompted for all required permissions.

## Azure AD App Registration

### Required API Permissions

Ensure your Azure AD app registration includes these Microsoft Graph permissions:

| Permission | Type | Description |
|------------|------|-------------|
| User.Read | Delegated | Read user profile |
| Files.Read.All | Delegated | Read all files user can access |
| Sites.Read.All | Delegated | Read items in all site collections |
| Team.ReadBasic.All | Delegated | Read basic team information |
| **Channel.ReadBasic.All** | Delegated | **Read basic channel information** |
| **Group.Read.All** | Delegated | **Read all groups** |
| offline_access | Delegated | Maintain access to data |

### Adding Permissions in Azure Portal

1. Go to **Azure Portal** → **App registrations**
2. Select your app
3. Go to **API permissions**
4. Click **Add a permission** → **Microsoft Graph** → **Delegated permissions**
5. Search for and add:
   - `Channel.ReadBasic.All`
   - `Group.Read.All`
6. Click **Add permissions**
7. **(Optional)** Click **Grant admin consent** if you want to pre-approve for all users

## What These Scopes Enable

- **Channel.ReadBasic.All**: Allows listing Teams channels and their basic properties
- **Group.Read.All**: Allows reading group/team membership to determine which Teams the user has access to

## Technical Details

### Files Updated

- **`server/services/integrations/Office365Service.js`**
  - Line ~89: Updated `generateAuthUrl()` scopes array
  - Line ~197: Updated `refreshAccessToken()` scopes string

### Token Storage

Existing refresh tokens **will not work** with the new scopes because they were issued with the old scope set. Users must go through the OAuth flow again to receive new tokens with the expanded permissions.

## Testing

After reconnecting:

1. Navigate to a chat with file upload enabled
2. Click the cloud storage icon
3. Select Office 365
4. Verify Teams section appears with channels
5. Verify files can be browsed from Teams channels

## Rollback

If you need to roll back to the previous scope set, remove these lines:

```diff
- 'Channel.ReadBasic.All', // Read Teams channel information
- 'Group.Read.All', // Read group/team membership
```

Note: Users who already granted the new permissions will still have them until they disconnect and reconnect again.
