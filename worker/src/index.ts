import { z } from 'zod';
// @ts-ignore
import { v4 as uuidv4 } from 'uuid';
import type { Chunk, Card, GenerateCardsRequest, GenerateCardsResponse, GradeRequest, GradeResponse } from './types';
import { GenerateCardsRequestSchema, GenerateCardsResponseSchema, GradeResponseSchema } from './types';

// In-memory job tracking (short-lived)
type JobStatus = { id: string; status: 'pending' | 'running' | 'succeeded' | 'failed'; error?: string; createdAt: number };
const jobs = new Map<string, JobStatus>();

// Debug: Store last AI responses for debugging
let lastAIResponses: string[] = [];

// Schemas
const GenerateRequestSchema = z.object({
  chunks: z.array(z.string().min(1)).min(1)
});

const FlashcardSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  tags: z.array(z.string()).optional()
});

const FlashcardsResponseSchema = z.object({
  flashcards: z.array(FlashcardSchema)
});

export interface Env {
  AI: any; // Workers AI binding
  WORKFLOWS?: any; // Workflows binding
  LLM_MODEL?: string;
  TTS_MODEL?: string;
  STT_MODEL?: string;
}

function jsonResponse(obj: unknown, init?: ResponseInit) {
  const headers = new Headers({
    'content-type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  if (init?.headers) {
    const extra = init.headers as HeadersInit;
    if (extra instanceof Headers) {
      extra.forEach((v, k) => headers.set(k, v));
    } else if (Array.isArray(extra)) {
      extra.forEach(([k, v]) => headers.set(k, v));
    } else {
      Object.entries(extra).forEach(([k, v]) => headers.set(k, v as string));
    }
  }
  return new Response(JSON.stringify(obj), { headers, ...init });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, { status });
}

// Resolve the LLM model to use. Prefer explicit override, then env var, then a safe default.
function resolveLLMModel(env: Env, override?: string): string {
  const val = (override ?? env.LLM_MODEL ?? '').trim();
  return val || '@cf/meta/llama-3.1-8b-instruct';
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      // Preflight CORS support
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': req.headers.get('origin') || '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': req.headers.get('access-control-request-headers') || 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400',
            'Vary': 'Origin'
          }
        });
      }
      // API routes
      if (req.method === 'POST' && url.pathname === '/api/generate-cards') {
        return await handleGenerateCards(req, env);
      }
      if (req.method === 'POST' && url.pathname === '/api/grade') {
        return await handleGrade(req, env);
      }
      if (req.method === 'POST' && url.pathname === '/api/voice/stt') {
        return await handleSTT(req, env);
      }
      if (req.method === 'POST' && url.pathname === '/api/voice/tts') {
        return await handleTTS(req, env);
      }
      if (req.method === 'POST' && url.pathname === '/workflow/generate') {
        const { text } = await req.json().catch(() => ({ text: '' }));
        if (!text || typeof text !== 'string') return errorResponse('Missing text');
        const chunks = chunk(text, 2000, 200);
        const out = await generateFromChunks(env, { chunks });
        return jsonResponse(out);
      }
      if (req.method === 'POST' && url.pathname === '/generate') {
        return await handleGenerate(req, env);
      }
      if (req.method === 'POST' && url.pathname === '/tts') {
        return await handleTTS(req, env);
      }
      if (req.method === 'POST' && url.pathname === '/stt') {
        return await handleSTT(req, env);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/job/')) {
        const id = url.pathname.split('/').pop()!;
        const job = jobs.get(id);
        if (!job) return errorResponse('Job not found', 404);
        return jsonResponse(job);
      }
      if (req.method === 'GET' && url.pathname === '/debug/ai-responses') {
        return jsonResponse({ responses: lastAIResponses });
      }
      if (url.pathname === '/' && req.method === 'GET') {
        return new Response('PDF-to-Flashcards Tutor Worker', { status: 200 });
      }
      return errorResponse('Not found', 404);
    } catch (e: any) {
      return errorResponse(e?.message ?? 'Server error', 500);
    }
  }
};

