// server.js — Alfred Phase 2: "Alfred has hands"
// Tool-use loop + Google OAuth + web search + Make webhooks + Postgres memory.
// Keeps Phase 1 contract: POST /api/chat -> { jobId }, poll GET /api/chat/:jobId.

const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');
const googleSvc = require('./google');
const { toolDefinitions, executeTool } = require('./tools');
const { buildSystemPrompt } = require('./prompt');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const PASSWORD = process.env.ALFRED_PASSWORD;
const MAX_TOOL_ITERATIONS = 8;
const TTS_CHAR_CAP = 600; // hard ceiling on ElevenLabs spend per reply

// ---- Auth (Phase 1 pattern: password -> bearer token, in-memory) ----
const validTokens = new Set();

app.post('/api/login', (req, res) => {
  if (!PASSWORD || req.body.password !== PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  validTokens.add(token);
  res.json({ token });
});

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!validTokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ---- Google OAuth routes ----
// Browser redirect can't carry a bearer header, so protect with ?key=PASSWORD.
app.get('/auth/google', (req, res) => {
  if (req.query.key !== PASSWORD) return res.status(401).send('Add ?key=YOUR_PASSWORD');
  res.redirect(googleSvc.getAuthUrl());
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    await googleSvc.handleCallback(req.query.code);
    res.send('<h2>Alfred is connected to Google.</h2><p>You can close this tab and go back to talking to him.</p>');
  } catch (err) {
    console.error('[oauth] callback failed:', err.message);
    res.status(500).send('OAuth failed: ' + err.message);
  }
});

// ---- ElevenLabs TTS with graceful text fallback ----
async function synthesize(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) return null;
  const spoken = text.length > TTS_CHAR_CAP ? text.slice(0, TTS_CHAR_CAP) : text;
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: spoken,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) {
      console.error('[tts] ElevenLabs error', res.status);
      return null; // fall back to text
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:audio/mpeg;base64,${buf.toString('base64')}`;
  } catch (err) {
    console.error('[tts] failed:', err.message);
    return null;
  }
}

// ---- The tool-use loop ----
async function runAgentLoop(history, userText) {
  const messages = [...history, { role: 'user', content: userText }];
  const system = buildSystemPrompt();

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: toolDefinitions,
      messages,
    });

    // Server tools (web_search) can pause long turns — just continue.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    if (response.stop_reason !== 'tool_use') {
      // Final answer: collect text blocks.
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
    }

    // Claude wants client tools. Echo assistant turn, execute, return results.
    messages.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      console.log(`[tool] ${block.name}`, JSON.stringify(block.input).slice(0, 200));
      const result = await executeTool(block.name, block.input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return "I'm afraid that took more steps than expected, sir. Could you rephrase or narrow the request?";
}

// ---- Job pipeline (Phase 1 pattern: background processing + polling) ----
const jobs = new Map(); // jobId -> { status, text, audio, error, createdAt }

// Sweep finished jobs older than 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
}, 60 * 1000);

app.post('/api/chat', requireAuth, (req, res) => {
  const { message, sessionId = 'default' } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Empty message' });

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'processing', createdAt: Date.now() });
  res.json({ jobId });

  // Background work — never blocks the response
  (async () => {
    try {
      const history = await db.getHistory(sessionId);
      const text = await runAgentLoop(history, message.trim());

      await db.saveMessage(sessionId, 'user', message.trim());
      await db.saveMessage(sessionId, 'assistant', text);

      const audio = await synthesize(text);
      jobs.set(jobId, { status: 'done', text, audio, createdAt: Date.now() });
    } catch (err) {
      console.error('[job] failed:', err);
      jobs.set(jobId, {
        status: 'error',
        error: err.message,
        text: "Something went wrong on my end. Give me a moment and try again.",
        createdAt: Date.now(),
      });
    }
  })();
});

app.get('/api/chat/:jobId', requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: 'not_found' });
  res.json(job);
});

app.get('/health', (req, res) => res.json({ ok: true, phase: 2 }));

// ---- Boot ----
const PORT = process.env.PORT || 3000;
db.init()
  .then(() => app.listen(PORT, () => console.log(`Alfred Phase 2 on :${PORT}`)))
  .catch((err) => {
    console.error('[boot] DB init failed:', err.message);
    process.exit(1);
  });
