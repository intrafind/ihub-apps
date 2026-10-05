# EU AI Act admin page shell and compliance banner (client)

Issue: intrafind/ihub-apps#2566 (epic #2563). Concept: `concepts/2026-09-27 EU AI Act Content Marking.md` §8.6.
Server contract: `server/routes/admin/aiTransparency.js` and `server/services/provenance/ComplianceService.js`.

This note explains how the client side of `/admin/eu-ai-act` and the admin compliance banner is built, so
anyone can continue the work.

## What the admin sees

- **Sidebar → Platform → EU AI Act** (`/admin/eu-ai-act`, also in the command palette).
- **Header:** title, overall pill "Conforming" / "Non-conforming", installation ID / URL / iHub version /
  status time, **Refresh**, **Download compliance report** (signed PDF).
- **Tabs** (`?tab=` in the URL, so checklist "Fix" links such as `/admin/eu-ai-act?tab=settings` open the
  right tab): Overview, Models, Apps, Settings, Certificates, Detection.
- **Banner** on the start page and the admin overview, for full admins only, when there are undismissed
  warnings.

## File map

| File | Layer | What it does |
| --- | --- | --- |
| `client/src/api/aiTransparencyAdminApi.js` | API | Wrappers for status, banner, dismissals, app opt-out/exemption, model acknowledgement, report download. Return `response.data`. |
| `client/src/features/admin/utils/euAiAct.js` | Logic | Pure helpers: tab ids, justification length, record normalisation, warning split, filters, banner audience. Unit-tested. |
| `client/src/features/admin/hooks/useAiTransparencyStatus.js` | State | Loads `/status`, exposes `reload()`. Keeps the old status while reloading, so tabs keep their form state. |
| `client/src/features/admin/hooks/useComplianceBanner.js` | State | Loads `/banner` only when `enabled`. |
| `client/src/features/admin/pages/AdminEuAiActPage.jsx` | Page | Header, tabs, panels. Owns `?tab=`. |
| `components/euAiAct/OverviewTab.jsx` | UI | Checklist (traffic light + text), active warnings with "Dismiss…", dismissed warnings with "Restore". |
| `components/euAiAct/ModelsTab.jsx` | UI | Model compliance matrix (reuses `DataTable`). Acknowledge / withdraw / edit model. |
| `components/euAiAct/AppsTab.jsx` | UI | Apps table: disclosure, opt-out, exemption, sensitive category, temperature 0. |
| `components/euAiAct/JustificationDialog.jsx` | UI | Shared modal that asks for a justification (min. 10 characters). |
| `components/euAiAct/ComplianceBadges.jsx` | UI | Pills with icon + text (never colour alone). |
| `components/euAiAct/RecordSummary.jsx` | UI | Who / when / reason / installation of any record. |
| `components/euAiAct/ComplianceBanner.jsx` | UI | Admin gate. Lazy-loads the panel only for admins. |
| `components/euAiAct/ComplianceBannerPanel.jsx` | UI | The banner itself (fetch, list, dismiss). |
| `components/euAiAct/SettingsTab.jsx`, `CertificatesTab.jsx`, `DetectionTab.jsx` | UI | Written separately; each gets `{ status, reload }`. |
| `tests/unit/client/eu-ai-act-page-shell.test.jsx` | Test | Helpers, dialog, banner gate, matrix, tab shell. |

(`components/` = `client/src/features/admin/components/`.)

## Rules the UI must keep

1. **A dismissal never changes conformance.** It only hides a banner entry for the state it was made for
   (`stateHash`). Every place that offers "Dismiss…" says so.
2. **An acknowledged unmarked model stays "Non-conforming".** Always render the server's `conforming` flag;
   never compute green from the acknowledgement.
3. **Only warnings with `dismissible: true`** get a "Dismiss…" button (ids starting `model:`,
   `certificate:`, `app:`). The others show "cannot be dismissed".
4. **Non-admins never see or fetch the banner.** `isComplianceBannerUser(user)` excludes content admins
   and the `anonymous` principal (the server always refuses it with 403, and a 403 would clear an
   anonymous-mode admin token in `makeAdminApiCall`).
5. **Status is text + icon**, never colour alone (WCAG 1.4.1).

## How to add a tab

1. Add the id to `EU_AI_ACT_TABS` in `utils/euAiAct.js`.
2. Add the component to `TAB_PANELS` and a label fallback to `TAB_LABEL_FALLBACKS` in `AdminEuAiActPage.jsx`.
3. Add `admin.euAiAct.tabs.<id>` to both language files.
4. The component receives `{ status, reload }`; call `await reload()` after every change.

## How to use the justification dialog

```jsx
<JustificationDialog
  open={Boolean(target)}
  title={t('admin.euAiAct.x.title', 'Title')}
  description={<p>{t('admin.euAiAct.x.description', 'What this record means')}</p>}
  label={t('admin.euAiAct.dialog.justification', 'Justification')}
  submitLabel={t('admin.euAiAct.x.submit', 'Save')}
  onSubmit={async reason => {
    await someApiCall(target.id, reason); // reject → message shown in the dialog, it stays open
    await reload(); // resolve → the dialog calls onClose()
  }}
  onClose={() => setTarget(null)}
>
  {/* optional extra fields; pass canSubmit={false} until they are valid */}
</JustificationDialog>
```

## i18n

All strings use `t('admin.euAiAct.…', 'English fallback')` (plus `admin.nav.euAiAct`, `common.cancel`,
`common.loading`). The keys of this part live under `admin.euAiAct.{title,subtitle,tabs,installation,
report,status,checkStatus,severity,common,checklist,overview,dismissDialog,dialog,record,models,apps,banner}`.
Settings, certificates and detection use `admin.euAiAct.{settings,certificates,detection}`.
Count strings avoid plurals ("Warnings: 3") so no `_one`/`_other` keys are needed.

## Known gaps / next steps

- The checklist `detail` and warning `message` come from the server in English. Translating them needs
  message ids + params from the server (the `params` field is already there).
- Two justification dialogs exist: this one and `client/src/shared/components/JustificationDialog.jsx`
  (app/model editors). They should be merged into one.
- The admin-page visibility key is `euAiAct`: `platform.admin.pages.euAiAct: false` hides the route and
  the sidebar entry, like every other admin page (there is no UI for these switches).
