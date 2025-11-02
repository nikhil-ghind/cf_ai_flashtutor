import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import { v4 as uuidv4 } from 'uuid';
import type { Chunk } from '../types';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString();

/**
 * Chunk text by sentences with a target length per chunk.
 * Default target is 2000 chars; we allow ~±25% slack.
 */
export function chunkBySentences(text: string, targetLen = 2000): string[] {
  const minChars = Math.max(500, Math.floor(targetLen * 0.75));
  const maxChars = Math.max(minChars + 500, Math.floor(targetLen * 1.25));
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return [cleaned];

  // Split by sentence boundaries (., !, ?, followed by space and capital letter or end)
  const sentences = cleaned.split(/(?<=[.!?])\s+(?=[A-Z]|$)/).filter(s => s.trim());

  const chunks: string[] = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    const testChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;

    if (testChunk.length <= maxChars) {
      currentChunk = testChunk;
    } else {
      if (currentChunk.length >= minChars) {
        chunks.push(currentChunk);
        currentChunk = sentence;
      } else {
        currentChunk = testChunk; // force add to avoid losing content
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.filter(chunk => chunk.trim().length > 0);
}

/**
 * Extract text from PDF file and return as structured chunks
 */
export async function extractPdfText(
  file: File,
  onProgress?: (current: number, total: number) => void
): Promise<Chunk[]> {
  try {
    // Load PDF document
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    
    const totalPages = pdf.numPages;
    const pageTexts: string[] = [];
    
    // Extract text from each page
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      // Join text items with spaces
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ')
        .trim();
      
      if (pageText) {
        pageTexts.push(pageText);
      }
      
      // Report progress
      if (onProgress) {
        onProgress(pageNum, totalPages);
      }
    }
    
    // Join all pages with double newlines
    const fullText = pageTexts.join('\n\n');
    
    if (!fullText.trim()) {
      throw new Error('No text content found in PDF');
    }
    
    // Chunk by sentences
    const textChunks = chunkBySentences(fullText);
    
    // Convert to Chunk objects with UUIDs and sequence numbers
    const chunks: Chunk[] = textChunks.map((text, index) => ({
      id: uuidv4(),
      seq: index,
      text: text.trim()
    }));
    
    return chunks;
    
  } catch (error) {
    console.error('PDF extraction error:', error);
    throw new Error(`Failed to extract text from PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}