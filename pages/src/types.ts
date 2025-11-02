import { z } from 'zod';

export const FlashcardSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  tags: z.array(z.string()).optional()
});

export const FlashcardsResponseSchema = z.object({
  flashcards: z.array(FlashcardSchema)
});

export type Flashcard = z.infer<typeof FlashcardSchema>;
export type FlashcardsResponse = z.infer<typeof FlashcardsResponseSchema>;

// Shared types for chunking and card generation
export type Chunk = { id: string; seq: number; text: string };
export type Card = {
  id: string;
  question: string;
  answer: string;
  difficulty: 'easy' | 'med' | 'hard';
  tags: string[];
  source_chunk_ids: string[];
};
export type GenerateCardsRequest = { chunks: Chunk[]; maxCards?: number; llmModel?: string };
export type GenerateCardsResponse = {
  cards: Card[];
  stats: { chunks: number; tokens_est: number; generated: number; deduped: number };
};
export type GradeRequest = { question: string; answerKey: string; userAnswer: string };
export type GradeResponse = { score: number; feedback: string };