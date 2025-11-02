import { z } from 'zod';

export type Chunk = { id: string; seq: number; text: string };
export type Card = {
  id: string;
  question: string;
  answer: string;
  difficulty: 'easy' | 'med' | 'hard';
  tags: string[];
  source_chunk_ids: string[];
};

export type GenerateCardsRequest = { chunks: Chunk[]; maxCards?: number };
export type GenerateCardsResponse = {
  cards: Card[];
  stats: { chunks: number; tokens_est: number; generated: number; deduped: number };
};
export type GradeRequest = { question: string; answerKey: string; userAnswer: string };
export type GradeResponse = { score: number; feedback: string };

// Zod Schemas for request/response validation
export const ChunkSchema = z.object({ id: z.string(), seq: z.number().int().nonnegative(), text: z.string().min(1) });
export const CardSchema = z.object({
  id: z.string(),
  question: z.string().min(1),
  answer: z.string().min(1),
  difficulty: z.enum(['easy', 'med', 'hard']),
  tags: z.array(z.string()),
  source_chunk_ids: z.array(z.string()).min(1)
});

export const GenerateCardsRequestSchema = z.object({
  chunks: z.array(ChunkSchema).min(1),
  maxCards: z.number().int().positive().optional()
});

export const GenerateCardsResponseSchema = z.object({
  cards: z.array(CardSchema),
  stats: z.object({
    chunks: z.number().int().nonnegative(),
    tokens_est: z.number().int().nonnegative(),
    generated: z.number().int().nonnegative(),
    deduped: z.number().int().nonnegative()
  })
});

export const GradeRequestSchema = z.object({
  question: z.string().min(1),
  answerKey: z.string().min(1),
  userAnswer: z.string()
});

export const GradeResponseSchema = z.object({
  score: z.number().min(0).max(1),
  feedback: z.string().min(1)
});