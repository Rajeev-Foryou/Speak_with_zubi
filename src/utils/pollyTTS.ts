import {
  PollyClient,
  SynthesizeSpeechCommand,
  type OutputFormat,
} from "@aws-sdk/client-polly";

type VoiceId = "Aditi";

const REGION = (import.meta.env.VITE_AWS_REGION as string) || "ap-south-1";
const ACCESS_KEY = import.meta.env.VITE_AWS_ACCESS_KEY_ID as string;
const SECRET_KEY = import.meta.env.VITE_AWS_SECRET_ACCESS_KEY as string;

if (!ACCESS_KEY || !SECRET_KEY) {
  console.warn("VITE_AWS_ACCESS_KEY_ID or VITE_AWS_SECRET_ACCESS_KEY missing in env");
}

const polly = new PollyClient({
  region: REGION,
  credentials: ACCESS_KEY && SECRET_KEY ? { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY } : undefined,
});

let lastPlayPromise: Promise<void> = Promise.resolve();
let activeAudio: HTMLAudioElement | null = null;

const LEADING_SILENCE_MS = 180;
const DEBUG_VOICE_LOGS = import.meta.env.DEV && import.meta.env.VITE_DEBUG_VOICE === "true";

function debugVoice(...args: unknown[]) {
  if (DEBUG_VOICE_LOGS) {
    console.info(...args);
  }
}

function escapeSsml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildBufferedSsml(text: string): string {
  const safe = escapeSsml(text);
  return `<speak><break time=\"${LEADING_SILENCE_MS}ms\"/>${safe}</speak>`;
}

function toMergedBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (total === 0) {
    throw new Error("Polly returned empty audio data");
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function toBlobBuffer(bytes: Uint8Array): ArrayBuffer {
  const clone = new Uint8Array(bytes.byteLength);
  clone.set(bytes);
  return clone.buffer;
}

async function streamToBlob(stream: unknown, mime = "audio/mpeg") {
  if (!stream) throw new Error("Polly returned empty audio stream");

  if (typeof (stream as any)?.transformToByteArray === "function") {
    const bytes = await (stream as any).transformToByteArray();
    if (!bytes?.length) throw new Error("Polly returned empty audio data");
    return new Blob([bytes], { type: mime });
  }

  if (typeof (stream as any)?.arrayBuffer === "function") {
    const buffer = await (stream as any).arrayBuffer();
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
      throw new Error("Polly returned empty audio data");
    }
    return new Blob([buffer], { type: mime });
  }

  if (typeof (stream as ReadableStream<any>)?.getReader === "function") {
    const reader = (stream as ReadableStream<Uint8Array | ArrayBuffer>).getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
    }

    const merged = toMergedBytes(chunks);
    return new Blob([toBlobBuffer(merged)], { type: mime });
  }

  if (typeof (stream as AsyncIterable<Uint8Array>)?.[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];

    for await (const part of stream as AsyncIterable<Uint8Array | ArrayBuffer>) {
      if (!part) continue;
      chunks.push(part instanceof Uint8Array ? part : new Uint8Array(part));
    }

    const merged = toMergedBytes(chunks);
    return new Blob([toBlobBuffer(merged)], { type: mime });
  }

  if (stream instanceof Uint8Array) {
    if (!stream.length) throw new Error("Polly returned empty audio data");
    return new Blob([toBlobBuffer(stream)], { type: mime });
  }

  if (stream instanceof ArrayBuffer) {
    if (!stream.byteLength) throw new Error("Polly returned empty audio data");
    return new Blob([stream], { type: mime });
  }

  if (stream instanceof Blob) {
    if (!stream.size) throw new Error("Polly returned empty audio data");
    return stream;
  }

  throw new Error("Unsupported Polly audio stream type");
}

function inferLanguageKey(input?: string): "en" | "hi" {
  const normalized = (input || "").toLowerCase();
  return normalized.startsWith("hi") ? "hi" : "en";
}

function resolveVoiceId(
  options: { voiceId?: VoiceId; languageCode?: string } = {},
): VoiceId {
  const requestedVoice = (options.voiceId || "Aditi").trim();
  if (requestedVoice === "Aditi") {
    return "Aditi";
  }
  return "Aditi";
}

