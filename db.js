// db.js — Railway Postgres: conversation memory, Google tokens, pending actions
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString,
  // Railway internal URLs don't need SSL; public proxy URLs do.
  ssl: connectionString && connectionString.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_tokens (
      id         INT PRIMARY KEY DEFAULT 1,
      tokens     JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_actions (
      id         TEXT PRIMARY KEY,
      tool_name  TEXT NOT NULL,
      args       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
  console.log('[db] schema ready');
}

// ---- Conversation memory (replaces in-memory sessions) ----
// 12 exchanges = 24 rows (user + assistant). Only final text turns are
// stored — tool_use plumbing stays inside a single job and is not persisted,
// which keeps context small and TTS-friendly.
async function getHistory(sessionId, limit = 24) {
  const { rows } = await pool.query(
    `SELECT role, content FROM messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2`,
    [sessionId, limit]
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

async function saveMessage(sessionId, role, content) {
  await pool.query(
    `INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)`,
    [sessionId, role, content]
  );
}

// ---- Google OAuth tokens (single-user app: one row, id = 1) ----
async function saveGoogleTokens(tokens) {
  await pool.query(
    `INSERT INTO google_tokens (id, tokens, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET
       tokens = google_tokens.tokens || EXCLUDED.tokens,
       updated_at = now()`,
    [JSON.stringify(tokens)]
  );
}

async function getGoogleTokens() {
  const { rows } = await pool.query(`SELECT tokens FROM google_tokens WHERE id = 1`);
  return rows.length ? rows[0].tokens : null;
}

// ---- Confirmation gates ----
async function stagePendingAction(id, toolName, args) {
  await pool.query(
    `INSERT INTO pending_actions (id, tool_name, args) VALUES ($1, $2, $3)`,
    [id, toolName, JSON.stringify(args)]
  );
}

// Pop = fetch + delete atomically. Actions expire after 5 minutes.
async function popPendingAction(id) {
  const { rows } = await pool.query(
    `DELETE FROM pending_actions
     WHERE id = $1 AND created_at > now() - interval '5 minutes'
     RETURNING tool_name, args`,
    [id]
  );
  return rows.length ? rows[0] : null;
}

module.exports = {
  pool, init, getHistory, saveMessage,
  saveGoogleTokens, getGoogleTokens,
  stagePendingAction, popPendingAction,
};
