// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import { runWatermarkSelfTest, testWatermarkDetector } from '../../../../api/euAiActAdminApi';
import CheckStatus from './CheckStatus';
import { BUTTON_SECONDARY } from './KeyDialogs';

/** Self-test diagnosis (server-side step 4) -> level and sentence. Never over-claims. */
function describeSelfTest(result, t) {
  const n = result.scoredTokens ?? 0;
  switch (result.diagnosis) {
    case 'keys_match':
      return {
        level: 'ok',
        text: t(
          'admin.euAiAct.selfTest.keysMatch',
          'Passed: the detector recognised the active key {{keyId}} ({{n}} tokens scored).',
          { keyId: result.matchedKeyId, n }
        )
      };
    case 'matches_retired_key':
      return {
        level: 'error',
        text: t(
          'admin.euAiAct.selfTest.retiredKey',
          'Failed: the text matches the retired key {{keyId}}. vLLM still runs the old key. Update vLLM with the current option and run the test again.',
          { keyId: result.matchedKeyId }
        )
      };
    case 'no_watermark_found':
      return {
        level: 'error',
        text: t(
          'admin.euAiAct.selfTest.notFound',
          'Failed: no key of this installation was found in the sample text. vLLM probably runs another key or no --watermark-config. Update vLLM with the current option and run the test again.'
        )
      };
    case 'too_short':
      return {
        level: 'warn',
        text: t(
          'admin.euAiAct.selfTest.tooShort',
          'Inconclusive: the sample text was too short ({{n}} tokens scored). Run the test again.',
          { n }
        )
      };
    case 'detector_unreachable':
      return {
        level: 'error',
        text: t(
          'admin.euAiAct.selfTest.unreachable',
          'Failed: the detector could not be reached or rejected the request. Use "Test connection" for details.'
        )
      };
    case 'not_applied':
      return {
        level: 'error',
        text: t(
          'admin.euAiAct.selfTest.notApplied',
          'Failed: the model did not apply the watermark to the sample ({{reason}}).',
          { reason: result.reason || '-' }
        )
      };
    case 'no_keys':
    default:
      return {
        level: 'warn',
        text: t(
          'admin.euAiAct.selfTest.noKeys',
          'There is no watermark key yet. Generate one first.'
        )
      };
  }
}

function describeConnection(result, t) {
  if (!result.reachable) {
    return {
      level: 'error',
      text: t('admin.euAiAct.test.unreachable', 'The detector did not answer ({{reason}}).', {
        reason: result.error || 'network'
      })
    };
  }
  if (!result.authenticated) {
    return {
      level: 'error',
      text: t('admin.euAiAct.test.unauthorized', 'The detector rejected the credential.')
    };
  }
  if (!result.contractValid) {
    return {
      level: 'error',
      text: t(
        'admin.euAiAct.test.contract',
        'The detector answered, but not in the expected format.'
      )
    };
  }
  return {
    level: 'ok',
    text: t('admin.euAiAct.test.ok', 'The detector answered in {{ms}} ms.', {
      ms: result.latencyMs
    })
  };
}

