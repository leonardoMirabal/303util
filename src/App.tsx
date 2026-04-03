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
  distortion: number;
  reverb: number;
};

type LineState = {
  steps: Step[];
  params: VoiceParams;
};

type LineFx = {
  send: GainNode;
  dry: GainNode;
  delaySend: GainNode;
  delayWet: GainNode;
  delay: DelayNode;
  feedback: GainNode;
  distSend: GainNode;
  distortion: WaveShaperNode;
  distWet: GainNode;
  reverbSend: GainNode;
  reverb: ConvolverNode;
  reverbWet: GainNode;
  lastDistortionAmount: number;
};

type ProjectData = {
  version: 1;
  programName: string;
  lineCount: 2 | 3;
  patternLength: number;
  tempo: number;
  selectedLine: number;
  lines: LineState[];
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
  distortion: 0.12,
  reverb: 0.16,
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

const defaultProjectLines = (): LineState[] => {
  const lines = Array.from({ length: MAX_LINES }, () => makeLine());
  lines[0] = {
    ...lines[0],
    steps: [
      { pitch: "C3", timeMode: "note", accent: true, slide: false, transpose: "down" },
      { pitch: null, timeMode: "rest", accent: false, slide: false, transpose: "none" },
      { pitch: "C3", timeMode: "note", accent: false, slide: false, transpose: "none" },
      { pitch: "C3", timeMode: "note", accent: false, slide: false, transpose: "down" },
      { pitch: null, timeMode: "rest", accent: false, slide: false, transpose: "none" },
      { pitch: "C3", timeMode: "note", accent: false, slide: false, transpose: "down" },
      { pitch: "D#3", timeMode: "note", accent: false, slide: true, transpose: "none" },
      { pitch: "C3", timeMode: "note", accent: false, slide: false, transpose: "none" },
      ...Array.from({ length: 8 }, (): Step => ({ pitch: null, timeMode: "rest", accent: false, slide: false, transpose: "none" })),
    ],
    params: { ...defaultParams(), resonance: 6.4, envMod: 59 },
  };
  return lines;
};

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

const makeDistortionCurve = (amount: number) => {
  const samples = 256;
  const curve = new Float32Array(samples);
  const k = 1 + amount * 80;
  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
};

const makeImpulseResponse = (ctx: AudioContext) => {
  const duration = 1.2;
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const decay = (1 - i / length) ** 2.2;
      data[i] = (Math.random() * 2 - 1) * decay;
    }
  }
  return impulse;
};

