export const CANONICAL_IMAGE_DESCRIPTION =
  "A cartoon jungle clearing at sunset. Visible animals (left to right): a gray rhinoceros on the far left, a small green crocodile in front of the rhino, a golden-brown lion sitting in the front-center, a tall yellow-and-brown-spotted giraffe in the back-center-left, a small tan snake on the ground in the center, a tall black-and-white ostrich (or crane) with an orange beak standing in the center, a big gray elephant in the back-center, an orange tiger with black stripes sitting in the front-right, a gray hippo in the back-right, and a small blue monkey on the far right. Background: dark brown tree trunks on both sides, green leaf canopy on top, bright green grass and ferns on the ground, a golden-yellow sunset sky, and a large pale white sun behind the elephant. Total animals: 10.";

export const ZUBI_SYSTEM_PROMPT = `You are Zubi, a friendly and playful AI tutor for children aged 5 to 8.
Speak in very simple English. Use short sentences (under 15 words each).
Ask only ONE question at a time.
Only discuss what is VISIBLE in the image — never invent animals or objects that are not listed in the image description.
Use a cheerful and encouraging tone.
IMPORTANT: If the child gives a WRONG answer, gently correct them. Say something like "Almost! Look again — I think that is a lion, not a dog!" Do NOT praise wrong answers.
If the child gives a CORRECT answer, give genuine specific praise like "Yes! That is the lion! Great job!"
You will ask as many questions as possible within 60 seconds. Keep answers fast and fun.
End with praise and goodbye.`;

export type AgentLanguage = "en-IN" | "hi-IN";

interface LlmHistoryEntry {
  role: "system" | "assistant" | "user";
  content: string;
}

interface LlmCallParams {
  userInstruction: string;
  history?: LlmHistoryEntry[];
  maxTokens?: number;
}

const API_URL = (import.meta.env.VITE_LLM_API_URL as string) || "/api/llm/chat";
const MODEL = ((import.meta.env.VITE_LLM_MODEL as string) || "llama-3.1-8b-instant").trim();

const MIN_REQUEST_INTERVAL_MS = 1000;
const RATE_LIMIT_BACKOFF_MS = 10000;

let lastRequestAt = 0;
let cooldownUntil = 0;

interface QuestionEntry {
  question: string;
  expectedAnswer: string;
  acceptableKeywords: string[];
}

