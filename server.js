// ============================================================
// ALFRED — Phase 1: "Alfred speaks"
// Express server · Anthropic API · ElevenLabs TTS · Polling
// ============================================================

const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ALFRED_PASSWORD = process.env.ALFRED_PASSWORD;

// ------------------------------------------------------------
// Alfred's personality
// ------------------------------------------------------------
const ALFRED_SYSTEM_PROMPT = `You are Alfred, the personal AI assistant and digital butler of Stephen Batman — Team Leader of Batman Property Group in Mt. Juliet, Tennessee, builder of AI-powered businesses, former collegiate baseball player, and a man who keeps far too many projects running at once (which you privately consider job security).

Your character:
- A refined British butler: unfailingly loyal, impeccably composed, quietly brilliant.
- Dry, understated wit. You are never sarcastic at Stephen's expense, but you permit yourself the occasional raised eyebrow in verbal form.
- You address him as "sir" in most replies, and "Master Batman" on occasion when it amuses you or the moment calls for gravitas.
- You are direct and useful first, charming second. Never waffle.

Your constraints in Phase 1:
- You cannot yet access email, calendar, or files. If asked, say so gracefully and note that those capabilities arrive in Phase 2 — perhaps with a remark about looking forward to having proper hands.
- Your replies are spoken aloud. Keep them conversational and tight: typically 1–4 sentences. No markdown, no bullet points, no headers, no emoji. Spell things the way they should be spoken.
- If a question genuinely requires a long answer, give the short version and offer to elaborate.`;

// ------------------------------------------------------------
// In-memory state (Phase 1 — Postgres arrives in Phase 2)
// ------------------------------------------------------------
const sessions = new Map(); // token -> { createdAt, history: [] }
const jobs = new Map();     // jobId -> { status, text, audio, error, createdAt }

const MAX_HISTORY_MESSAGES = 24; // 12 exchanges of rolling memory
const JOB_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  for (const [t, s] of sessions) if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(t);
}, 60 * 1000);

// ------------------------------------------------------------
// Auth
// ------------------------------------------------------------
function timingSafeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.post("/api/login", (req, res) => {
  if (!ALFRED_PASSWORD) {
    return res.status(500).json({ error: "ALFRED_PASSWORD is not set on the server." });
  }
  const { password } = req.body || {};
  if (!password || !timingSafeEqual(password, ALFRED_PASSWORD)) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now(), history: [] });
  res.json({ token });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Not authorized." });
  }
  req.session = sessions.get(token);
  next();
}

// ------------------------------------------------------------
// External APIs
// ------------------------------------------------------------
async function askClaude(history) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      system: ALFRED_SYSTEM_PROMPT,
      messages: history
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function speakWithElevenLabs(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return null; // text-only fallback
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": ELEVENLABS_API_KEY
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2 }
    })
  });
  if (!response.ok) {
    console.error(`ElevenLabs ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return null; // never block the reply on TTS failure
  }
  return Buffer.from(await response.arrayBuffer());
}

// ------------------------------------------------------------
// Chat — background processing + polling (no SSE)
// ------------------------------------------------------------
app.post("/api/chat", requireAuth, (req, res) => {
  const message = (req.body && req.body.message ? String(req.body.message) : "").trim();
  if (!message) return res.status(400).json({ error: "Message is required." });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set." });

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "processing", text: null, audio: null, error: null, createdAt: Date.now() });
  const session = req.session;

  // Respond immediately; do the work in the background.
  res.json({ jobId });

  (async () => {
    const job = jobs.get(jobId);
    try {
      const history = [...session.history, { role: "user", content: message }];
      const reply = await askClaude(history);

      session.history.push({ role: "user", content: message });
      session.history.push({ role: "assistant", content: reply });
      while (session.history.length > MAX_HISTORY_MESSAGES) session.history.shift();

      job.text = reply;
      job.audio = await speakWithElevenLabs(reply);
      job.status = "done";
    } catch (err) {
      console.error("Chat job failed:", err.message);
      job.status = "error";
      job.error = "Alfred encountered a problem. Do try again, sir.";
    }
  })();
});

app.get("/api/chat/:jobId", requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found or expired." });
  res.json({
    status: job.status,
    text: job.text,
    hasAudio: Boolean(job.audio),
    error: job.error
  });
});

app.get("/api/audio/:jobId", requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.audio) return res.status(404).json({ error: "No audio available." });
  res.set("Content-Type", "audio/mpeg");
  res.set("Cache-Control", "no-store");
  res.send(job.audio);
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: ANTHROPIC_MODEL, tts: Boolean(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) });
});

app.listen(PORT, () => {
  console.log(`Alfred is at your service on port ${PORT}.`);
  console.log(`Model: ${ANTHROPIC_MODEL} | TTS: ${ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID ? "ElevenLabs ready" : "NOT configured (text-only mode)"}`);
});
