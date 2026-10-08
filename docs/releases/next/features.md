# Features — Unreleased

## API Key Status for Models and Providers

A key that is stored but cannot be read used to look like a missing one. When the server's
encryption key is not the one a key was saved with — several instances without a shared
`TOKEN_ENCRYPTION_KEY`, or a lost `contents/.encryption-key` — chat failed with "API key not found"
although a key was set, and nothing said why.

- **Admin › Models** has an **API key** column and the model editor shows the status under the key
  field. **Admin › Providers** shows it for LLM providers instead of a plain "Configured".
- The states are **Key found** (and where it comes from: the model, its provider or an environment
  variable), **No key needed**, **No API key** and **Stored key unreadable**.
- A stored key that cannot be decrypted is reported as such, in the status, in the model test and
  to chat users, who see a message that an administrator has to enter the key again. The server log
  names the cause.
- A key from the environment still wins over an unreadable stored one.
- The last step of the setup guide says how many enabled models are ready to use and links to the
  models when some still lack a key. Choosing a cloud provider now points to **Local Provider** and
  to skipping the step for those who have no key yet.

If you run more than one instance, set the same `TOKEN_ENCRYPTION_KEY` on all of them.
