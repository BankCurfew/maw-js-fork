import { useState, useRef, useCallback, useEffect, memo } from "react";
import { apiUrl } from "../lib/api";

type Mode = "push" | "always";
type Phase = "idle" | "listening" | "processing" | "speaking";

interface VoiceMessage {
  role: "user" | "bob";
  text: string;
  ts: number;
}

const PHASE_CONFIG: Record<Phase, { gradient: string; glow: string; icon: string; label: string }> = {
  idle:       { gradient: "from-slate-600 to-slate-800",   glow: "rgba(100,116,139,0.15)", icon: "🎤", label: "Tap to talk" },
  listening:  { gradient: "from-cyan-400 to-blue-600",     glow: "rgba(34,211,238,0.4)",   icon: "🔴", label: "Listening..." },
  processing: { gradient: "from-purple-500 to-indigo-700", glow: "rgba(168,85,247,0.3)",   icon: "💭", label: "BoB is thinking..." },
  speaking:   { gradient: "from-emerald-400 to-teal-600",  glow: "rgba(52,211,153,0.4)",   icon: "🔊", label: "BoB is speaking..." },
};

let stylesInjected = false;
function injectVoiceStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    @keyframes voice-ripple { 0% { transform: scale(1); opacity: 0.4; } 100% { transform: scale(2.2); opacity: 0; } }
    @keyframes voice-glow { 0%,100% { box-shadow: 0 0 30px var(--glow); } 50% { box-shadow: 0 0 60px var(--glow), 0 0 90px var(--glow); } }
    .voice-ripple { animation: voice-ripple 1.5s ease-out infinite; }
    .voice-ripple-2 { animation: voice-ripple 1.5s ease-out 0.5s infinite; }
    .voice-glow { animation: voice-glow 2s ease-in-out infinite; }
  `;
  document.head.appendChild(s);
}

const SiriOrb = memo(function SiriOrb({ phase, onClick }: { phase: Phase; onClick: () => void }) {
  const cfg = PHASE_CONFIG[phase];
  const isActive = phase !== "idle";

  return (
    <button onClick={onClick} className="relative focus:outline-none active:scale-95 transition-transform" aria-label="Voice control">
      {/* Ripple rings */}
      {phase === "listening" && (
        <>
          <div className={`absolute inset-0 w-[120px] h-[120px] rounded-full bg-gradient-to-br ${cfg.gradient} opacity-30 voice-ripple`} />
          <div className={`absolute inset-0 w-[120px] h-[120px] rounded-full bg-gradient-to-br ${cfg.gradient} opacity-20 voice-ripple-2`} />
        </>
      )}

      {/* Main orb */}
      <div
        className={`relative w-[120px] h-[120px] rounded-full bg-gradient-to-br ${cfg.gradient} flex items-center justify-center transition-all duration-300 ${isActive ? "voice-glow" : ""}`}
        style={{ "--glow": cfg.glow } as any}
      >
        <div className="absolute top-4 left-7 w-8 h-4 rounded-full bg-white/15 blur-sm" />
        <span className="text-4xl relative z-10">{cfg.icon}</span>
      </div>
    </button>
  );
});

export function VoiceView() {
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<Mode>("push");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [bobActive, setBobActive] = useState(false);
  const [inputText, setInputText] = useState("");
  const [voiceName, setVoiceName] = useState("Roger");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(injectVoiceStyles, []);

  // Poll BoB status
  useEffect(() => {
    const check = () => fetch(apiUrl("/api/voice/status")).then(r => r.json()).then(d => setBobActive(d.bobActive || false)).catch(() => {});
    check();
    const iv = setInterval(check, 10000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // WebSocket for real-time voice streaming
  const connectVoiceWS = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return wsRef.current;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/voice`);
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "text") {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === "bob" && last.ts === data.streamId) {
              return [...prev.slice(0, -1), { ...last, text: last.text + data.chunk }];
            }
            return [...prev, { role: "bob", text: data.chunk, ts: data.streamId || Date.now() }];
          });
        } else if (data.type === "audio") {
          // Base64 audio chunk — play it
          setPhase("speaking");
        } else if (data.type === "done") {
          if (phase === "processing") setPhase("idle");
        }
      } catch {}
    };
    ws.onclose = () => { wsRef.current = null; };
    wsRef.current = ws;
    return ws;
  }, [phase]);

  const stopAudio = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    window.speechSynthesis?.cancel();
  }, []);

  const playTTS = useCallback(async (text: string) => {
    setPhase("speaking");
    try {
      const res = await fetch(apiUrl("/api/voice/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 1000) }),
      });
      if (res.ok && res.headers.get("content-type")?.includes("audio")) {
        const blob = await res.blob();
        const audio = new Audio(URL.createObjectURL(blob));
        audioRef.current = audio;
        audio.onended = () => {
          setPhase("idle");
          audioRef.current = null;
          if (mode === "always") startListening();
        };
        await audio.play();
        return;
      }
    } catch {}
    // Browser TTS fallback
    if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(text.slice(0, 500));
      u.lang = /[ก-๙]/.test(text) ? "th-TH" : "en-US";
      u.rate = 0.9;
      u.onend = () => {
        setPhase("idle");
        if (mode === "always") startListening();
      };
      window.speechSynthesis.speak(u);
    } else {
      setPhase("idle");
    }
  }, [mode]);

  const sendToBob = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setLiveTranscript("");
    setMessages(prev => [...prev, { role: "user", text, ts: Date.now() }]);
    setPhase("processing");

    try {
      const res = await fetch(apiUrl("/api/voice/stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text }),
      });

      if (res.ok && res.headers.get("content-type")?.includes("audio")) {
        const responseText = decodeURIComponent(res.headers.get("X-Voice-Text") || "");
        if (responseText) {
          setMessages(prev => [...prev, { role: "bob", text: responseText, ts: Date.now() }]);
        }
        setPhase("speaking");
        const blob = await res.blob();
        const audio = new Audio(URL.createObjectURL(blob));
        audioRef.current = audio;
        audio.onended = () => {
          setPhase("idle");
          audioRef.current = null;
          if (mode === "always") startListening();
        };
        await audio.play().catch(() => setPhase("idle"));
      } else {
        const data = await res.json().catch(() => ({}));
        const text2 = (data as any).text || (data as any).error || "No response";
        setMessages(prev => [...prev, { role: "bob", text: text2, ts: Date.now() }]);
        await playTTS(text2);
      }
    } catch (e: any) {
      setMessages(prev => [...prev, { role: "bob", text: `Error: ${e.message}`, ts: Date.now() }]);
      setPhase("idle");
    }
  }, [playTTS, mode]);

  const startListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert("Speech recognition not supported — use Chrome or Edge"); return; }

    stopAudio();

    const recognition = new SR();
    recognition.continuous = mode === "always";
    recognition.interimResults = true;
    recognition.lang = "th-TH";
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += t;
        else interim += t;
      }
      setLiveTranscript(interim);
      if (final) {
        setLiveTranscript("");
        sendToBob(final);
        if (mode === "push") recognition.stop();
      }
    };
    recognition.onerror = (e: any) => {
      if (e.error !== "aborted") setPhase("idle");
      setLiveTranscript("");
    };
    recognition.onend = () => {
      if (mode === "always" && recognitionRef.current) {
        try { recognition.start(); } catch { setPhase("idle"); }
      } else if (phase === "listening") {
        setPhase("idle");
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setPhase("listening");
  }, [mode, phase, sendToBob, stopAudio]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setPhase("idle");
    setLiveTranscript("");
  }, []);

  const handleOrbClick = useCallback(() => {
    if (phase === "listening") stopListening();
    else if (phase === "speaking") { stopAudio(); setPhase("idle"); }
    else if (phase === "idle") startListening();
  }, [phase, startListening, stopListening, stopAudio]);

  return (
    <div className="max-w-2xl mx-auto px-4 py-4 h-[calc(100vh-80px)] flex flex-col">
      {/* Mode + status bar */}
      <div className="flex items-center justify-center gap-2 mb-2 flex-shrink-0">
        {(["push", "always"] as Mode[]).map(m => (
          <button
            key={m}
            onClick={() => { setMode(m); if (m === "always" && phase === "idle") startListening(); else if (m === "push") stopListening(); }}
            className={`px-3 py-1 rounded-full text-[11px] font-mono transition-all ${mode === m ? (m === "push" ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30" : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30") : "text-white/30 border border-white/[0.04]"}`}
          >
            {m === "push" ? "Push to Talk" : "Always On"}
          </button>
        ))}
        <span className={`w-1.5 h-1.5 rounded-full ml-1 ${bobActive ? "bg-emerald-400" : "bg-red-400"}`} title={bobActive ? "BoB online" : "BoB offline"} />
      </div>

      {/* Siri Orb */}
      <div className="flex flex-col items-center py-4 flex-shrink-0">
        <SiriOrb phase={phase} onClick={handleOrbClick} />
        <p className="mt-4 text-sm text-white/30 font-mono">{PHASE_CONFIG[phase].label}</p>
        {liveTranscript && (
          <div className="mt-2 mx-8 px-4 py-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 max-w-xs">
            <p className="text-cyan-300/90 text-sm font-mono text-center">{liveTranscript}</p>
          </div>
        )}
      </div>

      {/* Conversation */}
      <div className="flex-1 overflow-y-auto space-y-2 mb-2 px-1 min-h-0" style={{ overscrollBehavior: "contain" }}>
        {messages.length === 0 && (
          <p className="text-center text-white/15 text-sm mt-8 font-mono">Tap the orb or type below</p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-[12px] leading-relaxed font-mono ${msg.role === "user" ? "bg-cyan-500/10 text-cyan-100/80 border border-cyan-500/15" : "bg-white/[0.03] text-white/60 border border-white/[0.05]"}`}>
              {msg.role === "bob" && <span className="text-[9px] text-purple-400/60 font-bold">BOB</span>}
              <pre className="whitespace-pre-wrap mt-0.5">{msg.text}</pre>
            </div>
          </div>
        ))}
        {phase === "processing" && (
          <div className="flex justify-start">
            <div className="bg-white/[0.03] rounded-2xl px-4 py-2 border border-white/[0.05]">
              <span className="text-purple-400/60 text-xs animate-pulse font-mono">thinking...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Text input */}
      <div className="flex-shrink-0 flex items-center gap-2 bg-white/[0.02] border border-white/[0.05] rounded-xl px-3 py-2">
        <input
          type="text"
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendToBob(inputText); setInputText(""); } }}
          placeholder="Type to BoB..."
          className="flex-1 bg-transparent text-white/70 outline-none text-sm font-mono"
          style={{ caretColor: "#22d3ee" }}
          disabled={phase === "processing"}
        />
        <button
          onClick={() => { sendToBob(inputText); setInputText(""); }}
          disabled={!inputText.trim() || phase === "processing"}
          className="px-3 py-1 rounded-lg bg-cyan-500 text-black text-xs font-bold disabled:opacity-20 active:scale-95"
        >
          Send
        </button>
      </div>
    </div>
  );
}
