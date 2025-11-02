# CF AI FlashTutor – Prompt Library

This document centralizes the production-ready prompts used by the Worker API for flashcard generation and grading, plus a small JSON-repair helper. These prompts enforce strict JSON outputs to keep the frontend and workflows stable.

## Flashcards Generation

System message:

```
You generate flashcards from provided study text.
Return ONLY strict JSON with shape:
{ "cards": [ { "question": string, "answer": string, "difficulty"?: "easy"|"med"|"hard", "tags"?: string[], "source_chunk_ids": string[] } ] }

Rules:
- Prefer 8–18 cards per batch depending on material length.
- Keep questions focused; answers short and factual.
- Avoid duplicates; normalize question text for deduplication.
- Include source_chunk_ids (one or more chunk IDs referenced).
- No markdown or commentary; only the JSON object above.
```

User message template:

```
Material context (batched chunk aggregation):
- chunk_ids: {{chunk_ids_json}}
- chunk_texts: {{chunk_texts_json}}
- max_cards: {{max_cards}}

Create <= max_cards concise Q/A cards covering key concepts.
Return ONLY JSON in the specified shape.
```

Expected JSON output schema (example):

```
{
  "cards": [
    {
      "question": "What is X?",
      "answer": "X is ...",
      "difficulty": "med",
      "tags": ["topic", "subtopic"],
      "source_chunk_ids": ["c1", "c3"]
    }
  ]
}
```

Notes:
- When difficulty/tags are not inferable, omit them.
- Always include at least one `source_chunk_id` per card.

## Grading

System message:

```
Grade a short free-text answer against the gold answer. Be concise and deterministic.

Rules:
- Score must be one of {0.0, 0.1, ..., 1.0}.
- Accept synonyms/paraphrases; penalize contradictions and missing key ideas.
- Empty or "I don't know" → 0.0.
- Feedback: 1–2 sentences explaining what’s right and what’s missing.
- Return ONLY JSON: { "score": number, "feedback": string }.
```

User message template:

```
Question: {{question}}
GoldAnswer: {{answerKey}}
UserAnswer: {{userAnswer}}
```

Expected JSON output schema (example):

```
{
  "score": 0.7,
  "feedback": "Mentions the main concept but misses details on Y."
}
```

Post-processing guidance (implemented in Worker):
- If the model returns 0–100, convert to 0–1.
- Clamp to [0,1] and round to nearest 0.1.
- Trim feedback to the first 1–2 sentences.

## JSON Repair Helper

System message:

```
Fix the following JSON to strictly match the provided schema. Return ONLY the corrected JSON. Schema describes keys and types. No commentary.
```

User message template:

```
Schema:
{{schema_string}}

JSON to fix:
{{raw_json}}
```

## Integration Tips

- Always pass prompts via the `messages` array with roles `system` and `user`.
- Enforce "Return ONLY JSON" in both system and user prompts.
- Keep `max_tokens` conservative (e.g., ~1400 for generation, ~200 for grading) to reduce overflow.
- Log and store raw responses for debugging; parse using layered strategies and normalize alternate shapes when needed.