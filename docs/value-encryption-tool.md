---
description:
  "Encrypt passwords and API keys in Admin → Security for use in configuration files: the screen,
  the API endpoint and where encrypted values work."
audience: admin
type: how-to
adminPage: /admin/security
---

# Value Encryption Tool

The Value Encryption Tool turns a secret, such as a password, an API key or a client secret, into an
encrypted `ENC[...]` value. You store that value in a configuration file instead of the plain text,
and iHub decrypts it when it reads the field.

| | |
| --- | --- |
| **Location** | **Admin → Security → Value Encryption** (`/admin/security`; the old `/admin/system` redirects there) |
| **Access** | Administrators only |
| **Algorithm** | AES-256-GCM, with the installation's encryption key (`TokenStorageService`) |
| **Direction** | Encrypt only. The UI never decrypts a value |

## Encrypt a Value

1. Sign in as an administrator and open **Admin → Security**.
2. Select the **Value Encryption** section. An amber **Usage Instructions** panel sums up the steps
   below.
3. Type the secret into **Plaintext Value to Encrypt**. It is a password field, so the value stays
   hidden.
4. Click **Encrypt Value**, or press Enter. The button is disabled while the field is empty and
   shows **Encrypting...** while the request runs.
5. When **Value encrypted successfully** appears, the result shows in the read-only **Encrypted
   Value** box. Click the box to select all of it, or click **Copy** in its top-right corner (the
   page confirms with **Copied to clipboard!**).
6. Paste the value into the secret field of your configuration (see
   [Where Encrypted Values Work](#where-encrypted-values-work)).

If the request fails, a red message reads **Failed to encrypt value: <reason>**, for example
`Value is already encrypted`. If the browser refuses clipboard access, the page shows **Failed to
copy to clipboard**; select the text in the box and copy it by hand.

### Example

Input:

```text
my-secret-password-123
```

Output:

```text
ENC[AES256_GCM,data:iUKy/kl7itql4QehbnMdN2QB30+eqw==,iv:Lrpa0jo1TMwsxqFevbrIhw==,tag:q7VzC7mPpsEDLpX6KrNNFA==,type:str]
```

Every run produces a different value for the same input, because each encryption uses a new random
IV.

## Where Encrypted Values Work

iHub decrypts an `ENC[...]` value where it reads a secret it keeps encrypted at rest, for example:

- the secret of a credential profile (**Admin → Credentials**, `contents/config/credentials.json`),
  such as an LDAP bind password referenced by `adminPasswordRef`
  ([LDAP/NTLM Authentication](ldap-ntlm-authentication.md));
- the `apiKey` of a provider or a model;
- secrets in `platform.json`, such as the outbound proxy password or the Azure Speech subscription
  key.

Most admin forms that save such a field encrypt it for you, so the tool is mainly for configuration
files you write by hand or deploy from version control.

> [!WARNING]
> iHub does not decrypt environment variables. A `.env` entry such as
> `OPENAI_API_KEY=ENC[...]` reaches the server as the literal `ENC[...]` text and fails. Keep plain
> values in the environment (protected by the host), or put the encrypted value into the
> configuration field itself.

## Security Considerations

- **Version control.** An encrypted value is safe to commit: without the key it cannot be
  decrypted.
- **The key.** Values are encrypted with the key in `contents/.encryption-key`, or the 64-character
  hex key in the `TOKEN_ENCRYPTION_KEY` environment variable when that is set. Back the key up;
  every server of a multi-server deployment needs the same key. If the key changes, existing values
  can no longer be decrypted. See [Encryption Key Management](encryption-key-management.md).
- **One way.** The admin UI only encrypts, so it cannot expose a stored secret. Decryption happens
  only inside the server, when the value is used.

## API Endpoint

The screen calls `POST /api/admin/encrypt-value`, which requires an administrator.

Request:

```json
{
  "value": "plaintext-to-encrypt"
}
```

Response (`200`):

```json
{
  "encryptedValue": "ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]"
}
```

Errors use the `application/problem+json` format; read `detail`:

| Status | `detail` / cause |
| --- | --- |
| `400` | `Invalid value: must be a non-empty string` |
| `400` | `Value is already encrypted` (the input is already in `ENC[...]` format) |
| `401` | Not signed in |
| `403` | Signed in, but not an administrator |
| `500` | Encryption failed on the server; the server log has the cause |

## Value Format

```text
ENC[AES256_GCM,data:<base64>,iv:<base64>,tag:<base64>,type:str]
```

| Part | Meaning |
| --- | --- |
| `data` | The encrypted value, base64-encoded |
| `iv` | The 16-byte initialization vector, base64-encoded |
| `tag` | The GCM authentication tag, base64-encoded |
| `type` | Value type; always `str` |

The key is 256 bits (32 bytes). GCM authenticates the data, so a changed or truncated value fails to
decrypt instead of producing wrong plain text.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Error about a missing encryption key | `contents/.encryption-key` exists and is readable by the server (permissions `600`), or `TOKEN_ENCRYPTION_KEY` is set |
| A value does not decrypt | The key has not changed since the value was encrypted; the value starts with `ENC[` and ends with `]`; it has no line breaks or added spaces; it sits in a configuration field, not an environment variable |
| `Value is already encrypted` | The input is already an `ENC[...]` value. Use it as it is |

## Related Documentation

- [Encryption Key Management](encryption-key-management.md)
- [LDAP/NTLM Authentication](ldap-ntlm-authentication.md)
- [Environment Variables](environment-variables.md)
- [Security Best Practices](security.md)
