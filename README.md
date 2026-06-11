# Alfred — Phase 1: "Alfred speaks"

Voice-enabled personal assistant. Express on Railway → Anthropic API → ElevenLabs TTS, with browser push-to-talk and a polling architecture (no SSE).

**Done when:** you say "Good morning, Alfred" into your phone and hear a British reply.

---

## Deploy to Railway (10 minutes)

1. **Push this folder to GitHub.** Create a new repo (e.g., `Sbatman19/Alfred`), upload all files, commit.
2. **Railway → New Project → Deploy from GitHub repo.** Select the repo. Railway auto-detects Node and runs `npm start`.
3. **Add environment variables** (Variables tab):

```
ANTHROPIC_API_KEY=     # platform.claude.com
ANTHROPIC_MODEL=claude-sonnet-4-5
ELEVENLABS_API_KEY=    # elevenlabs.io → Profile → API Keys
ELEVENLABS_VOICE_ID=   # see "Picking the voice" below
ALFRED_PASSWORD=       # your front-door password — make it strong
```

4. **Settings → Networking → Generate Domain.** Open the URL, enter your password, hold the bell, speak.
5. **On your phone:** open the URL in Safari/Chrome → Share → **Add to Home Screen.** Alfred now feels like a native app.

## Picking the voice

In ElevenLabs, open the **Voice Library**, search "British male" (try terms like *refined*, *butler*, *narrator*), add a voice to My Voices, then copy its **Voice ID** into `ELEVENLABS_VOICE_ID`. You can swap voices anytime by changing the env var — no redeploy of code needed.

## How it works

- `POST /api/login` — password → session token (kept in memory, 7-day expiry)
- `POST /api/chat` — returns a `jobId` immediately; Claude + TTS run in the background
- `GET /api/chat/:jobId` — frontend polls every 1s until `done`
- `GET /api/audio/:jobId` — streams the ElevenLabs MP3
- Conversation memory: rolling 12 exchanges per session, in memory (Postgres arrives in Phase 2)
- If ElevenLabs is down or unconfigured, Alfred still replies in text — TTS never blocks the answer

## Notes

- **Voice input** uses the free browser Web Speech API (push-to-talk). Works in Chrome, Edge, and recent iOS Safari. The text box is always there as a fallback. Whisper STT is a Phase 3 upgrade if accuracy bugs you.
- **Audio on iOS** is unlocked by your first tap on the page; if a reply ever plays silently, tap once and try again.
- Alfred's personality lives in `ALFRED_SYSTEM_PROMPT` at the top of `server.js` — edit freely. "Sir" vs. "Master Batman" frequency is one line.
- Phase 1 has no email/calendar/file access by design. That's Phase 2 (Google OAuth + tool-use loop + Postgres).

## Run locally (optional)

```
npm install
ANTHROPIC_API_KEY=... ALFRED_PASSWORD=test npm start
# open http://localhost:3000
```
