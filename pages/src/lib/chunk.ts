export function chunkText(text: string, maxChars = 2000, overlap = 200): string[] {
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