async function handleGenerate(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null);
  const parsed = GenerateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(`Invalid request: ${parsed.error.message}`, 400);
  }
  const { chunks } = parsed.data;

  // Create job
  const jobId = uuidv4();
  jobs.set(jobId, { id: jobId, status: 'running', createdAt: Date.now() });

  // Build instruction for strict JSON output
  const system = [
    'You generate flashcards from provided study text.',
    'Return ONLY strict JSON with shape: { "flashcards": [ { "question": string, "answer": string, "tags"?: string[] } ] }',
    'No markdown, no additional commentary.'
  ].join(' ');

  const user = [
    'Create focused, concise Q/A flashcards covering key concepts.',
    'Prefer 8-18 cards depending on material length.',
    'Avoid duplicates; answers should be short and factual.',
    'Input chunks:',
    ...chunks.map((c, i) => `Chunk ${i + 1}: ${c}`)
  ].join('\n\n');

  try {
    const aiRes = await env.AI.run(resolveLLMModel(env), {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      max_tokens: 1200
    });

    // Workers AI may return { response: string } or choices. Normalize
    const raw = typeof aiRes === 'string' ? aiRes : (aiRes?.response ?? aiRes?.choices?.[0]?.message?.content ?? '');

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // Try to recover by extracting JSON substring
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Model did not return JSON');
      data = JSON.parse(match[0]);
    }

    const validated = FlashcardsResponseSchema.safeParse(data);
    if (!validated.success) {
      throw new Error(`Invalid JSON from model: ${validated.error.message}`);
    }
    jobs.set(jobId, { id: jobId, status: 'succeeded', createdAt: Date.now() });
    return jsonResponse(validated.data);
  } catch (e: any) {
    jobs.set(jobId, { id: jobId, status: 'failed', error: e?.message ?? 'AI error', createdAt: Date.now() });
    return errorResponse(e?.message ?? 'AI error', 500);
  }
}

async function handleTTS(req: Request, env: Env): Promise<Response> {
  const { text, voice } = await req.json().catch(() => ({ text: '', voice: 'en-US' }));
  if (!text || typeof text !== 'string') return errorResponse('Missing text');
  try {
    const model = env.TTS_MODEL || '@cf/xtts';
    const audio = await env.AI.run(model, { text, voice });
    const bytes: ArrayBuffer = (audio?.audio ?? audio);
    return new Response(bytes, { headers: { 'content-type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*'} });
  } catch (e: any) {
    return errorResponse(e?.message ?? 'TTS failed', 500);
  }
}

async function handleSTT(req: Request, env: Env): Promise<Response> {
  const ct = req.headers.get('content-type') || '';
  if (!(ct.includes('audio') || ct.includes('octet-stream'))) {
    return errorResponse('Invalid audio content-type', 400);
  }
  const audio = await req.arrayBuffer();
  if (!audio || audio.byteLength < 128) {
    return errorResponse('Audio payload too small or missing', 400);
  }
  try {
    const model = env.STT_MODEL || '@cf/openai/whisper';
    console.log(`🎤 STT: Using model ${model}, audio size: ${audio.byteLength} bytes`);
    
    const result = await env.AI.run(model, { audio });
    console.log('🎤 STT result:', result);
    
    const text = result?.text ?? result?.transcript ?? '';
    if (!text) throw new Error('No text from STT result');
    
    console.log(`🎤 STT success: "${text}"`);
    return jsonResponse({ text });
  } catch (e: any) {
    console.error('🎤 STT error:', e);
    return errorResponse(`STT failed: ${e?.message ?? 'Unknown error'}`, 500);
  }
}

// --- GenerateCards API using Workflows ---

async function handleGenerateCards(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null);
  const parsed = GenerateCardsRequestSchema.safeParse(body);
  if (!parsed.success) return errorResponse(`Invalid request: ${parsed.error.message}`, 400);
  const { chunks, maxCards } = parsed.data as GenerateCardsRequest;

  const llmModel = resolveLLMModel(env);
  try {
    // Use local pipeline to avoid serialization issues with workflows
    // The workflow approach has serialization issues because env bindings can't be serialized
    const out = await runGenerateCardsPipeline(env, { chunks, maxCards, llmModel });
    const validated = GenerateCardsResponseSchema.parse(out);
    return jsonResponse(validated);
  } catch (e: any) {
    return errorResponse(e?.message ?? 'Generation error', 500);
  }
}

