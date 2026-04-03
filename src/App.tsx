import { useEffect, useRef, useState } from "react";
import "./App.css";

const STEPS = 16;
const MAX_LINES = 3;
const PITCHES = ["B3", "A#3", "A3", "G#3", "G3", "F#3", "F3", "E3", "D#3", "D3", "C#3", "C3"] as const;

type PitchName = (typeof PITCHES)[number];
type TimeMode = "note" | "tie" | "rest";
type Transpose = "none" | "down" | "up";

type Step = {
  pitch: PitchName | null;
  timeMode: TimeMode;
  accent: boolean;
  slide: boolean;
  transpose: Transpose;
};

type VoiceParams = {
  waveform: OscillatorType;
  tune: number;
  cutoff: number;
  resonance: number;
  envMod: number;
  decay: number;
  accent: number;
  volume: number;
  delayTime: number;
  delayFeedback: number;
  delayMix: number;
};

type LineState = {
  steps: Step[];
  params: VoiceParams;
};

type LineFx = {
  send: GainNode;
  dry: GainNode;
  wet: GainNode;
  delay: DelayNode;
  feedback: GainNode;
};

const defaultParams = (): VoiceParams => ({
  waveform: "sawtooth",
  tune: 0,
  cutoff: 420,
  resonance: 11,
  envMod: 1200,
  decay: 0.22,
  accent: 1.45,
  volume: 0.26,
  delayTime: 0.24,
  delayFeedback: 0.32,
  delayMix: 0.26,
});

const makeLine = (): LineState => ({
  steps: Array.from({ length: STEPS }, () => ({
    pitch: null,
    timeMode: "rest",
    accent: false,
    slide: false,
    transpose: "none",
  })),
  params: defaultParams(),
});

const noteToFrequency = (note: PitchName): number => {
  const match = note.match(/^([A-G])(#|b)?(\d)$/);
  if (!match) return 220;
  const [, letter, accidental, octaveText] = match;
  const semitoneByLetter: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let semitone = semitoneByLetter[letter];
  if (accidental === "#") semitone += 1;
  if (accidental === "b") semitone -= 1;
  const octave = Number(octaveText);
  const midi = (octave + 1) * 12 + semitone;
  return 440 * 2 ** ((midi - 69) / 12);
};

const transposeNote = (freq: number, mode: Transpose) => {
  if (mode === "down") return freq / 2;
  if (mode === "up") return freq * 2;
  return freq;
};

const shortNote = (pitch: PitchName | null): string => (pitch ? pitch.replace("#", "+") : "-");

type KnobProps = {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
};

function KnobControl({ label, min, max, step = 1, value, onChange, format }: KnobProps) {
  const normalized = (value - min) / (max - min);
  const angle = -135 + normalized * 270;
  const style: React.CSSProperties & { "--angle": string } = { "--angle": `${angle}deg` };

  return (
    <label className="knob-control">
      <span className="knob-label">{label}</span>
      <div className="knob" style={style}>
        <input
          className="knob-hit"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.currentTarget.value))}
        />
      </div>
      <span className="knob-value">{format ? format(value) : value.toString()}</span>
    </label>
  );
}

const findBaseStep = (steps: Step[], step: number): number | null => {
  if (steps[step].timeMode === "note" && steps[step].pitch) return step;
  if (steps[step].timeMode !== "tie") return null;
  for (let s = step - 1; s >= 0; s -= 1) {
    if (steps[s].timeMode === "note" && steps[s].pitch) return s;
    if (steps[s].timeMode === "rest") return null;
  }
  return null;
};

