'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface ChatMessage {
  id: number;
  role: 'user' | 'sentinel';
  text: string;
  timestamp: string;
  type?: 'question' | 'task' | 'new_mission';
  tools_used?: string[];
}

let msgCounter = 0;

function makeMessage(role: 'user' | 'sentinel', text: string, type?: string, tools?: string[]): ChatMessage {
  return {
    id: Date.now() + (++msgCounter),
    role,
    text,
    timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
    type: type as ChatMessage['type'],
    tools_used: tools,
  };
}

/** Play base64 audio with amplification and return a promise that resolves when it finishes. */
function playAudio(base64: string, audioRef: React.MutableRefObject<HTMLAudioElement | null>): Promise<void> {
  return new Promise((resolve) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    const audio = new Audio(`data:audio/mp3;base64,${base64}`);
    audio.volume = 1.0;
    audioRef.current = audio;

    // Boost volume beyond 100% using Web Audio API gain node
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(audio);
      const gainNode = ctx.createGain();
      gainNode.gain.value = 3.0; // 3x amplification
      source.connect(gainNode);
      gainNode.connect(ctx.destination);
    } catch { /* fallback to normal volume */ }

    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    audio.play().catch(() => resolve());
  });
}

const STOP_WORDS = ['stop', 'goodbye', 'end conversation', 'stop talking', 'quit'];

interface ChatInterfaceProps {
  compact?: boolean;
}

