import React, { useState, useRef } from 'react';
import { extractPdfText } from '../lib/pdf';
import type { Chunk } from '../types';

type Props = { onExtract: (chunks: Chunk[]) => void };

export default function PdfUploader({ onExtract }: Props) {
  const [status, setStatus] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    try {
      setStatus('Extracting text from PDF...');
      setProgress({ current: 0, total: 1 });
      
      const chunks = await extractPdfText(file, (current, total) => {
        setProgress({ current, total });
        setStatus(`Extracting text (page ${current}/${total})...`);
      });
      
      setStatus(`Extraction complete. Found ${chunks.length} chunks.`);
      setProgress(null);
      onExtract(chunks);
      
    } catch (error) {
      console.error('PDF extraction failed:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : 'Failed to extract PDF'}`);
      setProgress(null);
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    
    const files = Array.from(e.dataTransfer.files);
    const pdfFile = files.find(file => file.type === 'application/pdf');
    
    if (pdfFile) {
      void handleFile(pdfFile);
    } else {
      setStatus('Please drop a PDF file.');
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleFile(file);
    }
  };

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="uploader">
      <div
        className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
          isDragOver ? 'bg-blue-50 border-blue-500' : 'bg-gray-50 border-gray-300'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        role="button"
        aria-label="Drop PDF here or click to select"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        
        <div className="text-lg mb-2">📄 Drop PDF here or click to select</div>
        
        <div className="text-black text-sm">Supports PDF files up to 50MB</div>
      </div>
      
      {progress && (
        <div className="mt-4" aria-live="polite">
          <div className="w-full bg-gray-200 rounded overflow-hidden">
            <div
              className="h-2 bg-blue-600 transition-all"
              style={{ width: `${(progress.current / progress.total) * 100}%` }}
            />
          </div>
          <div className="text-center mt-2 text-sm text-black">
            Page {progress.current} of {progress.total}
          </div>
        </div>
      )}
      
      {status && (
        <div
          className={`status mt-4 p-2 rounded text-sm ${
            status.startsWith('Error') ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800'
          }`}
          role="status"
          aria-live="polite"
        >
          {status}
        </div>
      )}
    </div>
  );
}