// --- Grade API ---
const GradeRequestSchema = z.object({
  question: z.string().min(1),
  answerKey: z.string().min(1),
  // Accept empty user answers to score as 0.0 deterministically
  userAnswer: z.string()
});

async function handleGrade(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null);
  const parsed = GradeRequestSchema.safeParse(body);
  if (!parsed.success) return errorResponse(`Invalid request: ${parsed.error.message}`, 400);
  const input = parsed.data as GradeRequest;

  // Deterministic handling for empty or "I don't know" responses
  const ua = (input.userAnswer ?? '').trim();
  if (!ua || /^i\s+don'?t\s+know$/i.test(ua)) {
    const feedback = 'No answer provided; unable to assess key ideas.';
    return jsonResponse({ score: 0.0, feedback });
  }

  // Deterministic, strict JSON grader prompt per specification
  const system = [
    'Grade a short free-text answer against the gold answer. Be concise and deterministic.',
    'Rules:',
    '- Score in {0.0,0.1,...,1.0}.',
    '- Accept synonyms/paraphrases; penalize contradictions/missing key ideas.',
    '- Empty or "I don\'t know" → 0.',
    '- Feedback: 1–2 sentences: what\'s right, what\'s missing.',
    'Format: { "score": 0.0, "feedback": "..." }',
    'Return ONLY the JSON. No extra text.'
  ].join(' ');

  const user = [
    `Question: ${input.question}`,
    `GoldAnswer: ${input.answerKey}`,
    `UserAnswer: ${input.userAnswer}`
  ].join('\n');

  const model = resolveLLMModel(env);
  try {
    const raw = await callAI(env, model, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 200 });
    const parsedJson = await safeParseLLMJson<GradeResponse>(env, raw, z.object({ score: z.number(), feedback: z.string().min(1) }));

    // Normalize score deterministically: clamp to [0,1], convert 0-100 if needed, round to nearest 0.1
    let s = parsedJson.score;
    if (s > 1 && s <= 100) s = s / 100;
    if (s < 0) s = 0;
    if (s > 1) s = 1;
    s = Math.round(s * 10) / 10;

    const feedback = String(parsedJson.feedback || '').trim();
    // Enforce 1–2 sentences by trimming excessive length if needed (soft enforcement)
    const fb = feedback.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim();

    const result = { score: s, feedback: fb.length ? fb : 'Concise feedback unavailable.' };
    const validated = GradeResponseSchema.parse(result);
    return jsonResponse(validated);
  } catch (e: any) {
    return errorResponse(e?.message ?? 'Grading failed', 500);
  }
}

// Functions to support Workflows
export function chunk(text: string, maxChars = 2000, overlap = 200): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const chunks: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const end = Math.min(i + maxChars, cleaned.length);
    const chunk = cleaned.slice(i, end);
    chunks.push(chunk);
    if (end === cleaned.length) break;
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks;
}

export async function generateFromChunks(env: Env, input: { chunks: string[] }): Promise<{ flashcards: Array<{ question: string; answer: string; tags?: string[] }> }> {
  const { chunks } = input;
  const system = [
    'You generate flashcards from provided study text.',
    'Return ONLY strict JSON with shape: { "flashcards": [ { "question": string, "answer": string, "tags"?: string[] } ] }',
    'No markdown, no additional commentary.'
  ].join(' ');

  const user = [
    'Create focused, concise Q/A flashcards covering key concepts.',
    'Prefer 8-18 cards depending on material length.',
    'Avoid duplicates; answers should be short and factual.',
    'Input chunks:',
    ...chunks.map((c, i) => `Chunk ${i + 1}: ${c}`)
  ].join('\n\n');

  const raw = await callAI(env, resolveLLMModel(env), { messages: [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ], max_tokens: 1200 });

  const validated = await safeParseLLMJson(env, raw, FlashcardsResponseSchema);
  return validated;
}

