import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { LockClosedIcon, PlusIcon, TrashIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { fetchTransparencySettings, saveTransparencySettings } from './tabsApi';
import { extractApiError } from './fileHelpers';
import {
  SETTINGS_SECTION_KEYS,
  buildSettingsPatch,
  cloneSettings,
  fieldIdFor,
  getChangedSections,
  getIn,
  isNonConforming,
  setIn,
  validateSettingsDraft
} from './settingsModel';
import {
  Button,
  CheckboxField,
  DefinitionList,
  LoadingRow,
  Notice,
  NumberField,
  RadioCardGroup,
  SectionCard,
  SelectField,
  StatusPill,
  SwitchField,
  TextField
} from './EuAiActUi';

/** DOM id of a section card, used by the jump navigation. */
const sectionDomId = key => `eu-settings-section-${key}`;

/**
 * Settings tab of the EU AI Act admin page (`/admin/eu-ai-act?tab=settings`).
 *
 * Edits `platform.aiTransparency` through `GET/PUT
 * /admin/ai-transparency/settings`. The tab loads its own copy of the
 * settings, keeps a draft, and on save sends only the top-level sections
 * that changed. Switches whose "off" state makes the installation
 * non-conforming (disclosure, C2PA, image watermark, signing, detection)
 * show a warning while off.
 *
 * Form logic (diff, patch, validation, conformance) lives in
 * `settingsModel.js`; this component only renders and wires events.
 *
 * @param {Object} props
 * @param {Object} [props.status] - `GET /admin/ai-transparency/status` payload (for
 *   `featureActive` and the image-marking runtime status)
 * @param {() => void} [props.reload] - Refetches the status after a save
 */
function SettingsTab({ status, reload }) {
  const { t } = useTranslation();
  const [loadState, setLoadState] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [original, setOriginal] = useState(null);
  const [draft, setDraft] = useState(null);
  const [installation, setInstallation] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const focusAnchorIndexRef = useRef(null);

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError('');
    try {
      const data = await fetchTransparencySettings();
      setOriginal(cloneSettings(data.settings));
      setDraft(cloneSettings(data.settings));
      setInstallation(data.installation || null);
      setLoadState('ready');
    } catch (err) {
      setLoadError(extractApiError(err).message);
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Move focus into a trust-anchor textarea right after it was added.
  useEffect(() => {
    if (focusAnchorIndexRef.current === null) return;
    const el = document.getElementById(
      fieldIdFor(`signing.trustedAnchors.${focusAnchorIndexRef.current}`)
    );
    focusAnchorIndexRef.current = null;
    el?.focus();
  }, [draft?.signing?.trustedAnchors?.length]);

  const changedSections = useMemo(() => getChangedSections(original, draft), [original, draft]);
  const validationErrors = useMemo(() => validateSettingsDraft(draft), [draft]);
  const dirty = changedSections.length > 0;

  const sectionLabels = {
    provider: t('admin.euAiAct.settings.sections.provider', 'Provider details'),
    editorialResponsibility: t(
      'admin.euAiAct.settings.sections.editorialResponsibility',
      'Editorial responsibility'
    ),
    termsOfService: t('admin.euAiAct.settings.sections.termsOfService', 'Terms of service'),
    interactionDisclosure: t(
      'admin.euAiAct.settings.sections.interactionDisclosure',
      'Interaction disclosure'
    ),
    labels: t('admin.euAiAct.settings.sections.labels', 'Labels'),
    images: t('admin.euAiAct.settings.sections.images', 'Images'),
    text: t('admin.euAiAct.settings.sections.text', 'Text'),
    provenance: t('admin.euAiAct.settings.sections.provenance', 'Provenance records'),
    exports: t('admin.euAiAct.settings.sections.exports', 'Exports'),
    signing: t('admin.euAiAct.settings.sections.signing', 'Signing'),
    detection: t('admin.euAiAct.settings.sections.detection', 'Detection'),
    installationUrl: t('admin.euAiAct.settings.sections.installationUrl', 'Installation URL')
  };

  /** Human-readable text for a validation error from settingsModel. */
  const validationText = error => {
    if (!error) return undefined;
    switch (error.code) {
      case 'integerRange':
        return t(
          'admin.euAiAct.settings.validation.integerRange',
          'Enter a whole number between {{min}} and {{max}}.',
          error.params
        );
      case 'integerMin':
        return t(
          'admin.euAiAct.settings.validation.integerMin',
          'Enter a whole number of at least {{min}}.',
          error.params
        );
      case 'numberRange':
        return t(
          'admin.euAiAct.settings.validation.numberRange',
          'Enter a number between {{min}} and {{max}}.',
          error.params
        );
      case 'url':
        return t(
          'admin.euAiAct.settings.validation.url',
          'Enter an absolute http(s) URL, or leave the field empty.'
        );
      case 'pem':
        return t(
          'admin.euAiAct.settings.validation.pem',
          'Paste a PEM certificate (it starts with -----BEGIN CERTIFICATE-----).'
        );
      default:
        return t('admin.euAiAct.settings.validation.invalid', 'This value is not valid.');
    }
  };

  const errorFor = path => validationText(validationErrors.find(e => e.path === path));
  const update = (path, value) => setDraft(prev => setIn(prev, path, value));

  /** Props for a text/number field bound to a settings path. */
  const bind = path => ({
    id: fieldIdFor(path),
    value: getIn(draft, path),
    onChange: value => update(path, value),
    error: errorFor(path)
  });

  /** Props for a switch bound to a boolean settings path. */
  const bindSwitch = path => ({
    id: fieldIdFor(path),
    checked: Boolean(getIn(draft, path)),
    onChange: value => update(path, value),
    onLabel: t('admin.euAiAct.settings.switch.on', 'On'),
    offLabel: t('admin.euAiAct.settings.switch.off', 'Off')
  });

  const requiredBadge = t(
    'admin.euAiAct.settings.requiredForConformance',
    'Required for conformance'
  );

  const scrollToSection = key => {
    const el = document.getElementById(sectionDomId(key));
    if (!el) return;
    el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    el.focus({ preventScroll: true });
  };

  const handleDiscard = () => {
    setDraft(cloneSettings(original));
    setMessage(null);
  };

  const handleSave = async () => {
    if (validationErrors.length > 0) {
      setMessage({
        tone: 'error',
        text: t(
          'admin.euAiAct.settings.save.validationFailed',
          'Fix the highlighted fields before saving ({{count}} to fix).',
          { count: validationErrors.length }
        )
      });
      document.getElementById(fieldIdFor(validationErrors[0].path))?.focus();
      return;
    }
    const patch = buildSettingsPatch(original, draft);
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    setMessage(null);
    try {
      const data = await saveTransparencySettings(patch);
      setOriginal(cloneSettings(data.settings));
      setDraft(cloneSettings(data.settings));
      const saved = (data.changed || Object.keys(patch)).map(key => sectionLabels[key] || key);
      setMessage({
        tone: 'success',
        text:
          saved.length > 0
            ? t('admin.euAiAct.settings.save.success', 'Settings saved: {{sections}}.', {
                sections: saved.join(', ')
              })
            : t('admin.euAiAct.settings.save.noChanges', 'Nothing changed on the server.')
      });
      reload?.();
    } catch (err) {
      const { message: errorText, details } = extractApiError(err);
      setMessage({
        tone: 'error',
        text: t('admin.euAiAct.settings.save.error', 'Saving failed: {{error}}', {
          error: errorText
        }),
        details
      });
    } finally {
      setSaving(false);
    }
  };

  if (loadState === 'loading') {
    return <LoadingRow label={t('admin.euAiAct.settings.loading', 'Loading settings…')} />;
  }

  if (loadState === 'error' || !draft) {
    return (
      <Notice
        tone="error"
        role="alert"
        title={t('admin.euAiAct.settings.loadError', 'The settings could not be loaded.')}
      >
        {loadError && <p>{loadError}</p>}
        <div className="pt-2">
          <Button icon={ArrowPathIcon} onClick={load}>
            {t('admin.euAiAct.settings.retry', 'Try again')}
          </Button>
        </div>
      </Notice>
    );
  }

  const anchors = getIn(draft, 'signing.trustedAnchors') || [];
  const images = status?.images;

  const addAnchor = () => {
    focusAnchorIndexRef.current = anchors.length;
    update('signing.trustedAnchors', [...anchors, '']);
  };
  const removeAnchor = index => {
    update(
      'signing.trustedAnchors',
      anchors.filter((_, i) => i !== index)
    );
  };

  return (
    <div className="relative">
      {status && status.featureActive === false && (
        <Notice
          tone="warning"
          className="mb-6"
          title={t(
            'admin.euAiAct.settings.featureInactive.title',
            'The EU AI Act feature is switched off.'
          )}
        >
          <p>
            {t(
              'admin.euAiAct.settings.featureInactive.body',
              'These settings take effect once the feature is switched on.'
            )}{' '}
            <Link to="/admin/features" className="font-medium underline">
              {t('admin.euAiAct.settings.featureInactive.link', 'Open Features')}
            </Link>
          </p>
        </Notice>
      )}

      <div className="flex gap-8">
        <aside className="hidden lg:block w-52 shrink-0">
          <nav
            className="sticky top-4 space-y-1"
            aria-label={t('admin.euAiAct.settings.nav.label', 'Settings sections')}
          >
            {SETTINGS_SECTION_KEYS.map(key => (
              <button
                key={key}
                type="button"
                onClick={() => scrollToSection(key)}
                className="flex w-full items-center justify-between gap-2 text-left px-3 py-2 rounded-md text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
              >
                <span>{sectionLabels[key]}</span>
                {changedSections.includes(key) && (
                  <span className="text-xs text-amber-700 dark:text-amber-300">
                    {t('admin.euAiAct.settings.nav.changed', 'changed')}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </aside>

        <form
          className="flex-1 min-w-0 space-y-6 pb-4"
          noValidate
          onSubmit={e => {
            e.preventDefault();
            handleSave();
          }}
          aria-label={t('admin.euAiAct.settings.formLabel', 'EU AI Act settings')}
        >
          {/* ── Provider details ─────────────────────────────────────────── */}
          <SectionCard
            id={sectionDomId('provider')}
            title={sectionLabels.provider}
            description={t(
              'admin.euAiAct.settings.provider.description',
              'Who puts this installation into service. Shown in the compliance report and required for installations you run yourself.'
            )}
          >
            <TextField
              {...bind('provider.legalEntity')}
              label={t('admin.euAiAct.settings.provider.legalEntity', 'Legal entity')}
              hint={t(
                'admin.euAiAct.settings.provider.legalEntityHint',
                'Company or organisation name, as registered.'
              )}
              autoComplete="organization"
            />
            <TextField
              {...bind('provider.contact')}
              label={t('admin.euAiAct.settings.provider.contact', 'Contact')}
              hint={t(
                'admin.euAiAct.settings.provider.contactHint',
                'E-mail address or phone number for questions about AI transparency.'
              )}
            />
            <TextField
              {...bind('provider.address')}
              multiline
              rows={3}
              label={t('admin.euAiAct.settings.provider.address', 'Address')}
              autoComplete="street-address"
            />
            <RadioCardGroup
              name={fieldIdFor('provider.role')}
              legend={t('admin.euAiAct.settings.provider.role', 'Your role under the AI Act')}
              value={getIn(draft, 'provider.role')}
              onChange={value => update('provider.role', value)}
              options={[
                {
                  value: 'provider',
                  label: t('admin.euAiAct.settings.provider.roleProvider', 'Provider'),
                  description: t(
                    'admin.euAiAct.settings.provider.roleProviderDesc',
                    'You put iHub into service under your own name or trademark, or you modified it.'
                  )
                },
                {
                  value: 'deployer',
                  label: t('admin.euAiAct.settings.provider.roleDeployer', 'Deployer'),
                  description: t(
                    'admin.euAiAct.settings.provider.roleDeployerDesc',
                    'You use iHub unmodified, under your own authority.'
                  )
                }
              ]}
            />
            <Notice
              tone="info"
              title={t(
                'admin.euAiAct.settings.provider.roleInfoTitle',
                'How to decide (Art. 3(3))'
              )}
            >
              <p>
                {t(
                  'admin.euAiAct.settings.provider.roleInfoBody',
                  'A provider places an AI system on the market or puts it into service under its own name or trademark, or substantially modifies it. A deployer uses an AI system under its own authority without changing it. iHub plans conservatively: whoever installs and runs iHub themselves is treated as the provider of that installation. Choose “Deployer” only after your own legal assessment.'
                )}
              </p>
            </Notice>
          </SectionCard>

          {/* ── Editorial responsibility ─────────────────────────────────── */}
          <SectionCard
            id={sectionDomId('editorialResponsibility')}
            title={sectionLabels.editorialResponsibility}
            description={t(
              'admin.euAiAct.settings.editorial.description',
              'Art. 50(4): AI-generated text published to inform the public needs a person or team that holds editorial responsibility.'
            )}
          >
            <TextField
              {...bind('editorialResponsibility.contact')}
              label={t('admin.euAiAct.settings.editorial.contact', 'Editorial contact')}
              hint={t(
                'admin.euAiAct.settings.editorial.contactHint',
                'Name, team or e-mail address of whoever reviews AI-generated publications.'
              )}
            />
            <TextField
              {...bind('editorialResponsibility.policyUrl')}
              type="url"
              label={t('admin.euAiAct.settings.editorial.policyUrl', 'Editorial policy URL')}
              hint={t(
                'admin.euAiAct.settings.editorial.policyUrlHint',
                'Link to the policy that describes the human review.'
              )}
            />
          </SectionCard>

          {/* ── Terms of service ─────────────────────────────────────────── */}
          <SectionCard
            id={sectionDomId('termsOfService')}
            title={sectionLabels.termsOfService}
            description={t(
              'admin.euAiAct.settings.terms.description',
              'The Code of Practice asks providers to forbid removing AI markings in their terms of service.'
            )}
          >
            <CheckboxField
              id={fieldIdFor('termsOfService.markRemovalClause')}
              checked={getIn(draft, 'termsOfService.markRemovalClause')}
              onChange={value => update('termsOfService.markRemovalClause', value)}
              label={t(
                'admin.euAiAct.settings.terms.markRemovalClause',
                'Our terms of service prohibit removing or tampering with AI markings (CoP Measure 1.2(b))'
              )}
            />
            <TextField
              {...bind('termsOfService.url')}
              type="url"
              label={t('admin.euAiAct.settings.terms.url', 'Terms of service URL')}
            />
          </SectionCard>

          {/* ── Interaction disclosure ───────────────────────────────────── */}
          <SectionCard
            id={sectionDomId('interactionDisclosure')}
            title={sectionLabels.interactionDisclosure}
            description={t(
              'admin.euAiAct.settings.disclosure.description',
              'Art. 50(1): people must know they are interacting with an AI system. Admins can still switch the disclosure off for single apps, with a recorded reason.'
            )}
          >
            <SwitchField
              {...bindSwitch('interactionDisclosure.enabled')}
              label={t('admin.euAiAct.settings.disclosure.enabled', 'AI interaction disclosure')}
              description={t(
                'admin.euAiAct.settings.disclosure.enabledDesc',
                'Tell users in every app that they are talking to an AI system.'
              )}
              badge={requiredBadge}
              warning={
                isNonConforming(draft, 'interactionDisclosure.enabled')
                  ? t(
                      'admin.euAiAct.settings.warnings.disclosure',
                      'Off: users are no longer told that they are talking to an AI system. The installation does not conform to Art. 50(1). Use per-app opt-outs with a reason instead.'
                    )
                  : undefined
              }
            />
            <SwitchField
              {...bindSwitch('interactionDisclosure.firstTurnNotice')}
              label={t('admin.euAiAct.settings.disclosure.firstTurnNotice', 'First-turn notice')}
              description={t(
                'admin.euAiAct.settings.disclosure.firstTurnNoticeDesc',
                'Show a notice before the first message of a conversation.'
              )}
            />
            <SwitchField
              {...bindSwitch('interactionDisclosure.persistentBadge')}
              label={t('admin.euAiAct.settings.disclosure.persistentBadge', 'Persistent AI badge')}
              description={t(
                'admin.euAiAct.settings.disclosure.persistentBadgeDesc',
                'Keep an “AI” badge visible in the chat header.'
              )}
            />
            <SwitchField
              {...bindSwitch('interactionDisclosure.guardrail')}
              label={t('admin.euAiAct.settings.disclosure.guardrail', '“Are you an AI?” guardrail')}
              description={t(
                'admin.euAiAct.settings.disclosure.guardrailDesc',
                'Instruct the model to always admit that it is an AI when asked.'
              )}
            />
            <NumberField
              {...bind('interactionDisclosure.reminderInterval')}
              min={0}
              max={100}
              step={1}
              label={t(
                'admin.euAiAct.settings.disclosure.reminderInterval',
                'Reminder interval for sensitive apps (answers)'
              )}
              hint={t(
                'admin.euAiAct.settings.disclosure.reminderIntervalHint',
                'In apps marked as sensitive (legal, finance, health, complaints, vulnerable groups), repeat the notice every N assistant answers. 0 turns reminders off.'
              )}
            />
          </SectionCard>

          {/* ── Labels ───────────────────────────────────────────────────── */}
          <SectionCard
            id={sectionDomId('labels')}
            title={sectionLabels.labels}
            description={t(
              'admin.euAiAct.settings.labels.description',
              'Visible labels that tell readers content was generated by AI.'
            )}
          >
            <SwitchField
              {...bindSwitch('labels.messageBadge')}
              label={t('admin.euAiAct.settings.labels.messageBadge', 'Message badge')}
              description={t(
                'admin.euAiAct.settings.labels.messageBadgeDesc',
                'Show an “AI generated” chip on every assistant message.'
              )}
            />
            <SelectField
              id={fieldIdFor('labels.euIcon')}
              label={t('admin.euAiAct.settings.labels.euIcon', 'EU AI icon on exports')}
              value={getIn(draft, 'labels.euIcon')}
              onChange={value => update('labels.euIcon', value)}
              options={[
                { value: 'off', label: t('admin.euAiAct.settings.labels.euIconOff', 'Off') },
                {
                  value: 'optional',
                  label: t(
                    'admin.euAiAct.settings.labels.euIconOptional',
                    'Optional (the user decides per export)'
                  )
                },
                {
                  value: 'always',
                  label: t('admin.euAiAct.settings.labels.euIconAlways', 'Always')
                }
              ]}
            />
            <SwitchField
              {...bindSwitch('labels.exportLabel')}
              label={t('admin.euAiAct.settings.labels.exportLabel', 'Export label')}
              description={t(
                'admin.euAiAct.settings.labels.exportLabelDesc',
                'Add a visible AI label to the header or colophon of exported files.'
              )}
            />
            <SwitchField
              {...bindSwitch('labels.outbound')}
              label={t('admin.euAiAct.settings.labels.outbound', 'Outbound label')}
              description={t(
                'admin.euAiAct.settings.labels.outboundDesc',
                'Add a visible AI label to content that agents send to people: Jira, Outlook, webhooks and shared chats.'
              )}
            />
          </SectionCard>

          {/* ── Images ───────────────────────────────────────────────────── */}
          <SectionCard
            id={sectionDomId('images')}
            title={sectionLabels.images}
            description={t(
              'admin.euAiAct.settings.images.description',
              'Machine-readable marks on generated images (Art. 50(2)).'
            )}
          >
            <SwitchField
              {...bindSwitch('images.c2pa')}
              label={t('admin.euAiAct.settings.images.c2pa', 'C2PA manifest')}
              description={t(
                'admin.euAiAct.settings.images.c2paDesc',
                'Embed a signed C2PA manifest in every generated image.'
              )}
              badge={requiredBadge}
              warning={
                isNonConforming(draft, 'images.c2pa')
                  ? t(
                      'admin.euAiAct.settings.warnings.c2pa',
                      'Off: generated images carry no signed provenance manifest. The installation does not conform to Art. 50(2).'
                    )
                  : undefined
              }
            />
            <SelectField
              id={fieldIdFor('images.watermark')}
              label={t('admin.euAiAct.settings.images.watermark', 'Invisible watermark')}
              hint={t(
                'admin.euAiAct.settings.images.watermarkHint',
                'The watermark survives when metadata is stripped, e.g. by screenshots or re-uploads.'
              )}
              value={getIn(draft, 'images.watermark')}
              onChange={value => update('images.watermark', value)}
              options={[
                {
                  value: 'trustmark',
                  label: t('admin.euAiAct.settings.images.watermarkTrustmark', 'TrustMark')
                },
                {
                  value: 'none',
                  label: t('admin.euAiAct.settings.images.watermarkNone', 'None')
                }
              ]}
              after={
                isNonConforming(draft, 'images.watermark') ? (
                  <Notice tone="warning">
                    <p>
                      {t(
                        'admin.euAiAct.settings.warnings.watermark',
                        'No invisible watermark: the mark is lost as soon as metadata is removed. The installation does not conform to Art. 50(2).'
                      )}
                    </p>
                  </Notice>
                ) : undefined
              }
            />
            <NumberField
              {...bind('images.watermarkStrength')}
              min={0.1}
              max={1}
              step={0.05}
              label={t('admin.euAiAct.settings.images.watermarkStrength', 'Watermark strength')}
              hint={t(
                'admin.euAiAct.settings.images.watermarkStrengthHint',
                'Between 0.1 and 1. Higher values are more robust but can become visible. Default: 0.95.'
              )}
            />
            <TextField
              {...bind('images.trustmarkModelPath')}
              mono
              label={t('admin.euAiAct.settings.images.trustmarkModelPath', 'TrustMark model path')}
              hint={t(
                'admin.euAiAct.settings.images.trustmarkModelPathHint',
                'Directory with the TrustMark ONNX models. Empty uses contents/data/trustmark-models.'
              )}
            />
            <SwitchField
              {...bindSwitch('images.xmp')}
              label={t('admin.euAiAct.settings.images.xmp', 'IPTC/XMP metadata')}
              description={t(
                'admin.euAiAct.settings.images.xmpDesc',
                'Write the IPTC “trained algorithmic media” source type as a fallback for tools that do not read C2PA.'
              )}
            />
            {images && (
              <div className="rounded-md border border-gray-200 dark:border-gray-700 p-4">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
                  {t('admin.euAiAct.settings.images.runtimeTitle', 'Runtime status on this server')}
                </p>
                <DefinitionList
                  items={[
                    {
                      label: t('admin.euAiAct.settings.images.c2paLibrary', 'C2PA library'),
                      value: images.c2paAvailable ? (
                        <StatusPill tone="success">
                          {t('admin.euAiAct.settings.images.available', 'Available')}
                        </StatusPill>
                      ) : (
                        <StatusPill tone="error">
                          {t('admin.euAiAct.settings.images.notAvailable', 'Not available')}
                        </StatusPill>
                      )
                    },
                    {
                      label: t('admin.euAiAct.settings.images.trustmarkModels', 'TrustMark models'),
                      value:
                        images.watermarkAvailable && images.watermarkModelsPresent ? (
                          <StatusPill tone="success">
                            {t('admin.euAiAct.settings.images.modelsFound', 'Found')}
                          </StatusPill>
                        ) : (
                          <StatusPill tone="warning">
                            {t('admin.euAiAct.settings.images.modelsMissing', 'Not found')}
                          </StatusPill>
                        )
                    },
                    ...(images.modelPath
                      ? [
                          {
                            label: t(
                              'admin.euAiAct.settings.images.modelPathInUse',
                              'Model path in use'
                            ),
                            value: images.modelPath,
                            mono: true
                          }
                        ]
                      : []),
                    ...(images.watermarkError
                      ? [
                          {
                            label: t(
                              'admin.euAiAct.settings.images.watermarkError',
                              'Watermark error'
                            ),
                            value: images.watermarkError
                          }
                        ]
                      : [])
                  ]}
                />
              </div>
            )}
          </SectionCard>

          {/* ── Text ─────────────────────────────────────────────────────── */}
          <SectionCard
            id={sectionDomId('text')}
            title={sectionLabels.text}
            description={t(
              'admin.euAiAct.settings.text.description',
              'Marks on AI-generated free-form text.'
            )}
          >
            <NumberField
              {...bind('text.watermarkMinTokens')}
              min={1}
              step={1}
              label={t(
                'admin.euAiAct.settings.text.watermarkMinTokens',
                'Minimum length for text watermarking (tokens)'
              )}
              hint={t(
                'admin.euAiAct.settings.text.watermarkMinTokensHint',
                'Shorter answers are exempt, because a watermark cannot be detected reliably in them (CoP 1.1.2). Default: 200.'
              )}
            />
            <fieldset className="space-y-4">
              <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.euAiAct.settings.text.signpost', 'Signpost')}
              </legend>
              <p className="text-xs text-gray-500 dark:text-gray-400 -mt-2">
                {t(
                  'admin.euAiAct.settings.text.signpostHint',
                  'A C2PA text manifest made of invisible characters. It points verifiers to the detector of this installation (CoP 3.4).'
                )}
              </p>
              <SwitchField
                {...bindSwitch('text.signpost.exports')}
                label={t('admin.euAiAct.settings.text.signpostExports', 'In exported text files')}
              />
              <SwitchField
                {...bindSwitch('text.signpost.clipboard')}
                label={t(
                  'admin.euAiAct.settings.text.signpostClipboard',
                  'When copying to the clipboard'
                )}
                description={t(
                  'admin.euAiAct.settings.text.signpostClipboardDesc',
                  'Off by default until validated in a pilot: the invisible characters travel with the copied text.'
                )}
              />
            </fieldset>
            <SwitchField
              {...bindSwitch('text.strictMode')}
              label={t('admin.euAiAct.settings.text.strictMode', 'Strict mode')}
              description={t(
                'admin.euAiAct.settings.text.strictModeDesc',
                'Block unmarked free-form text above the minimum length (for example from models without text marking) instead of only flagging it.'
              )}
            />
            <Notice
              tone="warning"
              title={t(
                'admin.euAiAct.settings.text.strictModeNoteTitle',
                'Open decision: blocks unmarked long text. Off by default.'
              )}
            >
              <p>
                {t(
                  'admin.euAiAct.settings.text.strictModeNoteBody',
                  'Whether iHub should offer strict mode at all is still an open decision. The default is to flag, not block. Switch it on only if your installation must claim full Art. 50(2) conformance and your users can live with blocked answers.'
                )}
              </p>
            </Notice>
          </SectionCard>

          {/* ── Provenance records ───────────────────────────────────────── */}
          <SectionCard
            id={sectionDomId('provenance')}
            title={sectionLabels.provenance}
            description={t(
              'admin.euAiAct.settings.provenance.description',
              'A small record per AI answer: content hash, model, time and marking status, never the content. It lets iHub verify exports of chats that are not stored.'
            )}
          >
            <SwitchField
              {...bindSwitch('provenance.enabled')}
              label={t('admin.euAiAct.settings.provenance.enabled', 'Keep provenance records')}
            />
            <NumberField
              {...bind('provenance.retentionDays')}
              min={0}
              step={1}
              label={t('admin.euAiAct.settings.provenance.retentionDays', 'Retention (days)')}
              hint={t(
                'admin.euAiAct.settings.provenance.retentionDaysHint',
                '0 keeps the records until they are deleted.'
              )}
            />
          </SectionCard>

          {/* ── Exports ──────────────────────────────────────────────────── */}
          <SectionCard id={sectionDomId('exports')} title={sectionLabels.exports}>
            <SwitchField
              {...bindSwitch('exports.sign')}
              label={t('admin.euAiAct.settings.exports.sign', 'Sign exported files')}
              description={t(
                'admin.euAiAct.settings.exports.signDesc',
                'Add a signed provenance manifest to every exported file (C2PA where the format supports it).'
              )}
            />
          </SectionCard>

          {/* ── Signing ──────────────────────────────────────────────────── */}
          <SectionCard
            id={sectionDomId('signing')}
            title={sectionLabels.signing}
            description={t(
              'admin.euAiAct.settings.signing.description',
              'Signatures make manifests, exports and detection reports tamper-evident. Certificates are managed on the Certificates tab.'
            )}
          >
            <SwitchField
              {...bindSwitch('signing.enabled')}
              label={t('admin.euAiAct.settings.signing.enabled', 'Signing')}
              description={t(
                'admin.euAiAct.settings.signing.enabledDesc',
                'Sign C2PA manifests, exports and detection reports with the installation certificate.'
              )}
              badge={requiredBadge}
              warning={
                isNonConforming(draft, 'signing.enabled')
                  ? t(
                      'admin.euAiAct.settings.warnings.signing',
                      'Off: nothing is signed, so marks can be forged or altered unnoticed. The installation does not conform, and this warning cannot be dismissed.'
                    )
                  : undefined
              }
            />
            <TextField
              {...bind('signing.tsaUrl')}
              type="url"
              mono
              label={t(
                'admin.euAiAct.settings.signing.tsaUrl',
                'Time-stamp authority URL (RFC 3161)'
              )}
              hint={t(
                'admin.euAiAct.settings.signing.tsaUrlHint',
                'Empty uses the local clock of this server, which is documented in every record (typical for offline installations).'
              )}
            />
            <TextField
              {...bind('signing.organization')}
              label={t(
                'admin.euAiAct.settings.signing.organization',
                'Organization (certificate subject)'
              )}
              hint={t(
                'admin.euAiAct.settings.signing.organizationHint',
                'Empty uses the legal entity from the provider details. Applies to the next certificate that iHub issues.'
              )}
            />
            <TextField
              {...bind('signing.commonName')}
              label={t(
                'admin.euAiAct.settings.signing.commonName',
                'Common name (certificate subject)'
              )}
              hint={t(
                'admin.euAiAct.settings.signing.commonNameHint',
                'Empty uses “<organization> iHub”. Applies to the next certificate that iHub issues.'
              )}
            />
            <fieldset>
              <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.euAiAct.settings.signing.trustedAnchors', 'Trusted anchors')}
              </legend>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.euAiAct.settings.signing.trustedAnchorsHint',
                  'Root certificates (PEM) of other installations, e.g. of the same customer. Content they signed is shown as trusted here.'
                )}
              </p>
              <div className="mt-3 space-y-4">
                {anchors.length === 0 && (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('admin.euAiAct.settings.signing.noAnchors', 'No additional trust anchors.')}
                  </p>
                )}
                {anchors.map((pem, index) => {
                  const path = `signing.trustedAnchors.${index}`;
                  const number = index + 1;
                  return (
                    // Anchors have no stable id; the index is the identity here.
                    // eslint-disable-next-line @eslint-react/no-array-index-key
                    <div key={index} className="flex gap-2 items-start">
                      <div className="flex-1 min-w-0">
                        <TextField
                          {...bind(path)}
                          value={pem}
                          multiline
                          rows={5}
                          mono
                          placeholder="-----BEGIN CERTIFICATE-----"
                          label={t(
                            'admin.euAiAct.settings.signing.anchorLabel',
                            'Trust anchor {{number}} (PEM)',
                            { number }
                          )}
                        />
                      </div>
                      <Button
                        size="sm"
                        icon={TrashIcon}
                        className="mt-6"
                        onClick={() => removeAnchor(index)}
                        aria-label={t(
                          'admin.euAiAct.settings.signing.removeAnchorAria',
                          'Remove trust anchor {{number}}',
                          { number }
                        )}
                      >
                        {t('admin.euAiAct.settings.signing.removeAnchor', 'Remove')}
                      </Button>
                    </div>
                  );
                })}
                <Button size="sm" icon={PlusIcon} onClick={addAnchor}>
                  {t('admin.euAiAct.settings.signing.addAnchor', 'Add trust anchor')}
                </Button>
              </div>
            </fieldset>
          </SectionCard>

          {/* ── Detection ────────────────────────────────────────────────── */}
          <SectionCard
            id={sectionDomId('detection')}
            title={sectionLabels.detection}
            description={t(
              'admin.euAiAct.settings.detection.description',
              'The /verify page and the detection API of this installation (CoP 2.1).'
            )}
          >
            <SwitchField
              {...bindSwitch('detection.enabled')}
              label={t('admin.euAiAct.settings.detection.enabled', 'Detection')}
              description={t(
                'admin.euAiAct.settings.detection.enabledDesc',
                'Let people check whether content was generated by this installation.'
              )}
              badge={requiredBadge}
              warning={
                isNonConforming(draft, 'detection.enabled')
                  ? t(
                      'admin.euAiAct.settings.warnings.detection',
                      'Off: nobody can check content from this installation. The installation does not conform, and this warning cannot be dismissed.'
                    )
                  : undefined
              }
            />
            <RadioCardGroup
              name={fieldIdFor('detection.access')}
              legend={t('admin.euAiAct.settings.detection.access', 'Who may use the detector')}
              hint={t(
                'admin.euAiAct.settings.detection.accessHint',
                'Experts for free-form text watermark detection are approved on the Detection tab (CoP 2.1.2).'
              )}
              value={getIn(draft, 'detection.access')}
              onChange={value => update('detection.access', value)}
              options={[
                {
                  value: 'internal',
                  label: t('admin.euAiAct.settings.detection.accessInternal', 'Internal'),
                  description: t(
                    'admin.euAiAct.settings.detection.accessInternalDesc',
                    'Only admins and approved experts.'
                  )
                },
                {
                  value: 'authenticated',
                  label: t(
                    'admin.euAiAct.settings.detection.accessAuthenticated',
                    'Signed-in users'
                  ),
                  description: t(
                    'admin.euAiAct.settings.detection.accessAuthenticatedDesc',
                    'Every signed-in user of this installation.'
                  )
                },
                {
                  value: 'public',
                  label: t('admin.euAiAct.settings.detection.accessPublic', 'Public'),
                  description: t(
                    'admin.euAiAct.settings.detection.accessPublicDesc',
                    'Anyone, without signing in, rate-limited. For example for publicly shared chats.'
                  )
                }
              ]}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                {...bind('detection.rateLimit.windowMinutes')}
                min={1}
                step={1}
                label={t(
                  'admin.euAiAct.settings.detection.windowMinutes',
                  'Rate limit window (minutes)'
                )}
              />
              <NumberField
                {...bind('detection.rateLimit.limit')}
                min={1}
                step={1}
                label={t('admin.euAiAct.settings.detection.limit', 'Checks per window')}
              />
            </div>
            <SwitchField
              {...bindSwitch('detection.log.enabled')}
              label={t('admin.euAiAct.settings.detection.logEnabled', 'Detection log')}
              description={t(
                'admin.euAiAct.settings.detection.logEnabledDesc',
                'Records metadata only: time, requester, content hash, verdict and techniques.'
              )}
            />
            <NumberField
              {...bind('detection.log.retentionDays')}
              min={0}
              step={1}
              label={t('admin.euAiAct.settings.detection.logRetentionDays', 'Log retention (days)')}
              hint={t(
                'admin.euAiAct.settings.detection.logRetentionDaysHint',
                '0 keeps log entries until they are deleted.'
              )}
            />
            <div className="flex items-start justify-between gap-4 rounded-md border border-gray-200 dark:border-gray-700 p-4">
              <div className="min-w-0">
                <p
                  id={fieldIdFor('detection.zeroRetention')}
                  className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2"
                >
                  <LockClosedIcon className="h-4 w-4 text-gray-500" aria-hidden="true" />
                  {t(
                    'admin.euAiAct.settings.detection.zeroRetention',
                    'Zero retention of submitted content'
                  )}
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                  {t(
                    'admin.euAiAct.settings.detection.zeroRetentionDesc',
                    'Files and text submitted for detection are never stored (CoP 2.1.3). This is fixed and cannot be switched off.'
                  )}
                </p>
              </div>
              <StatusPill tone="success">
                {t('admin.euAiAct.settings.detection.alwaysOn', 'Always on')}
              </StatusPill>
            </div>
          </SectionCard>

          {/* ── Installation URL ─────────────────────────────────────────── */}
          <SectionCard
            id={sectionDomId('installationUrl')}
            title={sectionLabels.installationUrl}
            description={t(
              'admin.euAiAct.settings.installation.description',
              'The public address of this installation. It is written into provenance and opt-out records and into the signpost that points verifiers to /.well-known/ai-provenance.'
            )}
          >
            <TextField
              {...bind('installationUrl')}
              type="url"
              mono
              placeholder="https://ihub.example.com"
              label={t('admin.euAiAct.settings.installation.url', 'Installation URL')}
              hint={t(
                'admin.euAiAct.settings.installation.urlHint',
                'Empty uses the MCP public URL, or else the address the request came from.'
              )}
            />
            {installation && (
              <DefinitionList
                items={[
                  {
                    label: t('admin.euAiAct.settings.installation.currentUrl', 'URL in use'),
                    value: installation.installationUrl || '—',
                    mono: true
                  },
                  {
                    label: t('admin.euAiAct.settings.installation.id', 'Installation ID'),
                    value: installation.installationId || '—',
                    mono: true
                  },
                  {
                    label: t('admin.euAiAct.settings.installation.version', 'iHub version'),
                    value: installation.ihubVersion || '—'
                  }
                ]}
              />
            )}
          </SectionCard>
        </form>
      </div>

      {/* ── Sticky save bar + result messages ─────────────────────────────── */}
      <div
        className="sticky bottom-0 z-20 mt-6"
        role="region"
        aria-label={t('admin.euAiAct.settings.save.region', 'Save settings')}
      >
        <div aria-live="polite">
          {message && (
            <Notice tone={message.tone} className="mb-2 shadow-lg">
              <p>{message.text}</p>
              {message.details?.length > 0 && (
                <ul className="list-disc pl-5">
                  {message.details.map(detail => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </Notice>
          )}
        </div>
        {(dirty || saving) && (
          <div className="bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-700 dark:text-gray-300 flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
              {t('admin.euAiAct.settings.save.dirty', 'Unsaved changes in: {{sections}}', {
                sections: changedSections.map(key => sectionLabels[key]).join(', ')
              })}
            </p>
            <div className="flex items-center gap-2">
              <Button onClick={handleDiscard} disabled={saving}>
                {t('admin.euAiAct.settings.save.discard', 'Discard')}
              </Button>
              <Button variant="primary" busy={saving} onClick={handleSave}>
                {saving
                  ? t('admin.euAiAct.settings.save.saving', 'Saving…')
                  : t('admin.euAiAct.settings.save.save', 'Save changes')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default SettingsTab;
