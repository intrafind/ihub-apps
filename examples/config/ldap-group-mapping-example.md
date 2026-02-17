# LDAP Group Mapping Configuration Example

This example shows how to configure LDAP authentication with automatic group mapping and admin role assignment.

## Complete Example Configuration

### 1. Platform Configuration (`contents/config/platform.json`)

```json
{
  "auth": {
    "mode": "local",
    "authenticatedGroup": "authenticated",
    "sessionTimeoutMinutes": 480
  },
  "localAuth": {
    "enabled": true,
    "usersFile": "contents/config/users.json"
  },
  "ldapAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "corporate-ldap",
        "displayName": "Corporate LDAP",
        "url": "ldap://ldap.example.com:389",
        "adminDn": "cn=admin,dc=example,dc=org",
        "adminPassword": "${LDAP_ADMIN_PASSWORD}",
        "userSearchBase": "ou=people,dc=example,dc=org",
        "usernameAttribute": "uid",
        "userDn": "uid={{username}},ou=people,dc=example,dc=org",
        "groupSearchBase": "ou=groups,dc=example,dc=org",
        "groupClass": "groupOfNames",
        "defaultGroups": ["users"],
        "sessionTimeoutMinutes": 480
      }
    ]
  }
}
```

### 2. Groups Configuration (`contents/config/groups.json`)

```json
{
  "groups": {
    "admins": {
      "id": "admins",
      "name": "Admins",
      "description": "Full administrative access to all resources",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["IT-Admin", "IT-Admins", "Platform-Admins", "Administrators"]
    },
    "users": {
      "id": "users",
      "name": "Users",
      "description": "Standard user access to common applications and models",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": false
      },
      "mappings": ["Employees", "Staff", "Domain Users"]
    },
    "authenticated": {
      "id": "authenticated",
      "name": "Authenticated",
      "description": "Base permissions for all authenticated users",
      "inherits": ["anonymous"],
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": false
      },
      "mappings": []
    },
    "anonymous": {
      "id": "anonymous",
      "name": "Anonymous",
      "description": "Access for anonymous users",
      "permissions": {
        "apps": ["chat"],
        "prompts": ["*"],
        "models": ["gemini-2.0-flash"],
        "adminAccess": false
      },
      "mappings": ["anonymous", "public"]
    }
  }
}
```

### 3. Environment Variables (`.env`)

```bash
# LDAP Admin Credentials
LDAP_ADMIN_PASSWORD=your_ldap_admin_password

# LLM API Keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...

# JWT Secret (for token signing)
JWT_SECRET=your_random_secret_key_here
```

## Active Directory Example

For Active Directory environments:

### Platform Configuration

```json
{
  "ldapAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "active-directory",
        "displayName": "Active Directory",
        "url": "ldap://ad.example.com:389",
        "adminDn": "admin@example.com",
        "adminPassword": "${AD_BIND_PASSWORD}",
        "userSearchBase": "dc=example,dc=com",
        "usernameAttribute": "sAMAccountName",
        "userDn": "{{username}}@example.com",
        "groupSearchBase": "dc=example,dc=com",
        "groupClass": "group",
        "defaultGroups": ["users"],
        "sessionTimeoutMinutes": 480
      }
    ]
  }
}
```

### Groups Configuration

```json
{
  "groups": {
    "admins": {
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": [
        "Domain Admins",
        "Enterprise Admins",
        "IT-Admin",
        "App-Administrators"
      ]
    },
    "users": {
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": false
      },
      "mappings": [
        "Domain Users"
      ]
    }
  }
}
```

### Environment Variables

```bash
AD_BIND_PASSWORD=your_ad_service_account_password
```

## Multi-Level Permissions Example

For organizations with different permission tiers:

### Groups Configuration

```json
{
  "groups": {
    "admins": {
      "id": "admins",
      "name": "Admins",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["Administrators", "IT-Management"]
    },
    "developers": {
      "id": "developers",
      "name": "Developers",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["gpt-4", "claude-3-opus", "gemini-pro"],
        "adminAccess": false
      },
      "mappings": ["Developers", "Dev-Team", "Engineering"]
    },
    "analysts": {
      "id": "analysts",
      "name": "Analysts",
      "permissions": {
        "apps": ["chat", "translator", "summarizer"],
        "prompts": ["analysis", "general"],
        "models": ["gpt-3.5-turbo", "gemini-flash"],
        "adminAccess": false
      },
      "mappings": ["Business-Analysts", "Data-Analysts"]
    },
    "users": {
      "id": "users",
      "name": "Standard Users",
      "permissions": {
        "apps": ["chat", "translator"],
        "prompts": ["general"],
        "models": ["gpt-3.5-turbo", "gemini-flash"],
        "adminAccess": false
      },
      "mappings": ["All-Employees", "Staff"]
    }
  }
}
```

## Testing Your Configuration

### Step 1: Verify LDAP Connection

Test LDAP connectivity using `ldapsearch`:

```bash
ldapsearch -x -H ldap://ldap.example.com:389 \
  -D "cn=admin,dc=example,dc=org" \
  -w "password" \
  -b "ou=people,dc=example,dc=org" \
  "(uid=testuser)" memberOf
```

### Step 2: Check Server Logs

After logging in, check logs for:

```
[LDAP Auth] Extracted 3 LDAP groups for user john.doe: ["IT-Admin", "Employees", "VPN-Users"]
[LDAP Auth] Mapped 3 LDAP groups to 2 internal groups for user john.doe: ["admins", "users"]
[Authorization] External group "IT-Admin" mapped to internal groups: ["admins"]
[Authorization] External group "Employees" mapped to internal groups: ["users"]
```

### Step 3: Verify Admin Access

1. Log in with a user in an admin LDAP group
2. Navigate to `/admin`
3. Verify access is granted

### Step 4: Check for Unmapped Groups

Look for warnings about unmapped groups:

```
[Authorization] External group "VPN-Users" has no mapping in groups configuration
[Authorization] 1 external groups have no mapping: ["VPN-Users"]
```

Add these to your `groups.json` if needed.

## Common LDAP Group Names

### Generic LDAP

- `cn=admins,ou=groups,dc=example,dc=org` → Extract `admins`
- `cn=developers,ou=groups,dc=example,dc=org` → Extract `developers`

### Active Directory

- `CN=Domain Admins,CN=Users,DC=example,DC=com` → Extract `Domain Admins`
- `CN=Domain Users,CN=Users,DC=example,DC=com` → Extract `Domain Users`

## Security Best Practices

1. **Use Secure LDAP (LDAPS)** in production:
   ```json
   {
     "url": "ldaps://ldap.example.com:636"
   }
   ```

2. **Restrict Admin Groups** - Only map specific, trusted groups to admin role:
   ```json
   {
     "admins": {
       "mappings": ["IT-Admins"]  // Specific group, not "Domain Users"
     }
   }
   ```

3. **Use Service Accounts** for LDAP binding with minimal required permissions

4. **Enable TLS Options** for secure communication:
   ```json
   {
     "tlsOptions": {
       "rejectUnauthorized": true
     }
   }
   ```

5. **Regular Audit** - Review who is in your admin LDAP groups regularly

## Troubleshooting

If group mapping isn't working, see:
- [LDAP Group Mapping Troubleshooting Guide](../docs/LDAP-GROUP-MAPPING-TROUBLESHOOTING.md)
- [LDAP and NTLM Authentication Documentation](../docs/ldap-ntlm-authentication.md)
- [Concept Document](../concepts/2026-02-17 LDAP Group Lookup and Admin Role Assignment.md)
