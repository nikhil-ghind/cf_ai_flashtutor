import { FlashcardsResponseSchema, FlashcardsResponse, GenerateCardsRequest, GenerateCardsResponse } from '../types';

const BASE_URL = (import.meta as any).env?.VITE_WORKER_URL ?? 'http://127.0.0.1:8787';

export async function generateFlashcards(chunks: string[]): Promise<FlashcardsResponse> {
  const res = await fetch(`${BASE_URL}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chunks })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Generate failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  const parsed = FlashcardsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid response schema: ${parsed.error.toString()}`);
  }
  return parsed.data;
}

export async function generateCards(request: GenerateCardsRequest): Promise<GenerateCardsResponse> {
  const res = await fetch(`${BASE_URL}/api/generate-cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Generate cards failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  return json as GenerateCardsResponse;
}

export async function tts(text: string, voice = 'en-US'): Promise<Blob> {
  const res = await fetch(`${BASE_URL}/api/voice/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice })
  });
  if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Blob([buf], { type: res.headers.get('content-type') ?? 'audio/mpeg' });
}

export async function stt(audio: Blob): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/voice/stt`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm' },
    body: audio
  });
  if (!res.ok) throw new Error(`STT failed: ${res.status}`);
  const { text } = await res.json();
  if (typeof text !== 'string' || !text.length) throw new Error('Invalid STT response');
  return text;
}

export async function grade(question: string, answerKey: string, userAnswer: string): Promise<{ score: number; feedback: string }> {
  const res = await fetch(`${BASE_URL}/api/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, answerKey, userAnswer })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Grade failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  if (typeof json?.score !== 'number' || typeof json?.feedback !== 'string') {
    throw new Error('Invalid grade response');
  }
  return json as { score: number; feedback: string };
}