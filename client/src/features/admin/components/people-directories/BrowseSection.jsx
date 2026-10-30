// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import GroupMultiSelect from '../GroupMultiSelect';
import { CredentialRefSelect } from '../OpenApiToolEditor';
import FormSection from './FormSection';
import ChoiceField from './ChoiceField';
import {
  CALLOUT_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS
} from './formStyles';
import {
  BROWSE_MAX_RESULTS_DEFAULT,
  BROWSE_MAX_RESULTS_LIMIT
} from '../../utils/peopleDirectories';

/**
 * Editor section "LDAP browser": the admin tool that reads raw entries
 * (`browse` in `peopleDirectories.json`). Off by default.
 *
 * It has its own groups, separate from the directory's: neither grants the
 * other, and "Everyone" is not offered. Switched off, a directory that had the
 * browser keeps (and shows) its settings. Without an account of its own, the
 * browser reads whatever the directory's bind account can read, minus the
 * attributes that never leave a directory.
 *
 * @param {Object} props
 * @param {Object} props.form - Form state
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 * @param {Array<{id: string, name?: string, description?: string}>} props.availableGroups - Defined groups
 * @param {string} [props.baseDnHint] - The base DN the browser defaults to
 * @param {'ldaps'|'starttls'|'plaintext'|'unknown'} props.transport - Connection security
 */