// Helpers: callAI with timeout/retries; safe JSON parsing with repair
async function callAI(env: Env, model: string, payload: Record<string, unknown>, opts: { timeoutMs?: number; retries?: number } = {}): Promise<string> {
  const { timeoutMs = 20000, retries = 2 } = opts;
  let attempt = 0;
  let lastErr: any;
  while (attempt <= retries) {
    try {
      const p = env.AI.run(model, payload);
      const res = await (timeoutMs ? Promise.race([p, timeout(timeoutMs)]) : p);
      const raw = typeof res === 'string' ? res : (res?.response ?? res?.choices?.[0]?.message?.content ?? '');
      if (!raw) throw new Error('Empty AI response');
      return raw as string;
    } catch (e) {
      lastErr = e;
      attempt++;
      if (attempt > retries) break;
    }
  }
  throw new Error(lastErr?.message ?? 'AI call failed');
}

function timeout(ms: number) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms));
}

async function safeParseLLMJson<T>(env: Env, raw: string, schema: z.ZodSchema<T>): Promise<T> {
  console.log('🔍 [JSON Parser] Raw AI response:', raw);
  console.log('🔍 [JSON Parser] Response length:', raw.length);
  
  // Store for debug endpoint (keep last 5 responses)
  lastAIResponses.unshift(raw);
  if (lastAIResponses.length > 5) lastAIResponses.pop();
  
  const attempt = tryParse<T>(raw, schema);
  if (attempt.ok) {
    console.log('✅ [JSON Parser] Successfully parsed on first attempt');
    return attempt.value as T;
  }
  
  console.log('❌ [JSON Parser] Initial parse failed:', attempt.error);
  
  // Try repair using a fixer prompt
  try {
    console.log('🔧 [JSON Parser] Attempting repair with AI fixer...');
    const fixerSystem = 'Fix the following JSON to strictly match the provided schema. Return ONLY the corrected JSON. Schema describes keys and types. No commentary.';
    const fixerUser = `Schema: ${schema.toString()}\n\nJSON to fix:\n${raw}`;
    const model = resolveLLMModel(env);
    const fixedRaw = await callAI(env, model, { messages: [{ role: 'system', content: fixerSystem }, { role: 'user', content: fixerUser }], max_tokens: 400 });
    
    console.log('🔧 [JSON Parser] AI fixer response:', fixedRaw);
    
    const repaired = tryParse<T>(fixedRaw, schema);
    if (repaired.ok) {
      console.log('✅ [JSON Parser] Successfully repaired and parsed');
      return repaired.value as T;
    }
    console.log('❌ [JSON Parser] Repair attempt failed:', repaired.error);
  } catch (repairError) {
    console.log('💥 [JSON Parser] Repair process threw error:', repairError);
  }
  
  // Fallback: Create minimal valid response based on schema
  console.log('🚨 [JSON Parser] Using fallback empty response');
  if (schema._def?.typeName === 'ZodObject') {
    const shape = (schema as any)._def.shape();
    if (shape.flashcards) {
      console.log('📝 [JSON Parser] Returning empty flashcards array');
      return { flashcards: [] } as T;
    }
    if (shape.cards) {
      console.log('🃏 [JSON Parser] Returning empty cards array');
      return { cards: [] } as T;
    }
  }
  
  console.log('💥 [JSON Parser] All strategies failed, throwing error');
  throw new Error(`Could not parse or repair JSON: ${attempt.error}`);
}

