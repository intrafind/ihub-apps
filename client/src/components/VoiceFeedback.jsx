import React from "react";
import { useTranslation } from "react-i18next";

const wavesCount = 3;

const VoiceFeedback = (props) => {
  const { active } = props;
  const { t } = useTranslation();
  return (
    <div
      id="voice-feedback"
      className={`voice-feedback ${active ? "active" : ""}`}
    >
      <div className="voice-feedback-content">
        <div className="voice-waves">
          {Array.from(Array(wavesCount).keys()).map(() => (
            <div className="wave" />
          ))}
        </div>
        <h3 className="voice-text">
          {t("voiceInput.listening", "Listening...")}
        </h3>
        <span className="voice-instructions">
          {t("voiceInput.instructions", "Speak clearly and naturally")}
        </span>
      </div>
    </div>
  );
};

export default VoiceFeedback;
