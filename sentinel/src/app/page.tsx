'use client';

import { useState, useEffect, useCallback } from 'react';
import LiveFeed from '@/components/LiveFeed';
import SensorPanel from '@/components/SensorPanel';
import DetectionTimeline from '@/components/DetectionTimeline';
import GimbalControl from '@/components/GimbalControl';
import AgentReasoningLog from '@/components/AgentReasoningLog';
import StatsPanel from '@/components/StatsPanel';
import ModeSelector from '@/components/ModeSelector';
import MissionInput from '@/components/MissionInput';
import ChatInterface from '@/components/ChatInterface';
import AlertBar from '@/components/AlertBar';
import FaceUpload from '@/components/FaceUpload';

type AlertLevel = 'normal' | 'elevated' | 'alert';

interface SensorData {
  d: { f: number; l: number; r: number };
  ir: [number, number];
  s: number;
  p: number;
  t: number;
}

export default function CommandCenter() {
  const [sensors, setSensors] = useState<SensorData | null>(null);
  const [alertLevel, setAlertLevel] = useState<AlertLevel>('normal');
  const [currentMode, setCurrentMode] = useState<'chat' | 'monitor' | 'scan'>('chat');
  const [systemOnline, setSystemOnline] = useState(false);
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [telegramBot, setTelegramBot] = useState<string | null>(null);
  const [clock, setClock] = useState('');

  // Tick clock every second (avoids hydration mismatch from server vs client time)
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Poll perception data for sensor readings + alert state
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/sentinel/perception');
        const data = await res.json();
        if (data.perception) {
          setSystemOnline(true);
          const p = data.perception;
          if (p.sensors) {
            setSensors(p.sensors);
          }

          // Derive alert level from perception
          const ir = p.sensors?.ir;
          if (ir?.[0] === 1 || ir?.[1] === 1) {
            setAlertLevel('alert');
          } else if (p.vision?.people?.length > 0 && p.sensors?.d?.f < 200) {
            setAlertLevel('elevated');
          } else {
            setAlertLevel('normal');
          }
        }
      } catch {
        setSystemOnline(false);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Check Telegram connection on mount
  useEffect(() => {
    fetch('/api/sentinel/telegram')
      .then(r => r.json())
      .then(data => {
        setTelegramConnected(data.connected ?? false);
        setTelegramBot(data.bot?.username ?? null);
      })
      .catch(() => setTelegramConnected(false));
  }, []);

  // Poll mode from server to catch external changes
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/sentinel/mode');
        const data = await res.json();
        if (data.mode) {
          setCurrentMode(data.mode);
        }
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleModeChange = useCallback((mode: 'chat' | 'monitor' | 'scan') => {
    setCurrentMode(mode);
  }, []);

  const handleMissionSet = useCallback((mission: { text: string; task: Record<string, unknown> | null }) => {
    if (mission.task) {
      setCurrentMode('monitor');
    }
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-white">
      {/* Alert Bar */}
      <AlertBar alertLevel={alertLevel} clock={clock} />

      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full ${systemOnline ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
          <h1 className="text-lg font-bold tracking-wider text-white">
            SENTINEL
          </h1>
          <span className="text-xs text-zinc-500 font-mono">
            AUTONOMOUS PERCEPTION STATION
          </span>
          {telegramConnected && (
            <span className="flex items-center gap-1 rounded-full bg-blue-950/50 border border-blue-800/40 px-2 py-0.5 text-[10px] font-mono text-blue-400">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
              </svg>
              @{telegramBot}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <ModeSelector currentMode={currentMode} onModeChange={handleModeChange} />
          <FaceUpload />
          <span className="text-xs text-zinc-600 font-mono ml-auto tracking-widest hidden sm:block">
            {clock}
          </span>
        </div>
      </header>

      {/* Main Content — single grid, LiveFeed always mounted */}
      <main className="flex-1 p-4 overflow-hidden">
        <div className="grid grid-cols-12 gap-4 h-full max-h-[calc(100vh-110px)]">
          {/* Left column — LiveFeed always mounted, width varies by mode */}
          <div className={`flex flex-col gap-4 ${
            currentMode === 'chat' ? 'col-span-5'
              : currentMode === 'monitor' ? 'col-span-7'
              : 'col-span-8'
          }`}>
            <div className="flex-1 min-h-0">
              <LiveFeed />
            </div>
            {/* Below-feed panel varies by mode */}
            {currentMode === 'chat' && <MissionInput onMissionSet={handleMissionSet} />}
            {currentMode === 'monitor' && <MissionInput onMissionSet={handleMissionSet} />}
            {currentMode === 'scan' && (
              <div className="h-48">
                <DetectionTimeline />
              </div>
            )}
          </div>

          {/* Right column — panels vary by mode */}
          <div className={`flex flex-col gap-4 overflow-hidden min-h-0 ${
            currentMode === 'chat' ? 'col-span-7'
              : currentMode === 'monitor' ? 'col-span-5'
              : 'col-span-4'
          }`}>
            {currentMode === 'chat' && <ChatInterface />}
            {currentMode === 'monitor' && (
              <>
                <StatsPanel />
                {sensors && <SensorPanel sensors={sensors} />}
                <div className="flex-1 min-h-0">
                  <ChatInterface compact />
                </div>
              </>
            )}
            {currentMode === 'scan' && (
              <>
                {sensors && <SensorPanel sensors={sensors} />}
                <StatsPanel />
                <div className="flex-1 min-h-0 overflow-hidden">
                  <GimbalControl />
                </div>
              </>
            )}
          </div>
        </div>
      </main>

      {/* Bottom Panel — Agent Reasoning */}
      <div className="border-t border-zinc-800 px-4 py-2 h-44 shrink-0">
        <AgentReasoningLog />
      </div>
    </div>
  );
}
