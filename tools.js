// tools.js — tool definitions + executor with confirmation gates
const crypto = require('crypto');
const googleSvc = require('./google');
const db = require('./db');

// ---- Make.com webhook config (env vars, one URL each) ----
const WEBHOOKS = {
  post_to_social: process.env.MAKE_WEBHOOK_SOCIAL_URL, // posts publicly -> GATED
  log_to_sheet: process.env.MAKE_WEBHOOK_SHEET_URL,    // private log -> not gated
  send_notification: process.env.MAKE_WEBHOOK_NOTIFY_URL, // pings your phone -> not gated
};

// Tools that must be confirmed out loud before executing.
// When write scopes arrive later (send email, delete event), add them here —
// the gate machinery already handles them.
const GATED_TOOLS = new Set(['post_to_social']);

// ---- Definitions sent to Claude ----
// web_search is a SERVER tool: Anthropic executes it, results come back
// inside the same response. The loop in server.js never sees it as
// stop_reason 'tool_use'.
const toolDefinitions = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
  {
    name: 'search_email',
    description:
      "Search the user's Gmail inbox. Uses Gmail query syntax, e.g. 'from:todd newer_than:7d', 'subject:invoice is:unread'. Returns sender, subject, date, and a short snippet for each match. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query' },
        max_results: { type: 'integer', description: 'Max emails to return (default 5, max 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_calendar_events',
    description:
      "Get events from the user's primary Google Calendar between two times. Pass ISO 8601 timestamps WITH timezone offset (the user is in US Central time). Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        time_min: { type: 'string', description: 'Window start, ISO 8601 with offset, e.g. 2026-06-11T00:00:00-05:00' },
        time_max: { type: 'string', description: 'Window end, ISO 8601 with offset' },
      },
      required: ['time_min', 'time_max'],
    },
  },
  {
    name: 'post_to_social',
    description:
      'Post text publicly to social media via Make.com. THIS POSTS PUBLICLY. The server will require spoken confirmation from the user before it actually fires.',
    input_schema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'e.g. facebook, instagram, x' },
        text: { type: 'string', description: 'The post content' },
      },
      required: ['platform', 'text'],
    },
  },
  {
    name: 'log_to_sheet',
    description:
      'Append a note/row to the user\'s private log spreadsheet via Make.com. Private, fires immediately.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'e.g. idea, task, expense, lead' },
        note: { type: 'string', description: 'The content to log' },
      },
      required: ['note'],
    },
  },
  {
    name: 'send_notification',
    description:
      'Send a push notification to the user\'s phone via Make.com. Private, fires immediately.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Notification text' },
      },
      required: ['message'],
    },
  },
  {
    name: 'execute_pending_action',
    description:
      'Execute or cancel a previously staged action after the user has confirmed or declined out loud. Only call this AFTER the user explicitly answers.',
    input_schema: {
      type: 'object',
      properties: {
        action_id: { type: 'string', description: 'The action_id returned when the action was staged' },
        approved: { type: 'boolean', description: 'true if the user said yes, false if they declined' },
      },
      required: ['action_id', 'approved'],
    },
  },
];

async function fireWebhook(name, payload) {
  const url = WEBHOOKS[name];
  if (!url) return { error: `Webhook for ${name} is not configured (missing env var).` };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => '');
  return res.ok
    ? { status: 'sent', response: text.slice(0, 200) }
    : { error: `Webhook returned ${res.status}`, response: text.slice(0, 200) };
}

// The actual side-effecting execution, used directly for ungated tools and
// by execute_pending_action for gated ones.
async function runTool(name, input) {
  switch (name) {
    case 'search_email':
      return googleSvc.searchEmail(input.query, input.max_results || 5);
    case 'get_calendar_events':
      return googleSvc.getCalendarEvents(input.time_min, input.time_max);
    case 'post_to_social':
    case 'log_to_sheet':
    case 'send_notification':
      return fireWebhook(name, input);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// Entry point used by the tool loop in server.js.
async function executeTool(name, input) {
  try {
    if (name === 'execute_pending_action') {
      const action = await db.popPendingAction(input.action_id);
      if (!action) return { error: 'Action not found or expired (5 min limit). Stage it again if still wanted.' };
      if (!input.approved) return { status: 'cancelled', detail: 'User declined. Nothing was sent.' };
      return runTool(action.tool_name, action.args);
    }

    if (GATED_TOOLS.has(name)) {
      const id = crypto.randomUUID().slice(0, 8);
      await db.stagePendingAction(id, name, input);
      return {
        status: 'needs_confirmation',
        action_id: id,
        summary: `Staged ${name}: ${JSON.stringify(input).slice(0, 200)}`,
        instruction:
          'Read the user a one-sentence summary of this action and ask for a yes/no. Do NOT execute until they confirm. On their answer, call execute_pending_action with this action_id.',
      };
    }

    return await runTool(name, input);
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { toolDefinitions, executeTool };
