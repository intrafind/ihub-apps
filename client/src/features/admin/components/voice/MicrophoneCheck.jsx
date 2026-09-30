import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../../../shared/components/Icon';
import { getMicrophoneErrorMessage } from '../../../voice/utils/speechService';

// RMS of normal speech sits around 0.05–0.2; scale so it fills most of the bar.
const LEVEL_GAIN = 6;
// Peak level above which we call the microphone "picking up sound".
const SOUND_DETECTED_LEVEL = 0.1;

/**
 * Live microphone input level, independent of any speech backend: tells "the
 * browser gets no audio" apart from "the backend returns no text".
 */
function MicrophoneCheck({ t }) {
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [deviceLabel, setDeviceLabel] = useState('');
  const [error, setError] = useState('');
  const resourcesRef = useRef(null);
  // Set on unmount, so a permission prompt answered after leaving the page
  // releases the microphone instead of metering on.
  const disposedRef = useRef(false);

  const stop = useCallback(() => {
    const resources = resourcesRef.current;
    resourcesRef.current = null;
    if (resources) {
      cancelAnimationFrame(resources.frame);
      resources.stream.getTracks().forEach(track => track.stop());
      resources.context.close().catch(() => {});
    }
    setActive(false);
    setLevel(0);
  }, []);

  // Release the microphone when the page is left mid-check.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      stop();
    };
  }, [stop]);

  const start = async () => {
    setError('');
    setPeak(0);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setError(getMicrophoneErrorMessage(err, t));
      return;
    }
    if (disposedRef.current) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextImpl();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const resources = { stream, context, frame: 0 };

    const measure = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const current = Math.min(1, Math.sqrt(sum / samples.length) * LEVEL_GAIN);
      setLevel(current);
      setPeak(previous => Math.max(previous, current));
      resources.frame = requestAnimationFrame(measure);
    };

    resourcesRef.current = resources;
    setDeviceLabel(stream.getAudioTracks()[0]?.label || '');
    setActive(true);
    measure();
  };

  const soundDetected = peak >= SOUND_DETECTED_LEVEL;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.voiceInput.test.mic.title', 'Microphone check')}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.voiceInput.test.mic.description',
            'Shows the input level of your microphone, without any speech service involved.'
          )}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={active ? stop : start}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-md border border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400 text-sm font-medium hover:bg-indigo-50 dark:hover:bg-indigo-900/20"
        >
          <Icon name="microphone" className="w-4 h-4" />
          {active
            ? t('admin.voiceInput.test.mic.stop', 'Stop')
            : t('admin.voiceInput.test.mic.start', 'Check microphone')}
        </button>
        <div
          className="flex-1 h-3 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden"
          role="meter"
          aria-label={t('admin.voiceInput.test.mic.level', 'Input level')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
        >
          <div
            className={`h-full transition-[width] duration-75 ${
              level >= SOUND_DETECTED_LEVEL ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-500'
            }`}
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
      </div>

      {active && (
        <p className="text-xs text-gray-600 dark:text-gray-400">
          {deviceLabel &&
            t('admin.voiceInput.test.mic.device', 'Device: {{device}}', { device: deviceLabel }) +
              ' · '}
          {soundDetected ? (
            <span className="text-green-600 dark:text-green-400">
              {t(
                'admin.voiceInput.test.mic.soundDetected',
                'Sound detected: the microphone works.'
              )}
            </span>
          ) : (
            t('admin.voiceInput.test.mic.speak', 'Speak; the bar should move.')
          )}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1" role="alert">
          <Icon name="clearCircle" className="w-4 h-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

export default MicrophoneCheck;
