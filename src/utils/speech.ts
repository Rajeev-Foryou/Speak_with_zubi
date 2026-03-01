import speakWithPolly from "./pollyTTS";

let isFirstUtterance = true;
const SpeechRecognitionCtor =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

const STT_API_URL = (import.meta.env.VITE_STT_API_URL as string) || "/api/stt/transcribe";
const STT_MODEL = "whisper-large-v3-turbo";

function parseNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const STT_MIN_REQUEST_INTERVAL_MS = parseNonNegativeNumber(
  import.meta.env.VITE_STT_MIN_REQUEST_INTERVAL_MS,
  1200,
);
const STT_BACKOFF_MS = 20000;
const MIN_AUDIO_BLOB_BYTES = 1400;

let sttLastRequestAt = 0;
let sttCooldownUntil = 0;
let currentSpeechPromise: Promise<void> = Promise.resolve();

let speechActivationPromise: Promise<{ activated: true }> | null = null;

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    0: { transcript: string };
    isFinal: boolean;
  }>;
};

interface ListenResult {
  transcript: string;
  isSilent: boolean;
  error: string | null;
  attemptsUsed: number;
}

declare global {
  interface Window {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "unknown-error";
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function isSpeechSupported(): boolean {
  // TTS is handled by Amazon Polly. For STT, support either browser SpeechRecognition
  // or Whisper recording prerequisites (MediaRecorder + mic access API).
  const hasBrowserStt = Boolean(SpeechRecognitionCtor);
  const hasWhisperSttPrereqs =
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.MediaRecorder !== "undefined";
  return hasBrowserStt || hasWhisperSttPrereqs;
}

function hasUserActivation(): boolean {
  return Boolean(navigator.userActivation?.hasBeenActive);
}

export function ensureSpeechOutputActivation(): Promise<{ activated: true }> {
  if (hasUserActivation()) {
    return Promise.resolve({ activated: true as const });
  }

  if (speechActivationPromise) {
    return speechActivationPromise;
  }

  speechActivationPromise = new Promise((resolve) => {
    const events = ["pointerdown", "keydown", "touchstart", "click"];

    const finish = () => {
      events.forEach((eventName) => {
        window.removeEventListener(eventName, finish, true);
      });
      speechActivationPromise = null;
      resolve({ activated: true as const });
    };

    events.forEach((eventName) => {
      window.addEventListener(eventName, finish, { once: true, capture: true });
    });
  });

  return speechActivationPromise;
}

export function getMissingSttEnvVars(): string[] {
  const missing: string[] = [];
  if (!STT_API_URL) missing.push("VITE_STT_API_URL");
  return missing;
}

export function isWhisperConfigured(): boolean {
  return getMissingSttEnvVars().length === 0;
}

export async function ensureMicrophoneAccess(): Promise<{
  ok: boolean;
  error: string | null;
}> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: "media-devices-unsupported" };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

function pickRecordingMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function recordAudioClip({
  durationMs = 7000,
}: {
  durationMs?: number;
} = {}): Promise<{ ok: boolean; error: string | null; blob: Blob | null }> {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return { ok: false, error: "media-recorder-unsupported", blob: null };
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    return { ok: false, error: getErrorMessage(error), blob: null };
  }

  return new Promise((resolve) => {
    const chunks: BlobPart[] = [];
    let recorder: MediaRecorder;

    try {
      const mimeType = pickRecordingMimeType();
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      resolve({ ok: false, error: "recorder-create-failed", blob: null });
      return;
    }

    const cleanup = () => {
      stream.getTracks().forEach((track) => track.stop());
    };

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onerror = () => {
      cleanup();
      resolve({ ok: false, error: "recorder-error", blob: null });
    };

    recorder.onstop = () => {
      cleanup();
      if (chunks.length === 0) {
        resolve({ ok: false, error: "empty-audio", blob: null });
        return;
      }

      const blob = new Blob(chunks, {
        type: recorder.mimeType || "audio/webm",
      });

      if (blob.size < MIN_AUDIO_BLOB_BYTES) {
        resolve({ ok: false, error: "audio-too-short", blob: null });
        return;
      }

      resolve({ ok: true, error: null, blob });
    };

    recorder.start();
    setTimeout(() => {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        cleanup();
        resolve({ ok: false, error: "recorder-stop-failed", blob: null });
      }
    }, durationMs);
  });
}