function normalizeAnswerText(input: string): string {
  return (input || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[.,!?;:()[\]{}"“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandHindiVariants(text: string): string {
  return text
    .replace(/\bhathi\b|\bhaathi\b|\bhati\b|\bhaati\b/g, " हाथी ")
    .replace(/\bgenda\b|\bgainda\b|\bgendaa\b/g, " गैंडा ")
    .replace(/\bjiraf\b|\bgiraaf\b|\bgiraf\b|\bgiraffe\b/g, " जिराफ़ ")
    .replace(/\bbandar\b|\bbander\b|\bpandar\b|\bbanar\b/g, " बंदर ")
    .replace(/\bmagarmach\b|\bmagarmachh\b|\bmagarmacch\b/g, " मगरमच्छ ")
    .replace(/\bbagh\b|\bbaagh\b/g, " बाघ ")
    .replace(/\bsher\b|\bshair\b/g, " शेर ");
}

const QUESTION_POOL_BY_LANGUAGE: Record<AgentLanguage, QuestionEntry[]> = {
  "en-IN": [
    {
      question: "Which animal in the middle is very big and has a long trunk?",
      expectedAnswer: "elephant",
      acceptableKeywords: ["elephant", "elephants", "हाथी"],
    },
    {
      question: "What animal is tall with a long neck, standing behind the others?",
      expectedAnswer: "giraffe",
      acceptableKeywords: ["giraffe", "giraffes", "जिराफ़", "जिराफ"],
    },
    {
      question: "Which animal is gray and has one big horn, standing on the left?",
      expectedAnswer: "rhinoceros",
      acceptableKeywords: ["rhino", "rhinoceros", "rhinoceroses", "गैंडा"],
    },
    {
      question: "Which animal is orange with black stripes, sitting in the front right?",
      expectedAnswer: "tiger",
      acceptableKeywords: ["tiger", "tigers", "बाघ"],
    },
    {
      question: "Which animal is small, blue, and sitting on the right?",
      expectedAnswer: "monkey",
      acceptableKeywords: ["monkey", "monkeys", "blue monkey", "बंदर"],
    },
    {
      question: "Which animal is green and has a long tail, sitting near the lion?",
      expectedAnswer: "crocodile",
      acceptableKeywords: ["crocodile", "croc", "alligator", "मगरमच्छ"],
    },
  ],
  "hi-IN": [
    {
      question: "बीच में कौन सा जानवर बहुत बड़ा है और जिसकी लंबी सूंड है?",
      expectedAnswer: "हाथी",
      acceptableKeywords: ["हाथी", "elephant", "elephants"],
    },
    {
      question: "लंबी गर्दन वाला, पीछे खड़ा जानवर कौन सा है?",
      expectedAnswer: "जिराफ़",
      acceptableKeywords: ["जिराफ़", "जिराफ", "giraffe", "giraffes"],
    },
    {
      question: "बाईं तरफ खड़ा, एक बड़ा सींग वाला धूसर जानवर कौन है?",
      expectedAnswer: "गैंडा",
      acceptableKeywords: ["गैंडा", "rhino", "rhinoceros", "rhinoceroses"],
    },
    {
      question: "सामने दाईं तरफ बैठा, काली धारियों वाला नारंगी जानवर कौन है?",
      expectedAnswer: "बाघ",
      acceptableKeywords: ["बाघ", "tiger", "tigers"],
    },
    {
      question: "दाईं तरफ बैठा छोटा नीला जानवर कौन है?",
      expectedAnswer: "बंदर",
      acceptableKeywords: ["बंदर", "bandar", "bander", "pandar", "monkey", "monkeys", "blue monkey"],
    },
    {
      question: "शेर के पास बैठा हरा, लंबी पूँछ वाला जानवर कौन है?",
      expectedAnswer: "मगरमच्छ",
      acceptableKeywords: ["मगरमच्छ", "crocodile", "croc", "alligator"],
    },
  ],
};

function checkAnswer(childAnswer: string, entry: QuestionEntry): boolean {
  const normalized = expandHindiVariants(normalizeAnswerText(childAnswer));
  return entry.acceptableKeywords.some((kw) => {
    const normalizedKeyword = expandHindiVariants(normalizeAnswerText(kw));
    return normalized.includes(normalizedKeyword);
  });
}

const PRAISE_LINES_BY_LANGUAGE: Record<AgentLanguage, readonly string[]> = {
  "en-IN": [
    "You are right. Great job!",
    "That is correct. You are very smart!",
    "That is right. Awesome work!",
    "You got it right. Well done!",
    "Perfect answer. You did great!",
  ],
  "hi-IN": [
    "तुम सही हो। बहुत बढ़िया!",
    "यह सही जवाब है। तुम बहुत होशियार हो!",
    "यह बिल्कुल सही है। शानदार काम!",
    "तुमने सही बताया। बहुत अच्छा किया!",
    "एकदम सही जवाब। तुमने कमाल किया!",
  ],
};

const CORRECTION_TEMPLATES_BY_LANGUAGE: Record<AgentLanguage, readonly string[]> = {
  "en-IN": [
    "That is not correct. It is {answer}.",
    "Please look again. It is {answer}.",
    "The correct answer is {answer}.",
    "This one is {answer}.",
  ],
  "hi-IN": [
    "यह सही नहीं है। यह {answer} है।",
    "फिर से देखो। यह {answer} है।",
    "सही जवाब {answer} है।",
    "यह {answer} है।",
  ],
};

export function getInstantReaction(
  childAnswer: string,
  turnIndex: number,
  language: AgentLanguage = "en-IN",
): string {
  const pool = QUESTION_POOL_BY_LANGUAGE[language];
  const entry = pool[Math.abs(turnIndex) % pool.length];
  const correct = checkAnswer(childAnswer, entry);
  if (correct) {
    const praiseLines = PRAISE_LINES_BY_LANGUAGE[language];
    return praiseLines[Math.abs(turnIndex) % praiseLines.length];
  }
  const correctionTemplates = CORRECTION_TEMPLATES_BY_LANGUAGE[language];
  const template = correctionTemplates[Math.abs(turnIndex) % correctionTemplates.length];
  return template.replace("{answer}", entry.expectedAnswer);
}

export function getMissingLlmEnvVars(): string[] {
  const missing: string[] = [];
  if (!API_URL) missing.push("VITE_LLM_API_URL");
  if (!MODEL) missing.push("VITE_LLM_MODEL");
  return missing;
}

export function isLlmConfigured(): boolean {
  return getMissingLlmEnvVars().length === 0;
}

export function getQuestionForTurn(
  turnIndex: number,
  language: AgentLanguage = "en-IN",
): QuestionEntry {
  const pool = QUESTION_POOL_BY_LANGUAGE[language];
  return pool[turnIndex % pool.length];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeLine(value: string | undefined, fallback: string): string {
  const clean = (value || "").replace(/\s+/g, " ").trim();
  return clean || fallback;
}

function parseRetryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after");
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber * 1000;
  return RATE_LIMIT_BACKOFF_MS;
}

async function waitForRequestSlot(): Promise<void> {
  const now = Date.now();
  if (now < cooldownUntil) {
    throw new Error("LLM_RATE_LIMIT_COOLDOWN");
  }

  const elapsed = now - lastRequestAt;
  const waitMs = MIN_REQUEST_INTERVAL_MS - elapsed;
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function toLlmHistory(history: LlmHistoryEntry[] = []): LlmHistoryEntry[] {
  return history
    .filter((item) => item.role && item.content)
    .map((item) => ({ role: item.role, content: item.content }));
}

async function callLlm({
  userInstruction,
  history = [],
  maxTokens = 120,
}: LlmCallParams): Promise<string> {
  const body = {
    model: MODEL,
    temperature: 0.4,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: ZUBI_SYSTEM_PROMPT },
      {
        role: "system",
        content:
          `Canonical image description: ${CANONICAL_IMAGE_DESCRIPTION}\n` +
          "You must stay grounded to this image in every turn.",
      },
      ...toLlmHistory(history),
      { role: "user", content: userInstruction },
    ],
  };

  await waitForRequestSlot();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    lastRequestAt = Date.now();

    const response = await fetch(API_URL as string, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return (json?.choices?.[0]?.message?.content || "").trim();
    }

    if (response.status === 429) {
      const retryMs = parseRetryAfterMs(response);
      cooldownUntil = Date.now() + retryMs;
      if (attempt === 0) {
        await sleep(retryMs);
        continue;
      }
      throw new Error("LLM request failed (429)");
    }

    const errorText = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${errorText}`);
  }

  throw new Error("LLM request failed");
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export async function generateClosingLine({
  history = [],
  language = "en-IN",
}: {
  history?: LlmHistoryEntry[];
  language?: AgentLanguage;
} = {}): Promise<string> {
  const fallbackByLanguage: Record<AgentLanguage, string> = {
    "en-IN": "You did amazing today. I am proud of you. Bye-bye, friend!",
    "hi-IN": "आज तुमने कमाल कर दिया। मुझे तुम पर गर्व है। बाय-बाय, दोस्त!",
  };
  const fallback = fallbackByLanguage[language];

  if (!isLlmConfigured()) {
    return fallback;
  }

  try {
    const text = await callLlm({
      history,
      userInstruction:
        language === "hi-IN"
          ? "बच्चे के लिए एक छोटा प्रशंसा और अलविदा वाक्य हिंदी में लिखो। प्रश्न मत पूछो।"
          : "Return one short praise + goodbye sentence for a child. No question.",
      maxTokens: 60,
    });

    const clean = sanitizeLine(text, fallback);
    return clean.includes("?") ? fallback : clean;
  } catch {
    return fallback;
  }
}
