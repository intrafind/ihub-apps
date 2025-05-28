import * as speechSdk from "microsoft-cognitiveservices-speech-sdk";

const host = import.meta.env.VITE_AZURE_SERVER || "http://bmas01lal:5000/";

// const postfix = '?language=de-DE';
const postfix = "";
const subscriptionId = import.meta.env.VITE_AZURE_SUBSCRIPTION_ID;

class AzureSpeechRecognition {
  recognition;
  lang = "de-DE";
  continuous = false;
  interimResults = true;

  constructor() {
    this.recognition = this.getRecognizerOnPrem();
  }

  start() {
    this.#triggerOnStart();

    this.recognition.recognizeOnceAsync((result) => {
      switch (result.reason) {
        case speechSdk.ResultReason.RecognizedSpeech:
          this.#triggerOnResult(result);
          this.#triggerOnEnd();
          break;
        case speechSdk.ResultReason.NoMatch:
          this.#triggerOnError({ error: "no-speech" });

          break;
        case speechSdk.ResultReason.Canceled:
          const cancellation = speechSdk.CancellationDetails.fromResult(result);

          if (cancellation.reason == speechSdk.CancellationReason.Error) {
            switch (cancellation.ErrorCode) {
              case speechSdk.CancellationErrorCode.Forbidden:
              case speechSdk.CancellationErrorCode.ServiceError:
              case speechSdk.CancellationErrorCode.TooManyRequests:
              case speechSdk.CancellationErrorCode.AuthenticationFailure:
                this.#triggerOnError({ error: "not-allowed" });
                break;
              case speechSdk.CancellationErrorCode.ServiceTimeout:
              case speechSdk.CancellationErrorCode.ConnectionFailure:
                this.#triggerOnError({ error: "network" });
                break;
              default:
                this.#triggerOnError({ error: "" });
            }
          }
          break;
      }
      this.recognition.close();
    });
  }

  stop() {
    if (this.recognition) {
      this.recognition.stopContinuousRecognitionAsync(
        () => {
          console.log("Recording stopped!");
        },
        (error) => {
          throw new Error(error);
        }
      );
    }
    this.recognition = null;
  }

  getRecognizerOnPrem() {
    try {
      const hostURL = new URL(
        `${host}/speech/recognition/interactive/cognitiveservices/v1${postfix}`
      );
      const speechConfig = speechSdk.SpeechConfig.fromHost(
        hostURL,
        subscriptionId
      );
      const audioConfig = speechSdk.AudioConfig.fromDefaultMicrophoneInput();

      // No German recognition like this
      speechConfig.speechRecognitionLanguage = "de-DE";
      const recognizer = new speechSdk.SpeechRecognizer(
        speechConfig,
        audioConfig
      );
      return recognizer;
    } catch (e) {
      if (!host) {
        console.error("Failed to construct URL since 'host' is not defined");
        return;
      }

      console.error(e);
    }
  }

  #triggerOnResult(result) {
    console.log("Triggered onresult...");
    if ("onresult" in this) {
      this.onresult(result);
      return;
    }
    console.log("'onresult' is not defined");
  }

  #triggerOnStart() {
    console.log("Triggered onstart...");
    if ("onstart" in this) {
      this.onstart();
      return;
    }
    console.log("'onstart' is not defined");
  }

  #triggerOnError(err) {
    console.log("Triggered onerror...");
    if ("onerror" in this) {
      this.onerror(err);
      return;
    }
    console.log("'onerror' is not defined");
  }

  #triggerOnEnd() {
    console.log("Triggered onend...");
    if ("onend" in this) {
      this.onend();
      return;
    }
    console.log("'onend' is not defined");
  }
}

export default AzureSpeechRecognition;
