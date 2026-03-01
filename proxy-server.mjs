import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = trimmed
      .slice(0, eqIndex)
      .trim()
      .replace(/^\uFEFF/, "");
    const value = trimmed
      .slice(eqIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, ".env"));

const PROXY_PORT = Number(process.env.PROXY_PORT || 8787);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_BASE_URL =
  process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";

if (!GROQ_API_KEY) {
  console.error("[proxy] Missing GROQ_API_KEY in environment.");
  process.exit(1);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function handleChat(req, res) {
  const bodyBuffer = await readBody(req);

  const upstream = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: bodyBuffer,
  });

  const text = await upstream.text();
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/json",
  });
  res.end(text);
}

async function handleTranscribe(req, res) {
  const bodyBuffer = await readBody(req);
  const contentType = req.headers["content-type"];

  const upstream = await fetch(`${GROQ_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      ...(contentType ? { "Content-Type": contentType } : {}),
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: bodyBuffer,
  });

  const text = await upstream.text();
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/json",
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/api/llm/chat") {
      await handleChat(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/stt/transcribe") {
      await handleTranscribe(req, res);
      return;
    }

    writeJson(res, 404, { error: "Not found" });
  } catch (error) {
    writeJson(res, 500, {
      error: "proxy_error",
      message: error instanceof Error ? error.message : "Unknown proxy error",
    });
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.log(
      `[proxy] Port ${PROXY_PORT} already in use. Reusing existing proxy process.`,
    );
    process.exit(0);
  }

  console.error("[proxy] server error:", error);
  process.exit(1);
});

server.listen(PROXY_PORT, () => {
  console.log(`[proxy] running on http://localhost:${PROXY_PORT}`);
});
