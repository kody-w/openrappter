import { useCallback, useEffect, useRef, useState } from "react";

export interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}
export interface SpeechResultEvent {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechResult };
}
export interface SpeechRecognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type SpeechConstructor = new () => SpeechRecognizer;
declare global {
  interface Window {
    SpeechRecognition?: SpeechConstructor;
    webkitSpeechRecognition?: SpeechConstructor;
  }
}
export type DictationState = "unavailable" | "idle" | "requesting" | "listening" | "stopping" | "transcript" | "error";

const speechError = (code: string) => ({
  "not-allowed": "Microphone permission was denied. You can keep typing instead.",
  "service-not-allowed": "Speech recognition is not available in this browser. You can keep typing instead.",
  "audio-capture": "No microphone is available. Check your input device or keep typing.",
  "network": "The browser speech service could not connect. You can keep typing instead.",
  "no-speech": "No speech was recognized. Try again or keep typing.",
  "language-not-supported": "Speech recognition does not support this language. You can keep typing instead.",
}[code] ?? "Dictation could not finish. You can keep typing instead.");

export function useDictation({ enabled, onTranscript }: { enabled: boolean; onTranscript: (text: string) => void }) {
  const Constructor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const [state, setState] = useState<DictationState>(Constructor ? "idle" : "unavailable");
  const [detail, setDetail] = useState(Constructor ? "" : "Voice dictation is unavailable here. Type your message instead.");
  const [interim, setInterim] = useState("");
  const recognizer = useRef<SpeechRecognizer | null>(null);
  const callback = useRef(onTranscript);
  callback.current = onTranscript;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = ["requesting", "listening", "stopping"].includes(state);

  const release = useCallback(() => {
    clearTimeout(timer.current);
    const current = recognizer.current;
    recognizer.current = null;
    if (current) {
      current.onstart = current.onresult = current.onerror = current.onend = null;
      try { current.abort(); } catch { /* Some engines throw after an already-ended session. */ }
    }
  }, []);
  const cancel = useCallback(() => {
    if (!recognizer.current) return;
    release(); setInterim(""); setState("idle");
    setDetail("Dictation stopped. Only recognized text was added; nothing was sent.");
  }, [release]);

  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") cancel(); };
    window.addEventListener("blur", cancel);
    window.addEventListener("pagehide", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pagehide", cancel);
      document.removeEventListener("visibilitychange", hidden);
      release();
    };
  }, [cancel, release]);
  useEffect(() => { if (!enabled) cancel(); }, [enabled, cancel]);

  const toggle = () => {
    if (recognizer.current) {
      const current = recognizer.current;
      setState("stopping"); setDetail("Finishing dictation…");
      try {
        timer.current = setTimeout(() => { if (recognizer.current === current) cancel(); }, 1200);
        current.stop();
      } catch { cancel(); }
      return;
    }
    if (!Constructor || !enabled || document.visibilityState === "hidden") return;
    let current: SpeechRecognizer;
    try { current = new Constructor(); }
    catch { setState("error"); setDetail(speechError("service-not-allowed")); return; }
    recognizer.current = current;
    current.lang = document.documentElement.lang || "en-US";
    current.continuous = false;
    current.interimResults = true;
    const delivered = new Set<number>();
    let transcript = "";
    let failed = false;
    current.onstart = () => {
      if (recognizer.current !== current) return;
      setState("listening"); setDetail("Listening… Speak now. Nothing is sent until you choose Send.");
    };
    current.onresult = (event) => {
      if (recognizer.current !== current || document.visibilityState === "hidden") return;
      let partial = "";
      for (let index = 0; index < event.results.length; index++) {
        const result = event.results[index];
        if (!result) continue;
        const text = result[0].transcript.trim();
        if (result.isFinal && !delivered.has(index)) {
          delivered.add(index);
          if (text) {
            transcript = `${transcript} ${text}`.trim();
            callback.current(text);
          }
        } else if (!result.isFinal) partial += ` ${text}`;
      }
      setInterim(partial.trim());
      if (transcript) setDetail(`Recognized: ${transcript}. Added to your message, not sent.`);
    };
    current.onerror = (event) => {
      if (recognizer.current !== current) return;
      failed = true; setInterim(""); setState("error"); setDetail(speechError(event.error));
      release();
    };
    current.onend = () => {
      if (recognizer.current !== current) return;
      clearTimeout(timer.current);
      recognizer.current = null;
      current.onstart = current.onresult = current.onerror = current.onend = null;
      setInterim("");
      if (!failed) {
        setState(transcript ? "transcript" : "idle");
        setDetail(transcript ? `Transcript added: ${transcript}. Untrusted, unsent input; review it before sending.` : "No transcript was received. Try again or keep typing.");
      }
    };
    setInterim(""); setState("requesting"); setDetail("Starting dictation… Allow microphone access if prompted.");
    try { current.start(); }
    catch { release(); setState("error"); setDetail(speechError("service-not-allowed")); }
  };
  return { state, detail, interim, active, available: Boolean(Constructor), toggle, cancel };
}