const isPitchName = (value: unknown): value is PitchName => typeof value === "string" && (PITCHES as readonly string[]).includes(value);

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
  const [patternLength, setPatternLength] = useState(8);
  const [tempo, setTempo] = useState(126);
  const [programName, setProgramName] = useState("Program");
  const [workspaceView, setWorkspaceView] = useState<"editor" | "sheet">("editor");
  const [lines, setLines] = useState<LineState[]>(() => defaultProjectLines());
  const [selectedLine, setSelectedLine] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(-1);
  const [exportPreviewUrl, setExportPreviewUrl] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
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
      const delaySend = ctx.createGain();
      const delayWet = ctx.createGain();
      const delay = ctx.createDelay(1.0);
      const feedback = ctx.createGain();
      const distSend = ctx.createGain();
      const distortion = ctx.createWaveShaper();
      const distWet = ctx.createGain();
      const reverbSend = ctx.createGain();
      const reverb = ctx.createConvolver();
      const reverbWet = ctx.createGain();

      send.connect(dry);
      dry.connect(master);
      send.connect(delaySend);
      delaySend.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(delayWet);
      delayWet.connect(master);

      send.connect(distSend);
      distSend.connect(distortion);
      distortion.connect(distWet);
      distWet.connect(master);

      send.connect(reverbSend);
      reverbSend.connect(reverb);
      reverb.connect(reverbWet);
      reverbWet.connect(master);

      distortion.oversample = "4x";
      reverb.buffer = makeImpulseResponse(ctx);

      lineFxRef.current[lineIndex] = {
        send,
        dry,
        delaySend,
        delayWet,
        delay,
        feedback,
        distSend,
        distortion,
        distWet,
        reverbSend,
        reverb,
        reverbWet,
        lastDistortionAmount: -1,
      };
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
    fx.dry.gain.setValueAtTime(1, now);
    fx.delaySend.gain.setValueAtTime(Math.min(1, Math.max(0, line.params.delayMix)), now);
    fx.delayWet.gain.setValueAtTime(Math.min(1, Math.max(0, line.params.delayMix)), now);
    const distortionAmount = Math.min(1, Math.max(0, line.params.distortion));
    fx.distSend.gain.setValueAtTime(distortionAmount, now);
    fx.distWet.gain.setValueAtTime(distortionAmount, now);
    if (Math.abs(fx.lastDistortionAmount - distortionAmount) > 0.002) {
      fx.distortion.curve = makeDistortionCurve(distortionAmount);
      fx.lastDistortionAmount = distortionAmount;
    }
    const reverbAmount = Math.min(1, Math.max(0, line.params.reverb));
    fx.reverbSend.gain.setValueAtTime(reverbAmount, now);
    fx.reverbWet.gain.setValueAtTime(reverbAmount, now);

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
    const baseProgramName = programName.trim() || "Program";
    const patternName = `${baseProgramName} - ${selectedLine + 1}`;
    ctx.fillStyle = "#f0f0f0";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111";
    ctx.font = "bold 24px Arial";
    ctx.fillText("TB-303 Pattern Chart", 16, 30);
    ctx.font = "13px Arial";
    ctx.fillText(`Pattern Name: ${patternName}`, 16, 52);
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
          if (step.timeMode === "rest") value = "";
          else if (step.timeMode === "tie") value = "~";
          else value = shortNote(step.pitch);
        }
        if (label === "DOWN") value = step.transpose === "down" ? "x" : "";
        if (label === "UP") value = step.transpose === "up" ? "x" : "";
        if (label === "ACC") value = step.accent ? "x" : "";
        if (label === "SLIDE") value = step.slide ? "x" : "";
        if (label === "TIME") value = step.timeMode === "note" ? "N" : step.timeMode === "tie" ? "T" : "";
        if (value) ctx.fillText(value, x + 8, y + 16);
      }
    });
  }, [lines, patternLength, selectedLine, tempo, programName]);

  const buildExportDataUrl = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 980;
    canvas.height = 420;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const baseProgramName = programName.trim() || "Program";
    const patternName = `${baseProgramName} - ${selectedLine + 1}`;

    ctx.fillStyle = "#f8f8f8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#111";
    ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);

    ctx.fillStyle = "#111";
    ctx.font = "bold 34px Arial";
    ctx.fillText("TB-303 Pattern Chart", 24, 46);
    ctx.font = "13px Arial";
    ctx.fillText(`Pattern Name: ${patternName}`, 24, 72);
    ctx.fillText(`BPM: ${tempo}   Pattern Number: ${selectedLine + 1}`, 24, 92);

    const active = lines[selectedLine].steps.slice(0, patternLength);
    const left = 24;
    const top = 110;
    const rowHeight = 30;
    const labelWidth = 110;
    const colWidth = Math.floor((canvas.width - left - labelWidth - 24) / patternLength);
    const rows = ["STEP", "NOTE", "DOWN", "UP", "ACC", "SLIDE", "TIME"];

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
          if (step.timeMode === "rest") value = "";
          else if (step.timeMode === "tie") value = "~";
          else value = shortNote(step.pitch);
        }
        if (row === "DOWN") value = step.transpose === "down" ? "x" : "";
        if (row === "UP") value = step.transpose === "up" ? "x" : "";
        if (row === "ACC") value = step.accent ? "x" : "";
        if (row === "SLIDE") value = step.slide ? "x" : "";
        if (row === "TIME") value = step.timeMode === "note" ? "N" : step.timeMode === "tie" ? "T" : "";
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
    const baseProgramName = programName.trim() || "program";
    const safeProgramName = baseProgramName
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const link = document.createElement("a");
    link.href = exportPreviewUrl;
    link.download = `tb303-${safeProgramName || "program"}-line-${selectedLine + 1}-${Date.now()}.png`;
    link.click();
  };

  const exportProjectJson = () => {
    const payload: ProjectData = {
      version: 1,
      programName,
      lineCount,
      patternLength,
      tempo,
      selectedLine,
      lines,
    };
    const baseProgramName = programName.trim() || "program";
    const safeProgramName = baseProgramName
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tb303-${safeProgramName || "program"}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const validateProjectData = (raw: unknown): ProjectData => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid JSON root object.");
    const data = raw as Record<string, unknown>;
    if (data.version !== 1) throw new Error("Unsupported JSON version.");
    if (typeof data.programName !== "string") throw new Error("programName must be a string.");
    if (data.lineCount !== 2 && data.lineCount !== 3) throw new Error("lineCount must be 2 or 3.");
    if (typeof data.patternLength !== "number" || !Number.isFinite(data.patternLength) || data.patternLength < 4 || data.patternLength > 16) {
      throw new Error("patternLength must be a number between 4 and 16.");
    }
    if (typeof data.tempo !== "number" || !Number.isFinite(data.tempo)) throw new Error("tempo must be a number.");
    if (typeof data.selectedLine !== "number" || !Number.isInteger(data.selectedLine)) throw new Error("selectedLine must be an integer.");
    if (data.selectedLine < 0 || data.selectedLine >= MAX_LINES) throw new Error("selectedLine is out of range.");
    if (!Array.isArray(data.lines) || data.lines.length !== MAX_LINES) throw new Error(`lines must contain exactly ${MAX_LINES} line entries.`);

    const normalizedLines = data.lines.map((line, lineIndex): LineState => {
      if (!line || typeof line !== "object") throw new Error(`Line ${lineIndex + 1} is invalid.`);
      const lineObj = line as Record<string, unknown>;
      if (!Array.isArray(lineObj.steps) || lineObj.steps.length !== STEPS) throw new Error(`Line ${lineIndex + 1} must have ${STEPS} steps.`);
      if (!lineObj.params || typeof lineObj.params !== "object") throw new Error(`Line ${lineIndex + 1} params are invalid.`);
      const paramsRaw = lineObj.params as Record<string, unknown>;
      if (paramsRaw.waveform !== "sawtooth" && paramsRaw.waveform !== "square") throw new Error(`Line ${lineIndex + 1} waveform is invalid.`);

      const params: VoiceParams = {
        waveform: paramsRaw.waveform,
        tune: Number(paramsRaw.tune),
        cutoff: Number(paramsRaw.cutoff),
        resonance: Number(paramsRaw.resonance),
        envMod: Number(paramsRaw.envMod),
        decay: Number(paramsRaw.decay),
        accent: Number(paramsRaw.accent),
        volume: Number(paramsRaw.volume),
        delayTime: Number(paramsRaw.delayTime),
        delayFeedback: Number(paramsRaw.delayFeedback),
        delayMix: Number(paramsRaw.delayMix),
        distortion: typeof paramsRaw.distortion === "number" ? Number(paramsRaw.distortion) : 0,
        reverb: typeof paramsRaw.reverb === "number" ? Number(paramsRaw.reverb) : 0,
      };
      if (Object.values(params).some((v) => (typeof v === "number" ? !Number.isFinite(v) : false))) {
        throw new Error(`Line ${lineIndex + 1} params contain invalid numbers.`);
      }

      const steps: Step[] = lineObj.steps.map((stepRaw, stepIndex) => {
        if (!stepRaw || typeof stepRaw !== "object") throw new Error(`Line ${lineIndex + 1}, step ${stepIndex + 1} is invalid.`);
        const step = stepRaw as Record<string, unknown>;
        if (step.timeMode !== "note" && step.timeMode !== "tie" && step.timeMode !== "rest") {
          throw new Error(`Line ${lineIndex + 1}, step ${stepIndex + 1} has invalid timeMode.`);
        }
        if (step.transpose !== "none" && step.transpose !== "down" && step.transpose !== "up") {
          throw new Error(`Line ${lineIndex + 1}, step ${stepIndex + 1} has invalid transpose.`);
        }
        if (typeof step.accent !== "boolean" || typeof step.slide !== "boolean") {
          throw new Error(`Line ${lineIndex + 1}, step ${stepIndex + 1} has invalid flags.`);
        }
        const pitch = step.pitch === null ? null : isPitchName(step.pitch) ? step.pitch : null;
        if (step.timeMode === "note" && !pitch) {
          throw new Error(`Line ${lineIndex + 1}, step ${stepIndex + 1} note step must have a valid pitch.`);
        }
        return {
          pitch,
          timeMode: step.timeMode,
          accent: step.accent,
          slide: step.slide,
          transpose: step.transpose,
        };
      });

      return { steps, params };
    });

    return {
      version: 1,
      programName: data.programName,
      lineCount: data.lineCount,
      patternLength: data.patternLength,
      tempo: data.tempo,
      selectedLine: data.selectedLine,
      lines: normalizedLines,
    };
  };

  const importProjectJson = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const parsed = validateProjectData(JSON.parse(text));
      setProgramName(parsed.programName);
      setLineCount(parsed.lineCount);
      setPatternLength(parsed.patternLength);
      setTempo(parsed.tempo);
      setSelectedLine(parsed.selectedLine);
      setLines(parsed.lines);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid project JSON.";
      window.alert(`Import failed: ${message}`);
    } finally {
      event.currentTarget.value = "";
    }
  };

  useEffect(() => {
    const url = buildExportDataUrl();
    if (url) setExportPreviewUrl(url);
  }, [lines, patternLength, selectedLine, tempo, programName]);

  const params = lines[selectedLine].params;

  return (
    <main className="app">
      <header className="panel header-panel">
        <div className="header-row">
          <h1>TB-303 Companion</h1>
          <div className="header-actions">
            <label className="header-small">
              Lines
              <select value={lineCount} onChange={(e) => setLineCount(Number(e.currentTarget.value) as 2 | 3)}>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
            <label className="header-small">
              Length
              <input
                type="number"
                min={4}
                max={16}
                value={patternLength}
                onChange={(e) => setPatternLength(Math.max(4, Math.min(16, Number(e.currentTarget.value))))}
              />
            </label>
            <label className="header-program">
              Program
              <input type="text" value={programName} onChange={(e) => setProgramName(e.currentTarget.value)} />
            </label>
            <button onClick={() => setIsPlaying((v) => !v)}>{isPlaying ? "Stop" : "Play"}</button>
            <button onClick={() => setPlayhead(-1)}>Reset</button>
            <button onClick={exportProjectJson}>Export JSON</button>
            <button onClick={() => importRef.current?.click()}>Import JSON</button>
            <input ref={importRef} className="import-json-input" type="file" accept=".json,application/json" onChange={importProjectJson} />
          </div>
        </div>
      </header>

      <div className="workspace">
        <section className="panel hardware-panel">
          <div className="knob-groups">
            <div className="wave-knob-slot">
              <select value={params.waveform} onChange={(e) => updateParams({ waveform: e.currentTarget.value as OscillatorType })}>
                <option value="sawtooth">Saw</option>
                <option value="square">Square</option>
              </select>
            </div>

            <div className="delay-divider" />

            <div className="knob-grid main-knobs">
              <KnobControl label="BPM" min={80} max={180} value={tempo} onChange={setTempo} />
              <KnobControl label="Tune" min={-12} max={12} step={1} value={params.tune} onChange={(v) => updateParams({ tune: v })} />
              <KnobControl label="Cutoff" min={180} max={2400} value={params.cutoff} onChange={(v) => updateParams({ cutoff: v })} />
              <KnobControl label="Resonance" min={0} max={22} step={0.2} value={params.resonance} onChange={(v) => updateParams({ resonance: v })} />
              <KnobControl label="Env Mod" min={0} max={2600} value={params.envMod} onChange={(v) => updateParams({ envMod: v })} />
              <KnobControl label="Decay" min={0.08} max={0.6} step={0.01} value={params.decay} onChange={(v) => updateParams({ decay: v })} format={(v) => v.toFixed(2)} />
              <KnobControl label="Accent" min={1} max={2.5} step={0.05} value={params.accent} onChange={(v) => updateParams({ accent: v })} format={(v) => v.toFixed(2)} />
            </div>

            <div className="delay-divider" />

            <div className="knob-grid fx-knobs">
              <KnobControl label="Delay Time" min={0.02} max={1} step={0.01} value={params.delayTime} onChange={(v) => updateParams({ delayTime: v })} format={(v) => `${v.toFixed(2)}s`} />
              <KnobControl label="Feedback" min={0} max={0.92} step={0.01} value={params.delayFeedback} onChange={(v) => updateParams({ delayFeedback: v })} format={(v) => `${Math.round(v * 100)}%`} />
              <KnobControl label="Delay Mix" min={0} max={1} step={0.01} value={params.delayMix} onChange={(v) => updateParams({ delayMix: v })} format={(v) => `${Math.round(v * 100)}%`} />
              <KnobControl label="Distortion" min={0} max={1} step={0.01} value={params.distortion} onChange={(v) => updateParams({ distortion: v })} format={(v) => `${Math.round(v * 100)}%`} />
              <KnobControl label="Reverb" min={0} max={1} step={0.01} value={params.reverb} onChange={(v) => updateParams({ reverb: v })} format={(v) => `${Math.round(v * 100)}%`} />
              <KnobControl label="Volume" min={0.05} max={0.8} step={0.01} value={params.volume} onChange={(v) => updateParams({ volume: v })} format={(v) => `${Math.round(v * 100)}%`} />
            </div>

            <div className="delay-divider" />

            <div className="aux-controls">
              {Array.from({ length: lineCount }, (_, i) => (
                <button key={i} className={selectedLine === i ? "selected" : ""} onClick={() => setSelectedLine(i)}>
                  LINE {i + 1}
                </button>
              ))}
              <div className="view-toggle" role="tablist" aria-label="Workspace view">
                <button
                  role="tab"
                  aria-selected={workspaceView === "editor"}
                  className={workspaceView === "editor" ? "selected" : ""}
                  onClick={() => setWorkspaceView("editor")}
                >
                  Editor
                </button>
                <button
                  role="tab"
                  aria-selected={workspaceView === "sheet"}
                  className={workspaceView === "sheet" ? "selected" : ""}
                  onClick={() => setWorkspaceView("sheet")}
                >
                  Sheet
                </button>
              </div>
            </div>
          </div>
        </section>

        <div className="editor-sheet-row">
          <section
            className={`panel roll-panel workspace-pane ${workspaceView === "editor" ? "active" : "inactive"}`}
            style={{ "--step-count": patternLength } as React.CSSProperties}
          >
            <h2>Pitch Editor</h2>
            <div className="roll-header">
              <div className="pitch-col">Pitch</div>
              {Array.from({ length: patternLength }, (_, s) => (
                <button key={s} className={`step-head ${playhead === s ? "playhead" : ""}`}>
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

          <section className={`panel preview-panel workspace-pane ${workspaceView === "sheet" ? "active" : "inactive"}`}>
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
      </div>
    </main>
  );
}

export default App;
