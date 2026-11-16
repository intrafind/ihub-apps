---
description: "What the value encryption tool looks like and how its screens behave."
audience: admin
type: reference
adminPage: /admin/security
---

# Value Encryption Tool Screens

## Location

**Admin → System → Value Encryption Tool**

The Value Encryption Tool section appears between the "Password Change" and "Configuration Backup & Import" sections on the Admin System page.

## UI Components

### Section Header
- **Icon**: Blue shield with checkmark icon
- **Title**: "Value Encryption Tool"
- **Description**: Brief explanation of the tool's purpose

### Usage Instructions Panel (Amber/Warning Style)
Step-by-step instructions:
1. Enter your plaintext value (password, API key, etc.)
2. Click "Encrypt Value" to generate an encrypted version
3. Copy the encrypted value (starts with ENC[...])
4. Store it in your .env file or configuration
5. The application will automatically decrypt it at runtime

### Input Section
- **Label**: "Plaintext Value to Encrypt"
- **Input Type**: Password field (hides input for security)
- **Placeholder**: "Enter value to encrypt (password, API key, etc.)"
- **Enter Key Support**: Press Enter to encrypt

### Encrypt Button
- **Icon**: Shield with checkmark
- **Text**: "Encrypt Value"
- **State**: Disabled when input is empty
- **Loading State**: Shows spinner with "Encrypting..." text

### Output Section (Only visible after encryption)
- **Label**: "Encrypted Value"
- **Text Area**: Read-only, monospace font, 4 rows
- **Copy Button**: Top-right corner with clipboard icon
- **Hint Text**: Instructions for using the encrypted value

### Success/Error Messages
- **Success**: Green background with checkmark icon
- **Error**: Red background with warning icon
- **Copy Success**: "Copied to clipboard!" message

## Color Scheme

- **Primary**: Blue (#3B82F6) - Main action button and icon
- **Success**: Green (#10B981) - Success messages
- **Warning**: Amber (#F59E0B) - Info/instructions panel
- **Error**: Red (#EF4444) - Error messages

## Example Workflow

```
┌─────────────────────────────────────────────────────────┐
│ 🛡️  Value Encryption Tool                               │
├─────────────────────────────────────────────────────────┤
│ Encrypt sensitive values (passwords, API keys, secrets) │
│ to store them securely in .env files or configuration.  │
│                                                          │
│ ⚠️  Usage Instructions                                   │
│ 1. Enter your plaintext value                           │
│ 2. Click "Encrypt Value" to generate encrypted version  │
│ 3. Copy the encrypted value (starts with ENC[...])     │
│ 4. Store it in your .env file                           │
│ 5. Application will auto-decrypt at runtime             │
│                                                          │
│ Plaintext Value to Encrypt                              │
│ ┌────────────────────────────────────────────────────┐ │
│ │ ••••••••••••••••                                    │ │
│ └────────────────────────────────────────────────────┘ │
│                                                          │
│ [🛡️  Encrypt Value]                                    │
│                                                          │
│ ✅ Value encrypted successfully                         │
│                                                          │
│ Encrypted Value                          [📋 Copy]     │
│ ┌────────────────────────────────────────────────────┐ │
│ │ ENC[AES256_GCM,data:iUKy/kl7itql4QehbnMdN2QB30+eqw│ │
│ │ ==,iv:Lrpa0jo1TMwsxqFevbrIhw==,tag:q7VzC7mPpsEDLp │ │
│ │ X6KrNNFA==,type:str]                                │ │
│ │                                                      │ │
│ └────────────────────────────────────────────────────┘ │
│                                                          │
│ Use this encrypted value in your .env file. It will be  │
│ automatically decrypted at runtime.                      │
└─────────────────────────────────────────────────────────┘
```

## Accessibility

- All form fields have proper labels
- Keyboard navigation supported (Tab, Enter)
- Screen reader friendly
- High contrast color scheme
- Clear error messages

## Responsive Design

- Full width on mobile devices
- Stacked layout on smaller screens
- Touch-friendly button sizes
- Scrollable text areas for long encrypted values
