import "./ZubiPage.css";
import type { AgentLanguage } from "../utils/llm";
import { getDisplayedImageContext } from "../utils/imageContext";

interface ZubiPageProps {
  isListening: boolean;
  isSpeaking: boolean;
  isRunning: boolean;
  agentLanguage: AgentLanguage;
  feedbackText: string;
  instructionText: string;
  childSpeechText: string;
  secondsLeft: number;
  onStartTest: () => void;
  onEndTest: () => void;
  onLanguageChange: (language: AgentLanguage) => void;
}

function ZubiPage({
  isListening,
  isSpeaking,
  isRunning,
  agentLanguage,
  feedbackText,
  instructionText,
  childSpeechText,
  secondsLeft,
  onStartTest,
  onEndTest,
  onLanguageChange,
}: ZubiPageProps) {
  const displayedImage = getDisplayedImageContext();

  return (
    <div className="zubi-page" role="application" aria-label="Speak with Zubi app">
      <header className="zubi-header" data-purpose="app-header">
        <div className="brand-pill">
          <div className="mascot-icon" aria-hidden="true">
            🐘
          </div>
          <h1 className="zubi-title">Speak with Zubi</h1>
        </div>

        <div className="language-selector" data-purpose="language-selector">
          <button
            type="button"
            className={`lang-btn ${agentLanguage === "en-IN" ? "active" : ""}`}
            title="English"
            aria-label="English"
            onClick={() => onLanguageChange("en-IN")}
            disabled={isRunning}
          >
            🇺🇸
          </button>
          <button
            type="button"
            className={`lang-btn ${agentLanguage === "hi-IN" ? "active" : ""}`}
            title="Hindi"
            aria-label="Hindi"
            onClick={() => onLanguageChange("hi-IN")}
            disabled={isRunning}
          >
            🇮🇳
          </button>
        </div>
      </header>

      <main className="zubi-main" data-purpose="interaction-area">
        <div className="decor decor-star-pulse" aria-hidden="true">
          ⭐
        </div>
        <div className="decor decor-star-bounce" aria-hidden="true">
          ⭐
        </div>
        <div className="decor decor-emoji-float" aria-hidden="true">
          😊
        </div>

        <div className="mascot-wrap" data-purpose="mascot-display">
          <div className="feedback-badge">{feedbackText}</div>

          <section className="visual-card" aria-label="Zubi mascot card">
            <div className={`mascot-stage ${isSpeaking ? "is-speaking" : ""}`}>
              {displayedImage.src ? (
                <img
                  id="mascot-image"
                  className={`mascot-image float-animation ${isListening ? "is-listening" : ""}`}
                  src={displayedImage.src}
                  alt={displayedImage.altText}
                />
              ) : (
                <div
                  id="mascot-image"
                  className={`mascot-image float-animation ${isListening ? "is-listening" : ""}`}
                  aria-label="No local mascot image found"
                >
                  🐘
                </div>
              )}
              <div className="zubi-tag">Zubi</div>
            </div>
          </section>

          <p className="instruction-text">{instructionText}</p>
        </div>

        <section className="test-controls" data-purpose="test-controls">
          <div className={`countdown-pill ${secondsLeft <= 10 ? "urgent" : ""}`}>
            Time Left: <strong>{secondsLeft}s</strong>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="test-btn start-test"
              onClick={onStartTest}
              disabled={isRunning}
            >
              Start Test
            </button>
            <button
              type="button"
              className="test-btn end-test"
              onClick={onEndTest}
              disabled={!isRunning}
            >
              End Test
            </button>
          </div>
          <p className="test-state">
            {isListening
              ? "Listening..."
              : isRunning
                ? "Test is running"
                : "Test is idle"}
          </p>
        </section>

        <section className="speech-panel" aria-live="polite">
          <div className="speech-header">
            <span className="speech-indicator" aria-hidden="true">
              {isListening ? "🎤" : "💬"}
            </span>
            <span className="speech-label">You said:</span>
          </div>
          <p className={`speech-text ${childSpeechText ? "has-text" : "placeholder"}`}>
            {childSpeechText
              ? childSpeechText
              : isListening
                ? "Listening..."
                : "Say something!"}
          </p>
        </section>
      </main>
    </div>
  );
}

export default ZubiPage;
