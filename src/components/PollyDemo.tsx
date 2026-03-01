import React, { useState } from "react";
import speakWithPolly from "../utils/pollyTTS";

export default function PollyDemo() {
  const [speaking, setSpeaking] = useState(false);

  const handleSpeak = async () => {
    setSpeaking(true);
    try {
      await speakWithPolly("Hello — this is a Polly demo. The audio will play fully, then the mic will open.");
      // Promise resolves when audio ends — now open mic or continue turn-taking
      // For demo: simulate mic open action
      console.log("Audio finished — now open mic / start listening");
    } catch (err) {
      console.error("Polly playback error:", err);
    } finally {
      setSpeaking(false);
    }
  };

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <button onClick={handleSpeak} disabled={speaking}>
        {speaking ? "Speaking..." : "Speak with Polly"}
      </button>
      <span style={{ color: "#666" }}>{speaking ? "Polly is speaking" : "Ready"}</span>
    </div>
  );
}
