import React from "react";
import { useTranslation } from "react-i18next";

const wavesCount = 3;

const VoiceFeedback = (props) => {
  const { isActive, setIsActive, transcript = "" } = props;
  const { t } = useTranslation();

  const onClose = () => {
    setIsActive(false);
  };

  return (
    <div
      id="voice-feedback"
      className={`voice-feedback ${isActive ? "active" : ""}`}
    >
      <div className="voice-feedback-content">
        <div className="voice-waves">
          {Array.from(Array(wavesCount).keys()).map((_, index) => (
            <div key={`wave-${index}`} className="wave" />
          ))}
        </div>
        <h3 className="voice-text">
          {t("voiceInput.listening", "Listening...")}
        </h3>
        <span className="voice-instructions">
          {t("voiceInput.instructions", "Speak clearly and naturally")}
        </span>
        {transcript && (
          <div className="voice-transcript">{transcript}</div>
        )}
        <button className="voice-close" onClick={onClose}>
          &times;
        </button>
      </div>
    </div>
  );
};

export default VoiceFeedback;