async function transcribeAudioBlob(blob: Blob, language: "en" | "hi" = "en"): Promise<string> {
  const now = Date.now();
  if (now < sttCooldownUntil) {
    throw new Error("STT_COOLDOWN_ACTIVE");
  }

  const elapsed = now - sttLastRequestAt;
  const waitMs = STT_MIN_REQUEST_INTERVAL_MS - elapsed;
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  const form = new FormData();
  const sttPromptByLanguage: Record<"en" | "hi", string> = {
    en: "A child aged 5 to 8 is answering one-question prompts about a jungle cartoon scene. Expected words are mostly animal names: elephant, lion, tiger, giraffe, rhinoceros, crocodile, monkey, snake, hippo, ostrich. Return only what the child actually says.",
    hi: "एक 5–8 साल का बच्चा जंगल के कार्टून चित्र पर सवालों के जवाब दे रहा है। संभावित शब्द: हाथी, शेर, बाघ, जिराफ़, गैंडा, मगरमच्छ, बंदर, सांप, दरियाई घोड़ा, शुतुरमुर्ग। रोमन हिंदी भी हो सकती है: hathi, sher, bagh, jiraf, genda, magarmach, bandar. जो बच्चा बोले वही लिखो।",
  };

  form.append("file", new File([blob], "child-audio.webm", { type: blob.type }));
  form.append("model", STT_MODEL);
  form.append("language", language);
  form.append("temperature", "0");
  form.append("response_format", "json");
  form.append("prompt", sttPromptByLanguage[language]);

  sttLastRequestAt = Date.now();

  const response = await fetch(STT_API_URL as string, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const backoffMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : STT_BACKOFF_MS;
      sttCooldownUntil = Date.now() + backoffMs;
      throw new Error("STT_RATE_LIMITED");
    }
    throw new Error(`STT request failed (${response.status}): ${errorText}`);
  }

  const json = (await response.json()) as { text?: string };
  return (json?.text || "").trim();
}

export async function speakText(
  text: string,
  options: {
    rate?: number;
    pitch?: number;
    volume?: number;
    voiceNameHint?: string;
    languageCode?: "en" | "hi" | "en-IN" | "hi-IN" | "en-US";
    bufferWord?: string;
    skipBuffer?: boolean;
    isQuestion?: boolean;
  } = {},
): Promise<void> {
  const runSpeech = async (): Promise<void> => {
    const normalizedText = (text || "").trim();
    const rawHint = (options?.voiceNameHint || "").trim().toLowerCase();
    const rawLanguage = (options?.languageCode || "").toLowerCase();

    if (!normalizedText) {
      return;
    }

    const languageKey: "en" | "hi" =
      rawLanguage.startsWith("hi") || rawHint === "hi" || rawHint === "hindi"
        ? "hi"
        : "en";

    const VOICE_BY_LANGUAGE: Record<"en" | "hi", string> = {
      en: "Joanna",
      hi: "Aditi",
    };

    const voiceId = VOICE_BY_LANGUAGE[languageKey] ?? "Joanna";
    const languageCode = languageKey === "hi" ? "hi-IN" : "en-US";

    try {
      await speakWithPolly(normalizedText, { voiceId, languageCode });
    } catch {
      throw new Error("tts-playback-failed");
    }
  };

  const queuedSpeech = currentSpeechPromise.then(runSpeech, runSpeech);
  currentSpeechPromise = queuedSpeech.catch(() => undefined);
  await queuedSpeech;
}