function App() {
  const [lineCount, setLineCount] = useState<2 | 3>(2);
  const [patternLength, setPatternLength] = useState(16);
  const [tempo, setTempo] = useState(126);
  const [lines, setLines] = useState<LineState[]>(() => Array.from({ length: MAX_LINES }, () => makeLine()));
  const [selectedLine, setSelectedLine] = useState(0);
  const [selectedStep, setSelectedStep] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(-1);
  const [exportPreviewUrl, setExportPreviewUrl] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stepRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const lineFxRef = useRef<Array<LineFx | null>>(Array.from({ length: MAX_LINES }, () => null));
  const linesRef = useRef(lines);
  const lineCountRef = useRef(lineCount);
  const patternLengthRef = useRef(patternLength);

  const ensureAudio = (lineIndex?: number) => {
    const Ctx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioRef.current || !masterRef.current) {
      const ctx = new Ctx();
      const master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(ctx.destination);
      audioRef.current = ctx;
      masterRef.current = master;
    }
    if (typeof lineIndex === "number" && !lineFxRef.current[lineIndex]) {
      const ctx = audioRef.current;
      const master = masterRef.current;
      if (!ctx || !master) return null;
      const send = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const delay = ctx.createDelay(1.0);
      const feedback = ctx.createGain();

      send.connect(dry);
      dry.connect(master);
      send.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(master);

      lineFxRef.current[lineIndex] = { send, dry, wet, delay, feedback };
    }
    return { ctx: audioRef.current };
  };

  const placePitch = (lineIndex: number, stepIndex: number, pitch: PitchName) => {
    setLines((prev) =>
      prev.map((line, li) =>
        li === lineIndex
          ? {
              ...line,
              steps: line.steps.map((step, si) =>
                si === stepIndex
                  ? step.pitch === pitch && step.timeMode === "note"
                    ? { ...step, pitch: null, timeMode: "rest", accent: false, slide: false, transpose: "none" }
                    : { ...step, pitch, timeMode: "note" }
                  : step,
              ),
            }
          : line,
      ),
    );
    setSelectedLine(lineIndex);
    setSelectedStep(stepIndex);
  };

  const setStepMode = (lineIndex: number, stepIndex: number, mode: TimeMode) => {
    setLines((prev) =>
      prev.map((line, li) =>
        li === lineIndex
          ? {
              ...line,
              steps: line.steps.map((step, si) => {
                if (si !== stepIndex) return step;
                if (mode === "rest") return { ...step, timeMode: "rest", pitch: null, accent: false, slide: false, transpose: "none" };
                if (mode === "tie") return { ...step, timeMode: "tie", pitch: null, accent: false, slide: false };
                return { ...step, timeMode: "note" };
              }),
            }
          : line,
      ),
    );
    setSelectedLine(lineIndex);
    setSelectedStep(stepIndex);
  };

  const toggleFlag = (lineIndex: number, stepIndex: number, flag: "accent" | "slide") => {
    setLines((prev) =>
      prev.map((line, li) =>
        li === lineIndex
          ? {
              ...line,
              steps: line.steps.map((step, si) => {
                if (si !== stepIndex || step.timeMode !== "note" || !step.pitch) return step;
                return { ...step, [flag]: !step[flag] };
              }),
            }
          : line,
      ),
    );
  };

  const toggleTranspose = (lineIndex: number, stepIndex: number, mode: Transpose) => {
    setLines((prev) =>
      prev.map((line, li) =>
        li === lineIndex
          ? {
              ...line,
              steps: line.steps.map((step, si) => {
                if (si !== stepIndex || step.timeMode !== "note" || !step.pitch) return step;
                if (mode === "down") {
                  return { ...step, transpose: step.transpose === "down" ? "none" : "down" };
                }
                return { ...step, transpose: step.transpose === "up" ? "none" : "up" };
              }),
            }
          : line,
      ),
    );
  };

  const updateParams = (patch: Partial<VoiceParams>) => {
    setLines((prev) =>
      prev.map((line, li) => (li === selectedLine ? { ...line, params: { ...line.params, ...patch } } : line)),
    );
  };

  const playStep = (lineIndex: number, line: LineState, stepIndex: number, stepLenSeconds: number) => {
    const step = line.steps[stepIndex];
    if (step.timeMode !== "note" || !step.pitch) return;

    const graph = ensureAudio(lineIndex);
    if (!graph) return;
    const { ctx } = graph;
    const fx = lineFxRef.current[lineIndex];
    if (!fx) return;
    if (ctx.state === "suspended") void ctx.resume();

    let noteSteps = 1;
    for (let s = stepIndex + 1; s < patternLengthRef.current; s += 1) {
      if (line.steps[s].timeMode === "tie") noteSteps += 1;
      else break;
    }

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const amp = ctx.createGain();

    const freq = transposeNote(noteToFrequency(step.pitch), step.transpose);
    const accentBoost = step.accent ? line.params.accent : 1;
    const accentFilterBoost = step.accent ? 1.9 : 1;
    osc.type = line.params.waveform;
    osc.frequency.setValueAtTime(freq, now);

    if (step.slide) {
      const prevIdx = (stepIndex - 1 + patternLengthRef.current) % patternLengthRef.current;
      const prevBase = findBaseStep(line.steps, prevIdx);
      if (prevBase !== null) {
        const prevStep = line.steps[prevBase];
        if (prevStep.pitch) {
          const prevFreq = transposeNote(noteToFrequency(prevStep.pitch), prevStep.transpose);
          osc.frequency.setValueAtTime(prevFreq, now);
          osc.frequency.linearRampToValueAtTime(freq, now + Math.min(0.2, line.params.decay * 0.8 + 0.06));
        }
      }
    }

    filter.type = "lowpass";
    filter.Q.setValueAtTime(Math.min(30, line.params.resonance * accentFilterBoost), now);
    filter.frequency.setValueAtTime(line.params.cutoff, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(220, line.params.cutoff + line.params.envMod * accentFilterBoost), now + 0.02);
    filter.frequency.exponentialRampToValueAtTime(Math.max(140, line.params.cutoff * 0.58), now + line.params.decay * noteSteps);

    const gate = Math.max(0.12, noteSteps * stepLenSeconds * 0.92);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(line.params.volume * accentBoost, now + 0.005);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(gate, line.params.decay * noteSteps));

    osc.connect(filter);
    filter.connect(amp);
    amp.connect(fx.send);

    fx.delay.delayTime.setValueAtTime(Math.min(1, Math.max(0.02, line.params.delayTime)), now);
    fx.feedback.gain.setValueAtTime(Math.min(0.92, Math.max(0, line.params.delayFeedback)), now);
    fx.dry.gain.setValueAtTime(1 - line.params.delayMix, now);
    fx.wet.gain.setValueAtTime(line.params.delayMix, now);

    osc.start(now);
    osc.stop(now + gate + 0.08);
  };

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);
  useEffect(() => {
    lineCountRef.current = lineCount;
  }, [lineCount]);
  useEffect(() => {
    patternLengthRef.current = patternLength;
  }, [patternLength]);

  useEffect(() => {
    if (!isPlaying) return;
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const stepMs = (60 / tempo) * 250;
    const stepSec = stepMs / 1000;
    const tick = () => {
      const step = stepRef.current;
      const linesNow = linesRef.current;
      for (let li = 0; li < lineCountRef.current; li += 1) {
        playStep(li, linesNow[li], step, stepSec);
      }
      setPlayhead(step);
      stepRef.current = (step + 1) % patternLengthRef.current;
    };
    tick();
    timerRef.current = window.setInterval(tick, stepMs);
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isPlaying, tempo]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f0f0f0";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111";
    ctx.font = "bold 24px Arial";
    ctx.fillText("TB-303 Pattern Chart", 16, 30);
    ctx.font = "13px Arial";
    ctx.fillText(`Pattern Name: Line ${selectedLine + 1}`, 16, 52);
    ctx.fillText(`BPM: ${tempo}  Wave: ${lines[selectedLine].params.waveform.toUpperCase()}`, 16, 70);

    const cols = patternLength;
    const left = 16;
    const top = 84;
    const rowHeight = 24;
    const labelWidth = 100;
    const colWidth = Math.floor((canvas.width - left - labelWidth - 16) / cols);
    const labels = ["STEP", "NOTE", "DOWN", "UP", "ACC", "SLIDE", "TIME"];
    const active = lines[selectedLine].steps.slice(0, patternLength);

    labels.forEach((label, r) => {
      const y = top + r * rowHeight;
      ctx.strokeStyle = "#202020";
      ctx.strokeRect(left, y, labelWidth, rowHeight);
      ctx.fillStyle = "#111";
      ctx.fillText(label, left + 8, y + 16);
      for (let c = 0; c < cols; c += 1) {
        const x = left + labelWidth + c * colWidth;
        ctx.strokeRect(x, y, colWidth, rowHeight);
        const step = active[c];
        let value = "";
        if (label === "STEP") value = String(c + 1);
        if (label === "NOTE") {
          if (step.timeMode === "rest") value = "-";
          else if (step.timeMode === "tie") value = "~";
          else value = shortNote(step.pitch);
        }
        if (label === "DOWN") value = step.transpose === "down" ? "x" : "";
        if (label === "UP") value = step.transpose === "up" ? "x" : "";
        if (label === "ACC") value = step.accent ? "x" : "";
        if (label === "SLIDE") value = step.slide ? "x" : "";
        if (label === "TIME") value = step.timeMode === "note" ? "N" : step.timeMode === "tie" ? "T" : "R";
        if (value) ctx.fillText(value, x + 8, y + 16);
      }
    });
  }, [lines, patternLength, selectedLine, tempo]);

  const buildExportDataUrl = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 980;
    canvas.height = 420;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.fillStyle = "#f8f8f8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#111";
    ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);

    ctx.fillStyle = "#111";
    ctx.font = "bold 34px Arial";
    ctx.fillText("TB-303 Pattern Chart", 24, 46);
    ctx.font = "13px Arial";
    ctx.fillText(`Pattern Name: Line ${selectedLine + 1}`, 24, 72);
    ctx.fillText(`BPM: ${tempo}   Pattern Number: ${selectedLine + 1}`, 24, 92);

    const active = lines[selectedLine].steps.slice(0, patternLength);
    const left = 24;
    const top = 110;
    const rowHeight = 30;
    const labelWidth = 110;
    const colWidth = Math.floor((canvas.width - left - labelWidth - 24) / patternLength);
    const rows = ["STEP", "NOTE", "DOWN", "UP", "ACC", "SLIDE", "TIME", "EFX / Notes"];

    rows.forEach((row, r) => {
      const y = top + r * rowHeight;
      ctx.strokeRect(left, y, labelWidth, rowHeight);
      ctx.fillText(row, left + 8, y + 20);
      for (let i = 0; i < patternLength; i += 1) {
        const x = left + labelWidth + i * colWidth;
        ctx.strokeRect(x, y, colWidth, rowHeight);
        const step = active[i];
        let value = "";
        if (row === "STEP") value = String(i + 1);
        if (row === "NOTE") {
          if (step.timeMode === "rest") value = "-";
          else if (step.timeMode === "tie") value = "~";
          else value = shortNote(step.pitch);
        }
        if (row === "DOWN") value = step.transpose === "down" ? "x" : "";
        if (row === "UP") value = step.transpose === "up" ? "x" : "";
        if (row === "ACC") value = step.accent ? "x" : "";
        if (row === "SLIDE") value = step.slide ? "x" : "";
        if (row === "TIME") value = step.timeMode === "note" ? "N" : step.timeMode === "tie" ? "T" : "R";
        if (value) ctx.fillText(value, x + 8, y + 20);
      }
    });
    return canvas.toDataURL("image/png");
  };

  const generateExportPreview = () => {
    const url = buildExportDataUrl();
    if (url) setExportPreviewUrl(url);
  };
  const savePreviewPng = () => {
    if (!exportPreviewUrl) return;
    const link = document.createElement("a");
    link.href = exportPreviewUrl;
    link.download = `tb303-line-${selectedLine + 1}-${Date.now()}.png`;
    link.click();
  };

  useEffect(() => {
    const url = buildExportDataUrl();
    if (url) setExportPreviewUrl(url);
  }, [lines, patternLength, selectedLine, tempo]);

  const selected = lines[selectedLine].steps[selectedStep];
  const params = lines[selectedLine].params;

  return (
    <main className="app">
      <header className="panel header-panel">
        <h1>TB-303 Companion</h1>
        <p>Pitch editor + per-step lanes + TB-303 style sheet.</p>
      </header>

      <div className="workspace">
        <div className="left-column">
          <section className="panel hardware-panel">
            <div className="transport">
              <label>
                Lines
                <select value={lineCount} onChange={(e) => setLineCount(Number(e.currentTarget.value) as 2 | 3)}>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
              </label>
              <label>
                Length
                <input
                  type="number"
                  min={4}
                  max={16}
                  value={patternLength}
                  onChange={(e) => setPatternLength(Math.max(4, Math.min(16, Number(e.currentTarget.value))))}
                />
              </label>
              <button onClick={() => setIsPlaying((v) => !v)}>{isPlaying ? "Stop" : "Play"}</button>
              <button onClick={() => setPlayhead(-1)}>Reset</button>
            </div>

            <div className="line-tabs">
              {Array.from({ length: lineCount }, (_, i) => (
                <button key={i} className={selectedLine === i ? "selected" : ""} onClick={() => setSelectedLine(i)}>
                  LINE {i + 1}
                </button>
              ))}
            </div>

            <div className="wave-row">
              <label>
                Wave
                <select value={params.waveform} onChange={(e) => updateParams({ waveform: e.currentTarget.value as OscillatorType })}>
                  <option value="sawtooth">Saw</option>
                  <option value="square">Square</option>
                </select>
              </label>
            </div>

            <div className="knob-grid">
              <KnobControl label="BPM" min={80} max={180} value={tempo} onChange={setTempo} />
              <KnobControl label="Tune" min={-12} max={12} step={1} value={params.tune} onChange={(v) => updateParams({ tune: v })} />
              <KnobControl label="Cutoff" min={180} max={2400} value={params.cutoff} onChange={(v) => updateParams({ cutoff: v })} />
              <KnobControl label="Resonance" min={0} max={22} step={0.2} value={params.resonance} onChange={(v) => updateParams({ resonance: v })} />
              <KnobControl label="Env Mod" min={0} max={2600} value={params.envMod} onChange={(v) => updateParams({ envMod: v })} />
              <KnobControl label="Decay" min={0.08} max={0.6} step={0.01} value={params.decay} onChange={(v) => updateParams({ decay: v })} format={(v) => v.toFixed(2)} />
              <KnobControl label="Accent" min={1} max={2.5} step={0.05} value={params.accent} onChange={(v) => updateParams({ accent: v })} format={(v) => v.toFixed(2)} />
              <KnobControl label="Delay Time" min={0.02} max={1} step={0.01} value={params.delayTime} onChange={(v) => updateParams({ delayTime: v })} format={(v) => `${v.toFixed(2)}s`} />
              <KnobControl label="Feedback" min={0} max={0.92} step={0.01} value={params.delayFeedback} onChange={(v) => updateParams({ delayFeedback: v })} format={(v) => `${Math.round(v * 100)}%`} />
              <KnobControl label="Delay Mix" min={0} max={1} step={0.01} value={params.delayMix} onChange={(v) => updateParams({ delayMix: v })} format={(v) => `${Math.round(v * 100)}%`} />
            </div>
          </section>

          <section className="panel roll-panel">
            <h2>Pitch Editor</h2>
            <div className="roll-header">
              <div className="pitch-col">Pitch</div>
              {Array.from({ length: patternLength }, (_, s) => (
                <button key={s} className={`step-head ${playhead === s ? "playhead" : ""}`} onClick={() => setSelectedStep(s)}>
                  {s + 1}
                </button>
              ))}
            </div>

            <div className="roll-grid">
              {PITCHES.map((pitch) => (
                <div key={pitch} className="roll-row">
                  <div className="pitch-col">{pitch}</div>
                  {Array.from({ length: patternLength }, (_, s) => {
                    const step = lines[selectedLine].steps[s];
                    const isNote = step.timeMode === "note" && step.pitch === pitch;
                    return (
                      <button key={`${pitch}-${s}`} className={`cell ${isNote ? "note" : ""}`} onClick={() => placePitch(selectedLine, s, pitch)}>
                        {isNote ? "■" : ""}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="top-lanes">
              <div className="lane-row">
                <div className="lane-label">DOWN</div>
                {Array.from({ length: patternLength }, (_, s) => {
                  const step = lines[selectedLine].steps[s];
                  const enabled = step.timeMode === "note" && step.pitch && step.transpose === "down";
                  return (
                    <button key={`dn-${s}`} className={`lane-cell ${enabled ? "active" : ""}`} onClick={() => toggleTranspose(selectedLine, s, "down")} disabled={step.timeMode !== "note" || !step.pitch}>
                      {enabled ? "ON" : "--"}
                    </button>
                  );
                })}
              </div>
              <div className="lane-row">
                <div className="lane-label">UP</div>
                {Array.from({ length: patternLength }, (_, s) => {
                  const step = lines[selectedLine].steps[s];
                  const enabled = step.timeMode === "note" && step.pitch && step.transpose === "up";
                  return (
                    <button key={`up-${s}`} className={`lane-cell ${enabled ? "active" : ""}`} onClick={() => toggleTranspose(selectedLine, s, "up")} disabled={step.timeMode !== "note" || !step.pitch}>
                      {enabled ? "ON" : "--"}
                    </button>
                  );
                })}
              </div>
              <div className="lane-row">
                <div className="lane-label">ACC</div>
                {Array.from({ length: patternLength }, (_, s) => {
                  const step = lines[selectedLine].steps[s];
                  const enabled = step.timeMode === "note" && step.pitch && step.accent;
                  return (
                    <button key={`acc-${s}`} className={`lane-cell ${enabled ? "active" : ""}`} onClick={() => toggleFlag(selectedLine, s, "accent")} disabled={step.timeMode !== "note" || !step.pitch}>
                      {enabled ? "ON" : "--"}
                    </button>
                  );
                })}
              </div>
              <div className="lane-row">
                <div className="lane-label">SLIDE</div>
                {Array.from({ length: patternLength }, (_, s) => {
                  const step = lines[selectedLine].steps[s];
                  const enabled = step.timeMode === "note" && step.pitch && step.slide;
                  return (
                    <button key={`sl-${s}`} className={`lane-cell ${enabled ? "active" : ""}`} onClick={() => toggleFlag(selectedLine, s, "slide")} disabled={step.timeMode !== "note" || !step.pitch}>
                      {enabled ? "ON" : "--"}
                    </button>
                  );
                })}
              </div>
              <div className="lane-row">
                <div className="lane-label">TIME</div>
                {Array.from({ length: patternLength }, (_, s) => {
                  const step = lines[selectedLine].steps[s];
                  return (
                    <div key={`time-${s}`} className="lane-time">
                      <button className={step.timeMode === "note" ? "selected" : ""} onClick={() => setStepMode(selectedLine, s, "note")}>
                        N
                      </button>
                      <button className={step.timeMode === "tie" ? "selected" : ""} onClick={() => setStepMode(selectedLine, s, "tie")}>
                        T
                      </button>
                      <button className={step.timeMode === "rest" ? "selected" : ""} onClick={() => setStepMode(selectedLine, s, "rest")}>
                        R
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="panel step-panel">
            <h2>Step Detail</h2>
            <div className="step-controls">
              <span>Line {selectedLine + 1} / Step {selectedStep + 1}</span>
              <span>Time: {selected.timeMode.toUpperCase()}</span>
              <span>Pitch: {selected.timeMode === "note" ? selected.pitch ?? "-" : selected.timeMode === "tie" ? "~" : "REST"}</span>
              <span>Transpose: {selected.transpose.toUpperCase()}</span>
            </div>
          </section>
        </div>

        <section className="panel preview-panel">
          <h2>Visual Pattern Sheet (TB-303 style)</h2>
          <div className="preview-actions">
            <button onClick={generateExportPreview}>Refresh</button>
            <button onClick={savePreviewPng} disabled={!exportPreviewUrl}>
              Save PNG
            </button>
          </div>
          {exportPreviewUrl ? (
            <div className="sheet-preview-wrap">
              <img className="sheet-preview" src={exportPreviewUrl} alt="Pattern export preview" />
            </div>
          ) : (
            <p className="preview-help">Preparing preview...</p>
          )}
          <canvas className="export-canvas" ref={canvasRef} width={1040} height={300} />
        </section>
      </div>
    </main>
  );
}

export default App;
