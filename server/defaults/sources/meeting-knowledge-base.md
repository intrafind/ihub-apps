# Meeting Knowledge Base

This is a sample knowledge base used by the calendar-aware iHub apps
(`meeting-agenda-generator`, `meeting-briefing`). Administrators should
replace this content with their own organizational reference material —
or, better, swap the source binding in `config/sources.json` to point at
a `url`-type source backed by the company wiki, an `ifinder` source, or
any other connector iHub supports.

The content below is intentionally generic so the apps remain useful
out-of-the-box for demos and evaluation.

## Recurring Meetings

### Weekly Engineering Sync

- **Cadence:** Mondays, 10:00 – 10:30 (local time)
- **Purpose:** Surface blockers, share progress on the current sprint,
  align on cross-team dependencies.
- **Typical agenda:** Status round-robin (15 min) → Open issues (10 min)
  → Next-week priorities (5 min).
- **Owners:** Engineering Manager hosts; tech leads contribute updates.

### Monthly Product Review

- **Cadence:** First Wednesday of the month, 14:00 – 15:30.
- **Purpose:** Review feature launches, key metrics, customer feedback.
- **Typical agenda:** Launch recap → Metrics deep-dive → Roadmap
  preview → Q&A.

### Quarterly Business Review (QBR)

- **Cadence:** First week of each new quarter.
- **Purpose:** Whole-company review of OKRs, financials, customer
  health, and strategic priorities for the next quarter.

## Team Glossary

- **Platform Team:** Owns iHub infrastructure, deployments, and
  integration adapters.
- **Apps Team:** Owns the in-product AI applications, UX, and prompt
  engineering.
- **Customer Success:** Owns onboarding, training, and renewal motions.
- **Security & Compliance:** Owns security reviews, audit responses,
  vendor risk.

## Meeting Etiquette

- **Agenda first:** Every meeting longer than 30 minutes should circulate
  an agenda at least 24 hours in advance.
- **Decision log:** Capture decisions and owners in the meeting notes,
  not just discussion points.
- **Action items:** Each action item must have an assignee and a due
  date. "We should…" without an owner doesn't count.
- **Async first:** If a meeting can be replaced by a written update,
  cancel it.

## Common Project Codenames

- **Aurora:** Outlook add-in and calendar integration (this project).
- **Beacon:** Customer-facing analytics dashboard.
- **Compass:** Enterprise SSO and group management.
- **Delta:** Real-time chat infrastructure migration.

## Decision-Making Frameworks

- **DACI:** Driver, Approver, Contributors, Informed. Use for any
  cross-team initiative that needs a clear owner.
- **RFC + comment window:** Architectural decisions get a written
  proposal with a 5-business-day comment window before sign-off.
- **Single-threaded owner:** Long-running initiatives have one person
  accountable end-to-end, not a committee.
