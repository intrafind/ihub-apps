import * as speechSdk from 'microsoft-cognitiveservices-speech-sdk';
import { buildApiUrl } from './runtimeBasePath';

// const postfix = '?language=de-DE';
const postfix = '';

class AzureSpeechRecognition {
  recognition;
  lang = 'de-DE';
  host = '';
  continuous = false;
  interimResults = false;

  constructor() {}

  start() {
    this.#triggerOnStart();

    if (this.continuous) {
      // Use continuous recognition for manual mode
      this.#startContinuousRecognition();
    } else {
      // Use single-shot recognition for automatic mode
      this.#startSingleShotRecognition();
    }
  }

  stop() {
    if (this.continuous && this.recognition) {
      this.recognition.stopContinuousRecognitionAsync(
        () => {
          console.log('Continuous recognition stopped');
          this.#triggerOnEnd();
        },
        err => {
          console.error('Error stopping continuous recognition:', err);
          this.#triggerOnError({ error: 'network' });
        }
      );
    }
  }

  #startSingleShotRecognition() {
    this.recognition.recognizeOnceAsync(result => {
      switch (result.reason) {
        case speechSdk.ResultReason.RecognizedSpeech:
          this.#triggerOnResult(result);
          this.#triggerOnEnd();
          break;
        case speechSdk.ResultReason.NoMatch:
          this.#triggerOnError({ error: 'no-speech' });

          break;
        case speechSdk.ResultReason.Canceled:
          const cancellation = speechSdk.CancellationDetails.fromResult(result);

          if (cancellation.reason == speechSdk.CancellationReason.Error) {
            switch (cancellation.ErrorCode) {
              case speechSdk.CancellationErrorCode.Forbidden:
              case speechSdk.CancellationErrorCode.ServiceError:
              case speechSdk.CancellationErrorCode.TooManyRequests:
              case speechSdk.CancellationErrorCode.AuthenticationFailure:
                this.#triggerOnError({ error: 'not-allowed' });
                break;
              case speechSdk.CancellationErrorCode.ServiceTimeout:
              case speechSdk.CancellationErrorCode.ConnectionFailure:
                this.#triggerOnError({ error: 'network' });
                break;
              default:
                this.#triggerOnError({ error: '' });
            }
          }
          break;
      }
      this.recognition.close();
    });
  }

  #startContinuousRecognition() {
    // Set up event handlers for continuous recognition
    this.recognition.recognizing = (s, e) => {
      if (this.interimResults && e.result.reason === speechSdk.ResultReason.RecognizingSpeech) {
        // Trigger interim results
        this.#triggerOnResult({ text: e.result.text, isFinal: false });
      }
    };

    this.recognition.recognized = (s, e) => {
      if (e.result.reason === speechSdk.ResultReason.RecognizedSpeech) {
        // Trigger final results
        this.#triggerOnResult({ text: e.result.text, isFinal: true });
      } else if (e.result.reason === speechSdk.ResultReason.NoMatch) {
        console.log('No match found for current segment');
      }
    };

    this.recognition.canceled = (s, e) => {
      if (e.reason === speechSdk.CancellationReason.Error) {
        switch (e.errorCode) {
          case speechSdk.CancellationErrorCode.Forbidden:
          case speechSdk.CancellationErrorCode.ServiceError:
          case speechSdk.CancellationErrorCode.TooManyRequests:
          case speechSdk.CancellationErrorCode.AuthenticationFailure:
            this.#triggerOnError({ error: 'not-allowed' });
            break;
          case speechSdk.CancellationErrorCode.ServiceTimeout:
          case speechSdk.CancellationErrorCode.ConnectionFailure:
            this.#triggerOnError({ error: 'network' });
            break;
          default:
            this.#triggerOnError({ error: '' });
        }
      }
      this.#triggerOnEnd();
    };

    this.recognition.sessionStopped = (s, e) => {
      console.log('Session stopped');
      this.#triggerOnEnd();
    };

    // Start continuous recognition
    this.recognition.startContinuousRecognitionAsync(
      () => {
        console.log('Continuous recognition started');
      },
      err => {
        console.error('Error starting continuous recognition:', err);
        this.#triggerOnError({ error: 'network' });
      }
    );
  }

  // Fetch a short-lived Azure authorization token from the iHub server. The
  // subscription key stays server-side; the browser only ever sees the token.
  async #fetchAuthToken() {
    const res = await fetch(buildApiUrl('/voice/azure/token'), { credentials: 'include' });
    if (!res.ok) {
      let message = `Azure token request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(message);
    }
    return res.json(); // { token, region }
  }

  async initRecognizer() {
    try {
      const { token, region } = await this.#fetchAuthToken();

      // Prefer a custom host when configured (private/regional endpoint),
      // otherwise use the region from the token response. Either way the
      // recognizer authenticates with the short-lived token, never a key.
      let speechConfig;
      if (this.host) {
        const hostURL = new URL(
          `${this.host}/speech/recognition/interactive/cognitiveservices/v1${postfix}`
        );
        speechConfig = speechSdk.SpeechConfig.fromHost(hostURL);
        speechConfig.authorizationToken = token;
      } else {
        speechConfig = speechSdk.SpeechConfig.fromAuthorizationToken(token, region);
      }

      const audioConfig = speechSdk.AudioConfig.fromDefaultMicrophoneInput();
      speechConfig.speechRecognitionLanguage = this.lang ?? 'de-DE';
      this.recognition = new speechSdk.SpeechRecognizer(speechConfig, audioConfig);
    } catch (e) {
      console.error('Failed to initialize Azure recognizer:', e);
      this.#triggerOnError({ error: 'service', message: e.message });
    }
  }

  // PRIVATE METHODS
  #triggerOnResult(result) {
    console.log('Triggered onresult...');
    if ('onresult' in this) {
      this.onresult(result);
      return;
    }
    console.log("'onresult' is not defined");
  }

  #triggerOnStart() {
    console.log('Triggered onstart...');
    if ('onstart' in this) {
      this.onstart();
      return;
    }
    console.log("'onstart' is not defined");
  }

  #triggerOnError(err) {
    console.log('Triggered onerror...');
    if ('onerror' in this) {
      this.onerror(err);
      return;
    }
    console.log("'onerror' is not defined");
  }

  #triggerOnEnd() {
    console.log('Triggered onend...');
    if ('onend' in this) {
      this.onend();
      return;
    }
    console.log("'onend' is not defined");
  }

  // GETTER SETTER

  get host() {
    return this.host;
  }

  set host(host) {
    this.host = host;
  }

  get lang() {
    return this.lang;
  }

  set lang(lang) {
    this.lang = lang;
  }
}

export default AzureSpeechRecognition;