function DetectorRow({ detector, modelStatus, onChanged }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(null); // 'test' | 'selfTest' | null
  const [outcome, setOutcome] = useState(null);
  const modelId = detector.modelId;

  const run = async (kind, call, describe) => {
    setBusy(kind);
    setOutcome(null);
    try {
      const result = await call(modelId);
      setOutcome(describe(result, t));
    } catch (error) {
      setOutcome({ level: 'error', text: getAdminApiErrorMessage(error) });
    } finally {
      setBusy(null);
      onChanged?.();
    }
  };

  const last = modelStatus?.selfTest;
  const lastText =
    !last || last.state === 'never'
      ? t('admin.euAiAct.selfTest.never', 'Not run yet')
      : t(`admin.euAiAct.selfTest.state.${last.state}`, last.state) +
        (last.at ? ` (${new Date(last.at).toLocaleDateString()})` : '');

  return (
    <li className="border-t border-gray-200 dark:border-gray-700 pt-4 first:border-t-0 first:pt-0">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{modelId}</h4>
      <dl className="mt-2 grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-600 dark:text-gray-400">
          {t('admin.euAiAct.detector.url', 'Detector URL')}
        </dt>
        <dd className="text-gray-900 dark:text-gray-100 break-all font-mono text-xs">
          {detector.detectorUrl || t('admin.euAiAct.detector.notSet', 'Not set')}
          {detector.urlPolicyProblem && (
            <span className="block font-sans text-red-700 dark:text-red-300">
              {detector.urlPolicyProblem}
            </span>
          )}
        </dd>
        <dt className="text-gray-600 dark:text-gray-400">
          {t('admin.euAiAct.detector.credential', 'Credential')}
        </dt>
        <dd className="text-gray-900 dark:text-gray-100">
          {detector.credentialRef
            ? t('admin.euAiAct.detector.credentialSet', 'Set ({{ref}})', {
                ref: detector.credentialRef
              })
            : t('admin.euAiAct.detector.notSet', 'Not set')}
        </dd>
        <dt className="text-gray-600 dark:text-gray-400">
          {t('admin.euAiAct.detector.lastSelfTest', 'Last self-test')}
        </dt>
        <dd className="text-gray-900 dark:text-gray-100">{lastText}</dd>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link to={`/admin/models/${encodeURIComponent(modelId)}`} className={BUTTON_SECONDARY}>
          {t('admin.euAiAct.detector.edit', 'Edit detector settings')}
          <span className="sr-only"> {modelId}</span>
        </Link>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => run('test', testWatermarkDetector, describeConnection)}
          className={BUTTON_SECONDARY}
        >
          {t('admin.euAiAct.detector.test', 'Test connection')}
          <span className="sr-only"> {modelId}</span>
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          aria-busy={busy === 'selfTest'}
          onClick={() => run('selfTest', runWatermarkSelfTest, describeSelfTest)}
          className={BUTTON_SECONDARY}
        >
          <Icon
            name={busy === 'selfTest' ? 'refresh' : 'shield-check'}
            size="sm"
            className={busy === 'selfTest' ? 'animate-spin motion-reduce:animate-none' : ''}
          />
          {t('admin.euAiAct.selfTest.run', 'Run self-test')}
          <span className="sr-only"> {modelId}</span>
        </button>
        <span className="text-xs text-gray-600 dark:text-gray-400">
          {t('admin.euAiAct.selfTest.cost', 'Uses about 400 tokens.')}
        </span>
      </div>
      <div role="status" aria-live="polite" className="mt-3">
        {busy === 'selfTest' && (
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t(
              'admin.euAiAct.selfTest.running',
              'Generating sample text and checking the detector. This can take up to a minute…'
            )}
          </p>
        )}
        {busy === 'test' && (
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t('admin.euAiAct.test.running', 'Testing the connection…')}
          </p>
        )}
        {outcome && (
          <div className="flex flex-wrap items-start gap-2">
            <CheckStatus level={outcome.level} />
            <p className="text-sm text-gray-900 dark:text-gray-100 flex-1 min-w-0">
              {outcome.text}
            </p>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The per-model detector settings with "Test connection" and "Run self-test".
 * The settings themselves (URL, credential, tokenizer) are edited in the model
 * editor, so a secret keeps one write path.
 */
export default function DetectorRows({ detectors, statusModels, onChanged }) {
  const { t } = useTranslation();
  if (!detectors.length) {
    return (
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {t(
          'admin.euAiAct.detector.none',
          'No model is marked "iHub watermark". Set Output marking on a vLLM model to use the watermark.'
        )}
      </p>
    );
  }
  return (
    <ul className="space-y-4">
      {detectors.map(detector => (
        <DetectorRow
          key={detector.modelId}
          detector={detector}
          modelStatus={statusModels?.find(model => model.modelId === detector.modelId)}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
}
