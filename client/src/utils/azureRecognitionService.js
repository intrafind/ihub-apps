import * as speechSdk from "microsoft-cognitiveservices-speech-sdk";

// const postfix = '?language=de-DE';
const postfix = "";
const subscriptionId = import.meta.env.VITE_AZURE_SUBSCRIPTION_ID;

class AzureSpeechRecognition {
  recognition;
  lang = "de-DE";
  host = "";

  constructor() {}

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


  initRecognizer() {
    try {
      const hostURL = new URL(
        `${this.host}/speech/recognition/interactive/cognitiveservices/v1${postfix}`
      );
      const speechConfig = speechSdk.SpeechConfig.fromHost(
        hostURL,
        subscriptionId
      );
      const audioConfig = speechSdk.AudioConfig.fromDefaultMicrophoneInput();

      // No German recognition like this
      speechConfig.speechRecognitionLanguage = this.lang ?? "de-DE";
      const recognizer = new speechSdk.SpeechRecognizer(
        speechConfig,
        audioConfig
      );
      this.recognition = recognizer;
    } catch (e) {
      if (!host) {
        console.error("Failed to construct URL since 'host' is not defined");
        return;
      }

      console.error(e);
    }
  }

  // PRIVATE METHODS
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