function tryParse<T>(raw: string, schema: z.ZodSchema<T>): { ok: true; value: T } | { ok: false; error: string } {
  console.log('🎯 [tryParse] Starting parse strategies...');
  
  // Strategy 1: Direct parse
  try {
    console.log('📋 [tryParse] Strategy 1: Direct JSON.parse');
    const obj = JSON.parse(raw);
    const parsed = schema.safeParse(obj);
    if (parsed.success) {
      console.log('✅ [tryParse] Strategy 1 succeeded');
      return { ok: true, value: parsed.data };
    }
    console.log('❌ [tryParse] Strategy 1: Schema validation failed');

    // Strategy 1b: Normalize alternate shapes (array of {question,answer,source})
    console.log('🧭 [tryParse] Strategy 1b: Attempting normalization for alternate shapes');
    const isArrayOfQA = Array.isArray(obj) && obj.every((x) => x && typeof x === 'object' && 'question' in x && 'answer' in x);
    const isObjectWithCardsArray = !Array.isArray(obj) && obj && typeof obj === 'object' && Array.isArray((obj as any).cards);

    // Detect schema target keys
    const def: any = (schema as any)._def;
    const hasShape = def?.typeName === 'ZodObject' && typeof def.shape === 'function';
    const shape = hasShape ? def.shape() : undefined;
    const expectsCards = !!shape?.cards;
    const expectsFlashcards = !!shape?.flashcards;

    const mapToCard = (item: any) => ({
      question: String(item.question ?? ''),
      answer: String(item.answer ?? ''),
      difficulty: item.difficulty && ['easy','med','hard'].includes(item.difficulty) ? item.difficulty : undefined,
      tags: Array.isArray(item.tags) ? item.tags.filter((t: any) => typeof t === 'string').slice(0, 5) : undefined,
      source_chunk_ids: Array.isArray(item.source_chunk_ids) && item.source_chunk_ids.length > 0
        ? item.source_chunk_ids.map((s: any) => String(s))
        : [ item.source ? String(item.source) : 'unknown' ]
    });

    const mapToFlashcard = (item: any) => ({
      question: String(item.question ?? ''),
      answer: String(item.answer ?? ''),
      tags: Array.isArray(item.tags) ? item.tags.filter((t: any) => typeof t === 'string') : []
    });

    let normalized: any = null;
    if (expectsCards) {
      if (isArrayOfQA) {
        normalized = { cards: (obj as any[]).map(mapToCard) };
      } else if (isObjectWithCardsArray) {
        const arr = (obj as any).cards as any[];
        normalized = { cards: arr.map(mapToCard) };
      }
    } else if (expectsFlashcards) {
      if (isArrayOfQA) {
        normalized = { flashcards: (obj as any[]).map(mapToFlashcard) };
      } else if (isObjectWithCardsArray) {
        const arr = (obj as any).cards as any[];
        normalized = { flashcards: arr.map(mapToFlashcard) };
      }
    }

    if (normalized) {
      console.log('🧭 [tryParse] Strategy 1b: Normalized object:', JSON.stringify(normalized).slice(0, 500) + '...');
      const parsedNorm = schema.safeParse(normalized);
      if (parsedNorm.success) {
        console.log('✅ [tryParse] Strategy 1b succeeded');
        return { ok: true, value: parsedNorm.data };
      }
      console.log('❌ [tryParse] Strategy 1b: Normalization did not satisfy schema');
    }
  } catch (e) {
    console.log('❌ [tryParse] Strategy 1: JSON.parse failed:', e);
  }

  // Strategy 2: Extract first complete JSON object
  try {
    console.log('🔍 [tryParse] Strategy 2: Balanced brace extraction');
    let braceCount = 0;
    let start = -1;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '{') {
        if (start === -1) start = i;
        braceCount++;
      } else if (raw[i] === '}') {
        braceCount--;
        if (braceCount === 0 && start !== -1) {
          const jsonStr = raw.slice(start, i + 1);
          console.log('🔍 [tryParse] Strategy 2: Extracted JSON:', jsonStr);
          const obj = JSON.parse(jsonStr);
          const parsed = schema.safeParse(obj);
          if (parsed.success) {
            console.log('✅ [tryParse] Strategy 2 succeeded');
            return { ok: true, value: parsed.data };
          }
          console.log('❌ [tryParse] Strategy 2: Schema validation failed');
          break;
        }
      }
    }
    console.log('❌ [tryParse] Strategy 2: No complete JSON object found');
  } catch (e) {
    console.log('❌ [tryParse] Strategy 2 failed:', e);
  }

  // Strategy 3: Clean and extract JSON from code blocks
  try {
    console.log('🧹 [tryParse] Strategy 3: Code block cleaning');
    const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
    console.log('🧹 [tryParse] Strategy 3: Cleaned text:', cleaned);
    const obj = JSON.parse(cleaned);
    const parsed = schema.safeParse(obj);
    if (parsed.success) {
      console.log('✅ [tryParse] Strategy 3 succeeded');
      return { ok: true, value: parsed.data };
    }
    console.log('❌ [tryParse] Strategy 3: Schema validation failed');
  } catch (e) {
    console.log('❌ [tryParse] Strategy 3 failed:', e);
  }

  // Strategy 4: Regex fallback with greedy match
  try {
    console.log('🎯 [tryParse] Strategy 4: Regex fallback');
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      console.log('🎯 [tryParse] Strategy 4: Regex matched:', match[0]);
      const obj = JSON.parse(match[0]);
      const parsed = schema.safeParse(obj);
      if (parsed.success) {
        console.log('✅ [tryParse] Strategy 4 succeeded');
        return { ok: true, value: parsed.data };
      }
      console.log('❌ [tryParse] Strategy 4: Schema validation failed');
    } else {
      console.log('❌ [tryParse] Strategy 4: No regex match found');
    }
  } catch (e) {
    console.log('❌ [tryParse] Strategy 4 failed:', e);
  }

  console.log('💥 [tryParse] All strategies exhausted');
  return { ok: false, error: 'Could not extract valid JSON from response' };
}

