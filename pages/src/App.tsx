import React, { useRef, useState } from 'react';
import PdfUploader from './components/PdfUploader';
import { generateCards, tts, stt, grade } from './lib/api';
import type { Chunk, Card } from './types';

type View = 'upload' | 'deck' | 'quiz';

export default function App() {
  const [view, setView] = useState<View>('upload');
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<boolean>(false);
  const [currentIdx, setCurrentIdx] = useState<number>(0);
  const [userAnswer, setUserAnswer] = useState<string>('');
  const [lastScore, setLastScore] = useState<number | null>(null);
  const [lastFeedback, setLastFeedback] = useState<string | null>(null);
  const [scores, setScores] = useState<number[]>([]);
  const [debugResponses, setDebugResponses] = useState<string[]>([]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksAudioRef = useRef<BlobPart[]>([]);
  const recordTimeoutRef = useRef<number | null>(null);

  async function fetchDebugResponses() {
    try {
      const response = await fetch('http://127.0.0.1:8787/debug/ai-responses');
      if (response.ok) {
        const data = await response.json();
        setDebugResponses(data.responses || []);
      }
    } catch (e) {
      console.error('Failed to fetch debug responses:', e);
    }
  }

  async function onExtract(extractedChunks: Chunk[]) {
    setChunks(extractedChunks);
    setCards([]);
    setError(null);
    // Auto-generate cards and go to DeckView
    try {
      setLoading(true);
      const response = await generateCards({ 
        chunks: extractedChunks, 
        maxCards: 40
      });
      setCards(response.cards);
      setView('deck');
      // Fetch debug responses after generating cards
      await fetchDebugResponses();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to generate cards');
    } finally {
      setLoading(false);
    }
  }

  function startQuiz() {
    setView('quiz');
    setCurrentIdx(0);
    setUserAnswer('');
    setLastScore(null);
    setLastFeedback(null);
    setScores([]);
  }

  async function speak(text: string) {
    const audioBlob = await tts(text);
    const url = URL.createObjectURL(audioBlob);
    const audio = new Audio(url);
    audio.play();
  }

  async function startRecording() {
    try {
      if (!('mediaDevices' in navigator)) {
        setError('Audio recording is not supported in this browser. Try Chrome or Edge.');
        return;
      }
      if (typeof MediaRecorder === 'undefined') {
        setError('MediaRecorder is unavailable. Update your browser to record audio.');
        return;
      }
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
      if (!mime) {
        setError('This browser does not support WebM audio recording.');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      chunksAudioRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksAudioRef.current.push(e.data); };
      recorder.onstop = async () => {
        const audioBlob = new Blob(chunksAudioRef.current, { type: mime });
        setRecording(false);
        if (recordTimeoutRef.current) {
          window.clearTimeout(recordTimeoutRef.current);
          recordTimeoutRef.current = null;
        }
        try {
          const text = await stt(audioBlob);
          setUserAnswer(text);
        } catch (e: any) {
          setError(e?.message ?? 'STT error');
        }
      };
      recorder.start();
      setRecording(true);
      mediaRecorderRef.current = recorder;
      // Enforce 30s max duration
      recordTimeoutRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
          setError('Recording stopped at 30 seconds maximum length.');
        }
      }, 30000);
    } catch (e: any) {
      setError(e?.message ?? 'Unable to start recording');
    }
  }

  // Alias to match requested handler naming
  function recordAudio() {
    return startRecording();
  }

  function stopRecording() {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    if (recordTimeoutRef.current) {
      window.clearTimeout(recordTimeoutRef.current);
      recordTimeoutRef.current = null;
    }
    setRecording(false);
  }

  async function submitAnswer() {
    setError(null);
    setLastScore(null);
    setLastFeedback(null);
    const card = cards[currentIdx];
    if (!card) return;
    try {
      const res = await grade(card.question, card.answer, userAnswer.trim());
      setLastScore(res.score);
      setLastFeedback(res.feedback);
      setScores((prev) => [...prev, res.score]);
    } catch (e: any) {
      setError(e?.message ?? 'Grading failed');
    }
  }

  function nextQuestion() {
    const nextIdx = currentIdx + 1;
    if (nextIdx >= cards.length) {
      setView('deck');
      setCurrentIdx(0);
      setUserAnswer('');
      setLastScore(null);
      setLastFeedback(null);
      return;
    }
    setCurrentIdx(nextIdx);
    setUserAnswer('');
    setLastScore(null);
    setLastFeedback(null);
  }

  const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  return (
    <div className="min-h-screen">
      <header className="bg-white shadow">
        <div className="max-w-5xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-semibold">PDF-to-Flashcards Tutor</h1>
          <p className="text-black">Extract PDF → Generate Deck → Quiz</p>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {view === 'upload' && (
          <section aria-label="UploadView" className="space-y-4">
            <h2 className="text-xl font-medium">Upload a PDF</h2>
            <PdfUploader onExtract={onExtract} />
            {loading && <div className="text-black">Generating deck…</div>}
            {error && <div className="text-black" role="alert">{error}</div>}
          </section>
        )}

        {view === 'deck' && (
          <section aria-label="DeckView" className="space-y-4">
            {/* Debug AI Responses */}
            {debugResponses.length > 0 && (
              <div className="bg-gray-100 border rounded p-4">
                <h3 className="text-lg font-medium mb-2">🔍 AI Debug Responses</h3>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {debugResponses.map((response, i) => (
                    <div key={i} className="bg-white border rounded p-2">
                      <div className="text-xs text-gray-500 mb-1">Response {i + 1} ({response.length} chars)</div>
                      <pre className="text-xs text-gray-800 whitespace-pre-wrap break-words">{response}</pre>
                    </div>
                  ))}
                </div>
                <button 
                  onClick={fetchDebugResponses}
                  className="mt-2 px-3 py-1 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300"
                >
                  Refresh Debug Data
                </button>
              </div>
            )}
            
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-medium">Study Deck</h2>
                <p className="text-black">Chunks: {chunks.length} · Cards: {cards.length}</p>
              </div>
              <button className="px-4 py-2 bg-blue-600 text-black rounded" onClick={startQuiz} aria-label="Start quiz">Start quiz</button>
            </div>
            <div>
              <h3 className="text-lg font-medium">Sample Questions</h3>
              <ul className="list-disc list-inside text-black">
                {cards.slice(0, 5).map((c, i) => (
                  <li key={c.id || i}>{c.question}</li>
                ))}
                {cards.length === 0 && <li className="text-black">No cards yet.</li>}
              </ul>
            </div>
            {error && <div className="text-black" role="alert">{error}</div>}
          </section>
        )}

        {view === 'quiz' && (
          <section aria-label="QuizView" className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white rounded shadow p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-medium">Question {currentIdx + 1} of {cards.length}</h2>
                <div className="space-x-2">
                  <button className="px-3 py-1 bg-gray-100 rounded" onClick={() => speak(cards[currentIdx]?.question || '')} aria-label="Read question aloud">Speak Q</button>
                  <button className="px-3 py-1 bg-gray-100 rounded" onClick={() => speak(cards[currentIdx]?.answer || '')} aria-label="Read answer aloud">Speak A</button>
                </div>
              </div>
              <div className="mb-3">
                <div className="text-black font-medium">{cards[currentIdx]?.question}</div>
              </div>
              <label htmlFor="answer" className="block text-sm text-black">Your answer</label>
              <textarea
                id="answer"
                value={userAnswer}
                onChange={(e) => setUserAnswer(e.target.value)}
                className="mt-1 w-full h-28 p-2 border rounded"
                aria-label="Type your answer"
              />
              <div className="mt-2 flex items-center gap-2">
                <button className="px-3 py-1 bg-blue-600 text-black rounded" onClick={submitAnswer} aria-label="Submit answer">Submit</button>
                <button className="px-3 py-1 bg-gray-100 rounded" onClick={recordAudio} disabled={recording} aria-label="Start recording">{recording ? 'Recording…' : 'Mic'}</button>
                <button className="px-3 py-1 bg-gray-100 rounded" onClick={stopRecording} disabled={!recording} aria-label="Stop recording">Stop</button>
              </div>
              {lastScore !== null && (
                <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded" aria-live="polite">
                  <div className="font-medium">Score: {lastScore.toFixed(1)}</div>
                  <div className="text-black">{lastFeedback}</div>
                </div>
              )}
              <div className="mt-3">
                <button className="px-4 py-2 bg-blue-600 text-black rounded" onClick={nextQuestion} aria-label="Next question">Next</button>
              </div>
              {error && <div className="mt-3 text-black" role="alert">{error}</div>}
            </div>
            <aside className="bg-white rounded shadow p-4" aria-label="Quiz progress">
              <h3 className="text-lg font-medium">Progress</h3>
              <div className="mt-2">{currentIdx + 1} / {cards.length}</div>
              <div className="mt-4">
                <div className="text-sm text-black">Average score</div>
                <div className="text-xl font-semibold">{avgScore.toFixed(2)}</div>
              </div>
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}