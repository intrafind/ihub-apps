import { getAppVersion } from './versionHelper.js';

/**
 * The add-in Id every iHub manifest carried before it became configurable.
 * Installations without `officeIntegration.addinId` keep serving it, so an
 * add-in already deployed in Outlook stays the same add-in.
 */
export const LEGACY_OFFICE_ADDIN_ID = '4fe644da-8036-47f8-ac9f-e478bcbe5274';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The manifest `<Id>` for this installation. */
export function resolveOfficeAddinId(officeConfig) {
  const id = officeConfig?.addinId;
  return typeof id === 'string' && GUID_RE.test(id) ? id.toLowerCase() : LEGACY_OFFICE_ADDIN_ID;
}

/**
 * The manifest `<Version>` (four numeric parts), taken from the iHub release
 * so every upgrade serves a higher version and Outlook picks up manifest
 * changes on re-deploy — a constant version made it keep the old one.
 */
export function officeManifestVersion(appVersion = getAppVersion()) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(appVersion ?? ''));
  return match ? `${match[1]}.${match[2]}.${match[3]}.0` : '1.1.0.0';
}