export function listenOnce({
  lang = "en-US",
  timeoutMs = 8000,
  minListenMs = 1800,
  interimResults = false,
  onInterim,
}: {
  lang?: string;
  timeoutMs?: number;
  minListenMs?: number;
  interimResults?: boolean;
  onInterim?: (text: string) => void;
} = {}): Promise<ListenResult> {
  return new Promise((resolve) => {
    if (!SpeechRecognitionCtor) {
      resolve({
        transcript: "",
        isSilent: true,
        error: "unsupported",
        attemptsUsed: 1,
      });
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = interimResults;
    recognition.maxAlternatives = 1;

    let finished = false;
    let timeoutId: number | null = null;
    let startedAt = 0;
    let restartedOnce = false;
    let recognitionEnded = false;
    let pendingPayload: ListenResult | null = null;

    const resolvePayload = (payload: ListenResult) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve(payload);
    };

    const finish = (payload: ListenResult) => {
      if (finished) return;
      finished = true;

      pendingPayload = payload;

      try {
        recognition.stop();
      } catch {
        recognitionEnded = true;
      }

      if (recognitionEnded && pendingPayload) {
        const finalPayload = pendingPayload;
        pendingPayload = null;
        resolvePayload(finalPayload);
      }
    };

    const startRecognition = () => {
      startedAt = Date.now();
      recognition.start();
    };

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      const results = event?.results;
      let finalTranscript = "";
      let interimTranscript = "";

      for (let i = event.resultIndex; i < results.length; i += 1) {
        const chunk = results?.[i]?.[0]?.transcript || "";
        if (results?.[i]?.isFinal) {
          finalTranscript += chunk;
        } else {
          interimTranscript += chunk;
        }
      }

      const cleanInterim = interimTranscript.trim();
      if (cleanInterim && typeof onInterim === "function") {
        onInterim(cleanInterim);
      }

      const transcript = finalTranscript.trim();
      if (transcript) {
        finish({ transcript, isSilent: false, error: null, attemptsUsed: 1 });
      }
    };

    recognition.onerror = (event: { error: string }) => {
      if (event.error === "no-speech") {
        finish({ transcript: "", isSilent: true, error: null, attemptsUsed: 1 });
        return;
      }
      finish({
        transcript: "",
        isSilent: true,
        error: event.error,
        attemptsUsed: 1,
      });
    };

    recognition.onend = () => {
      recognitionEnded = true;

      if (finished && pendingPayload) {
        const finalPayload = pendingPayload;
        pendingPayload = null;
        resolvePayload(finalPayload);
        return;
      }

      if (!finished) {
        const elapsed = Date.now() - startedAt;
        if (elapsed < minListenMs && !restartedOnce) {
          restartedOnce = true;
          try {
            startRecognition();
            return;
          } catch {
            // ignore and finish silently
          }
        }
        finish({ transcript: "", isSilent: true, error: null, attemptsUsed: 1 });
      }
    };

    timeoutId = window.setTimeout(() => {
      finish({ transcript: "", isSilent: true, error: "timeout", attemptsUsed: 1 });
    }, timeoutMs);

    try {
      startRecognition();
    } catch {
      finish({
        transcript: "",
        isSilent: true,
        error: "start-failed",
        attemptsUsed: 1,
      });
    }
  });
}

export async function listenForChildResponse({
  attempts = 2,
  lang = "en-US",
  timeoutMs = 12000,
  minListenMs = 2500,
  onInterim,
}: {
  attempts?: number;
  lang?: string;
  timeoutMs?: number;
  minListenMs?: number;
  onInterim?: (text: string) => void;
} = {}): Promise<ListenResult> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const heard = await listenOnce({
      lang,
      timeoutMs,
      minListenMs,
      interimResults: true,
      onInterim,
    });

    lastError = heard.error;

    if (heard.transcript?.trim()) {
      return {
        transcript: heard.transcript.trim(),
        isSilent: false,
        error: null,
        attemptsUsed: attempt,
      };
    }

    if (
      heard.error === "not-allowed" ||
      heard.error === "service-not-allowed" ||
      heard.error === "audio-capture"
    ) {
      return {
        transcript: "",
        isSilent: true,
        error: heard.error,
        attemptsUsed: attempt,
      };
    }
  }

  return {
    transcript: "",
    isSilent: true,
    error: lastError,
    attemptsUsed: attempts,
  };
}

export async function listenForChildResponseWhisper({
  attempts = 2,
  language = "en",
  recordDurationMs = 7000,
  onPhase,
}: {
  attempts?: number;
  language?: "en" | "hi";
  recordDurationMs?: number;
  onPhase?: (phase: "recording" | "transcribing", attempt: number) => void;
} = {}): Promise<ListenResult> {
  if (!isWhisperConfigured()) {
    return {
      transcript: "",
      isSilent: true,
      error: "stt-not-configured",
      attemptsUsed: 0,
    };
  }

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (typeof onPhase === "function") onPhase("recording", attempt);
    const recording = await recordAudioClip({ durationMs: recordDurationMs });

    if (!recording.ok || !recording.blob) {
      lastError = recording.error;
      continue;
    }

    try {
      if (typeof onPhase === "function") onPhase("transcribing", attempt);
      const transcript = await transcribeAudioBlob(recording.blob, language);
      if (transcript && countWords(transcript) >= 1) {
        return {
          transcript,
          isSilent: false,
          error: null,
          attemptsUsed: attempt,
        };
      }
      lastError = "empty-transcript";
    } catch (error) {
      lastError = getErrorMessage(error);
      if (lastError === "STT_RATE_LIMITED") {
        return {
          transcript: "",
          isSilent: true,
          error: "stt-rate-limited",
          attemptsUsed: attempt,
        };
      }

      if (lastError === "STT_COOLDOWN_ACTIVE") {
        return {
          transcript: "",
          isSilent: true,
          error: "stt-cooldown",
          attemptsUsed: attempt,
        };
      }
    }
  }

  return {
    transcript: "",
    isSilent: true,
    error: lastError,
    attemptsUsed: attempts,
  };
}
