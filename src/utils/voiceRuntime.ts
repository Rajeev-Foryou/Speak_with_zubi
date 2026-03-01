type SessionLanguage = "en" | "hi" | "en-US" | "en-IN" | "hi-IN";
type VoiceId = "Aditi";

interface VoiceConfig {
  voiceId: VoiceId;
  languageCode: "en-IN" | "hi-IN";
}

function resolveVoiceConfig(language: SessionLanguage): VoiceConfig {
  const isHindi = language.startsWith("hi");
  return isHindi
    ? { voiceId: "Aditi", languageCode: "hi-IN" }
    : { voiceId: "Aditi", languageCode: "en-IN" };
}

class VoiceRuntime {
  private sessionVoice: VoiceConfig | null = null;

  private speechQueue: Promise<void> = Promise.resolve();

  private speakingNow = false;

  beginSession(language: SessionLanguage): VoiceConfig {
    if (!this.sessionVoice) {
      this.sessionVoice = resolveVoiceConfig(language);
    }
    return this.sessionVoice;
  }

  endSession(): void {
    this.sessionVoice = null;
  }

  getVoiceConfig(languageFallback: SessionLanguage = "en-IN"): VoiceConfig {
    return this.sessionVoice || resolveVoiceConfig(languageFallback);
  }

  enqueueSpeech(task: () => Promise<void>): Promise<void> {
    const run = async () => {
      this.speakingNow = true;
      try {
        await task();
      } finally {
        this.speakingNow = false;
      }
    };

    const chained = this.speechQueue.then(run, run);
    this.speechQueue = chained.catch(() => undefined);
    return chained;
  }

  waitForSpeechIdle(): Promise<void> {
    return this.speechQueue.catch(() => undefined);
  }

  isSpeaking(): boolean {
    return this.speakingNow;
  }
}

export const voiceRuntime = new VoiceRuntime();