// Export Workflows object to satisfy Wrangler dev expectations
export const Workflows = {} as Record<string, unknown>;

// ============================
// Workflow helper functions
// ============================

export function prepareBatches(input: { chunks: Chunk[]; targetTokens?: number; maxCards?: number }): { batches: Array<{ id: string; text: string; chunk_ids: string[]; chunk_texts: string[]; tokens_est: number; max_cards_per_batch?: number }>; stats: { chunks: number; tokens_est: number } } {
  const target = input.targetTokens ?? 3000;
  const batches: Array<{ id: string; text: string; chunk_ids: string[]; chunk_texts: string[]; tokens_est: number; max_cards_per_batch?: number }> = [];
  let current: { text: string; chunk_ids: string[]; chunk_texts: string[]; tokens_est: number } = { text: '', chunk_ids: [], chunk_texts: [], tokens_est: 0 };
  let batchIndex = 1;

  const totalTokensEst = input.chunks.reduce((acc, c) => acc + Math.ceil(c.text.length / 4), 0);

  for (const c of input.chunks) {
    const t = Math.ceil(c.text.length / 4);
    if (current.tokens_est + t > target && current.text) {
      batches.push({ id: `batch-${batchIndex++}`, text: current.text.trim(), chunk_ids: current.chunk_ids.slice(), chunk_texts: current.chunk_texts.slice(), tokens_est: current.tokens_est });
      current = { text: '', chunk_ids: [], chunk_texts: [], tokens_est: 0 };
    }
    current.text += (current.text ? '\n\n' : '') + c.text;
    current.chunk_ids.push(c.id);
    current.chunk_texts.push(c.text);
    current.tokens_est += t;
  }
  if (current.text) {
    batches.push({ id: `batch-${batchIndex++}`, text: current.text.trim(), chunk_ids: current.chunk_ids.slice(), chunk_texts: current.chunk_texts.slice(), tokens_est: current.tokens_est });
  }
  // Distribute maxCards across batches (soft cap per batch)
  if (typeof input.maxCards === 'number' && input.maxCards > 0) {
    const per = Math.max(1, Math.floor(input.maxCards / Math.max(1, batches.length)));
    for (const b of batches) b.max_cards_per_batch = per;
  }
  return { batches, stats: { chunks: input.chunks.length, tokens_est: totalTokensEst } };
}

