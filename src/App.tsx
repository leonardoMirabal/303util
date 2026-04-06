import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { refreshToken as refreshNativeGoogleToken, signIn as signInWithNativeGoogle } from "@choochmeque/tauri-plugin-google-auth-api";
import "./App.css";

const STEPS = 16;
const MAX_LINES = 3;
const PITCHES = ["B3", "A#3", "A3", "G#3", "G3", "F#3", "F3", "E3", "D#3", "D3", "C#3", "C3"] as const;
const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const DELAY_SUBDIVISIONS = [
  { value: "1/4", label: "1/4", beats: 1 },
  { value: "1/4.", label: "1/4.", beats: 1.5 },
  { value: "1/8", label: "1/8", beats: 0.5 },
  { value: "1/8.", label: "1/8.", beats: 0.75 },
  { value: "1/8T", label: "1/8T", beats: 1 / 3 },
  { value: "1/16", label: "1/16", beats: 0.25 },
  { value: "1/16.", label: "1/16.", beats: 0.375 },
  { value: "1/16T", label: "1/16T", beats: 1 / 6 },
  { value: "1/32", label: "1/32", beats: 0.125 },
  { value: "1/32.", label: "1/32.", beats: 0.1875 },
] as const;

type PitchName = (typeof PITCHES)[number];
type PitchClass = (typeof PITCH_CLASSES)[number];
type TimeMode = "note" | "tie" | "rest";
type Transpose = "none" | "down" | "up";
type PatternTimingMode = "normal" | "triplet";
type DelaySubdivision = (typeof DELAY_SUBDIVISIONS)[number]["value"];

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
  delaySync: boolean;
  delaySubdivision: DelaySubdivision;
  delayFeedback: number;
  delayMix: number;
  distortion: number;
  reverb: number;
};

type LineState = {
  timingMode: PatternTimingMode;
  patternLength: number;
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
  lineCount: 1 | 2 | 3;
  scalePresetId?: string;
  scaleRoot?: PitchClass;
  tempo: number;
  selectedLine: number;
  lines: LineState[];
};

type LibraryRecord = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

type PatternRecord = {
  id: string;
  libraryId: string;
  name: string;
  project: ProjectData;
  createdAt: number;
  updatedAt: number;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type DriveBackupPayload = {
  version: 1;
  exportedAt: number;
  latestUpdatedAt: number;
  selectedLibraryId: string;
  selectedPatternId: string;
  libraries: LibraryRecord[];
  patterns: PatternRecord[];
};

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
};

type GoogleTokenClient = {
  requestAccessToken: (options?: { prompt?: "" | "consent" }) => void;
};

type GoogleTokenClientConfig = {
  client_id: string;
  scope: string;
  callback: (response: GoogleTokenResponse) => void;
};

type GoogleIdentityWindow = Window & {
  google?: {
    accounts?: {
      oauth2?: {
        initTokenClient: (config: GoogleTokenClientConfig) => GoogleTokenClient;
      };
    };
  };
};

const DB_NAME = "tb303-local-db";
const DB_VERSION = 1;
const LIBRARIES_STORE = "libraries";
const PATTERNS_STORE = "patterns";
const LAST_LIBRARY_ID_KEY = "tb303:last-library-id";
const LAST_PATTERN_ID_KEY = "tb303:last-pattern-id";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const DRIVE_BACKUP_FOLDER_NAME = "TB-303 Companion Backups";
const DRIVE_BACKUP_FILE_NAME = "tb303-backup.json";
const GOOGLE_SYNC_ENABLED_KEY = "tb303:google-sync-enabled";

let googleScriptPromise: Promise<void> | null = null;

const SCALE_PRESETS = [
  { id: "major-ionian", label: "Major (Ionian)", group: "Major scales", intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: "dorian", label: "Dorian", group: "Major scales", intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: "phrygian", label: "Phrygian", group: "Major scales", intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: "lydian", label: "Lydian", group: "Major scales", intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: "mixolydian", label: "Mixolydian", group: "Major scales", intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: "minor-aeolian", label: "Minor (Aeolian)", group: "Major scales", intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: "locrian", label: "Locrian", group: "Major scales", intervals: [0, 1, 3, 5, 6, 8, 10] },
  { id: "melodic-minor", label: "Melodic Minor", group: "Melodic minor scales", intervals: [0, 2, 3, 5, 7, 9, 11] },
  { id: "dorian-b2", label: "Dorian b2", group: "Melodic minor scales", intervals: [0, 1, 3, 5, 7, 9, 10] },
  { id: "lydian-augmented", label: "Lydian Augmented", group: "Melodic minor scales", intervals: [0, 2, 4, 6, 8, 9, 11] },
  { id: "lydian-dominant", label: "Lydian Dominant", group: "Melodic minor scales", intervals: [0, 2, 4, 6, 7, 9, 10] },
  { id: "mixolydian-b6", label: "Mixolydian b6 (Hindu)", group: "Melodic minor scales", intervals: [0, 2, 4, 5, 7, 8, 10] },
  { id: "aeolian-b5", label: "Aeolian b5 (Locrian nat2)", group: "Melodic minor scales", intervals: [0, 2, 3, 5, 6, 8, 10] },
  { id: "super-locrian", label: "Super Locrian", group: "Melodic minor scales", intervals: [0, 1, 3, 4, 6, 8, 10] },
  { id: "harmonic-minor", label: "Harmonic Minor", group: "Harmonic minor scales", intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: "locrian-nat6", label: "Locrian nat-6", group: "Harmonic minor scales", intervals: [0, 1, 3, 5, 6, 9, 10] },
  { id: "ionian-sharp5", label: "Ionian #5 (Aug)", group: "Harmonic minor scales", intervals: [0, 2, 4, 5, 8, 9, 11] },
  { id: "dorian-sharp4", label: "Dorian #4", group: "Harmonic minor scales", intervals: [0, 2, 3, 6, 7, 9, 10] },
  { id: "phrygian-dominant", label: "Phrygian Dom (SP Gypsy)", group: "Harmonic minor scales", intervals: [0, 1, 4, 5, 7, 8, 10] },
  { id: "lydian-sharp2", label: "Lydian #2", group: "Harmonic minor scales", intervals: [0, 3, 4, 6, 7, 9, 11] },
  { id: "altered", label: "Altered", group: "Harmonic minor scales", intervals: [0, 1, 3, 4, 6, 8, 10] },
  { id: "major-pentatonic", label: "Major Pentatonic", group: "Miscellaneous scales", intervals: [0, 2, 4, 7, 9] },
  { id: "minor-pentatonic", label: "Minor Pentatonic", group: "Miscellaneous scales", intervals: [0, 3, 5, 7, 10] },
  { id: "whole-tone", label: "Whole Tone", group: "Miscellaneous scales", intervals: [0, 2, 4, 6, 8, 10] },
  { id: "whole-half-diminished", label: "Whole Half Diminished", group: "Miscellaneous scales", intervals: [0, 2, 3, 5, 6, 8, 9, 11] },
  { id: "half-whole-diminished", label: "Half Whole Diminished", group: "Miscellaneous scales", intervals: [0, 1, 3, 4, 6, 7, 9, 10] },
  { id: "minor-blues", label: "Minor Blues", group: "Miscellaneous scales", intervals: [0, 3, 5, 6, 7, 10] },
  { id: "chromatic", label: "Chromatic", group: "Miscellaneous scales", intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: "bhairav-arabic", label: "Bhairav / Arabic", group: "World scales", intervals: [0, 1, 4, 5, 7, 8, 11] },
  { id: "hungarian-minor", label: "Hungarian Minor", group: "World scales", intervals: [0, 2, 3, 6, 7, 8, 11] },
  { id: "chinese", label: "Chinese", group: "World scales", intervals: [0, 4, 6, 7, 11] },
  { id: "hirajoshi", label: "Hirajoshi", group: "World scales", intervals: [0, 2, 3, 7, 8] },
  { id: "in-sen", label: "In-Sen", group: "World scales", intervals: [0, 1, 5, 7, 10] },
  { id: "kumoi", label: "Kumoi", group: "World scales", intervals: [0, 2, 3, 7, 9] },
  { id: "pelog", label: "Pelog", group: "World scales", intervals: [0, 1, 3, 7, 8] },
  { id: "major-triad", label: "Major", group: "Major chords", intervals: [0, 4, 7] },
  { id: "major-6", label: "Major 6th", group: "Major chords", intervals: [0, 4, 7, 9] },
  { id: "major-7", label: "Major 7th", group: "Major chords", intervals: [0, 4, 7, 11] },
  { id: "major-7-b5", label: "Major 7th (b5)", group: "Major chords", intervals: [0, 4, 6, 11] },
  { id: "major-7-sharp5", label: "Major 7th (#5)", group: "Major chords", intervals: [0, 4, 8, 11] },
  { id: "dominant-7", label: "Dominant 7th", group: "Major chords", intervals: [0, 4, 7, 10] },
  { id: "major-9", label: "Major 9th", group: "Major chords", intervals: [0, 2, 4, 7, 11] },
  { id: "minor-triad", label: "Minor", group: "Minor chords", intervals: [0, 3, 7] },
  { id: "minor-6", label: "Minor 6th", group: "Minor chords", intervals: [0, 3, 7, 9] },
  { id: "minor-7", label: "Minor 7th", group: "Minor chords", intervals: [0, 3, 7, 10] },
  { id: "minor-7-b5", label: "Minor 7th (b5)", group: "Minor chords", intervals: [0, 3, 6, 10] },
  { id: "diminished-7", label: "Diminished 7th", group: "Minor chords", intervals: [0, 3, 6, 9] },
  { id: "minor-9", label: "Minor 9th", group: "Minor chords", intervals: [0, 2, 3, 7, 10] },
  { id: "minor-11", label: "Minor 11th", group: "Minor chords", intervals: [0, 2, 3, 5, 7, 10] },
] as const;

const SCALE_PRESET_ID_SET = new Set<string>(SCALE_PRESETS.map((preset) => preset.id));
const SCALE_PRESET_GROUPS = Array.from(
  SCALE_PRESETS.reduce<Map<string, (typeof SCALE_PRESETS)[number][]>>((groups, preset) => {
    const items = [...(groups.get(preset.group) ?? []), preset];
    groups.set(preset.group, items);
    return groups;
  }, new Map()),
);
const PITCH_CLASS_INDEX: Record<PitchClass, number> = Object.fromEntries(PITCH_CLASSES.map((pitchClass, index) => [pitchClass, index])) as Record<PitchClass, number>;

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
  delaySync: true,
  delaySubdivision: "1/8",
  delayFeedback: 0.32,
  delayMix: 0.26,
  distortion: 0.12,
  reverb: 0.16,
});

