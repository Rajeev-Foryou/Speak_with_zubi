# Speak with Zubi

Speak with Zubi is a child-friendly, voice-first web app where an AI companion asks simple questions about a picture, listens to the child’s answer, and responds with encouraging feedback.

This project is designed for children aged 4–8 and prioritizes:

- smooth interaction over feature complexity,
- clear and playful visuals,
- low-friction conversation in English and Hindi.

---

## 1) Introduction

### What this project is

Speak with Zubi is a single-page voice interaction experience built with React + Vite. A child sees one friendly image and talks with “Zubi” in short question-answer turns.

### Who it is for

- Primary users: children (ages 4–8)
- Secondary users: evaluators, educators, and parents reviewing interaction quality

### Why it was built

The app was built as a UX-first demo to show that voice AI for children can be:

- simple,
- understandable,
- and emotionally supportive,
  without overwhelming the user with complex controls.

---

## 2) Key Features

- **Voice-based interaction:** Zubi speaks to the child and listens for spoken answers.
- **Image-driven questions:** prompts are grounded in the visible image context.
- **Child-friendly feedback:** short, encouraging responses with gentle correction.
- **English + Hindi support:** both prompt language and recognition are language-aware.
- **Clean single-page UI:** central image focus with minimal distractions.
- **Speech-to-text display:** child speech is shown in a separate, readable chat-style panel.

---

## 3) User Experience Design

### Design philosophy: storybook, friendly, safe

The UI is intentionally soft, playful, and predictable. The child sees one focused scene, one companion (Zubi), and one active task at a time.

### Why single-page

Children in this age band should not manage navigation complexity. A single-page flow avoids context switching and reduces confusion.

### Why the image stays central

The image is the learning anchor for every question. Keeping it central improves comprehension and keeps the task concrete.

### Why chat bubbles are used

Speech transcription is shown in a friendly “You said” panel so evaluators and caregivers can quickly confirm what the child answered, without cluttering the image area.

---

## 4) Tech Stack

### Frontend

- **React 18 + TypeScript + Vite**
- fast feedback in development, lightweight production build

### Styling

- **Plain CSS (no Tailwind runtime)**
- chosen for predictable, explicit control of child-focused visual details

### Speech-to-Text (STT)

- Primary: **Groq Whisper** (`whisper-large-v3-turbo`) through proxy endpoint `/api/stt/transcribe`
- Fallback: browser `SpeechRecognition` if Whisper path errors/rate-limits

### Text-to-Speech (TTS)

- **Amazon Polly** via AWS SDK (`@aws-sdk/client-polly`)
- currently using language-appropriate voices (`Joanna` for English, `Aditi` for Hindi)

### LLM

- **Groq Chat Completions API** via local proxy endpoint `/api/llm/chat`
- model default: `llama-3.1-8b-instant`

### Local hosting/runtime

- Vite frontend dev server + small Node proxy (`proxy-server.mjs`)
- `vite.config.ts` forwards `/api/*` to `http://localhost:8787`

---

## 5) AI & Voice Stack (Simple Explanation)

### Which LLM is used

- Provider: **Groq**
- Model: **`llama-3.1-8b-instant`** (configurable via `VITE_LLM_MODEL`)

### Why this model

- fast response profile suitable for short conversational turns,
- good cost-performance for demo-scale usage,
- simple integration via OpenAI-compatible API format.

### How questions and feedback are generated

This project currently uses a **hybrid strategy** for reliability and child-safety:

- Question prompts come from a curated language-specific pool.
- Feedback is generated with deterministic correctness checks (keyword-based matching), then child-friendly praise/correction templates.
- LLM is used for flexible closing lines and can be extended for more dynamic generation later.

### How voice output is generated

- Text is synthesized with **Amazon Polly** and played as buffered audio.

### Why Polly over Web Speech API

