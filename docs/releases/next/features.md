# Features — Unreleased

## Local Sign-In: Lockout After Failed Attempts, and a Warning for Demo Passwords

Local sign-in now locks an account for a while after repeated failed attempts, and the admin area
warns while the login page still offers the demo accounts with the passwords they ship with.

- After 5 failed sign-ins within 15 minutes, the account is locked for 15 minutes. While it is
  locked, sign-in is refused with "Too many failed sign-in attempts. Try again in … minutes."
  without checking the password. A successful sign-in, or a new password set under
  **Admin → Users**, clears the count.
- The limits are under **Admin → Authentication → Local Authentication Settings** (`localAuth.lockout` in
  `platform.json`), where the lockout can also be turned off. The upgrade adds the default
  settings.
- While **Show Demo Accounts in Login Form** is on and the `admin` or `user` demo account still has
  its shipped password, every admin page shows a warning with links to turn the option off or to
  change the passwords.