const makeLine = (): LineState => ({
  timingMode: "normal",
  patternLength: 8,
  steps: Array.from({ length: STEPS }, () => ({
    pitch: null,
    timeMode: "rest",
    accent: false,
    slide: false,
    transpose: "none",
  })),
  params: defaultParams(),
});

const DEFAULT_PROJECT_TEMPLATE: ProjectData = {
  version: 1,
  programName: "pattern 1",
  lineCount: 2,
  scalePresetId: "off",
  scaleRoot: "C",
  tempo: 126,
  selectedLine: 0,
  lines: [
    {
      timingMode: "normal",
      patternLength: 8,
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
      params: {
        waveform: "sawtooth",
        tune: 0,
        cutoff: 642,
        resonance: 1.6,
        envMod: 59,
        decay: 0.22,
        accent: 2.5,
        volume: 0.26,
        delayTime: 0.24,
        delaySync: true,
        delaySubdivision: "1/8.",
        delayFeedback: 0.41,
        delayMix: 0.51,
        distortion: 0,
        reverb: 0.28,
      },
    },
    {
      timingMode: "normal",
      patternLength: 8,
      steps: Array.from({ length: STEPS }, (): Step => ({ pitch: null, timeMode: "rest", accent: false, slide: false, transpose: "none" })),
      params: {
        waveform: "sawtooth",
        tune: 0,
        cutoff: 420,
        resonance: 5.6,
        envMod: 0,
        decay: 0.22,
        accent: 1.75,
        volume: 0.26,
        delayTime: 0.24,
        delaySync: true,
        delaySubdivision: "1/8.",
        delayFeedback: 0.44,
        delayMix: 0.51,
        distortion: 0.12,
        reverb: 0.16,
      },
    },
    {
      timingMode: "normal",
      patternLength: 8,
      steps: Array.from({ length: STEPS }, (): Step => ({ pitch: null, timeMode: "rest", accent: false, slide: false, transpose: "none" })),
      params: defaultParams(),
    },
  ],
};

const BLANK_PROJECT_TEMPLATE: ProjectData = (() => {
  const voice1 = makeLine();
  const voice2 = makeLine();
  const voice3 = makeLine();
  voice2.params.delaySubdivision = "1/8.";
  return {
    version: 1,
    programName: "pattern 1",
    lineCount: 2,
    scalePresetId: "off",
    scaleRoot: "C",
    tempo: 126,
    selectedLine: 0,
    lines: [voice1, voice2, voice3],
  };
})();

const cloneProjectData = (project: ProjectData): ProjectData => JSON.parse(JSON.stringify(project)) as ProjectData;

const resetProjectState = () => ({
  ...cloneProjectData(DEFAULT_PROJECT_TEMPLATE),
});

const blankProjectState = () => ({
  ...cloneProjectData(BLANK_PROJECT_TEMPLATE),
});

const DEFAULT_PROJECT_STATE = resetProjectState();

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
const isPitchClass = (value: unknown): value is PitchClass => typeof value === "string" && (PITCH_CLASSES as readonly string[]).includes(value);
const isScalePresetId = (value: unknown): value is string => typeof value === "string" && value !== "off" && SCALE_PRESET_ID_SET.has(value);

const shortNote = (pitch: PitchName | null): string => (pitch ? pitch : "-");
const toPitchClass = (pitch: PitchName): PitchClass => pitch.replace(/\d/g, "") as PitchClass;
const buildScalePitchClassSet = (root: PitchClass, presetId: string): Set<PitchClass> => {
  const preset = SCALE_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) return new Set();
  const rootIndex = PITCH_CLASS_INDEX[root];
  return new Set(preset.intervals.map((interval) => PITCH_CLASSES[(rootIndex + interval) % PITCH_CLASSES.length]));
};

type KnobProps = {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  disabled?: boolean;
};

function KnobControl({ label, min, max, step = 1, value, onChange, format, disabled = false }: KnobProps) {
  const normalized = (value - min) / (max - min);
  const angle = -135 + normalized * 270;
  const style: React.CSSProperties & { "--angle": string } = { "--angle": `${angle}deg` };
  const pointerRef = useRef<{ pointerId: number; startX: number; startY: number; startValue: number; dragging: boolean } | null>(null);
  const displayValue = format ? format(value) : value.toString();

  const clampValue = (next: number) => {
    const clamped = Math.max(min, Math.min(max, next));
    const snapped = min + Math.round((clamped - min) / step) * step;
    return Number(snapped.toFixed(6));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    pointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startValue: value,
      dragging: event.pointerType === "mouse",
    };
    if (event.pointerType === "mouse") {
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId || disabled) return;
    if (!pointer.dragging) {
      const deltaX = event.clientX - pointer.startX;
      const deltaY = pointer.startY - event.clientY;
      if (Math.abs(deltaY) < 8 || Math.abs(deltaY) <= Math.abs(deltaX)) {
        return;
      }
      pointer.dragging = true;
      pointer.startY = event.clientY;
      pointer.startValue = value;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const deltaY = pointer.startY - event.clientY;
    const nextValue = pointer.startValue + (deltaY / 160) * (max - min);
    event.preventDefault();
    onChange(clampValue(nextValue));
  };

  const clearPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current;
    if (pointer && event.currentTarget.hasPointerCapture(pointer.pointerId)) {
      event.currentTarget.releasePointerCapture(pointer.pointerId);
    }
    pointerRef.current = null;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      event.preventDefault();
      onChange(clampValue(value + step));
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      event.preventDefault();
      onChange(clampValue(value - step));
    }
  };

  return (
    <label className="knob-control">
      <span className="knob-label">{label}</span>
      <div
        className="knob"
        style={style}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={displayValue}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={clearPointer}
        onPointerCancel={clearPointer}
        onKeyDown={handleKeyDown}
      >
        <input
          className="knob-hit"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.currentTarget.value))}
        />
      </div>
      <span className="knob-value">{displayValue}</span>
    </label>
  );
}

const isDelaySubdivision = (value: unknown): value is DelaySubdivision =>
  typeof value === "string" && DELAY_SUBDIVISIONS.some((subdivision) => subdivision.value === value);

const delayTimeFromTempo = (tempo: number, subdivision: DelaySubdivision): number => {
  const beats = DELAY_SUBDIVISIONS.find((entry) => entry.value === subdivision)?.beats ?? 0.5;
  return (60 / tempo) * beats;
};

const openLocalDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LIBRARIES_STORE)) {
        db.createObjectStore(LIBRARIES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PATTERNS_STORE)) {
        const store = db.createObjectStore(PATTERNS_STORE, { keyPath: "id" });
        store.createIndex("by_library", "libraryId", { unique: false });
        store.createIndex("by_updated", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open local database."));
  });

const runWrite = (db: IDBDatabase, storeNames: string[], operation: (tx: IDBTransaction) => void): Promise<void> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Database write transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("Database write transaction aborted."));
    operation(tx);
  });

const getAllFromStore = <T,>(db: IDBDatabase, storeName: string): Promise<T[]> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error(`Failed to read ${storeName}.`));
  });

const findBaseStep = (steps: Step[], step: number): number | null => {
  if (steps[step].timeMode === "note" && steps[step].pitch) return step;
  if (steps[step].timeMode !== "tie") return null;
  for (let s = step - 1; s >= 0; s -= 1) {
    if (steps[s].timeMode === "note" && steps[s].pitch) return s;
    if (steps[s].timeMode === "rest") return null;
  }
  return null;
};

const mapLegacyPatternLength = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 8;
  return Math.max(4, Math.min(16, raw));
};

const isTripletDisabledStep = (stepIndex: number): boolean => (stepIndex + 1) % 4 === 0;

const isStepDisabledForTimingMode = (stepIndex: number, mode: PatternTimingMode): boolean => mode === "triplet" && isTripletDisabledStep(stepIndex);

const playableStepIndicesForLength = (patternLength: number, mode: PatternTimingMode): number[] =>
  Array.from({ length: patternLength }, (_, stepIndex) => stepIndex).filter((stepIndex) => !isStepDisabledForTimingMode(stepIndex, mode));

const maxPatternLengthForMode = (_mode: PatternTimingMode): number => 16;

const clampPatternLength = (length: number, mode: PatternTimingMode): number => Math.max(4, Math.min(maxPatternLengthForMode(mode), length));

const stepSecondsForTimingMode = (tempo: number, mode: PatternTimingMode): number => (60 / tempo) / (mode === "triplet" ? 3 : 4);

const schedulerTickMs = (tempo: number): number => (60 / tempo) * (1000 / 12);

const schedulerTicksPerStep = (mode: PatternTimingMode): number => (mode === "triplet" ? 4 : 3);

const loadGoogleScript = (): Promise<void> => {
  if (googleScriptPromise) return googleScriptPromise;
  googleScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_SCRIPT_URL}"]`);
    if (existing) {
      if ((window as GoogleIdentityWindow).google?.accounts?.oauth2) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Google Identity script.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = GOOGLE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Identity script."));
    document.head.appendChild(script);
  });
  return googleScriptPromise;
};

const getLatestUpdatedAt = (libraries: LibraryRecord[], patterns: PatternRecord[]): number => {
  const latestLibrary = libraries.reduce((max, library) => Math.max(max, library.updatedAt), 0);
  const latestPattern = patterns.reduce((max, pattern) => Math.max(max, pattern.updatedAt), 0);
  return Math.max(latestLibrary, latestPattern);
};

