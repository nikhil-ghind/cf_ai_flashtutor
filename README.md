# CF AI FlashTutor (PDF-to-Flashcards Tutor)

A two-part project for turning study material into flashcards using Cloudflare Workers AI. It includes:
- A Worker API (Cloudflare Workers + Workflows) that chunks text, calls AI to generate cards, performs deduplication, and supports STT/TTS.
- A Pages app (Vite + React) to upload PDFs, generate and study cards, and view AI debug responses.

## Project Structure

```
cf-ai-flashtutor/
├── worker/                # Cloudflare Worker API
│   ├── src/index.ts       # Routes, AI calls, parsing, workflows helpers
│   ├── src/types.ts       # Zod schemas and types
│   └── wrangler.toml      # Worker config and AI bindings
├── pages/                 # Vite + React app
│   ├── src/App.tsx        # UI, deck view, API calls
│   └── vite.config.ts     # Dev server config
└── workflows/             # Declarative workflows
    ├── GenerateCards.yaml
    └── flashcards.yaml
```

## Prerequisites

- Node.js 18+
- pnpm or npm
- Cloudflare Wrangler (v3+). Local dev simulates Workers, but AI model usage calls your Cloudflare account and may incur charges.
- Optional: microphone for STT testing.

## Install

You can install dependencies at the workspace root or per package.

- Using pnpm (workspace-aware):
```
pnpm install
```

- Using npm:
```
cd worker && npm install
cd ../pages && npm install
```

## Run Locally

Run API and UI in separate terminals.

- Start Worker API:
```
cd worker
npx wrangler dev
```
It should be ready on `http://127.0.0.1:8787`.

- Start Pages app:
```
cd pages
npm run dev
```
It should be available at `http://localhost:5173/`.

If your worker runs on a non-default URL, set the frontend base URL via `VITE_WORKER_URL` (e.g., `.env` or shell):
```
VITE_WORKER_URL=http://127.0.0.1:8787
```

## Configuration

Worker AI bindings are configured in `worker/wrangler.toml` (local dev) or `infra/wrangler.toml` (remote):

- AI binding:
```
[ai]
binding = "AI"
```

- Vars (models used by the worker):
```
[vars]
LLM_MODEL = "@cf/meta/llama-3.1-8b-instruct"
TTS_MODEL = "@cf/xtts"
STT_MODEL = "@cf/openai/whisper"
```
Note: Model availability depends on your Cloudflare account. You can override vars per environment.

## Using the App

- Open `http://localhost:5174/`.
- Upload a PDF to extract text chunks.
- Click "Generate Cards" to create a study deck.
- View the Study Deck and sample questions.
- Above the deck, a debug box shows the latest raw AI JSON responses captured by the worker.

## API Endpoints (Worker)

Base URL: `http://127.0.0.1:8787`

- Generate (simple):
```
POST /generate
{
  "chunks": ["text chunk 1", "text chunk 2"]
}
```
Returns: `{ "flashcards": Array<{ question, answer, tags? }> }`

- Generate Cards (pipeline):
```
POST /api/generate-cards
{
  "chunks": [ { "id":"c1","seq":0,"text":"..." }, ... ],
  "maxCards": 40
}
```
Returns: `{ cards: Card[], stats: {...} }` where `Card = { id, question, answer, difficulty, tags, source_chunk_ids }`.

- Speech-to-Text (STT):
```
POST /api/voice/stt
Content-Type: audio/wav (or application/octet-stream)
<raw audio bytes>
```
Returns: `{ text: string }`.

- Text-to-Speech (TTS):
```
POST /api/voice/tts
{
  "text": "Hello world"
}
```
Returns audio bytes.

- Debug last AI responses:
```
GET /debug/ai-responses
```
Returns: `{ responses: string[] }` (last 5 raw responses).

## JSON Parsing & Normalization

AI outputs can be imperfect. The worker implements robust parsing in `safeParseLLMJson` with multiple strategies:
- Direct `JSON.parse` + zod validation.
- Balanced brace extraction.
- Code block cleanup.
- Regex fallback.
- AI repair prompt.
- Fallback to empty valid shape if all else fails.

Additionally, normalization accepts array-shaped Q/A like:
```
[
  { "question": "...", "answer": "...", "source": "chunk-id" },
  ...
]
```
It maps to the expected schema:
- For `{ cards: [...] }`, `source` becomes `source_chunk_ids: [source]`.
- For `{ flashcards: [...] }`, maps `{ question, answer, tags? }`.

## Troubleshooting

- Worker not starting or exits:
  - Update Wrangler: `npm i -D wrangler@4`.
  - Check logs for binding/compatibility issues.

- STT returns 400/500:
  - Ensure `Content-Type` is `audio/*` or `application/octet-stream`.
  - Audio payload must be non-empty (`> 128` bytes).
  - Verify `STT_MODEL` in `wrangler.toml`.
  - Check worker console logs (look for 🎤 STT logs).

- JSON parse errors on card generation:
  - Check the worker logs (🔍 JSON Parser / 🎯 tryParse logs).
  - Use `/debug/ai-responses` to inspect the raw AI output.
  - Parser will normalize array-shaped Q/A automatically.

- Frontend cannot reach worker:
  - Set `VITE_WORKER_URL` to your worker URL.
  - Confirm ports: worker `8787`, pages `5174`.

## Build & Deploy

- Build the Pages app:
```
cd pages
npm run build
```
Outputs static assets in `dist/`.

- Deploy the Worker:
```
cd worker
npx wrangler deploy
```
Configure your Cloudflare account/environment before deploying.

## Contributing

- Keep changes focused and minimal.
- Follow existing code style and zod schemas.
- Prefer improving root causes (e.g., parser robustness) over patching symptoms.