export async function generateCardsFromBatches(env: Env, input: { batches: Array<{ id: string; chunk_ids: string[]; chunk_texts: string[]; max_cards_per_batch?: number }>; llmModel: string; maxCardsPerBatch?: number }): Promise<{ candidates: Array<{ question: string; answer: string; difficulty?: 'easy'|'med'|'hard'; tags?: string[]; source_chunk_ids: string[] }> }> {
  const CardOutSchema = z.object({
    id: z.string().optional(),
    question: z.string().min(1),
    answer: z.string().min(1),
    difficulty: z.enum(['easy','med','hard']).optional(),
    tags: z.array(z.string()).max(5).optional(),
    source_chunk_ids: z.array(z.string()).min(1)
  });
  const ModelCardsResponseSchema = z.object({ cards: z.array(CardOutSchema) });

  const system = [
    'Create high-quality atomic flashcards from textbook-like prose.',
    'Use ONLY the provided text.',
    'Rules: Target ~12–20 cards per ~3k tokens (respect max_cards). Each card is atomic (one fact/relation). Prefer why/how/compare when suitable; answers concise. Include source chunk ids. Output STRICT JSON per schema, no prose.'
  ].join(' ');

  const candidates: Array<{ question: string; answer: string; difficulty?: 'easy'|'med'|'hard'; tags?: string[]; source_chunk_ids: string[] }> = [];
  for (const b of input.batches) {
    const userPayload = {
      chunk_ids: b.chunk_ids,
      chunk_texts: b.chunk_texts,
      max_cards: b.max_cards_per_batch ?? input.maxCardsPerBatch ?? 20
    };
    const user = [
      'USER:',
      `chunk_ids: ${JSON.stringify(userPayload.chunk_ids)}`,
      `chunk_texts: ${JSON.stringify(userPayload.chunk_texts)}`,
      `max_cards: ${userPayload.max_cards}`,
      'Return <= max_cards cards, deduped by normalized question text.'
    ].join('\n');

    const raw = await callAI(env, input.llmModel, { messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ], max_tokens: 1400 });

    const validated = await safeParseLLMJson(env, raw, ModelCardsResponseSchema);
    for (const f of validated.cards) {
      candidates.push({ question: f.question, answer: f.answer, difficulty: f.difficulty, tags: f.tags, source_chunk_ids: f.source_chunk_ids });
    }
  }
  return { candidates };
}

// Builder: Run GenerateCards pipeline programmatically without Workflows
export async function runGenerateCardsPipeline(env: Env, input: { chunks: Chunk[]; maxCards?: number; llmModel?: string }): Promise<GenerateCardsResponse> {
  const { batches, stats } = prepareBatches({ chunks: input.chunks, targetTokens: 3000, maxCards: input.maxCards });
  const { candidates } = await generateCardsFromBatches(env, { batches, llmModel: resolveLLMModel(env, input.llmModel) });
  const { cards, stats: finalStats } = dedupeAndTrim({ candidates, maxCards: input.maxCards, prevStats: stats });
  return { cards, stats: finalStats };
}

export function dedupeAndTrim(input: { candidates: Array<{ question: string; answer: string; difficulty?: 'easy'|'med'|'hard'; tags?: string[]; source_chunk_ids: string[] }>; maxCards?: number; prevStats?: { chunks: number; tokens_est: number } }): { cards: Card[]; stats: { chunks: number; tokens_est: number; generated: number; deduped: number } } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const toTerms = (s: string) => new Set(norm(s).split(' ').filter(Boolean));
  const jaccard = (a: Set<string>, b: Set<string>) => {
    const inter = new Set([...a].filter((x) => b.has(x)));
    const union = new Set([...a, ...b]);
    return inter.size / union.size;
  };

  const threshold = 0.85;
  const unique: Array<{ question: string; answer: string; difficulty?: 'easy'|'med'|'hard'; tags?: string[]; source_chunk_ids: string[] }> = [];
  for (const c of input.candidates) {
    const cTerms = toTerms(c.question);
    let isDup = false;
    for (const u of unique) {
      const uTerms = toTerms(u.question);
      if (jaccard(cTerms, uTerms) > threshold) {
        isDup = true;
        break;
      }
    }
    if (!isDup) unique.push(c);
  }

  const trimmed = typeof input.maxCards === 'number' ? unique.slice(0, input.maxCards) : unique;
  const cards: Card[] = trimmed.map((f) => ({ id: uuidv4(), question: f.question, answer: f.answer, difficulty: f.difficulty ?? 'med', tags: f.tags ?? [], source_chunk_ids: f.source_chunk_ids }));
  const generated = input.candidates.length;
  const deduped = cards.length;
  const chunks = input.prevStats?.chunks ?? 0;
  const tokens_est = input.prevStats?.tokens_est ?? 0;
  return { cards, stats: { chunks, tokens_est, generated, deduped } };
}