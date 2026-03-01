import { useEffect, useRef, useState } from "react";
import {
  type AgentLanguage,
  generateClosingLine,
  getInstantReaction,
  getMissingLlmEnvVars,
  getQuestionForTurn,
  isLlmConfigured,
} from "../utils/llm";
import {
  endVoiceSession,
  ensureMicrophoneAccess,
  ensureSpeechOutputActivation,
  getMissingSttEnvVars,
  isSpeechSupported,
  isWhisperConfigured,
  listenForChildResponse,
  listenForChildResponseWhisper,
  speakText,
  startVoiceSession,
  stopActiveSttCapture,
  waitForSpeechIdle,
} from "../utils/speech";

const MAX_TURNS = 10;
const GLOBAL_TIME_LIMIT_MS = 60_000;
const LISTEN_WINDOW_MS = 3000;
const RETRY_LISTEN_WINDOW_MS = 2500;
const LLM_TIMEOUT_MS = 3500;
const TTS_TIMEOUT_MS = 12000;

const SPOKEN_LINES: Record<AgentLanguage, {
  gentleRetryPrompt: string;
  politeSilenceEnd: string;
  micIssueEnd: string;
  timeUpEnd: string;
  fallbackClosing: string;
}> = {
  "en-IN": {
    gentleRetryPrompt: "I am listening, friend. Please say it one more time.",
    politeSilenceEnd: "That is okay, friend. You did great. Bye-bye!",
    micIssueEnd: "Please check your microphone. Bye-bye, friend!",
    timeUpEnd: "Time is up! You did amazing! Bye-bye, friend!",
    fallbackClosing: "You did amazing today. I am proud of you. Bye-bye, friend!",
  },
  "hi-IN": {
    gentleRetryPrompt: "मैं सुन रही हूँ दोस्त, कृपया एक बार फिर बोलो।",
    politeSilenceEnd: "कोई बात नहीं दोस्त, तुमने बहुत अच्छा किया। बाय-बाय!",
    micIssueEnd: "कृपया अपना माइक्रोफ़ोन जांचो। बाय-बाय, दोस्त!",
    timeUpEnd: "समय पूरा हो गया! तुमने बहुत अच्छा किया! बाय-बाय, दोस्त!",
    fallbackClosing: "आज तुमने कमाल कर दिया। मुझे तुम पर गर्व है। बाय-बाय, दोस्त!",
  },
};

type TurnState =
  | "IDLE"
  | "AI_SPEAKING"
  | "WAITING_FOR_CHILD"
  | "PROCESSING_RESPONSE"
  | "END";

const ALLOWED_TRANSITIONS: Record<TurnState, TurnState[]> = {
  IDLE: ["AI_SPEAKING", "END"],
  AI_SPEAKING: ["WAITING_FOR_CHILD", "END"],
  WAITING_FOR_CHILD: ["PROCESSING_RESPONSE", "AI_SPEAKING", "END"],
  PROCESSING_RESPONSE: ["AI_SPEAKING", "END"],
  END: [],
};

interface ChatMessage {
  id: string;
  speaker: "zubi" | "child";
  text: string;
}

interface HeardResult {
  transcript: string;
  isSilent: boolean;
  error: string | null;
  fatal?: boolean;
}

export interface VoiceToolActionEvent {
  gotAnswer: boolean;
  turn: number;
  totalTurns: number;
}

export interface VoiceControllerViewState {
  turnState: TurnState;
  status: string;
  currentQuestion: string;
  lastChildAnswer: string;
  interimText: string;
  isListening: boolean;
  secondsLeft: number;
  latestZubiMessage: string;
  chatMessages: Array<{
    id: string;
    speaker: "zubi" | "child";
    text: string;
  }>;
}

export type { AgentLanguage };

