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

## Skills: Users Create, Share and Promote Their Own Skills

Signed-in users can now write skills of their own on the new **Skills** page (`/skills`), the
same way they keep prompts: instructions the model follows, optional text reference files, and a
description that tells the model when to use the skill. Prompts and skills now share one
**Library** page (`/prompts`, with a Prompts / Skills switch). A skill is used by writing
`/skill-name` in a message — the `/` picker inserts it — or automatically when a request matches;
scheduled tasks use the same `/skill-name` in their instructions.

- A skill is private until it is shared with users, groups or everyone signed in, as *can use*
  or *can edit*. Every save is kept as a version that can be restored, and any skill — global
  skills included — can be copied into **My skills** to adapt it.
- Under **Admin → Skills → User skills**, admins and content admins see the skills shared with a
  group or everyone, can edit, re-share or delete them, and can **promote** one to a global skill.
  Limits and sharing options are in the same place (`userSkills` in `platform.json`; the upgrade
  adds the defaults).
- An app can keep user skills out with `"skillSettings": { "allowPersonal": false }`.
- User skills need the **Agent Skills** feature.