function buildSynthesisConfig(
  voiceId: VoiceId,
  languageCodeHint?: string,
  outputFormat?: OutputFormat,
) {
  const languageKey = inferLanguageKey(languageCodeHint);
  const languageCode: "en-IN" | "hi-IN" = languageKey === "hi" ? "hi-IN" : "en-IN";
  return {
    voiceId,
    languageCode,
    outputFormat: outputFormat || "mp3",
    sampleRate: "22050",
    engine: undefined,
  };
}

function waitForAudioReady(audio: HTMLAudioElement): Promise<void> {
  if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("Audio failed to buffer before playback"));
    };

    const cleanup = () => {
      audio.removeEventListener("canplaythrough", onReady);
      audio.removeEventListener("loadeddata", onReady);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("abort", onError);
    };

    audio.addEventListener("canplaythrough", onReady, { once: true });
    audio.addEventListener("loadeddata", onReady, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.addEventListener("abort", onError, { once: true });
    audio.load();
  });
}

async function playBufferedBlob(blob: Blob): Promise<void> {
  if (!blob.size) {
    throw new Error("Cannot play empty audio blob");
  }

  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = url;

  activeAudio = audio;

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      audio.onended = null;
      audio.onerror = null;
      audio.onabort = null;
      if (activeAudio === audio) {
        activeAudio = null;
      }
      URL.revokeObjectURL(url);
    };

    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error("Audio playback error"));
    };

    audio.onended = () => resolveOnce();
    audio.onerror = () => rejectOnce(new Error("Audio playback error"));
    audio.onabort = () => rejectOnce(new Error("Audio playback aborted"));

    void waitForAudioReady(audio)
      .then(() => audio.play())
      .then(() => {
        if (audio.ended) {
          resolveOnce();
        }
      })
      .catch((error) => {
        rejectOnce(error);
      });
  });
}

export async function speakWithPolly(
  text: string,
  opts?: {
    voiceId?: VoiceId;
    outputFormat?: OutputFormat;
    languageCode?: "en" | "hi" | "en-US" | "hi-IN" | "en-IN";
  },
) {
  await lastPlayPromise;

  const normalizedText = (text || "").trim();
  if (!normalizedText) {
    return;
  }

  const safeRequestedVoice = resolveVoiceId(opts);

  const synthesis = buildSynthesisConfig(
    safeRequestedVoice,
    opts?.languageCode,
    opts?.outputFormat,
  );
  const bufferedSsml = buildBufferedSsml(normalizedText);
  const lockedVoiceId = synthesis.voiceId as VoiceId;

  debugVoice("[Polly] speakWithPolly enter", {
    text: normalizedText,
    safeRequestedVoice,
    languageCode: synthesis.languageCode,
    region: REGION,
  });

  let res: any = null;
  try {
    const command = new SynthesizeSpeechCommand({
      Text: bufferedSsml,
      VoiceId: lockedVoiceId,
      LanguageCode: synthesis.languageCode,
      OutputFormat: synthesis.outputFormat as OutputFormat,
      SampleRate: synthesis.sampleRate,
      TextType: "ssml",
    });
    res = await polly.send(command);
  } catch (error) {
    debugVoice("[Polly] SynthesizeSpeech failed for locked voice", {
      voiceId: lockedVoiceId,
      error,
    });
    throw error;
  }

  const audioStream = (res as any).AudioStream;
  if (!audioStream) {
    throw new Error("Polly returned no AudioStream");
  }

  const blob = await streamToBlob(audioStream, "audio/mpeg");
  if (!blob.size) {
    throw new Error("Polly returned empty audio blob");
  }

  const playPromise = playBufferedBlob(blob);

  lastPlayPromise = playPromise.catch((error) => {
    debugVoice("[Polly] speakWithPolly playback failed", {
      voiceId: safeRequestedVoice,
      languageCode: synthesis.languageCode,
      error,
    });
  });

  void playPromise.then(() => {
    debugVoice("[Polly] speakWithPolly exit", {
      voiceId: safeRequestedVoice,
      languageCode: synthesis.languageCode,
    });
  });

  return playPromise;
}

export default speakWithPolly;
