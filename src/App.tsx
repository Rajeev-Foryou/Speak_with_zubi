import { useState } from "react";
import ZubiPage from "./components/ZubiPage";
import VoiceController, {
  type AgentLanguage,
  type VoiceControllerViewState,
} from "./components/VoiceController";

type SessionState = "idle" | "running" | "finished";

const INITIAL_VIEW_STATE: VoiceControllerViewState = {
  turnState: "IDLE",
  status: "Press Start Test to begin.",
  currentQuestion: "",
  lastChildAnswer: "",
  interimText: "",
  isListening: false,
  secondsLeft: 60,
  latestZubiMessage: "",
  chatMessages: [],
};

function App() {
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [agentLanguage, setAgentLanguage] = useState<AgentLanguage>("en-IN");
  const [voiceView, setVoiceView] = useState<VoiceControllerViewState>(INITIAL_VIEW_STATE);

  const isRunning = sessionState === "running";
  const isSpeaking = voiceView.turnState === "AI_SPEAKING";

  const handleStartTest = () => {
    if (isRunning) return;
    setVoiceView(INITIAL_VIEW_STATE);
    setSessionState("running");
  };

  const handleEndTest = () => {
    if (!isRunning) return;
    setSessionState("idle");
    setVoiceView(INITIAL_VIEW_STATE);
  };

  const handleLanguageChange = (language: AgentLanguage) => {
    if (isRunning) return;
    setAgentLanguage(language);
  };

  const feedbackText = sessionState === "finished"
    ? "Great job! 🌟"
    : voiceView.isListening
      ? "Listening 👂"
      : isRunning
        ? "Keep going! 🌟"
        : "Let’s play! 🌟";

  const instructionText =
    voiceView.currentQuestion ||
    voiceView.status ||
    "Say something to Zubi!";

  const childSpeechText = voiceView.interimText || voiceView.lastChildAnswer;

  return (
    <>
      <ZubiPage
        isListening={voiceView.isListening}
        isSpeaking={isSpeaking}
        isRunning={isRunning}
        agentLanguage={agentLanguage}
        feedbackText={feedbackText}
        instructionText={instructionText}
        childSpeechText={childSpeechText}
        secondsLeft={voiceView.secondsLeft}
        onStartTest={handleStartTest}
        onEndTest={handleEndTest}
        onLanguageChange={handleLanguageChange}
      />

      {isRunning ? (
        <VoiceController
          agentLanguage={agentLanguage}
          onStateChange={setVoiceView}
          onConversationEnd={() => setSessionState("finished")}
        />
      ) : null}
    </>
  );
}

export default App;
