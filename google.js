// google.js — OAuth2 + read-only Gmail & Calendar
const { google } = require('googleapis');
const db = require('./db');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI // https://alfred-production-1e00.up.railway.app/auth/google/callback
  );
}

function getAuthUrl() {
  return makeOAuthClient().generateAuthUrl({
    access_type: 'offline', // gets a refresh token
    prompt: 'consent',      // forces refresh token even on re-auth
    scope: SCOPES,
  });
}

async function handleCallback(code) {
  const client = makeOAuthClient();
  const { tokens } = await client.getToken(code);
  await db.saveGoogleTokens(tokens);
  return tokens;
}

// Returns an authed client, auto-persisting refreshed access tokens.
async function getAuthedClient() {
  const tokens = await db.getGoogleTokens();
  if (!tokens) {
    throw new Error('Google account not connected. Visit /auth/google?key=YOUR_PASSWORD once to connect.');
  }
  const client = makeOAuthClient();
  client.setCredentials(tokens);
  client.on('tokens', (fresh) => {
    db.saveGoogleTokens(fresh).catch((e) => console.error('[google] token save failed', e.message));
  });
  return client;
}

// ---- Gmail: search messages, return compact metadata + snippet ----
async function searchEmail(query, maxResults = 5) {
  const auth = await getAuthedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: Math.min(maxResults, 10),
  });

  const ids = (list.data.messages || []).map((m) => m.id);
  if (!ids.length) return { results: [], note: `No emails matched: "${query}"` };

  const results = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    });
    const headers = {};
    for (const h of msg.data.payload.headers || []) headers[h.name.toLowerCase()] = h.value;
    results.push({
      from: headers.from || '',
      to: headers.to || '',
      subject: headers.subject || '(no subject)',
      date: headers.date || '',
      snippet: (msg.data.snippet || '').slice(0, 200),
    });
  }
  return { results };
}

// ---- Calendar: events in a window ----
async function getCalendarEvents(timeMin, timeMax, maxResults = 15) {
  const auth = await getAuthedClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults,
  });

  const events = (res.data.items || []).map((e) => ({
    title: e.summary || '(untitled)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || null,
    allDay: !e.start?.dateTime,
  }));
  return { events, count: events.length };
}

module.exports = { getAuthUrl, handleCallback, searchEmail, getCalendarEvents };