interface VoiceControllerProps {
  agentLanguage: AgentLanguage;
  onToolAction?: (event: VoiceToolActionEvent) => void;
  onConversationEnd?: () => void;
  onStateChange?: (state: VoiceControllerViewState) => void;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
    }),
  ]);
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return fallback;
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function estimateTtsTimeoutMs(text: string): number {
  const words = Math.max(1, countWords(text));
  const estimatedSpeechMs = Math.ceil((words / 2.6) * 1000);
  const bufferMs = 1800;
  return Math.max(2500, Math.min(TTS_TIMEOUT_MS, estimatedSpeechMs + bufferMs));
}

function VoiceController({
  agentLanguage,
  onToolAction,
  onConversationEnd,
  onStateChange,
}: VoiceControllerProps) {
  const [turnState, setTurnState] = useState<TurnState>("IDLE");
  const [status, setStatus] = useState("Preparing...");
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [lastChildAnswer, setLastChildAnswer] = useState("");
  const [interimText, setInterimText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [secondsLeft, setSecondsLeft] = useState(60);

  const stopRef = useRef(false);
  const stateRef = useRef<TurnState>("IDLE");
  const sttModeRef = useRef<"whisper" | "browser">("whisper");
  const deadlineRef = useRef(0);
  const timerIdRef = useRef<number | null>(null);
  const onToolActionRef = useRef(onToolAction);
  const onConversationEndRef = useRef(onConversationEnd);
  const onStateChangeRef = useRef(onStateChange);
  const spokenLines = SPOKEN_LINES[agentLanguage];

  // Keep refs in sync with latest props without restarting the effect
  useEffect(() => {
    onToolActionRef.current = onToolAction;
    onConversationEndRef.current = onConversationEnd;
    onStateChangeRef.current = onStateChange;
  }, [onToolAction, onConversationEnd, onStateChange]);

  useEffect(() => {
    onStateChangeRef.current?.({
      turnState,
      status,
      currentQuestion,
      lastChildAnswer,
      interimText,
      isListening,
      secondsLeft,
      latestZubiMessage:
        [...chatMessages]
          .reverse()
          .find((message) => message.speaker === "zubi")
          ?.text ?? "",
      chatMessages,
    });
  }, [
    turnState,
    status,
    currentQuestion,
    lastChildAnswer,
    interimText,
    isListening,
    secondsLeft,
    chatMessages,
  ]);

  const transitionTo = (next: TurnState): boolean => {
    const current = stateRef.current;
    if (current === next) return true;

    if (!ALLOWED_TRANSITIONS[current].includes(next)) {
      return false;
    }

    stateRef.current = next;
    setTurnState(next);
    return true;
  };

  useEffect(() => {
    stopRef.current = false;
    startVoiceSession(agentLanguage);

    const addMessage = (speaker: "zubi" | "child", text: string) => {
      if (!text) return;
      setChatMessages((prev) => [
        ...prev,
        { id: `${Date.now()}-${Math.random()}`, speaker, text },
      ]);
    };

    const remainingMs = (deadline: number): number => Math.max(0, deadline - Date.now());

    const speakTurn = async (text: string, deadline: number) => {
      if (remainingMs(deadline) <= 0) {
        throw new Error("global-timeout");
      }

      stopActiveSttCapture();
      setIsListening(false);

      await speakText(text, {
        rate: 0.98,
        pitch: 1.0,
        volume: 1,
        languageCode: agentLanguage,
      });
    };

    const listenChildOnce = async (
      deadline: number,
      isRetry: boolean,
    ): Promise<HeardResult> => {
      const listenMs = isRetry ? RETRY_LISTEN_WINDOW_MS : LISTEN_WINDOW_MS;
      const available = remainingMs(deadline);
      if (available < 1200) {
        return { transcript: "", isSilent: true, error: "global-timeout" };
      }

      await waitForSpeechIdle();
      if (stopRef.current) {
        return { transcript: "", isSilent: true, error: "stopped" };
      }

      const cappedListen = Math.min(listenMs, available);
      setIsListening(true);
      setInterimText("");

      let heard: HeardResult = {
        transcript: "",
        isSilent: true,
        error: "silence",
      };

      if (sttModeRef.current === "whisper") {
        try {
          heard = await withTimeout(
            listenForChildResponseWhisper({
              attempts: 1,
              language: agentLanguage === "hi-IN" ? "hi" : "en",
              recordDurationMs: cappedListen,
              onPhase: (phase) => {
                if (phase === "recording") setStatus("Listening to child...");
                if (phase === "transcribing") setStatus("Processing child voice...");
              },
            }),
            Math.min(available, cappedListen + 5000),
            "stt-timeout",
          );
        } catch (error) {
          heard = {
            transcript: "",
            isSilent: true,
            error: toErrorMessage(error, "stt-timeout"),
          };
        }

        if (
          heard.error &&
          heard.error !== "silence" &&
          heard.error !== "global-timeout"
        ) {
          if (agentLanguage === "hi-IN") {
            console.warn("[Zubi] Whisper STT error in Hindi mode; keeping Whisper mode:", heard.error);
            setStatus("Listening mode continues in Hindi...");
          } else {
            console.warn("[Zubi] Whisper STT error, switching to browser STT:", heard.error);
            sttModeRef.current = "browser";
            setStatus("Switching to browser listening mode...");
          }
        }
      }

      if (sttModeRef.current === "browser") {
        try {
          heard = await withTimeout(
            listenForChildResponse({
              attempts: 1,
              lang: agentLanguage,
              timeoutMs: cappedListen,
              minListenMs: 1800,
              onInterim: (text) => setInterimText(text),
            }),
            Math.min(available, cappedListen + 2000),
            "browser-stt-timeout",
          );
        } catch (error) {
          heard = {
            transcript: "",
            isSilent: true,
            error: toErrorMessage(error, "browser-stt-timeout"),
          };
        }
      }

      setIsListening(false);

      if (
        heard.error === "not-allowed" ||
        heard.error === "service-not-allowed" ||
        heard.error === "audio-capture"
      ) {
        return { ...heard, fatal: true };
      }

      const cleanTranscript = (heard.transcript || "").trim();
      if (!cleanTranscript || countWords(cleanTranscript) < 1) {
        return { transcript: "", isSilent: true, error: heard.error || "silence" };
      }

      return { transcript: cleanTranscript, isSilent: false, error: null };
    };

    const endConversation = async (deadline: number, reasonLine?: string) => {
      if (!transitionTo("AI_SPEAKING")) {
        transitionTo("END");
        onConversationEndRef.current?.();
        return;
      }

      const closing = reasonLine || (await withTimeout(
        generateClosingLine({ language: agentLanguage }),
        Math.max(1200, Math.min(LLM_TIMEOUT_MS, remainingMs(deadline))),
        "llm-timeout",
      ).catch(() => spokenLines.fallbackClosing));

      setStatus("Zubi is saying goodbye...");
      addMessage("zubi", closing);
      await speakTurn(closing, deadline).catch(() => undefined);

      transitionTo("END");
      setStatus("Conversation complete.");
      setCurrentQuestion("");
      setIsListening(false);
      onConversationEndRef.current?.();
    };

    const runConversation = async () => {
      if (!isLlmConfigured()) {
        setStatus(`Missing LLM env config: ${getMissingLlmEnvVars().join(", ")}`);
        transitionTo("END");
        onConversationEndRef.current?.();
        return;
      }

      const whisperConfigured = isWhisperConfigured();
      if (!whisperConfigured) {
        if (!isSpeechSupported()) {
          setStatus(`Missing STT env config: ${getMissingSttEnvVars().join(", ")}`);
          transitionTo("END");
          onConversationEndRef.current?.();
          return;
        }
        sttModeRef.current = "browser";
      } else {
        sttModeRef.current = "whisper";
      }

      setStatus("Tap or click once to enable voice...");
      await ensureSpeechOutputActivation();

      const mic = await ensureMicrophoneAccess();
      if (!mic.ok) {
        setStatus(`Microphone access failed (${mic.error}).`);
        transitionTo("END");
        onConversationEndRef.current?.();
        return;
      }

      const startedAt = Date.now();
      const deadline = startedAt + GLOBAL_TIME_LIMIT_MS;
      deadlineRef.current = deadline;
      const history: Array<{ role: "assistant" | "user"; content: string }> = [];

      // Start visible countdown timer
      timerIdRef.current = window.setInterval(() => {
        const left = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
        setSecondsLeft(left);
        if (left <= 0 && timerIdRef.current) {
          clearInterval(timerIdRef.current);
          timerIdRef.current = null;
        }
      }, 250);

      stateRef.current = "IDLE";
      setTurnState("IDLE");
      setChatMessages([]);

      let turnIndex = 0;

      while (!stopRef.current && Date.now() < deadline) {
        const entry = getQuestionForTurn(turnIndex, agentLanguage);

        const question = entry.question;

        if (!transitionTo("AI_SPEAKING")) {
          break;
        }

        setCurrentQuestion(question);
        setStatus("Zubi is speaking...");
        addMessage("zubi", question);
        history.push({ role: "assistant", content: question });
        await speakTurn(question, deadline).catch(() => undefined);

        if (stopRef.current || Date.now() >= deadline) {
          break;
        }

        if (!transitionTo("WAITING_FOR_CHILD")) {
          break;
        }

        let heard = await listenChildOnce(deadline, false);
        if (heard.fatal) {
          await endConversation(deadline, spokenLines.micIssueEnd);
          return;
        }

        if (heard.error === "global-timeout") {
          await endConversation(deadline, spokenLines.timeUpEnd);
          return;
        }

        if (heard.isSilent) {
          if (Date.now() >= deadline) break;
          if (!transitionTo("AI_SPEAKING")) {
            break;
          }

          setStatus("Zubi gives a gentle retry prompt...");
          addMessage("zubi", spokenLines.gentleRetryPrompt);
          await speakTurn(spokenLines.gentleRetryPrompt, deadline).catch(() => undefined);

          if (stopRef.current || Date.now() >= deadline) {
            break;
          }

          if (!transitionTo("WAITING_FOR_CHILD")) {
            break;
          }

          heard = await listenChildOnce(deadline, true);
          if (heard.fatal) {
            await endConversation(deadline, spokenLines.micIssueEnd);
            return;
          }

          if (heard.error === "global-timeout") {
            await endConversation(deadline, spokenLines.timeUpEnd);
            return;
          }

          if (heard.isSilent) {
            await endConversation(deadline, spokenLines.politeSilenceEnd);
            return;
          }
        }

        if (!transitionTo("PROCESSING_RESPONSE")) {
          break;
        }

        setStatus("Processing answer...");
        const childAnswer = heard.transcript;
        setLastChildAnswer(childAnswer);
        setInterimText("");
        addMessage("child", childAnswer);
        history.push({ role: "user", content: childAnswer });

        const reaction = getInstantReaction(childAnswer, turnIndex, agentLanguage);

        if (!transitionTo("AI_SPEAKING")) {
          break;
        }

        setStatus("Zubi is replying...");
        addMessage("zubi", reaction);
        history.push({ role: "assistant", content: reaction });
        await speakTurn(reaction, deadline).catch(() => undefined);

        onToolActionRef.current?.({
          gotAnswer: true,
          turn: turnIndex,
          totalTurns: 10,
        });

        turnIndex += 1;
      }

      if (Date.now() >= deadline) {
        await endConversation(deadline, spokenLines.timeUpEnd);
        return;
      }

      await endConversation(deadline);
    };

    runConversation();

    return () => {
      stopRef.current = true;
      stopActiveSttCapture();
      endVoiceSession();
      stateRef.current = "END";
      setTurnState("END");
      setIsListening(false);
      if (timerIdRef.current) {
        clearInterval(timerIdRef.current);
        timerIdRef.current = null;
      }
      // TTS now handled by Amazon Polly; nothing to cancel here.
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

export default VoiceController;