function App() {
  const [lineCount, setLineCount] = useState<1 | 2 | 3>(DEFAULT_PROJECT_STATE.lineCount);
  const [tempo, setTempo] = useState(DEFAULT_PROJECT_STATE.tempo);
  const [programName, setProgramName] = useState(DEFAULT_PROJECT_STATE.programName);
  const [scalePresetId, setScalePresetId] = useState<string>(DEFAULT_PROJECT_STATE.scalePresetId ?? "off");
  const [scaleRoot, setScaleRoot] = useState<PitchClass>(DEFAULT_PROJECT_STATE.scaleRoot ?? "C");
  const [workspaceView, setWorkspaceView] = useState<"editor" | "sheet">("editor");
  const [lines, setLines] = useState<LineState[]>(() => DEFAULT_PROJECT_STATE.lines);
  const [selectedLine, setSelectedLine] = useState(DEFAULT_PROJECT_STATE.selectedLine);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(-1);
  const [exportPreviewUrl, setExportPreviewUrl] = useState<string | null>(null);
  const [libraries, setLibraries] = useState<LibraryRecord[]>([]);
  const [patterns, setPatterns] = useState<PatternRecord[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string>(() => window.localStorage.getItem(LAST_LIBRARY_ID_KEY) ?? "default");
  const [selectedPatternId, setSelectedPatternId] = useState<string>(() => window.localStorage.getItem(LAST_PATTERN_ID_KEY) ?? "");
  const [storageAction, setStorageAction] = useState("menu");
  const [isMobileViewport, setIsMobileViewport] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 980px)").matches,
  );
  const [mobileControlsOpen, setMobileControlsOpen] = useState(
    () => !(typeof window !== "undefined" && window.matchMedia("(max-width: 980px)").matches),
  );
  const [mobileProjectOpen, setMobileProjectOpen] = useState(
    () =>
      !(
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 980px)").matches &&
        window.matchMedia("(orientation: landscape)").matches
      ),
  );
  const [mobileModifiersOpen, setMobileModifiersOpen] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [googleSyncStatus, setGoogleSyncStatus] = useState<"idle" | "connecting" | "syncing" | "ready">("idle");
  const [googleSyncMessage, setGoogleSyncMessage] = useState("");
  const [isLibraryPickerOpen, setIsLibraryPickerOpen] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const voiceStepRef = useRef<number[]>(Array.from({ length: MAX_LINES }, () => 0));
  const voiceTickRef = useRef<number[]>(Array.from({ length: MAX_LINES }, () => 0));
  const timerRef = useRef<number | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const lineFxRef = useRef<Array<LineFx | null>>(Array.from({ length: MAX_LINES }, () => null));
  const linesRef = useRef(lines);
  const lineCountRef = useRef(lineCount);
  const restoredPatternRef = useRef(false);
  const googleSyncEnabledRef = useRef(false);
  const hasLoadedLocalDataRef = useRef(false);
  const isApplyingDriveBackupRef = useRef(false);
  const lastDriveBackupSignatureRef = useRef("");
  const driveBackupTimerRef = useRef<number | null>(null);

  const buildProjectSnapshot = (): ProjectData => ({
    version: 1,
    programName,
    lineCount,
    scalePresetId,
    scaleRoot,
    tempo,
    selectedLine,
    lines,
  });
  const googleClientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() ?? "";
  const googleDesktopClientId = (import.meta.env.VITE_GOOGLE_DESKTOP_CLIENT_ID as string | undefined)?.trim() ?? "";
  const isAndroidTauriApp = isTauri() && /\bAndroid\b/i.test(window.navigator.userAgent);

  const buildDriveSignature = (payload: DriveBackupPayload): string =>
    `${payload.latestUpdatedAt}|${payload.selectedLibraryId}|${payload.selectedPatternId}|${payload.libraries.length}|${payload.patterns.length}`;

  const requestGoogleAccessToken = async (prompt: "" | "consent"): Promise<string> => {
    if (isTauri()) {
      if (!googleDesktopClientId) {
        throw new Error("Google sync is not configured for the installed app. Missing VITE_GOOGLE_DESKTOP_CLIENT_ID.");
      }
      if (isAndroidTauriApp) {
        const tokenResponse =
          prompt === "consent"
            ? await signInWithNativeGoogle({
                clientId: googleDesktopClientId,
                scopes: [GOOGLE_SCOPE],
              })
            : await refreshNativeGoogleToken({
                clientId: googleDesktopClientId,
                scopes: [GOOGLE_SCOPE],
              });
        if (!tokenResponse.accessToken) {
          throw new Error("Google sign-in completed without an access token.");
        }
        return tokenResponse.accessToken;
      }
      return await invoke<string>("desktop_google_drive_access_token", {
        clientId: googleDesktopClientId,
        scope: GOOGLE_SCOPE,
      });
    }
    if (!googleClientId) {
      throw new Error("Google sync is not configured. Missing VITE_GOOGLE_CLIENT_ID.");
    }
    await loadGoogleScript();
    const googleIdentity = (window as GoogleIdentityWindow).google?.accounts?.oauth2;
    if (!googleIdentity) throw new Error("Google Identity API did not load.");
    return await new Promise<string>((resolve, reject) => {
      const tokenClient = googleIdentity.initTokenClient({
        client_id: googleClientId,
        scope: GOOGLE_SCOPE,
        callback: (response) => {
          if (response.error || !response.access_token) {
            reject(new Error(response.error || "Failed to get Google access token."));
            return;
          }
          resolve(response.access_token);
        },
      });
      tokenClient.requestAccessToken({ prompt });
    });
  };

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
    if (isStepDisabledForTimingMode(stepIndex, lines[lineIndex]?.timingMode ?? "normal")) return;
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
    if (isStepDisabledForTimingMode(stepIndex, lines[lineIndex]?.timingMode ?? "normal")) return;
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
    if (isStepDisabledForTimingMode(stepIndex, lines[lineIndex]?.timingMode ?? "normal")) return;
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
    if (isStepDisabledForTimingMode(stepIndex, lines[lineIndex]?.timingMode ?? "normal")) return;
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

  const updateVoicePatternLength = (value: number) => {
    const selectedTimingMode = lines[selectedLine]?.timingMode ?? "normal";
    const nextLength = clampPatternLength(value, selectedTimingMode);
    setLines((prev) => prev.map((voice, vi) => (vi === selectedLine ? { ...voice, patternLength: nextLength } : voice)));
  };

  const halveTempo = () => {
    setTempo((prev) => Math.max(1, Math.round(prev / 2)));
  };

  const applyPatternTimingMode = (mode: PatternTimingMode) => {
    if (mode === lines[selectedLine]?.timingMode) return;
    setLines((prev) =>
      prev.map((line, lineIndex) =>
        lineIndex === selectedLine
          ? {
              ...line,
              timingMode: mode,
              patternLength: clampPatternLength(line.patternLength, mode),
            }
          : line,
      ),
    );
    setPlayhead(-1);
    voiceStepRef.current = Array.from({ length: MAX_LINES }, () => 0);
    voiceTickRef.current = Array.from({ length: MAX_LINES }, () => 0);
  };

  const togglePatternTimingMode = () => {
    const nextMode = (lines[selectedLine]?.timingMode ?? "normal") === "normal" ? "triplet" : "normal";
    applyPatternTimingMode(nextMode);
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
    for (let s = stepIndex + 1; s < line.patternLength; s += 1) {
      if (isStepDisabledForTimingMode(s, line.timingMode)) break;
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
      let prevIdx = (stepIndex - 1 + line.patternLength) % line.patternLength;
      while (prevIdx !== stepIndex && isStepDisabledForTimingMode(prevIdx, line.timingMode)) {
        prevIdx = (prevIdx - 1 + line.patternLength) % line.patternLength;
      }
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

    const delayTime = line.params.delaySync ? delayTimeFromTempo(tempo, line.params.delaySubdivision) : line.params.delayTime;
    fx.delay.delayTime.setValueAtTime(Math.min(1, Math.max(0.02, delayTime)), now);
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
    setSelectedLine((prev) => Math.min(prev, lineCount - 1));
  }, [lineCount]);
  useEffect(() => {
    void (async () => {
      await ensureDefaultLibrary();
      await refreshLocalStorageData();
      hasLoadedLocalDataRef.current = true;
    })();
  }, []);
  useEffect(() => {
    if (libraries.length === 0) return;
    if (!libraries.some((library) => library.id === selectedLibraryId)) {
      setSelectedLibraryId(libraries[0].id);
    }
  }, [libraries, selectedLibraryId]);
  useEffect(() => {
    if (patterns.length === 0) return;
    const stillValid = patterns.some((pattern) => pattern.id === selectedPatternId && pattern.libraryId === selectedLibraryId);
    if (!stillValid) {
      const firstInLibrary = patterns.find((pattern) => pattern.libraryId === selectedLibraryId);
      setSelectedPatternId(firstInLibrary?.id ?? "");
    }
  }, [selectedLibraryId, patterns, selectedPatternId]);
  useEffect(() => {
    if (!selectedPatternId) return;
    const selectedPattern = patterns.find((pattern) => pattern.id === selectedPatternId && pattern.libraryId === selectedLibraryId);
    if (selectedPattern) loadPattern(selectedPattern);
  }, [selectedPatternId, selectedLibraryId, patterns]);
  useEffect(() => {
    window.localStorage.setItem(LAST_LIBRARY_ID_KEY, selectedLibraryId);
  }, [selectedLibraryId]);
  useEffect(() => {
    window.localStorage.setItem(LAST_PATTERN_ID_KEY, selectedPatternId);
  }, [selectedPatternId]);
  useEffect(() => {
    if (restoredPatternRef.current || patterns.length === 0) return;
    const lastLibraryId = window.localStorage.getItem(LAST_LIBRARY_ID_KEY);
    const lastPatternId = window.localStorage.getItem(LAST_PATTERN_ID_KEY);
    if (!lastPatternId) {
      restoredPatternRef.current = true;
      return;
    }
    const selectedPattern = patterns.find(
      (pattern) => pattern.id === lastPatternId && (!lastLibraryId || pattern.libraryId === lastLibraryId),
    );
    if (!selectedPattern) {
      restoredPatternRef.current = true;
      return;
    }
    setSelectedLibraryId(selectedPattern.libraryId);
    setSelectedPatternId(selectedPattern.id);
    loadPattern(selectedPattern);
    restoredPatternRef.current = true;
  }, [patterns]);
  useEffect(() => {
    const configuredClientId = isTauri() ? googleDesktopClientId : googleClientId;
    if (!configuredClientId) return;
    const wantsGoogleSync = window.localStorage.getItem(GOOGLE_SYNC_ENABLED_KEY) === "1";
    if (!wantsGoogleSync || googleSyncEnabledRef.current) return;
    void connectGoogleDrive(false);
  }, [googleClientId, googleDesktopClientId]);
  useEffect(() => {
    if (!googleAccessToken) return;
    if (!hasLoadedLocalDataRef.current) return;
    if (isApplyingDriveBackupRef.current) return;
    if (driveBackupTimerRef.current !== null) {
      window.clearTimeout(driveBackupTimerRef.current);
    }
    driveBackupTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          setGoogleSyncStatus("syncing");
          await pushBackupToDrive(googleAccessToken);
          setGoogleSyncStatus("ready");
        } catch (error) {
          setGoogleSyncStatus("idle");
          const message = error instanceof Error ? error.message : "Could not upload backup.";
          setGoogleSyncMessage(message);
        }
      })();
    }, 1200);
    return () => {
      if (driveBackupTimerRef.current !== null) {
        window.clearTimeout(driveBackupTimerRef.current);
        driveBackupTimerRef.current = null;
      }
    };
  }, [googleAccessToken, libraries, patterns, selectedLibraryId, selectedPatternId]);
  useEffect(() => {
    if (!isPlaying) return;
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    voiceStepRef.current = Array.from({ length: MAX_LINES }, () => 0);
    voiceTickRef.current = Array.from({ length: MAX_LINES }, () => 0);
    const stepMs = schedulerTickMs(tempo);
    const tick = () => {
      const linesNow = linesRef.current;
      for (let li = 0; li < lineCountRef.current; li += 1) {
        const line = linesNow[li];
        const ticksPerStep = schedulerTicksPerStep(line.timingMode);
        if (voiceTickRef.current[li] % ticksPerStep !== 0) {
          voiceTickRef.current[li] += 1;
          continue;
        }
        const voiceLength = clampPatternLength(line.patternLength, line.timingMode);
        const playableSteps = playableStepIndicesForLength(voiceLength, line.timingMode);
        if (playableSteps.length === 0) {
          voiceTickRef.current[li] += 1;
          continue;
        }
        const stepIndex = playableSteps[voiceStepRef.current[li] % playableSteps.length];
        playStep(li, line, stepIndex, stepSecondsForTimingMode(tempo, line.timingMode));
        if (li === selectedLine) {
          setPlayhead(stepIndex);
        }
        voiceStepRef.current[li] += 1;
        voiceTickRef.current[li] += 1;
      }
    };
    tick();
    timerRef.current = window.setInterval(tick, stepMs);
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isPlaying, tempo, selectedLine]);

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

    const cols = lines[selectedLine].patternLength;
    const left = 16;
    const top = 84;
    const rowHeight = 24;
    const labelWidth = 100;
    const colWidth = Math.floor((canvas.width - left - labelWidth - 16) / cols);
    const labels = ["STEP", "TIME", "NOTE", "DOWN", "UP", "ACC", "SLIDE"];
    const active = lines[selectedLine].steps.slice(0, lines[selectedLine].patternLength);

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
        if (label === "TIME") value = step.timeMode === "note" ? "𝅘𝅥𝅯" : step.timeMode === "tie" ? "⁀𝅘𝅥𝅯" : "";
        if (value) ctx.fillText(value, x + 8, y + 16);
      }
    });
  }, [lines, selectedLine, tempo, programName]);

  const buildExportDataUrl = () => {
    const exportVoices = Math.max(1, Math.min(3, lineCount));
    const voiceRows = ["STEP", "TIME", "NOTE", "DOWN", "UP", "ACC", "SLIDE"] as const;
    const voiceBlockHeight = 286;
    const canvas = document.createElement("canvas");
    canvas.width = 980;
    canvas.height = 120 + voiceBlockHeight * exportVoices;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const baseProgramName = programName.trim() || "Program";

    ctx.fillStyle = "#f8f8f8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#111";
    ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);

    ctx.fillStyle = "#111";
    ctx.font = "bold 34px Arial";
    ctx.fillText("TB-303 Pattern Charts", 24, 46);
    ctx.font = "13px Arial";
    ctx.fillText(`Program: ${baseProgramName}`, 24, 72);
    ctx.fillText(`BPM: ${tempo}   Voices exported: ${exportVoices}`, 24, 92);

    const left = 24;
    const rowHeight = 30;
    const labelWidth = 110;

    for (let voiceIndex = 0; voiceIndex < exportVoices; voiceIndex += 1) {
      const voice = lines[voiceIndex];
      const voiceTop = 120 + voiceIndex * voiceBlockHeight;
      const voiceLength = clampPatternLength(voice.patternLength, voice.timingMode);
      const active = voice.steps.slice(0, voiceLength);
      const colWidth = Math.floor((canvas.width - left - labelWidth - 24) / voiceLength);

      ctx.font = "bold 16px Arial";
      ctx.fillText(`VOICE ${voiceIndex + 1} (${voice.timingMode === "triplet" ? "Triplet" : "Normal"})`, left, voiceTop - 8);
      ctx.font = "13px Arial";

      voiceRows.forEach((row, r) => {
        const y = voiceTop + r * rowHeight;
        ctx.strokeRect(left, y, labelWidth, rowHeight);
        ctx.fillText(row, left + 8, y + 20);
        for (let i = 0; i < voiceLength; i += 1) {
          const x = left + labelWidth + i * colWidth;
          ctx.strokeRect(x, y, colWidth, rowHeight);
          if (isStepDisabledForTimingMode(i, voice.timingMode)) {
            ctx.save();
            ctx.fillStyle = "#d8dce1";
            ctx.fillRect(x + 1, y + 1, colWidth - 2, rowHeight - 2);
            ctx.restore();
            continue;
          }
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
          if (row === "TIME") value = step.timeMode === "note" ? "𝅘𝅥𝅯" : step.timeMode === "tie" ? "⁀𝅘𝅥𝅯" : "";
          if (value) ctx.fillText(value, x + 8, y + 20);
        }
      });
    }
    return canvas.toDataURL("image/png");
  };

  const generateExportPreview = () => {
    const url = buildExportDataUrl();
    if (url) setExportPreviewUrl(url);
  };
  const exportSheetPng = (urlOverride?: string) => {
    const url = urlOverride ?? buildExportDataUrl();
    if (!url) return;
    setExportPreviewUrl(url);
    const baseProgramName = programName.trim() || "program";
    const safeProgramName = baseProgramName
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const link = document.createElement("a");
    link.href = url;
    link.download = `tb303-${safeProgramName || "program"}-${lineCount}voice-sheet-${Date.now()}.png`;
    link.click();
  };
  const savePreviewPng = () => {
    if (!exportPreviewUrl) return;
    exportSheetPng(exportPreviewUrl);
  };

  const exportProjectJson = () => {
    const payload = buildProjectSnapshot();
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
    if (data.lineCount !== 1 && data.lineCount !== 2 && data.lineCount !== 3) throw new Error("voiceCount must be 1, 2, or 3.");
    const scalePresetId = data.scalePresetId === "off" || isScalePresetId(data.scalePresetId) ? data.scalePresetId : "off";
    const scaleRoot = isPitchClass(data.scaleRoot) ? data.scaleRoot : "C";
    if (typeof data.tempo !== "number" || !Number.isFinite(data.tempo)) throw new Error("tempo must be a number.");
    if (typeof data.selectedLine !== "number" || !Number.isInteger(data.selectedLine)) throw new Error("selectedLine must be an integer.");
    if (data.selectedLine < 0 || data.selectedLine >= MAX_LINES) throw new Error("selectedLine is out of range.");
    if (!Array.isArray(data.lines) || data.lines.length < 1 || data.lines.length > MAX_LINES) {
      throw new Error(`lines must contain between 1 and ${MAX_LINES} voice entries.`);
    }

    const sourceLines = [...data.lines];
    while (sourceLines.length < MAX_LINES) sourceLines.push(makeLine());

    const normalizedLines = sourceLines.map((line, lineIndex): LineState => {
      if (!line || typeof line !== "object") throw new Error(`Voice ${lineIndex + 1} is invalid.`);
      const lineObj = line as Record<string, unknown>;
      if (!Array.isArray(lineObj.steps) || lineObj.steps.length !== STEPS) throw new Error(`Voice ${lineIndex + 1} must have ${STEPS} steps.`);
      if (!lineObj.params || typeof lineObj.params !== "object") throw new Error(`Voice ${lineIndex + 1} params are invalid.`);
      const timingMode: PatternTimingMode =
        lineObj.timingMode === "triplet" || lineObj.timingMode === "normal" ? lineObj.timingMode : "normal";
      const patternLength = typeof lineObj.patternLength === "number" ? lineObj.patternLength : mapLegacyPatternLength(undefined);
      if (!Number.isFinite(patternLength) || patternLength < 4 || patternLength > maxPatternLengthForMode(timingMode)) {
        throw new Error(`Voice ${lineIndex + 1} patternLength must be between 4 and ${maxPatternLengthForMode(timingMode)}.`);
      }
      const paramsRaw = lineObj.params as Record<string, unknown>;
      if (paramsRaw.waveform !== "sawtooth" && paramsRaw.waveform !== "square") throw new Error(`Voice ${lineIndex + 1} waveform is invalid.`);

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
        delaySync: typeof paramsRaw.delaySync === "boolean" ? paramsRaw.delaySync : false,
        delaySubdivision: isDelaySubdivision(paramsRaw.delaySubdivision) ? paramsRaw.delaySubdivision : "1/8",
        delayFeedback: Number(paramsRaw.delayFeedback),
        delayMix: Number(paramsRaw.delayMix),
        distortion: typeof paramsRaw.distortion === "number" ? Number(paramsRaw.distortion) : 0,
        reverb: typeof paramsRaw.reverb === "number" ? Number(paramsRaw.reverb) : 0,
      };
      if (Object.values(params).some((v) => (typeof v === "number" ? !Number.isFinite(v) : false))) {
        throw new Error(`Voice ${lineIndex + 1} params contain invalid numbers.`);
      }

      const steps: Step[] = lineObj.steps.map((stepRaw, stepIndex) => {
        if (!stepRaw || typeof stepRaw !== "object") throw new Error(`Voice ${lineIndex + 1}, step ${stepIndex + 1} is invalid.`);
        const step = stepRaw as Record<string, unknown>;
        if (step.timeMode !== "note" && step.timeMode !== "tie" && step.timeMode !== "rest") {
          throw new Error(`Voice ${lineIndex + 1}, step ${stepIndex + 1} has invalid timeMode.`);
        }
        if (step.transpose !== "none" && step.transpose !== "down" && step.transpose !== "up") {
          throw new Error(`Voice ${lineIndex + 1}, step ${stepIndex + 1} has invalid transpose.`);
        }
        if (typeof step.accent !== "boolean" || typeof step.slide !== "boolean") {
          throw new Error(`Voice ${lineIndex + 1}, step ${stepIndex + 1} has invalid flags.`);
        }
        const pitch = step.pitch === null ? null : isPitchName(step.pitch) ? step.pitch : null;
        if (step.timeMode === "note" && !pitch) {
          throw new Error(`Voice ${lineIndex + 1}, step ${stepIndex + 1} note step must have a valid pitch.`);
        }
        return {
          pitch,
          timeMode: step.timeMode,
          accent: step.accent,
          slide: step.slide,
          transpose: step.transpose,
        };
      });

      return { timingMode, patternLength: clampPatternLength(patternLength, timingMode), steps, params };
    });

    return {
      version: 1,
      programName: data.programName,
      lineCount: data.lineCount,
      scalePresetId,
      scaleRoot,
      tempo: data.tempo,
      selectedLine: Math.min(data.selectedLine, data.lineCount - 1),
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
      setScalePresetId(parsed.scalePresetId ?? "off");
      setScaleRoot(parsed.scaleRoot ?? "C");
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

  const buildDriveBackupPayload = (): DriveBackupPayload => ({
    version: 1,
    exportedAt: Date.now(),
    latestUpdatedAt: getLatestUpdatedAt(libraries, patterns),
    selectedLibraryId,
    selectedPatternId,
    libraries,
    patterns,
  });

  const validateDriveBackupPayload = (raw: unknown): DriveBackupPayload => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid backup JSON.");
    const record = raw as Record<string, unknown>;
    if (record.version !== 1) throw new Error("Unsupported backup version.");
    if (!Array.isArray(record.libraries) || !Array.isArray(record.patterns)) throw new Error("Backup content is missing libraries or patterns.");

    const libraryList = (record.libraries as unknown[]).map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Invalid library entry.");
      const lib = entry as Record<string, unknown>;
      if (typeof lib.id !== "string" || typeof lib.name !== "string") throw new Error("Invalid library fields.");
      const createdAt = Number(lib.createdAt);
      const updatedAt = Number(lib.updatedAt);
      if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) throw new Error("Invalid library timestamps.");
      return { id: lib.id, name: lib.name, createdAt, updatedAt } satisfies LibraryRecord;
    });

    const patternList = (record.patterns as unknown[]).map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Invalid pattern entry.");
      const pattern = entry as Record<string, unknown>;
      if (typeof pattern.id !== "string" || typeof pattern.libraryId !== "string" || typeof pattern.name !== "string") {
        throw new Error("Invalid pattern identifiers.");
      }
      const createdAt = Number(pattern.createdAt);
      const updatedAt = Number(pattern.updatedAt);
      if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) throw new Error("Invalid pattern timestamps.");
      const project = validateProjectData(pattern.project);
      return { id: pattern.id, libraryId: pattern.libraryId, name: pattern.name, project, createdAt, updatedAt } satisfies PatternRecord;
    });

    if (!libraryList.some((library) => library.id === "default")) {
      const now = Date.now();
      libraryList.push({ id: "default", name: "Default Library", createdAt: now, updatedAt: now });
    }

    const selectedLibrary = typeof record.selectedLibraryId === "string" ? record.selectedLibraryId : "default";
    const selectedPattern = typeof record.selectedPatternId === "string" ? record.selectedPatternId : "";
    const latestUpdatedAt =
      typeof record.latestUpdatedAt === "number" && Number.isFinite(record.latestUpdatedAt)
        ? record.latestUpdatedAt
        : getLatestUpdatedAt(libraryList, patternList);
    const exportedAt = typeof record.exportedAt === "number" && Number.isFinite(record.exportedAt) ? record.exportedAt : Date.now();

    return {
      version: 1,
      exportedAt,
      latestUpdatedAt,
      selectedLibraryId: selectedLibrary,
      selectedPatternId: selectedPattern,
      libraries: libraryList,
      patterns: patternList,
    };
  };

  const fetchDrive = async (token: string, url: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google Drive request failed (${response.status}): ${text || response.statusText}`);
    }
    return response;
  };

  const ensureDriveBackupFolder = async (token: string): Promise<string> => {
    const query = encodeURIComponent(
      `name='${DRIVE_BACKUP_FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    );
    const listResponse = await fetchDrive(
      token,
      `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&fields=files(id,name)&pageSize=1`,
    );
    const listed = (await listResponse.json()) as { files?: Array<{ id: string }> };
    const existing = listed.files?.[0];
    if (existing?.id) return existing.id;

    const createResponse = await fetchDrive(token, "https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: DRIVE_BACKUP_FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
      }),
    });
    const created = (await createResponse.json()) as { id?: string };
    if (!created.id) throw new Error("Could not create Google Drive backup folder.");
    return created.id;
  };

  const findDriveBackupFile = async (token: string, folderId: string): Promise<string | null> => {
    const query = encodeURIComponent(
      `name='${DRIVE_BACKUP_FILE_NAME.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`,
    );
    const response = await fetchDrive(
      token,
      `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=1`,
    );
    const parsed = (await response.json()) as { files?: Array<{ id: string }> };
    return parsed.files?.[0]?.id ?? null;
  };

  const uploadDriveBackup = async (token: string, payload: DriveBackupPayload): Promise<void> => {
    const folderId = await ensureDriveBackupFolder(token);
    const fileId = await findDriveBackupFile(token, folderId);
    const metadata = fileId
      ? { name: DRIVE_BACKUP_FILE_NAME }
      : { name: DRIVE_BACKUP_FILE_NAME, parents: [folderId] };
    const multipartBoundary = `tb303-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const body = [
      `--${multipartBoundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${multipartBoundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(payload),
      `--${multipartBoundary}--`,
      "",
    ].join("\r\n");

    const endpoint = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
    await fetchDrive(token, endpoint, {
      method: fileId ? "PATCH" : "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${multipartBoundary}`,
      },
      body,
    });
  };

  const downloadDriveBackup = async (token: string): Promise<DriveBackupPayload | null> => {
    const folderId = await ensureDriveBackupFolder(token);
    const fileId = await findDriveBackupFile(token, folderId);
    if (!fileId) return null;
    const response = await fetchDrive(token, `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    const parsed = (await response.json()) as unknown;
    return validateDriveBackupPayload(parsed);
  };

  const applyDriveBackupToLocalDb = async (payload: DriveBackupPayload): Promise<void> => {
    const db = await openLocalDb();
    try {
      await runWrite(db, [LIBRARIES_STORE, PATTERNS_STORE], (tx) => {
        const libraryStore = tx.objectStore(LIBRARIES_STORE);
        const patternStore = tx.objectStore(PATTERNS_STORE);
        libraryStore.clear();
        patternStore.clear();
        payload.libraries.forEach((library) => libraryStore.put(library));
        payload.patterns.forEach((pattern) => patternStore.put(pattern));
      });
    } finally {
      db.close();
    }
    setSelectedLibraryId(payload.selectedLibraryId || "default");
    setSelectedPatternId(payload.selectedPatternId || "");
    await refreshLocalStorageData();
  };

  const syncFromDrive = async (token: string): Promise<void> => {
    const drivePayload = await downloadDriveBackup(token);
    if (!drivePayload) {
      setGoogleSyncMessage("Connected. No Drive backup found yet.");
      return;
    }
    const localLatest = getLatestUpdatedAt(libraries, patterns);
    if (localLatest > drivePayload.latestUpdatedAt) {
      setGoogleSyncMessage("Connected. Local data is newer than Drive backup.");
      return;
    }
    isApplyingDriveBackupRef.current = true;
    try {
      await applyDriveBackupToLocalDb(drivePayload);
      const signature = buildDriveSignature(drivePayload);
      lastDriveBackupSignatureRef.current = signature;
      setGoogleSyncMessage("Restored latest backup from Google Drive.");
    } finally {
      isApplyingDriveBackupRef.current = false;
    }
  };

  const pushBackupToDrive = async (token: string): Promise<void> => {
    const payload = buildDriveBackupPayload();
    const signature = buildDriveSignature(payload);
    if (signature === lastDriveBackupSignatureRef.current) return;
    await uploadDriveBackup(token, payload);
    lastDriveBackupSignatureRef.current = signature;
    setGoogleSyncMessage("Backup synced to Google Drive.");
  };

  const connectGoogleDrive = async (interactive = true) => {
    try {
      setGoogleSyncStatus("connecting");
      setGoogleSyncMessage("Connecting to Google...");
      const token = await requestGoogleAccessToken(interactive ? "consent" : "");
      setGoogleAccessToken(token);
      googleSyncEnabledRef.current = true;
      window.localStorage.setItem(GOOGLE_SYNC_ENABLED_KEY, "1");
      setGoogleSyncStatus("syncing");
      await syncFromDrive(token);
      setGoogleSyncStatus("ready");
    } catch (error) {
      googleSyncEnabledRef.current = false;
      setGoogleSyncStatus("idle");
      const message = error instanceof Error ? error.message : "Could not connect to Google Drive.";
      setGoogleSyncMessage(message);
      if (interactive) {
        window.alert(`Google Drive sync failed: ${message}`);
      }
    }
  };

  const runDriveBackupNow = async () => {
    if (!googleAccessToken) {
      await connectGoogleDrive(true);
      return;
    }
    try {
      setGoogleSyncStatus("syncing");
      await pushBackupToDrive(googleAccessToken);
      setGoogleSyncStatus("ready");
    } catch (error) {
      setGoogleSyncStatus("idle");
      const message = error instanceof Error ? error.message : "Could not upload backup.";
      setGoogleSyncMessage(message);
      window.alert(`Google Drive backup failed: ${message}`);
    }
  };

  const refreshLocalStorageData = async () => {
    const db = await openLocalDb();
    try {
      const [libraryRows, patternRows] = await Promise.all([
        getAllFromStore<LibraryRecord>(db, LIBRARIES_STORE),
        getAllFromStore<PatternRecord>(db, PATTERNS_STORE),
      ]);
      setLibraries(libraryRows.sort((a, b) => b.updatedAt - a.updatedAt));
      setPatterns(patternRows.sort((a, b) => b.updatedAt - a.updatedAt));
    } finally {
      db.close();
    }
  };

  const ensureDefaultLibrary = async () => {
    const db = await openLocalDb();
    try {
      await runWrite(db, [LIBRARIES_STORE], (tx) => {
        const store = tx.objectStore(LIBRARIES_STORE);
        const req = store.get("default");
        req.onsuccess = () => {
          if (req.result) return;
          const now = Date.now();
          store.put({ id: "default", name: "Default Library", createdAt: now, updatedAt: now } satisfies LibraryRecord);
        };
      });
    } finally {
      db.close();
    }
  };

  const createLibrary = async () => {
    const libraryName = window.prompt("Library name");
    if (!libraryName) return;
    const trimmed = libraryName.trim();
    if (!trimmed) return;
    const id = `lib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const db = await openLocalDb();
    try {
      await runWrite(db, [LIBRARIES_STORE], (tx) => {
        tx.objectStore(LIBRARIES_STORE).put({ id, name: trimmed, createdAt: now, updatedAt: now } satisfies LibraryRecord);
      });
    } finally {
      db.close();
    }
    setSelectedLibraryId(id);
    await refreshLocalStorageData();
  };

  const savePatternToLibrary = async (libraryId?: string) => {
    const patternName = window.prompt("Pattern name", programName.trim() || "Pattern");
    if (!patternName) return;
    const trimmed = patternName.trim();
    if (!trimmed) return;
    const now = Date.now();
    const id = `pat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const targetLibraryId = libraryId ?? selectedLibraryId;
    const db = await openLocalDb();
    try {
      await runWrite(db, [PATTERNS_STORE, LIBRARIES_STORE], (tx) => {
        tx.objectStore(PATTERNS_STORE).put({
          id,
          libraryId: targetLibraryId,
          name: trimmed,
          project: JSON.parse(JSON.stringify(buildProjectSnapshot())) as ProjectData,
          createdAt: now,
          updatedAt: now,
        } satisfies PatternRecord);
        const libReq = tx.objectStore(LIBRARIES_STORE).get(targetLibraryId);
        libReq.onsuccess = () => {
          const lib = libReq.result as LibraryRecord | undefined;
          if (lib) {
            tx.objectStore(LIBRARIES_STORE).put({ ...lib, updatedAt: now });
          }
        };
      });
    } finally {
      db.close();
    }
    await refreshLocalStorageData();
  };

  const saveSelectedPattern = async () => {
    const selectedPattern = patterns.find((pattern) => pattern.id === selectedPatternId && pattern.libraryId === selectedLibraryId);
    if (!selectedPattern) {
      await savePatternToLibrary(selectedLibraryId);
      return;
    }
    const now = Date.now();
    const db = await openLocalDb();
    try {
      await runWrite(db, [PATTERNS_STORE, LIBRARIES_STORE], (tx) => {
        tx.objectStore(PATTERNS_STORE).put({
          ...selectedPattern,
          project: JSON.parse(JSON.stringify(buildProjectSnapshot())) as ProjectData,
          updatedAt: now,
        } satisfies PatternRecord);
        const libReq = tx.objectStore(LIBRARIES_STORE).get(selectedLibraryId);
        libReq.onsuccess = () => {
          const lib = libReq.result as LibraryRecord | undefined;
          if (lib) {
            tx.objectStore(LIBRARIES_STORE).put({ ...lib, updatedAt: now });
          }
        };
      });
    } finally {
      db.close();
    }
    await refreshLocalStorageData();
  };

  const createEmptyPattern = async () => {
    const patternName = window.prompt("Pattern name", "New Pattern");
    if (!patternName) return;
    const trimmed = patternName.trim();
    if (!trimmed) return;
    const now = Date.now();
    const id = `pat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const targetLibraryId = selectedLibraryId;
    const emptyProject: ProjectData = { ...blankProjectState(), programName: trimmed };

    const db = await openLocalDb();
    try {
      await runWrite(db, [PATTERNS_STORE, LIBRARIES_STORE], (tx) => {
        tx.objectStore(PATTERNS_STORE).put({
          id,
          libraryId: targetLibraryId,
          name: trimmed,
          project: emptyProject,
          createdAt: now,
          updatedAt: now,
        } satisfies PatternRecord);
        const libReq = tx.objectStore(LIBRARIES_STORE).get(targetLibraryId);
        libReq.onsuccess = () => {
          const lib = libReq.result as LibraryRecord | undefined;
          if (lib) {
            tx.objectStore(LIBRARIES_STORE).put({ ...lib, updatedAt: now });
          }
        };
      });
    } finally {
      db.close();
    }
    await refreshLocalStorageData();
    setSelectedPatternId(id);
    loadPattern({
      id,
      libraryId: targetLibraryId,
      name: trimmed,
      project: emptyProject,
      createdAt: now,
      updatedAt: now,
    });
  };

  const openUnsavedEmptyPattern = () => {
    const emptyProject: ProjectData = { ...blankProjectState(), programName: "Untitled" };
    setSelectedPatternId("");
    loadPattern({
      id: "unsaved-empty",
      libraryId: selectedLibraryId,
      name: "Untitled",
      project: emptyProject,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };

  const loadPattern = (pattern: PatternRecord) => {
    try {
      const raw = typeof pattern.project === "string" ? JSON.parse(pattern.project) : pattern.project;
      const parsed = validateProjectData(raw);
      setIsPlaying(false);
      setPlayhead(-1);
      voiceStepRef.current = Array.from({ length: MAX_LINES }, () => 0);
      voiceTickRef.current = Array.from({ length: MAX_LINES }, () => 0);
      setWorkspaceView("editor");
      setProgramName(parsed.programName);
      setLineCount(parsed.lineCount);
      setScalePresetId(parsed.scalePresetId ?? "off");
      setScaleRoot(parsed.scaleRoot ?? "C");
      setTempo(parsed.tempo);
      setSelectedLine(parsed.selectedLine);
      setLines(parsed.lines);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid stored pattern.";
      window.alert(`Load failed: ${message}`);
    }
  };

  const deletePattern = async (patternId: string) => {
    const db = await openLocalDb();
    try {
      await runWrite(db, [PATTERNS_STORE], (tx) => {
        tx.objectStore(PATTERNS_STORE).delete(patternId);
      });
    } finally {
      db.close();
    }
    await refreshLocalStorageData();
  };

  const deleteLibrary = async () => {
    if (selectedLibraryId === "default") {
      window.alert("Default Library cannot be deleted.");
      return;
    }
    const currentLibrary = libraries.find((library) => library.id === selectedLibraryId);
    const ok = window.confirm(`Delete library "${currentLibrary?.name ?? selectedLibraryId}" and all its patterns?`);
    if (!ok) return;
    const db = await openLocalDb();
    try {
      const allPatterns = await getAllFromStore<PatternRecord>(db, PATTERNS_STORE);
      const idsToDelete = allPatterns.filter((pattern) => pattern.libraryId === selectedLibraryId).map((pattern) => pattern.id);
      await runWrite(db, [PATTERNS_STORE, LIBRARIES_STORE], (tx) => {
        const patternStore = tx.objectStore(PATTERNS_STORE);
        idsToDelete.forEach((id) => patternStore.delete(id));
        tx.objectStore(LIBRARIES_STORE).delete(selectedLibraryId);
      });
    } finally {
      db.close();
    }
    setSelectedLibraryId("default");
    await refreshLocalStorageData();
  };

  const runStorageAction = async (action: string) => {
    if (!action) return;
    if (action === "set-voices") {
      const value = window.prompt("Voices (1-3)", String(lineCount));
      if (value === null) return;
      const parsed = Number(value);
      if (parsed !== 1 && parsed !== 2 && parsed !== 3) {
        window.alert("Voices must be 1, 2, or 3.");
        return;
      }
      setLineCount(parsed);
      return;
    }
    if (action === "set-length") {
      const maxLength = maxPatternLengthForMode(selectedTimingMode);
      const value = window.prompt(`Length (4-${maxLength})`, String(patternLength));
      if (value === null) return;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        window.alert("Length must be a number.");
        return;
      }
      updateVoicePatternLength(parsed);
      return;
    }
    if (action === "set-library") {
      setIsLibraryPickerOpen(true);
      return;
    }
    if (action === "export-json") {
      exportProjectJson();
      return;
    }
    if (action === "export-png") {
      exportSheetPng();
      return;
    }
    if (action === "import-json") {
      importRef.current?.click();
      return;
    }
    if (action === "delete-library") {
      const currentLibrary = libraries.find((library) => library.id === selectedLibraryId);
      if (!currentLibrary || currentLibrary.id === "default") {
        window.alert("Default Library cannot be deleted.");
        return;
      }
      await deleteLibrary();
      return;
    }

    if (action === "new-library") {
      await createLibrary();
      return;
    }

    if (action === "save-pattern") {
      await saveSelectedPattern();
      return;
    }
    if (action === "new-pattern") {
      await createEmptyPattern();
      return;
    }
    if (action === "google-drive-connect") {
      await connectGoogleDrive(true);
      return;
    }
    if (action === "google-drive-backup-now") {
      await runDriveBackupNow();
      return;
    }

    const visiblePatterns = patterns.filter((pattern) => pattern.libraryId === selectedLibraryId);
    const selectedPattern = visiblePatterns.find((pattern) => pattern.id === selectedPatternId);
    if (!selectedPattern) {
      window.alert("Pick a saved pattern first.");
      return;
    }

    if (action === "load-pattern") {
      loadPattern(selectedPattern);
      return;
    }

    if (action === "delete-pattern") {
      const ok = window.confirm(`Delete pattern "${selectedPattern.name}"?`);
      if (!ok) return;
      await deletePattern(selectedPattern.id);
      openUnsavedEmptyPattern();
      return;
    }
  };

  const resetPattern = () => {
    const resetProject = { ...blankProjectState(), programName };
    setIsPlaying(false);
    setPlayhead(-1);
    voiceStepRef.current = Array.from({ length: MAX_LINES }, () => 0);
    voiceTickRef.current = Array.from({ length: MAX_LINES }, () => 0);
    setLineCount(resetProject.lineCount);
    setScalePresetId(resetProject.scalePresetId ?? "off");
    setScaleRoot(resetProject.scaleRoot ?? "C");
    setTempo(resetProject.tempo);
    setSelectedLine(resetProject.selectedLine);
    setLines(resetProject.lines);
  };

  useEffect(() => {
    const url = buildExportDataUrl();
    if (url) setExportPreviewUrl(url);
  }, [lines, selectedLine, tempo, programName]);

  useEffect(() => {
    const mobileQuery = window.matchMedia("(max-width: 980px)");
    const orientationQuery = window.matchMedia("(orientation: landscape)");
    const syncLandscapeState = () => {
      const nextIsMobile = mobileQuery.matches;
      const nextIsPhoneLandscape = nextIsMobile && orientationQuery.matches;
      setIsMobileViewport(nextIsMobile);
      setMobileProjectOpen(!nextIsPhoneLandscape);
      setMobileControlsOpen(true);
    };
    syncLandscapeState();
    mobileQuery.addEventListener("change", syncLandscapeState);
    orientationQuery.addEventListener("change", syncLandscapeState);
    return () => {
      mobileQuery.removeEventListener("change", syncLandscapeState);
      orientationQuery.removeEventListener("change", syncLandscapeState);
    };
  }, []);

  useEffect(() => {
    const fullDoc = document as FullscreenDocument;
    const syncFullscreenState = () => {
      setIsFullscreen(Boolean(document.fullscreenElement || fullDoc.webkitFullscreenElement));
    };
    syncFullscreenState();
    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("webkitfullscreenchange", syncFullscreenState as EventListener);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("webkitfullscreenchange", syncFullscreenState as EventListener);
    };
  }, []);

  const selectedTimingMode = lines[selectedLine].timingMode;
  const params = lines[selectedLine].params;
  const patternLength = clampPatternLength(lines[selectedLine].patternLength, selectedTimingMode);
  const visiblePatterns = patterns.filter((pattern) => pattern.libraryId === selectedLibraryId);
  const shouldShowRotateOverlay = false;
  const controlsToggleLabel = "Controls";
  const projectToggleLabel = "Project";
  const modifiersToggleLabel = "Mods";
  const patternTimingLabel = selectedTimingMode === "normal" ? "♪" : "♪₃";
  const patternTimingAriaLabel = selectedTimingMode === "normal" ? "Regular note timing" : "Triplet note timing";
  const scaleEnabled = scalePresetId !== "off";
  const scalePitchClasses = scaleEnabled ? buildScalePitchClassSet(scaleRoot, scalePresetId) : null;
  const getPitchHighlightClass = (pitch: PitchName) => {
    if (!scalePitchClasses) return "";
    const pitchClass = toPitchClass(pitch);
    if (pitchClass === scaleRoot) return "scale-root";
    if (scalePitchClasses.has(pitchClass)) return "scale-member";
    return "";
  };
  const synthLabels = isMobileViewport
    ? { resonance: "RES", envMod: "ENV", accent: "ACC", volume: "VOL", delayTime: "TIME", feedback: "FDBK", delayMix: "MIX", distortion: "DIST", reverb: "REV" }
    : { resonance: "Resonance", envMod: "Env Mod", accent: "Accent", volume: "Volume", delayTime: "Delay Time", feedback: "Feedback", delayMix: "Delay Mix", distortion: "Distortion", reverb: "Reverb" };
  const enterFullscreen = () => {
    const fullDoc = document as FullscreenDocument;
    const fullElement = document.documentElement as FullscreenElement;
    const currentFullscreenElement = document.fullscreenElement || fullDoc.webkitFullscreenElement;

    if (currentFullscreenElement) {
      return;
    }

    if (fullElement.requestFullscreen) {
      void fullElement.requestFullscreen();
      return;
    }
    if (fullElement.webkitRequestFullscreen) {
      void fullElement.webkitRequestFullscreen();
      return;
    }
    window.alert("Fullscreen is not supported in this browser.");
  };

  const exitFullscreen = () => {
    const fullDoc = document as FullscreenDocument;
    const currentFullscreenElement = document.fullscreenElement || fullDoc.webkitFullscreenElement;

    if (!currentFullscreenElement) {
      return;
    }

    if (document.exitFullscreen) {
      void document.exitFullscreen();
      return;
    }
    if (fullDoc.webkitExitFullscreen) {
      void fullDoc.webkitExitFullscreen();
      return;
    }
    window.alert("Fullscreen exit is not supported in this browser.");
  };

  const renderAuxControls = (extraClassName?: string) => (
    <div className={extraClassName ? `aux-controls ${extraClassName}` : "aux-controls"}>
      {Array.from({ length: lineCount }, (_, i) => (
        <button key={i} className={`voice-line-button ${selectedLine === i ? "selected" : ""}`} onClick={() => setSelectedLine(i)}>
          {isMobileViewport ? i + 1 : `VOICE ${i + 1}`}
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
  );

  const renderWaveformToggle = (extraClassName?: string) => (
    <div className={extraClassName ? `wave-toggle ${extraClassName}` : "wave-toggle"}>
      <button
        type="button"
        className="selected"
        aria-label={params.waveform === "sawtooth" ? "Switch to square waveform" : "Switch to saw waveform"}
        onClick={() => updateParams({ waveform: params.waveform === "sawtooth" ? "square" : "sawtooth" })}
      >
        {params.waveform === "sawtooth" ? "/|" : "_-_"}
      </button>
    </div>
  );

  return (
    <main className="app">
      {isLibraryPickerOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setIsLibraryPickerOpen(false)}>
          <div
            className="modal-card library-picker-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-picker-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="library-picker-title">Choose library</h2>
              <button type="button" onClick={() => setIsLibraryPickerOpen(false)}>
                Close
              </button>
            </div>
            <div className="library-picker-list">
              {libraries.map((library) => (
                <button
                  key={library.id}
                  type="button"
                  className={library.id === selectedLibraryId ? "selected" : ""}
                  onClick={() => {
                    setSelectedLibraryId(library.id);
                    setIsLibraryPickerOpen(false);
                  }}
                >
                  {library.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {shouldShowRotateOverlay ? (
        <div className="rotate-overlay">
          <p>Rotate your phone to landscape to use 303 util.</p>
        </div>
      ) : null}
      <header className="panel header-panel">
        <div className="header-row">
          <h1>{isMobileViewport ? "TB-303" : "TB-303 util"}</h1>
          <div className="header-primary-actions">
            <button className="play-button" onClick={() => setIsPlaying((v) => !v)}>
              {isPlaying ? "Stop" : "Play"}
            </button>
            <button onClick={resetPattern}>Init</button>
            <button onClick={() => void saveSelectedPattern()}>Save</button>
          </div>
          <div className={`header-actions ${isMobileViewport && !mobileProjectOpen ? "mobile-collapsed" : ""}`}>
            <div className="view-toggle header-timing-toggle" role="group" aria-label="Pattern timing">
              <button
                type="button"
                className={selectedTimingMode === "triplet" ? "selected" : ""}
                aria-label={patternTimingAriaLabel}
                title={patternTimingAriaLabel}
                onClick={togglePatternTimingMode}
              >
                {patternTimingLabel}
              </button>
            </div>
            <label className="header-program header-program-name">
              Program
              <input type="text" value={programName} onChange={(e) => setProgramName(e.currentTarget.value)} />
            </label>
            <input ref={importRef} className="import-json-input" type="file" accept=".json,application/json" onChange={importProjectJson} />
            <label className="header-program header-library-select">
              Library
              <select value={selectedLibraryId} onChange={(e) => setSelectedLibraryId(e.currentTarget.value)}>
                {libraries.map((library) => (
                  <option key={library.id} value={library.id}>
                    {library.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="header-program header-pattern-select">
              Pattern
              <select value={selectedPatternId} onChange={(e) => setSelectedPatternId(e.currentTarget.value)}>
                <option value="">Select...</option>
                {visiblePatterns.map((pattern) => (
                  <option key={pattern.id} value={pattern.id}>
                    {pattern.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="header-program header-scale-root">
              Root
              <select value={scaleRoot} onChange={(e) => setScaleRoot(e.currentTarget.value as PitchClass)} disabled={!scaleEnabled}>
                {PITCH_CLASSES.map((pitchClass) => (
                  <option key={pitchClass} value={pitchClass}>
                    {pitchClass}
                  </option>
                ))}
              </select>
            </label>
            <label className="header-program header-scale-select">
              Scale
              <select value={scalePresetId} onChange={(e) => setScalePresetId(e.currentTarget.value)}>
                <option value="off">Off</option>
                {SCALE_PRESET_GROUPS.map(([group, presets]) => (
                  <optgroup key={group} label={group}>
                    {presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <select
              className="header-storage-menu"
              value={storageAction}
              onChange={(e) => {
                const action = e.currentTarget.value;
                setStorageAction("menu");
                void runStorageAction(action);
              }}
            >
              <option value="menu">Menu...</option>
              <option value="set-voices">Voices</option>
              <option value="set-length">Length</option>
              <option value="set-library">Library</option>
              <option value="export-json">Export JSON</option>
              <option value="export-png">Export PNG</option>
              <option value="import-json">Import JSON</option>
              <option value="new-pattern">New Pattern</option>
              <option value="save-pattern">Save Pattern</option>
              <option value="delete-pattern">Delete Pattern</option>
              <option value="new-library">New Library</option>
              <option value="delete-library">Delete Library</option>
              <option value="google-drive-connect">Connect Google Drive</option>
              <option value="google-drive-backup-now">Backup to Google Drive now</option>
            </select>
            {googleSyncMessage ? <span className={`google-sync-status ${googleSyncStatus}`}>{googleSyncMessage}</span> : null}
          </div>
        </div>
      </header>

      <div className="workspace">
        <section className="panel hardware-panel">
          <div className="mobile-hardware-bar">
            <button type="button" className="mobile-fullscreen-toggle" onClick={enterFullscreen} disabled={isFullscreen}>
              Full
            </button>
            <button
              type="button"
              className={mobileProjectOpen ? "mobile-project-toggle selected" : "mobile-project-toggle"}
              onClick={() => setMobileProjectOpen((open) => !open)}
              aria-expanded={mobileProjectOpen}
            >
              {projectToggleLabel}
            </button>
            <button
              type="button"
              className={`mobile-controls-toggle ${mobileControlsOpen ? "selected" : ""}`}
              onClick={() => setMobileControlsOpen((open) => !open)}
              aria-expanded={mobileControlsOpen}
              aria-controls="mobile-hardware-controls"
            >
              {controlsToggleLabel}
            </button>
            {isFullscreen ? (
              <button type="button" className="mobile-fullscreen-toggle" onClick={exitFullscreen}>
                Exit Full
              </button>
            ) : null}
            <button
              type="button"
              className={mobileModifiersOpen ? "mobile-modifiers-toggle selected" : "mobile-modifiers-toggle"}
              onClick={() => setMobileModifiersOpen((open) => !open)}
              aria-expanded={mobileModifiersOpen}
              aria-controls="mobile-modifier-controls"
            >
              {modifiersToggleLabel}
            </button>
            {renderAuxControls("mobile-aux-controls")}
          </div>

          <div className="hardware-scroll">
            <div
              id="mobile-hardware-controls"
              className={`knob-groups ${isMobileViewport && !mobileControlsOpen ? "mobile-collapsed" : ""}`}
            >
              {isMobileViewport ? (
                <>
                  <div className="leading-controls">
                    <div className="tempo-controls">
                      <div className="bpm-knob-slot">
                        <KnobControl label="BPM" min={1} max={180} value={tempo} onChange={setTempo} />
                      </div>
                      <button type="button" className="tempo-action-button" onClick={halveTempo} aria-label="Halve BPM">
                        1/2
                      </button>
                    </div>
                    <div className="volume-knob-slot">
                      <KnobControl label={synthLabels.volume} min={0.05} max={0.8} step={0.01} value={params.volume} onChange={(v) => updateParams({ volume: v })} format={(v) => `${Math.round(v * 100)}%`} />
                    </div>
                  </div>

                  <div className="delay-divider" />

                  <div className="knob-grid main-knobs">
                    <div className="wave-knob-slot">{renderWaveformToggle()}</div>
                    <KnobControl label="Tune" min={-12} max={12} step={1} value={params.tune} onChange={(v) => updateParams({ tune: v })} />
                    <KnobControl label="Cutoff" min={180} max={2400} value={params.cutoff} onChange={(v) => updateParams({ cutoff: v })} />
                    <KnobControl label={synthLabels.resonance} min={0} max={22} step={0.2} value={params.resonance} onChange={(v) => updateParams({ resonance: v })} />
                    <KnobControl label={synthLabels.envMod} min={0} max={2600} value={params.envMod} onChange={(v) => updateParams({ envMod: v })} />
                    <KnobControl label="Decay" min={0.08} max={0.6} step={0.01} value={params.decay} onChange={(v) => updateParams({ decay: v })} format={(v) => v.toFixed(2)} />
                    <KnobControl label={synthLabels.accent} min={1} max={2.5} step={0.05} value={params.accent} onChange={(v) => updateParams({ accent: v })} format={(v) => v.toFixed(2)} />
                  </div>

                  <div className="delay-divider" />

                  <div className="knob-grid fx-knobs">
                    <label className="knob-control delay-sync-control">
                      <button
                        className={params.delaySync ? "selected" : ""}
                        aria-label={params.delaySync ? "Switch delay to free time" : "Switch delay to synced time"}
                        onClick={() => updateParams({ delaySync: !params.delaySync })}
                      >
                        {params.delaySync ? "S" : "F"}
                      </button>
                      <select
                        aria-label="Delay subdivision"
                        value={params.delaySubdivision}
                        disabled={!params.delaySync}
                        onChange={(e) => updateParams({ delaySubdivision: e.currentTarget.value as DelaySubdivision })}
                      >
                        {DELAY_SUBDIVISIONS.map((subdivision) => (
                          <option key={subdivision.value} value={subdivision.value}>
                            {subdivision.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <KnobControl
                      label={synthLabels.delayTime}
                      min={0.02}
                      max={1}
                      step={0.01}
                      value={params.delaySync ? delayTimeFromTempo(tempo, params.delaySubdivision) : params.delayTime}
                      disabled={params.delaySync}
                      onChange={(v) => updateParams({ delayTime: v })}
                      format={(v) => `${v.toFixed(2)}s`}
                    />
                    <KnobControl label={synthLabels.feedback} min={0} max={0.92} step={0.01} value={params.delayFeedback} onChange={(v) => updateParams({ delayFeedback: v })} format={(v) => `${Math.round(v * 100)}%`} />
                    <KnobControl label={synthLabels.delayMix} min={0} max={1} step={0.01} value={params.delayMix} onChange={(v) => updateParams({ delayMix: v })} format={(v) => `${Math.round(v * 100)}%`} />
                    <KnobControl label={synthLabels.distortion} min={0} max={1} step={0.01} value={params.distortion} onChange={(v) => updateParams({ distortion: v })} format={(v) => `${Math.round(v * 100)}%`} />
                    <KnobControl label={synthLabels.reverb} min={0} max={1} step={0.01} value={params.reverb} onChange={(v) => updateParams({ reverb: v })} format={(v) => `${Math.round(v * 100)}%`} />
                  </div>
                </>
              ) : (
                <>
                  <div className="leading-controls desktop-leading-controls">
                    <div className="tempo-controls">
                      <div className="bpm-knob-slot desktop-bpm-knob-slot">
                        <KnobControl label="BPM" min={1} max={180} value={tempo} onChange={setTempo} />
                      </div>
                      <button type="button" className="tempo-action-button" onClick={halveTempo} aria-label="Halve BPM">
                        1/2
                      </button>
                    </div>
                    <div className="volume-knob-slot desktop-volume-knob-slot">
                      <KnobControl label="Volume" min={0.05} max={0.8} step={0.01} value={params.volume} onChange={(v) => updateParams({ volume: v })} format={(v) => `${Math.round(v * 100)}%`} />
                    </div>
                  </div>

                  <div className="delay-divider" />

                  <div className="knob-grid main-knobs">
                    <div className="wave-knob-slot">
                      {renderWaveformToggle("desktop-wave-toggle")}
                    </div>
                    <KnobControl label="Tune" min={-12} max={12} step={1} value={params.tune} onChange={(v) => updateParams({ tune: v })} />
                    <KnobControl label="Cutoff" min={180} max={2400} value={params.cutoff} onChange={(v) => updateParams({ cutoff: v })} />
                    <KnobControl label="Resonance" min={0} max={22} step={0.2} value={params.resonance} onChange={(v) => updateParams({ resonance: v })} />
                    <KnobControl label="Env Mod" min={0} max={2600} value={params.envMod} onChange={(v) => updateParams({ envMod: v })} />
                    <KnobControl label="Decay" min={0.08} max={0.6} step={0.01} value={params.decay} onChange={(v) => updateParams({ decay: v })} format={(v) => v.toFixed(2)} />
                    <KnobControl label="Accent" min={1} max={2.5} step={0.05} value={params.accent} onChange={(v) => updateParams({ accent: v })} format={(v) => v.toFixed(2)} />
                  </div>

                  <div className="delay-divider" />

                  <div className="knob-grid fx-knobs">
                    <label className="knob-control delay-sync-control">
                      <button
                        className={params.delaySync ? "selected" : ""}
                        onClick={() => updateParams({ delaySync: !params.delaySync })}
                      >
                        {params.delaySync ? "SYNC" : "FREE"}
                      </button>
                      <select
                        value={params.delaySubdivision}
                        disabled={!params.delaySync}
                        onChange={(e) => updateParams({ delaySubdivision: e.currentTarget.value as DelaySubdivision })}
                      >
                        {DELAY_SUBDIVISIONS.map((subdivision) => (
                          <option key={subdivision.value} value={subdivision.value}>
                            {subdivision.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <KnobControl
                      label="Delay Time"
                      min={0.02}
                      max={1}
                      step={0.01}
                      value={params.delaySync ? delayTimeFromTempo(tempo, params.delaySubdivision) : params.delayTime}
                      disabled={params.delaySync}
                      onChange={(v) => updateParams({ delayTime: v })}
                      format={(v) => `${v.toFixed(2)}s`}
                    />
                    <KnobControl label="Feedback" min={0} max={0.92} step={0.01} value={params.delayFeedback} onChange={(v) => updateParams({ delayFeedback: v })} format={(v) => `${Math.round(v * 100)}%`} />
                    <KnobControl label="Delay Mix" min={0} max={1} step={0.01} value={params.delayMix} onChange={(v) => updateParams({ delayMix: v })} format={(v) => `${Math.round(v * 100)}%`} />
                    <KnobControl label="Distortion" min={0} max={1} step={0.01} value={params.distortion} onChange={(v) => updateParams({ distortion: v })} format={(v) => `${Math.round(v * 100)}%`} />
                    <KnobControl label="Reverb" min={0} max={1} step={0.01} value={params.reverb} onChange={(v) => updateParams({ reverb: v })} format={(v) => `${Math.round(v * 100)}%`} />
                  </div>
                </>
              )}

              <div className="delay-divider desktop-aux-divider" />
              {renderAuxControls("desktop-aux-controls")}
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
                <button key={s} className={`step-head ${playhead === s ? "playhead" : ""} ${isStepDisabledForTimingMode(s, selectedTimingMode) ? "disabled" : ""}`.trim()}>
                  {s + 1}
                </button>
              ))}
            </div>

            <div className="roll-grid">
              {PITCHES.map((pitch) => (
                <div key={pitch} className="roll-row">
                  <div className={`pitch-col ${getPitchHighlightClass(pitch)}`}>{pitch}</div>
                  {Array.from({ length: patternLength }, (_, s) => {
                    const step = lines[selectedLine].steps[s];
                    const isDisabled = isStepDisabledForTimingMode(s, selectedTimingMode);
                    const isNote = step.timeMode === "note" && step.pitch === pitch;
                    return (
                      <button
                        key={`${pitch}-${s}`}
                        className={`cell ${isNote ? "note" : ""} ${isDisabled ? "disabled" : ""} ${getPitchHighlightClass(pitch)}`.trim()}
                        onClick={() => placePitch(selectedLine, s, pitch)}
                        disabled={isDisabled}
                      >
                        {isNote ? "■" : ""}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            <div
              id="mobile-modifier-controls"
              className={`top-lanes ${isMobileViewport && !mobileModifiersOpen ? "mobile-collapsed" : ""}`}
            >
              <div className="lane-row">
                <div className="lane-label">DOWN</div>
                {Array.from({ length: patternLength }, (_, s) => {
                  const step = lines[selectedLine].steps[s];
                  const isDisabled = isStepDisabledForTimingMode(s, selectedTimingMode);
                  const enabled = step.timeMode === "note" && step.pitch && step.transpose === "down";
                  return (
                    <button key={`dn-${s}`} className={`lane-cell ${enabled ? "active" : ""} ${isDisabled ? "disabled" : ""}`.trim()} onClick={() => toggleTranspose(selectedLine, s, "down")} disabled={isDisabled || step.timeMode !== "note" || !step.pitch}>
                      {enabled ? "ON" : "--"}
                    </button>
                  );
                })}
              </div>
              <div className="lane-row">
                <div className="lane-label">UP</div>
                {Array.from({ length: patternLength }, (_, s) => {
                  const step = lines[selectedLine].steps[s];
                  const isDisabled = isStepDisabledForTimingMode(s, selectedTimingMode);
                  const enabled = step.timeMode === "note" && step.pitch && step.transpose === "up";
                  return (
                    <button key={`up-${s}`} className={`lane-cell ${enabled ? "active" : ""} ${isDisabled ? "disabled" : ""}`.trim()} onClick={() => toggleTranspose(selectedLine, s, "up")} disabled={isDisabled || step.timeMode !== "note" || !step.pitch}>
                      {enabled ? "ON" : "--"}
                    </button>
                  );
                })}
              </div>
              <div className="lane-row">
                <div className="lane-label">ACC</div>
                {Array.from({ length: patternLength }, (_, s) => {
                  const step = lines[selectedLine].steps[s];
                  const isDisabled = isStepDisabledForTimingMode(s, selectedTimingMode);
                  const enabled = step.timeMode === "note" && step.pitch && step.accent;
                  return (
                    <button key={`acc-${s}`} className={`lane-cell ${enabled ? "active" : ""} ${isDisabled ? "disabled" : ""}`.trim()} onClick={() => toggleFlag(selectedLine, s, "accent")} disabled={isDisabled || step.timeMode !== "note" || !step.pitch}>
                      {enabled ? "ON" : "--"}
                    </button>
                  );
                })}
              </div>
              <div className="lane-row">
                <div className="lane-label">SLIDE</div>
                {Array.from({ length: patternLength }, (_, s) => {
                  const step = lines[selectedLine].steps[s];
                  const isDisabled = isStepDisabledForTimingMode(s, selectedTimingMode);
                  const enabled = step.timeMode === "note" && step.pitch && step.slide;
                  return (
                    <button key={`sl-${s}`} className={`lane-cell ${enabled ? "active" : ""} ${isDisabled ? "disabled" : ""}`.trim()} onClick={() => toggleFlag(selectedLine, s, "slide")} disabled={isDisabled || step.timeMode !== "note" || !step.pitch}>
                      {enabled ? "ON" : "--"}
                    </button>
                  );
                })}
              </div>
              <div className="lane-row">
                <div className="lane-label">TIME</div>
                {Array.from({ length: patternLength }, (_, s) => {
                  const step = lines[selectedLine].steps[s];
                  const isDisabled = isStepDisabledForTimingMode(s, selectedTimingMode);
                  return (
                    <div key={`time-${s}`} className={`lane-time ${isDisabled ? "disabled" : ""}`.trim()}>
                      <button className={step.timeMode === "note" ? "selected" : ""} onClick={() => setStepMode(selectedLine, s, "note")} disabled={isDisabled}>
                        N
                      </button>
                      <button className={step.timeMode === "tie" ? "selected" : ""} onClick={() => setStepMode(selectedLine, s, "tie")} disabled={isDisabled}>
                        T
                      </button>
                      <button className={step.timeMode === "rest" ? "selected" : ""} onClick={() => setStepMode(selectedLine, s, "rest")} disabled={isDisabled}>
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