export default function ChatInterface({ compact = false }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [conversationMode, setConversationMode] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const conversationModeRef = useRef(false);
  const isLoadingRef = useRef(false);

  useEffect(() => { conversationModeRef.current = conversationMode; }, [conversationMode]);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // Load chat history on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/sentinel/chat');
        if (!res.ok) return;
        const data = await res.json();
        if (data.messages?.length) {
          setMessages(data.messages.map((m: Record<string, unknown>, i: number) => ({
            id: -(i + 1), // negative IDs for history — can never collide with positive new-message IDs
            role: (m.role === 'user' ? 'user' : 'sentinel') as 'user' | 'sentinel',
            text: m.text as string,
            timestamp: m.timestamp
              ? new Date(m.timestamp as string).toLocaleTimeString('en-US', { hour12: false })
              : '',
            tools_used: m.tools_used as string[] | undefined,
          })));
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // ── Send message with sequential audio + conversation loop ──

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoadingRef.current) return;

    setMessages(prev => [...prev, makeMessage('user', trimmed)]);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/sentinel/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      setMessages(prev => [
        ...prev,
        makeMessage('sentinel', data.text || 'No response.', data.type, data.tools_used),
      ]);

      // Play audio — await so we don't restart recording too early
      if (data.audio_base64) {
        await playAudio(data.audio_base64, audioRef);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setMessages(prev => [...prev, makeMessage('sentinel', `[ERROR] ${msg}`)]);
    }

    setIsLoading(false);

    // In conversation mode, automatically start recording again
    if (conversationModeRef.current) {
      setTimeout(() => startRecording(), 400);
    } else {
      inputRef.current?.focus();
    }
  }, []);

  // ── Audio recording via MediaRecorder (works in ALL browsers) ──

  const startRecording = useCallback(async () => {
    if (isLoadingRef.current || isTranscribing) return;

    try {
      // Reuse existing stream or get new one
      if (!streamRef.current) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      chunksRef.current = [];
      const recorder = new MediaRecorder(streamRef.current, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        // Skip if recording was too short (< 500 bytes = ~0.1s silence)
        if (blob.size < 500) {
          if (conversationModeRef.current) setTimeout(() => startRecording(), 300);
          return;
        }
        transcribeAndSend(blob);
      };

      // Request data every 250ms so we get chunks even on short recordings
      recorder.start(250);
      setIsRecording(true);
    } catch (err) {
      console.error('Mic access failed:', err);
    }
  }, [isTranscribing]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  // ── Transcribe audio via ElevenLabs STT, then send as chat ──

  const transcribeAndSend = useCallback(async (blob: Blob) => {
    setIsTranscribing(true);

    try {
      // Convert blob to base64
      const buffer = await blob.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );

      const res = await fetch('/api/sentinel/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64, mimeType: blob.type }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || err.error || `Transcription failed (${res.status})`);
      }
      const data = await res.json();
      const transcript = (data.text || '').trim();

      if (!transcript) {
        // No speech detected — in conversation mode, restart recording
        if (conversationModeRef.current) {
          setTimeout(() => startRecording(), 500);
        }
        setIsTranscribing(false);
        return;
      }

      // Check stop words in conversation mode
      if (conversationModeRef.current && STOP_WORDS.includes(transcript.toLowerCase())) {
        setConversationMode(false);
        setIsTranscribing(false);
        return;
      }

      setIsTranscribing(false);
      sendMessage(transcript);
    } catch (err) {
      console.error('Transcription error:', err);
      setIsTranscribing(false);
      // In conversation mode, recover
      if (conversationModeRef.current) {
        setTimeout(() => startRecording(), 1000);
      }
    }
  }, [sendMessage, startRecording]);

  // ── Conversation mode toggle ──

  const toggleConversationMode = useCallback(() => {
    if (conversationMode) {
      // Already in conversation mode — check if audio is playing
      if (audioRef.current && !audioRef.current.paused) {
        // Interrupt audio and start listening immediately
        audioRef.current.pause();
        audioRef.current = null;
        startRecording();
        return;
      }
      // No audio playing — turn off conversation mode
      setConversationMode(false);
      stopRecording();
    } else {
      // Turn on — interrupt any playing audio and start listening
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setConversationMode(true);
      startRecording();
    }
  }, [conversationMode, startRecording, stopRecording]);

  // Cleanup mic stream on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  // ── PTT handlers ──

  const handlePTTStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if ('touches' in e) e.preventDefault();
    if (!conversationMode) startRecording();
  }, [conversationMode, startRecording]);

  const handlePTTEnd = useCallback(() => {
    if (!conversationMode) stopRecording();
  }, [conversationMode, stopRecording]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') sendMessage(input);
  };

  const busy = isLoading || isTranscribing;

  return (
    <div className={`flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden ${compact ? 'h-full' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${conversationMode ? 'bg-purple-500' : 'bg-cyan-500'} animate-pulse`} />
          <h2 className="text-xs font-mono font-bold tracking-widest text-zinc-400 uppercase">
            {conversationMode ? 'Voice Mode' : 'SENTINEL Chat'}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {busy && (
            <span className="flex items-center gap-1.5 text-[10px] font-mono text-cyan-400">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
              {isTranscribing ? 'Transcribing' : 'Thinking'}
            </span>
          )}
          <button
            onClick={toggleConversationMode}
            className={`rounded-md px-2 py-0.5 text-[10px] font-mono font-bold tracking-wider transition-all ${
              conversationMode
                ? 'bg-purple-900/50 border border-purple-500 text-purple-300 animate-pulse'
                : 'bg-zinc-800 border border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500'
            }`}
          >
            {conversationMode ? 'LIVE' : 'VOICE'}
          </button>
        </div>
      </div>

      {/* Conversation mode status bar */}
      {conversationMode && (
        <div className="flex items-center justify-center gap-2 bg-purple-950/30 border-b border-purple-800/30 px-4 py-1.5">
          <div className={`w-3 h-3 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : busy ? 'bg-cyan-500 animate-pulse' : 'bg-purple-500'}`} />
          <span className="text-[10px] font-mono text-purple-300 tracking-wider">
            {isRecording ? 'LISTENING...' : isTranscribing ? 'TRANSCRIBING...' : isLoading ? 'THINKING...' : 'SPEAKING...'}
          </span>
          <span className="text-[10px] font-mono text-purple-600 ml-auto">say &quot;stop&quot; to exit</span>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className={`flex-1 overflow-y-auto p-4 space-y-3 font-mono text-sm ${compact ? 'min-h-0' : 'min-h-[200px] max-h-[400px]'}`}
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center py-8">
            <div className="text-zinc-700 mb-2">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p className="text-xs text-zinc-600">
              Ask SENTINEL anything or give it a mission.
            </p>
            <p className="text-[10px] text-zinc-700 mt-1">
              &quot;Who is in the room?&quot; &middot; &quot;Watch for anyone running&quot;
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col gap-0.5 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <span className="text-[10px] tracking-widest text-zinc-600">
              {msg.role === 'user' ? 'YOU' : 'SENTINEL'} &middot; {msg.timestamp}
            </span>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-zinc-800 text-zinc-200 rounded-tr-none'
                  : msg.type === 'new_mission'
                    ? 'bg-zinc-900 border border-amber-800/60 text-amber-300 rounded-tl-none'
                    : 'bg-zinc-900 border border-cyan-900/60 text-cyan-300 rounded-tl-none'
              }`}
            >
              {msg.text}
              {msg.type === 'new_mission' && (
                <span className="block mt-1 text-[10px] text-amber-500 font-bold tracking-wider uppercase">
                  Mission deployed
                </span>
              )}
              {msg.tools_used && msg.tools_used.length > 0 && (
                <span className="block mt-1 text-[10px] text-zinc-600">
                  tools: {msg.tools_used.join(', ')}
                </span>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex items-start gap-2">
            <div className="bg-zinc-900 border border-cyan-900/40 rounded-lg rounded-tl-none px-3 py-2">
              <div className="flex gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-600 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-600 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-600 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2 shrink-0">
        {/* Push-to-talk mic button */}
        <button
          onMouseDown={handlePTTStart}
          onMouseUp={handlePTTEnd}
          onMouseLeave={handlePTTEnd}
          onTouchStart={handlePTTStart}
          onTouchEnd={handlePTTEnd}
          disabled={busy || conversationMode}
          className={`
            relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-all duration-200 select-none
            ${isRecording
              ? 'border-red-500 bg-red-900/30 text-red-400 scale-110'
              : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'}
            disabled:opacity-40 disabled:cursor-not-allowed
          `}
          title="Hold to talk"
        >
          {isRecording && (
            <span className="absolute inset-0 rounded-full border-2 border-red-500 animate-ping opacity-50" />
          )}
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-6 11a6 6 0 0 0 12 0h2a8 8 0 0 1-7 7.938V22h-2v-2.062A8 8 0 0 1 4 12H6z" />
          </svg>
        </button>

        {/* Text input */}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={conversationMode ? 'Voice mode active...' : compact ? 'Ask SENTINEL...' : 'Type or hold mic to talk...'}
          disabled={busy || isRecording || conversationMode}
          className="
            flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5
            text-xs font-mono text-zinc-200 placeholder-zinc-600
            focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-900
            disabled:opacity-40 disabled:cursor-not-allowed
            transition-colors duration-150
          "
        />

        {/* Send button */}
        <button
          onClick={() => sendMessage(input)}
          disabled={busy || isRecording || !input.trim() || conversationMode}
          className="
            flex h-8 w-8 shrink-0 items-center justify-center rounded-full border
            border-zinc-700 bg-zinc-900 text-zinc-500
            hover:border-cyan-600 hover:text-cyan-400
            disabled:opacity-30 disabled:cursor-not-allowed
            transition-all duration-150
          "
          title="Send"
        >
          <svg className="h-3.5 w-3.5 rotate-90" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