- more consistent voice quality across devices,
- predictable voice selection for English/Hindi,
- fewer browser-specific voice inconsistencies.

### Language handling

- English mode: `en-IN` flow, Polly voice mapping to English-compatible voice
- Hindi mode: `hi-IN` flow, Hindi transcription prompts/variants, Polly Hindi-compatible voice

---

## 6) Interaction Flow

1. App loads and shows the central image.
2. Zubi starts a question turn.
3. Microphone/listen phase activates.
4. Child answers by speaking.
5. Speech is converted to text (Whisper or browser fallback).
6. Response is evaluated against expected image-grounded answers.
7. Zubi speaks feedback.
8. Loop continues until turn/time constraints end the session.

---

## 7) UX Decisions & Trade-offs

### Why plain CSS instead of Tailwind

- easy to keep strict control over final visual output,
- simpler handoff for evaluator review,
- less abstraction for small, custom UI.

### Why a full backend was avoided

- this is a demo-first prototype optimized for speed,
- a tiny proxy is used for API mediation and key usage,
- avoids introducing heavy backend complexity at this stage.

### Why evaluation messages are simplified

- children need short, direct reinforcement,
- concise feedback improves pace and reduces cognitive load.

### How audio glitches were handled pragmatically

- queueing and timeout safeguards for TTS playback,
- fallback from Whisper STT to browser STT when needed,
- silence/retry prompts to keep the session stable.

---

## 8) Accessibility & Child Safety

- Large, clear interaction controls
- Simple sentence structure and friendly vocabulary
- No ads and no distracting outbound navigation in core flow
- Minimal UI states and no complex multi-page navigation
- Grounded image-based prompts to reduce ambiguity

---

## 9) How to Run the Project

### Prerequisites

- Node.js 18+
- Modern Chromium browser with microphone access enabled

### Install

```bash
npm install
```

### Create `.env`

Create a `.env` file in project root (this file is gitignored):

```env
# Proxy (Groq)
GROQ_API_KEY=your_groq_api_key
GROQ_BASE_URL=https://api.groq.com/openai/v1
PROXY_PORT=8787

# Frontend LLM/STT endpoints (defaults shown)
VITE_LLM_API_URL=/api/llm/chat
VITE_STT_API_URL=/api/stt/transcribe
VITE_LLM_MODEL=llama-3.1-8b-instant

# Optional STT tuning
VITE_STT_MIN_REQUEST_INTERVAL_MS=1200

# Amazon Polly (demo setup)
VITE_AWS_REGION=ap-south-1
VITE_AWS_ACCESS_KEY_ID=your_aws_access_key_id
VITE_AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key

# Optional voice debugging
VITE_DEBUG_VOICE=false
```

### Start locally

```bash
npm run dev
```

This runs:

- Vite frontend at `http://localhost:5173`
- Proxy server at `http://localhost:8787`

### Production build

```bash
npm run build
npm run preview
```

---

## 10) Known Limitations

- Microphone permission is browser-dependent and must be explicitly allowed.
- Polly credentials are currently consumed in a frontend demo context (not ideal for production security).
- The demo assumes stable internet for LLM/STT/TTS calls.
- Speech recognition accuracy can vary with background noise, accent, and device mic quality.

---

## 11) Future Improvements

- Move all provider credentials and voice generation to a secure backend.
- Add session analytics (turn success, silence rate, language usage).
- Expand image sets and question categories (shapes, colors, actions, counting).
- Add lightweight gamification (stickers, rewards, progression).
- Add parent/teacher dashboard for progress snapshots.

---

## 12) Conclusion

Speak with Zubi demonstrates a practical, child-focused voice AI experience where UX clarity is treated as a first-class engineering goal.

It is more than a toy UI:

- interaction flow is structured,
- voice stack is intentionally layered for resilience,
- and the interface is optimized for young learners and evaluators.

In short, this project is a strong demo of **UX-first AI interaction design** with a clear path to production hardening.
