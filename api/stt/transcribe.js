const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_BASE_URL =
  process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!GROQ_API_KEY) {
    res.status(500).json({ error: "Missing GROQ_API_KEY" });
    return;
  }

  try {
    const body = await readBody(req);
    const contentType = req.headers["content-type"];

    const upstream = await fetch(`${GROQ_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: {
        ...(contentType ? { "Content-Type": contentType } : {}),
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body,
    });

    const text = await upstream.text();
    const responseType =
      upstream.headers.get("content-type") || "application/json";

    res
      .status(upstream.status)
      .setHeader("Content-Type", responseType)
      .send(text);
  } catch (error) {
    res.status(500).json({
      error: "stt_proxy_error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