function BrowseSection({ form, update, availableGroups, baseDnHint, transport }) {
  const { t } = useTranslation();
  const id = form.id?.trim() || '<id>';

  const bindOptions = [
    {
      value: 'directory',
      label: t('admin.peopleDirectories.browse.bindDirectory', "The directory's account"),
      help: t(
        'admin.peopleDirectories.browse.bindDirectoryHelp',
        'The account under Access. The browser can read everything it can read.'
      )
    },
    {
      value: 'anonymous',
      label: t('admin.peopleDirectories.access.anonymous', 'Anonymous'),
      help: t(
        'admin.peopleDirectories.browse.bindAnonymousHelp',
        'Only what the directory shows to anonymous clients.'
      )
    },
    {
      value: 'service',
      label: t('admin.peopleDirectories.browse.bindService', 'An account of its own'),
      help: t(
        'admin.peopleDirectories.browse.bindServiceHelp',
        'A read-only account with exactly the reach admins should have.'
      )
    }
  ];

  return (
    <FormSection
      id="pd-browse"
      title={t('admin.peopleDirectories.browse.title', 'LDAP browser')}
      description={t(
        'admin.peopleDirectories.browse.description',
        'Lets admins ask about the directory in plain words and see the raw entries: attributes, branches, group members. Separate from people search, which only returns mapped fields.'
      )}
    >
      <ChoiceField
        id="pd-browse-enabled"
        type="checkbox"
        checked={form.browseEnabled}
        onChange={browseEnabled => update({ browseEnabled })}
        label={t('admin.peopleDirectories.browse.enabled', 'Offer the LDAP browser')}
        help={t(
          'admin.peopleDirectories.browse.enabledHelp',
          'Adds the tools {{tools}}. Only apps that list "ldapBrowse", such as the LDAP browser app, get them.',
          { tools: `${id}__browse_search, ${id}__browse_read, ${id}__browse_children` }
        )}
      />

      {/* Kept settings stay visible while the browser is off: they are saved
          and checked, so an error must be able to point at them. */}
      {!form.browseEnabled && form.hasBrowse && (
        <p className={CALLOUT_CLASS.info}>
          {t(
            'admin.peopleDirectories.browse.offKept',
            'The LDAP browser is off. Its settings below are kept for when you switch it on again.'
          )}
        </p>
      )}

      {(form.browseEnabled || form.hasBrowse) && (
        <>
          <GroupMultiSelect
            id="pd-browse-groups"
            label={t('admin.peopleDirectories.browse.groups', 'Who may browse')}
            value={form.browseGroups}
            onChange={browseGroups => update({ browseGroups })}
            availableGroups={availableGroups}
            allowCustom={false}
            placeholder={t(
              'admin.peopleDirectories.visibility.groupsPlaceholder',
              'Search groups…'
            )}
            helpText={t(
              'admin.peopleDirectories.browse.groupsHelp',
              "Signed-in users in one of these groups. Separate from the directory's groups under Visibility: neither grants the other."
            )}
          />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="pd-browse-base" className={LABEL_CLASS}>
                {t('admin.peopleDirectories.browse.base', 'Browse base')}
              </label>
              <input
                id="pd-browse-base"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.browseBase}
                onChange={e => update({ browseBase: e.target.value })}
                placeholder={baseDnHint || 'dc=example,dc=org'}
                aria-describedby="pd-browse-base-help"
                className={MONO_INPUT_CLASS}
              />
              <p id="pd-browse-base-help" className={HELP_CLASS}>
                {t(
                  'admin.peopleDirectories.browse.baseHelp',
                  'Every DN the browser reads must lie here. Leave empty for the base DN, the whole directory; set a branch to limit what admins can see.'
                )}
              </p>
            </div>
            <div>
              <label htmlFor="pd-browse-max-results" className={LABEL_CLASS}>
                {t('admin.peopleDirectories.browse.maxResults', 'Maximum entries per search')}
              </label>
              <input
                id="pd-browse-max-results"
                type="number"
                inputMode="numeric"
                min={1}
                max={BROWSE_MAX_RESULTS_LIMIT}
                value={form.browseMaxResults}
                onChange={e => update({ browseMaxResults: e.target.value })}
                placeholder={String(BROWSE_MAX_RESULTS_DEFAULT)}
                aria-describedby="pd-browse-max-results-help"
                className={INPUT_CLASS}
              />
              <p id="pd-browse-max-results-help" className={HELP_CLASS}>
                {t(
                  'admin.peopleDirectories.browse.maxResultsHelp',
                  '1 to {{max}}; empty for {{default}}.',
                  { max: BROWSE_MAX_RESULTS_LIMIT, default: BROWSE_MAX_RESULTS_DEFAULT }
                )}
              </p>
            </div>
          </div>

          <fieldset>
            <legend className={LABEL_CLASS}>
              {t('admin.peopleDirectories.browse.bind', 'Account for browsing')}
            </legend>
            <div className="space-y-3">
              {bindOptions.map(option => (
                <ChoiceField
                  key={option.value}
                  id={`pd-browse-bind-mode-${option.value}`}
                  name="pd-browse-bind-mode"
                  value={option.value}
                  checked={form.browseBindMode === option.value}
                  onChange={() => update({ browseBindMode: option.value })}
                  label={option.label}
                  help={option.help}
                />
              ))}
            </div>
          </fieldset>

          {form.browseBindMode === 'directory' && (
            <div className={CALLOUT_CLASS.warning} role="note">
              {t(
                'admin.peopleDirectories.browse.bindDirectoryWarning',
                "With the directory's account, the browser has the full reach of the people search account. Use an account of its own if that account can read more than admins should see."
              )}
            </div>
          )}

          {form.browseBindMode === 'service' && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="pd-browse-bind-dn" className={LABEL_CLASS}>
                  {t('admin.peopleDirectories.access.bindDn', 'Bind DN')}
                </label>
                <input
                  id="pd-browse-bind-dn"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.browseBindDn}
                  onChange={e => update({ browseBindDn: e.target.value })}
                  placeholder="cn=ldap-reader,ou=services,dc=example,dc=org"
                  className={MONO_INPUT_CLASS}
                />
              </div>
              <CredentialRefSelect
                id="pd-browse-bind-password-ref"
                value={form.browseBindPasswordRef}
                onChange={passwordRef => update({ browseBindPasswordRef: passwordRef })}
                types={['secret', 'basic']}
                label={t('admin.peopleDirectories.access.password', 'Password')}
                help={t(
                  'admin.peopleDirectories.access.passwordHelp',
                  'Choose the stored credential that holds the password.'
                )}
              />
              {transport === 'plaintext' && (
                <div className={`${CALLOUT_CLASS.danger} md:col-span-2`} role="note">
                  {t(
                    'admin.peopleDirectories.access.servicePlaintext',
                    'A service account never binds over plain text. Use ldaps:// or StartTLS, or this directory cannot connect.'
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <label htmlFor="pd-browse-deny-attributes" className={LABEL_CLASS}>
              {t('admin.peopleDirectories.browse.denyAttributes', 'Further attributes to withhold')}
            </label>
            <textarea
              id="pd-browse-deny-attributes"
              rows={2}
              spellCheck={false}
              value={form.browseDenyAttributes}
              onChange={e => update({ browseDenyAttributes: e.target.value })}
              placeholder="info"
              aria-describedby="pd-browse-deny-attributes-help"
              className={MONO_INPUT_CLASS}
            />
            <p id="pd-browse-deny-attributes-help" className={HELP_CLASS}>
              {t(
                'admin.peopleDirectories.browse.denyAttributesHelp',
                'One attribute name per line. Passwords, LAPS and BitLocker secrets, certificates and photos are always withheld; add attributes where your directory keeps other secrets. Withheld attributes cannot be used in a filter either.'
              )}
            </p>
          </div>

          <p className={CALLOUT_CLASS.info}>
            {t(
              'admin.peopleDirectories.browse.auditNote',
              'Every browser call is written to the audit log with the filter used, never the values returned. The LDAP browser app ships disabled: enable it under Apps and give it only to admin groups.'
            )}
          </p>
        </>
      )}
    </FormSection>
  );
}

export default BrowseSection;
