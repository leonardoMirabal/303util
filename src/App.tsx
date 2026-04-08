import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { refreshToken as refreshNativeGoogleToken, signIn as signInWithNativeGoogle } from "@choochmeque/tauri-plugin-google-auth-api";
import packageJson from "../package.json";
import { delayTimeFromTempo, ensureAudioGraph, playScheduledStep, type AudioLineFx } from "./audioEngine";
import "./App.css";

const STEPS = 32;
const MAX_LINES = 3;
const DEFAULT_PATTERN_LENGTH = 16;
const MIN_PATTERN_LENGTH = 4;
const APP_ICON_SRC = `${import.meta.env.BASE_URL}icon_knob.svg`;
const APP_VERSION = (import.meta.env.VITE_APP_VERSION?.trim() || packageJson.version).trim();
const RELEASES_URL = "https://github.com/leonardoMirabal/303util/releases";
const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;
const LATEST_RELEASE_API_URL = "https://api.github.com/repos/leonardoMirabal/303util/releases/latest";
const PATTERN_LENGTH_OPTIONS = Array.from({ length: STEPS - MIN_PATTERN_LENGTH + 1 }, (_, index) => index + MIN_PATTERN_LENGTH);
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
  delayTone: number;
  overdrive: number;
  overdriveTone: number;
  distortion: number;
  distortionTone: number;
  reverb: number;
  reverbTail: number;
  reverbPreDelay: number;
  reverbTone: number;
};

type FxVisibilitySettings = {
  delay: boolean;
  reverb: boolean;
  overdrive: boolean;
  distortion: boolean;
};

type LineState = {
  timingMode: PatternTimingMode;
  patternLength: number;
  steps: Step[];
  params: VoiceParams;
};

type UpdateDialogState =
  | { kind: "up-to-date"; currentVersion: string }
  | { kind: "available"; currentVersion: string; latestVersion: string; releaseUrl: string }
  | { kind: "error"; currentVersion: string; message: string; releaseUrl: string };

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
const DEFAULT_LIBRARY_NAME = "dlib";
const LAST_LIBRARY_ID_KEY = "tb303:last-library-id";
const LAST_PATTERN_ID_KEY = "tb303:last-pattern-id";
const MIN_TEMPO = 1;
const MAX_TEMPO = 180;
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const DRIVE_BACKUP_FOLDER_NAME = "TB-303 Companion Backups";
const DRIVE_BACKUP_FILE_NAME = "tb303-backup.json";
const GOOGLE_SYNC_ENABLED_KEY = "tb303:google-sync-enabled";
const FX_VISIBILITY_KEY = "tb303:fx-visibility";
const DEFAULT_UNSAVED_PATTERN_NAME = "changeme";
const MAX_VISIBLE_FX = 3;
const FX_VISIBILITY_ORDER: Array<keyof FxVisibilitySettings> = ["delay", "reverb", "overdrive", "distortion"];
const DEFAULT_FX_VISIBILITY_SETTINGS: FxVisibilitySettings = {
  delay: true,
  reverb: true,
  overdrive: true,
  distortion: false,
};

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
  delayTime: 0,
  delaySync: false,
  delaySubdivision: "1/8",
  delayFeedback: 0,
  delayMix: 0,
  delayTone: 8200,
  overdrive: 0,
  overdriveTone: 9200,
  distortion: 0,
  distortionTone: 7600,
  reverb: 0,
  reverbTail: 2.0,
  reverbPreDelay: 0.02,
  reverbTone: 6800,
});

const makeLine = (): LineState => ({
  timingMode: "normal",
  patternLength: DEFAULT_PATTERN_LENGTH,
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
  lineCount: 3,
  scalePresetId: "off",
  scaleRoot: "C",
  tempo: 126,
  selectedLine: 0,
  lines: [
    {
      timingMode: "normal",
      patternLength: DEFAULT_PATTERN_LENGTH,
      steps: [
        { pitch: "C3", timeMode: "note", accent: true, slide: false, transpose: "down" },
        { pitch: null, timeMode: "rest", accent: false, slide: false, transpose: "none" },
        { pitch: "C3", timeMode: "note", accent: false, slide: false, transpose: "none" },
        { pitch: "C3", timeMode: "note", accent: false, slide: false, transpose: "down" },
        { pitch: null, timeMode: "rest", accent: false, slide: false, transpose: "none" },
        { pitch: "C3", timeMode: "note", accent: false, slide: false, transpose: "down" },
        { pitch: "D#3", timeMode: "note", accent: false, slide: true, transpose: "none" },
        { pitch: "C3", timeMode: "note", accent: false, slide: false, transpose: "none" },
        ...Array.from({ length: STEPS - 8 }, (): Step => ({ pitch: null, timeMode: "rest", accent: false, slide: false, transpose: "none" })),
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
        delayTone: 8400,
        overdrive: 0,
        overdriveTone: 9200,
        distortion: 0,
        distortionTone: 7600,
        reverb: 0.28,
        reverbTail: 2.0,
        reverbPreDelay: 0.02,
        reverbTone: 7000,
      },
    },
    {
      timingMode: "normal",
      patternLength: DEFAULT_PATTERN_LENGTH,
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
        delayTone: 7800,
        overdrive: 0.12,
        overdriveTone: 8600,
        distortion: 0,
        distortionTone: 7600,
        reverb: 0.16,
        reverbTail: 2.0,
        reverbPreDelay: 0.01,
        reverbTone: 6200,
      },
    },
    {
      timingMode: "normal",
      patternLength: DEFAULT_PATTERN_LENGTH,
      steps: Array.from({ length: STEPS }, (): Step => ({ pitch: null, timeMode: "rest", accent: false, slide: false, transpose: "none" })),
      params: defaultParams(),
    },
  ],
};

const BLANK_PROJECT_TEMPLATE: ProjectData = (() => {
  const voice1 = makeLine();
  const voice2 = makeLine();
  const voice3 = makeLine();
  voice1.params = {
    ...voice1.params,
    cutoff: 606,
    resonance: 4,
    envMod: 287,
    accent: 2.5,
    volume: 0.42,
    delayTime: 0.24,
    delaySync: true,
    delaySubdivision: "1/8.",
    delayFeedback: 0.68,
    delayMix: 0.5,
  };
  voice2.patternLength = 8;
  voice2.params = {
    ...voice2.params,
    delayTime: 0.24,
    delaySync: true,
    delaySubdivision: "1/8.",
    delayFeedback: 0.32,
    delayMix: 0.26,
    overdrive: 0.12,
    reverb: 0.16,
  };
  voice3.patternLength = 8;
  voice3.params = {
    ...voice3.params,
    delayTime: 0.24,
    delaySync: true,
    delaySubdivision: "1/8",
    delayFeedback: 0.32,
    delayMix: 0.26,
    overdrive: 0.12,
    reverb: 0.16,
  };
  return {
    version: 1,
    programName: DEFAULT_UNSAVED_PATTERN_NAME,
    lineCount: 3,
    scalePresetId: "off",
    scaleRoot: "C",
    tempo: 94,
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
const BASE_PITCH_MIN_MIDI = 48; // C3
const BASE_PITCH_MAX_MIDI = 59; // B3
const TRANSPOSED_PITCH_MIN_MIDI = BASE_PITCH_MIN_MIDI - 12; // C2
const TRANSPOSED_PITCH_MAX_MIDI = BASE_PITCH_MAX_MIDI + 12; // B4

const noteToMidi = (note: PitchName): number => {
  const match = note.match(/^([A-G])(#|b)?(\d)$/);
  if (!match) return 57;
  const [, letter, accidental, octaveText] = match;
  const semitoneByLetter: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let semitone = semitoneByLetter[letter];
  if (accidental === "#") semitone += 1;
  if (accidental === "b") semitone -= 1;
  const octave = Number(octaveText);
  return (octave + 1) * 12 + semitone;
};

const isPitchName = (value: unknown): value is PitchName => typeof value === "string" && (PITCHES as readonly string[]).includes(value);
const isPitchClass = (value: unknown): value is PitchClass => typeof value === "string" && (PITCH_CLASSES as readonly string[]).includes(value);
const isScalePresetId = (value: unknown): value is string => typeof value === "string" && value !== "off" && SCALE_PRESET_ID_SET.has(value);

const shortNote = (pitch: PitchName | null): string => (pitch ? pitch : "-");
const toPitchClass = (pitch: PitchName): PitchClass => pitch.replace(/\d/g, "") as PitchClass;
const midiToPitchName = (midi: number): PitchName | null => {
  const pitchClass = PITCH_CLASSES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  const pitch = `${pitchClass}${octave}`;
  return isPitchName(pitch) ? pitch : null;
};
const transposeOffsetForStep = (transpose: Transpose): number => (transpose === "down" ? -12 : transpose === "up" ? 12 : 0);
const pitchAndTransposeFromMidi = (midi: number): { pitch: PitchName; transpose: Transpose } | null => {
  if (midi < TRANSPOSED_PITCH_MIN_MIDI || midi > TRANSPOSED_PITCH_MAX_MIDI) return null;
  if (midi < BASE_PITCH_MIN_MIDI) {
    const pitch = midiToPitchName(midi + 12);
    return pitch ? { pitch, transpose: "down" } : null;
  }
  if (midi > BASE_PITCH_MAX_MIDI) {
    const pitch = midiToPitchName(midi - 12);
    return pitch ? { pitch, transpose: "up" } : null;
  }
  const pitch = midiToPitchName(midi);
  return pitch ? { pitch, transpose: "none" } : null;
};
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

type MobileHeaderSection = "pattern" | "scale" | "fx" | "utilities";
type FxMenuSection = keyof FxVisibilitySettings;
type NewPatternModalMode = "create" | "save";

function KnobControl({ label, min, max, step = 1, value, onChange, format, disabled = false }: KnobProps) {
  const normalized = (value - min) / (max - min);
  const angle = -135 + normalized * 270;
  const style: React.CSSProperties & { "--angle": string } = { "--angle": `${angle}deg` };
  const pointerRef = useRef<{
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    startValue: number;
    dragging: boolean;
  } | null>(null);
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
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      startValue: value,
      dragging: event.pointerType === "mouse",
    };
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.currentTarget.focus({ preventScroll: true });
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId || disabled) return;
    event.preventDefault();
    if (!pointer.dragging) {
      const deltaX = event.clientX - pointer.startX;
      const deltaY = pointer.startY - event.clientY;
      if (Math.abs(deltaY) < 6 || Math.abs(deltaY) <= Math.abs(deltaX)) {
        return;
      }
      pointer.dragging = true;
      pointer.startY = event.clientY;
      pointer.startValue = value;
    }
    const deltaY = pointer.startY - event.clientY;
    const travel = pointer.pointerType === "touch" ? 220 : 160;
    const nextValue = pointer.startValue + (deltaY / travel) * (max - min);
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
    <div className="knob-control">
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
    </div>
  );
}

const isDelaySubdivision = (value: unknown): value is DelaySubdivision =>
  typeof value === "string" && DELAY_SUBDIVISIONS.some((subdivision) => subdivision.value === value);

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
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_PATTERN_LENGTH;
  return Math.max(MIN_PATTERN_LENGTH, Math.min(STEPS, raw));
};

const playablePatternLengthForMode = (patternLength: number, mode: PatternTimingMode): number =>
  mode === "triplet" ? Math.max(1, patternLength - Math.floor(patternLength / 4)) : patternLength;

const isStepDisabledForTimingMode = (stepIndex: number, patternLength: number, mode: PatternTimingMode): boolean =>
  stepIndex >= playablePatternLengthForMode(patternLength, mode);

const maxPatternLengthForMode = (_mode: PatternTimingMode): number => STEPS;

const clampPatternLength = (length: number, mode: PatternTimingMode): number =>
  Math.max(MIN_PATTERN_LENGTH, Math.min(maxPatternLengthForMode(mode), length));

const normalizeVersionTag = (version: string): number[] =>
  version
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));

const compareVersionTags = (left: string, right: string): number => {
  const leftParts = normalizeVersionTag(left);
  const rightParts = normalizeVersionTag(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart === rightPart) continue;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
};

const normalizeFxVisibilitySettings = (settings: FxVisibilitySettings): FxVisibilitySettings => {
  let enabledCount = 0;
  return FX_VISIBILITY_ORDER.reduce((acc, key) => {
    const nextEnabled = settings[key] && enabledCount < MAX_VISIBLE_FX;
    if (nextEnabled) enabledCount += 1;
    acc[key] = nextEnabled;
    return acc;
  }, {} as FxVisibilitySettings);
};

const loadFxVisibilitySettings = (): FxVisibilitySettings => {
  const raw = window.localStorage.getItem(FX_VISIBILITY_KEY);
  if (!raw) return DEFAULT_FX_VISIBILITY_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<FxVisibilitySettings>;
    return normalizeFxVisibilitySettings({
      delay: parsed.delay !== false,
      reverb: parsed.reverb !== false,
      overdrive: parsed.overdrive !== false,
      distortion: parsed.distortion === true,
    });
  } catch {
    return DEFAULT_FX_VISIBILITY_SETTINGS;
  }
};

const stepSecondsForTimingMode = (tempo: number, mode: PatternTimingMode): number => (60 / tempo) / (mode === "triplet" ? 3 : 4);
const SCHEDULER_LOOKAHEAD_SECONDS = 0.12;
const SCHEDULER_INTERVAL_MS = 25;

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

const clampTempo = (value: number): number => Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, Math.round(value)));

const lineHasPatternContent = (line: LineState): boolean => {
  const voiceLength = clampPatternLength(line.patternLength, line.timingMode);
  return line.steps.slice(0, voiceLength).some((step) => step.pitch !== null || step.timeMode !== "rest" || step.accent || step.slide || step.transpose !== "none");
};

const getExportVoiceIndices = (projectLines: LineState[], activeLineCount: 1 | 2 | 3): number[] => {
  const indices = projectLines
    .slice(0, activeLineCount)
    .flatMap((line, index) => (index === 0 || lineHasPatternContent(line) ? [index] : []));
  return indices.length > 0 ? indices : [0];
};

function App() {
  const [lineCount, setLineCount] = useState<1 | 2 | 3>(DEFAULT_PROJECT_STATE.lineCount);
  const [tempo, setTempo] = useState(DEFAULT_PROJECT_STATE.tempo);
  const [halfTempoBase, setHalfTempoBase] = useState<number | null>(null);
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
  const [mobileHeaderSection, setMobileHeaderSection] = useState<MobileHeaderSection>("pattern");
  const [mobileModifiersOpen, setMobileModifiersOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [googleSyncStatus, setGoogleSyncStatus] = useState<"idle" | "connecting" | "syncing" | "ready">("idle");
  const [googleSyncMessage, setGoogleSyncMessage] = useState("");
  const [isLibraryPickerOpen, setIsLibraryPickerOpen] = useState(false);
  const [pickerLibraryId, setPickerLibraryId] = useState<string>(() => window.localStorage.getItem(LAST_LIBRARY_ID_KEY) ?? "default");
  const [isNewPatternModalOpen, setIsNewPatternModalOpen] = useState(false);
  const [newPatternName, setNewPatternName] = useState(DEFAULT_UNSAVED_PATTERN_NAME);
  const [newPatternLibraryId, setNewPatternLibraryId] = useState<string>(() => window.localStorage.getItem(LAST_LIBRARY_ID_KEY) ?? "default");
  const [newPatternModalMode, setNewPatternModalMode] = useState<NewPatternModalMode>("create");
  const [isNewLibraryModalOpen, setIsNewLibraryModalOpen] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState("");
  const [updateDialog, setUpdateDialog] = useState<UpdateDialogState | null>(null);
  const [isInitDialogOpen, setIsInitDialogOpen] = useState(false);
  const [fxVisibility, setFxVisibility] = useState<FxVisibilitySettings>(() => loadFxVisibilitySettings());
  const [selectedFxMenu, setSelectedFxMenu] = useState<FxMenuSection>("delay");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const voiceStepRef = useRef<number[]>(Array.from({ length: MAX_LINES }, () => 0));
  const voiceTickRef = useRef<number[]>(Array.from({ length: MAX_LINES }, () => 0));
  const nextStepTimeRef = useRef<number[]>(Array.from({ length: MAX_LINES }, () => 0));
  const timerRef = useRef<number | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const reverbBufferRef = useRef<AudioBuffer | null>(null);
  const lineFxRef = useRef<Array<AudioLineFx | null>>(Array.from({ length: MAX_LINES }, () => null));
  const playheadRef = useRef(-1);
  const linesRef = useRef(lines);
  const lineCountRef = useRef(lineCount);
  const selectedLineRef = useRef(selectedLine);
  const restoredPatternRef = useRef(false);
  const transposeOriginRef = useRef<{ lines: LineState[]; scaleRoot: PitchClass } | null>(null);
  const googleSyncEnabledRef = useRef(false);
  const hasLoadedLocalDataRef = useRef(false);
  const isApplyingDriveBackupRef = useRef(false);
  const lastDriveBackupSignatureRef = useRef("");
  const driveBackupTimerRef = useRef<number | null>(null);
  const scheduledPlayheadTimeoutsRef = useRef<number[]>([]);

  const setPlayheadValue = (value: number) => {
    if (playheadRef.current === value) return;
    playheadRef.current = value;
    setPlayhead(value);
  };

  const clearScheduledPlayheadUpdates = () => {
    for (const timeoutId of scheduledPlayheadTimeoutsRef.current) {
      window.clearTimeout(timeoutId);
    }
    scheduledPlayheadTimeoutsRef.current = [];
  };

  const resetPlaybackState = () => {
    clearScheduledPlayheadUpdates();
    setPlayheadValue(-1);
    voiceStepRef.current.fill(0);
    voiceTickRef.current.fill(0);
    nextStepTimeRef.current.fill(audioRef.current?.currentTime ?? 0);
  };

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

  const ensureAudio = (lineIndex?: number) => ensureAudioGraph(audioRef, masterRef, reverbBufferRef, lineFxRef, lineIndex);

  const placePitch = (lineIndex: number, stepIndex: number, pitch: PitchName) => {
    const line = lines[lineIndex];
    if (!line) return;
    if (isStepDisabledForTimingMode(stepIndex, clampPatternLength(line.patternLength, line.timingMode), line.timingMode)) return;
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
    const line = lines[lineIndex];
    if (!line) return;
    if (isStepDisabledForTimingMode(stepIndex, clampPatternLength(line.patternLength, line.timingMode), line.timingMode)) return;
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
    const line = lines[lineIndex];
    if (!line) return;
    if (isStepDisabledForTimingMode(stepIndex, clampPatternLength(line.patternLength, line.timingMode), line.timingMode)) return;
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
    const line = lines[lineIndex];
    if (!line) return;
    if (isStepDisabledForTimingMode(stepIndex, clampPatternLength(line.patternLength, line.timingMode), line.timingMode)) return;
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

  const applyLivePatternLines = (nextLines: LineState[]) => {
    linesRef.current = nextLines;
    if (isPlaying) {
      resetPlaybackState();
    }
    setLines(nextLines);
  };

  const transposeCurrentPattern = (semitoneDelta: number) => {
    if (!transposeOriginRef.current) {
      transposeOriginRef.current = {
        lines: cloneProjectData({ ...buildProjectSnapshot(), lines }).lines,
        scaleRoot,
      };
    }

    const transposedLines = lines.map((line) => ({
      ...line,
      steps: line.steps.map((step) => {
        if (!step.pitch) return step;
        const effectiveMidi = noteToMidi(step.pitch) + transposeOffsetForStep(step.transpose) + semitoneDelta;
        const nextStep = pitchAndTransposeFromMidi(effectiveMidi);
        if (!nextStep) return null;
        return { ...step, pitch: nextStep.pitch, transpose: nextStep.transpose };
      }),
    }));

    if (transposedLines.some((line) => line.steps.some((step) => step === null))) {
      window.alert(`Pattern cannot be transposed ${semitoneDelta > 0 ? "up" : "down"} any further.`);
      return;
    }

    applyLivePatternLines(
      transposedLines.map((line) => ({
        ...line,
        steps: line.steps as Step[],
      })),
    );
    setScaleRoot((prev) => PITCH_CLASSES[(PITCH_CLASS_INDEX[prev] + semitoneDelta + PITCH_CLASSES.length) % PITCH_CLASSES.length]);
  };

  const rollbackTransposedPattern = () => {
    const origin = transposeOriginRef.current;
    if (!origin) return;
    applyLivePatternLines(origin.lines.map((line) => ({ ...line, steps: line.steps.map((step) => ({ ...step })), params: { ...line.params } })));
    setScaleRoot(origin.scaleRoot);
    transposeOriginRef.current = null;
  };

  const setProjectTempo = (value: number) => {
    setHalfTempoBase(null);
    setTempo(clampTempo(value));
  };

  const setTempoFromKnob = (value: number) => {
    const nextTempo = clampTempo(value);
    setTempo(nextTempo);
    setHalfTempoBase((prev) => (prev === null ? null : clampTempo(nextTempo * 2)));
  };

  const toggleHalfTempo = () => {
    if (halfTempoBase === null) {
      setHalfTempoBase(tempo);
      setTempo(clampTempo(tempo / 2));
      return;
    }

    setTempo(halfTempoBase);
    setHalfTempoBase(null);
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
    resetPlaybackState();
  };

  const togglePatternTimingMode = () => {
    const nextMode = (lines[selectedLine]?.timingMode ?? "normal") === "normal" ? "triplet" : "normal";
    applyPatternTimingMode(nextMode);
  };

  const applyFxVisibilityToParams = (params: VoiceParams): VoiceParams => ({
    ...params,
    delayTime: fxVisibility.delay ? params.delayTime : 0,
    delaySync: fxVisibility.delay ? params.delaySync : false,
    delayFeedback: fxVisibility.delay ? params.delayFeedback : 0,
    delayMix: fxVisibility.delay ? params.delayMix : 0,
    overdrive: fxVisibility.overdrive ? params.overdrive : 0,
    distortion: fxVisibility.distortion ? params.distortion : 0,
    reverb: fxVisibility.reverb ? params.reverb : 0,
  });

  const playStep = (lineIndex: number, line: LineState, stepIndex: number, stepLenSeconds: number, startTime?: number) => {
    playScheduledStep({
      lineIndex,
      line: { ...line, params: applyFxVisibilityToParams(line.params) },
      stepIndex,
      stepLenSeconds,
      startTime,
      tempo,
      audioRef,
      masterRef,
      reverbBufferRef,
      lineFxRef,
      findBaseStep,
    });
  };

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);
  useEffect(() => {
    lineCountRef.current = lineCount;
  }, [lineCount]);
  useEffect(() => {
    selectedLineRef.current = selectedLine;
  }, [selectedLine]);
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
    window.localStorage.setItem(FX_VISIBILITY_KEY, JSON.stringify(fxVisibility));
  }, [fxVisibility]);

  useEffect(() => {
    transposeOriginRef.current = null;
  }, [selectedLibraryId, selectedPatternId]);
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
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const graph = ensureAudio();
    if (graph?.ctx.state === "suspended") {
      void graph.ctx.resume();
    }
    for (let li = 0; li < lineCountRef.current; li += 1) {
      ensureAudio(li);
    }

    resetPlaybackState();
    const normalStepSeconds = stepSecondsForTimingMode(tempo, "normal");
    const tripletStepSeconds = stepSecondsForTimingMode(tempo, "triplet");
    const schedulePlayheadUpdate = (lineIndex: number, stepIndex: number, stepTime: number, currentTime: number) => {
      if (lineIndex !== selectedLineRef.current) return;
      const delayMs = Math.max(0, (stepTime - currentTime) * 1000);
      if (delayMs <= 8) {
        setPlayheadValue(stepIndex);
        return;
      }
      const timeoutId = window.setTimeout(() => {
        scheduledPlayheadTimeoutsRef.current = scheduledPlayheadTimeoutsRef.current.filter((id) => id !== timeoutId);
        if (selectedLineRef.current === lineIndex) {
          setPlayheadValue(stepIndex);
        }
      }, delayMs);
      scheduledPlayheadTimeoutsRef.current.push(timeoutId);
    };
    const tick = () => {
      const ctx = audioRef.current;
      if (!ctx) return;
      const currentTime = ctx.currentTime;
      const scheduleUntil = currentTime + SCHEDULER_LOOKAHEAD_SECONDS;
      const linesNow = linesRef.current;
      for (let li = 0; li < lineCountRef.current; li += 1) {
        const line = linesNow[li];
        const stepSeconds = line.timingMode === "triplet" ? tripletStepSeconds : normalStepSeconds;
        const voiceLength = clampPatternLength(line.patternLength, line.timingMode);
        const playableLength = playablePatternLengthForMode(voiceLength, line.timingMode);
        if (playableLength <= 0) {
          nextStepTimeRef.current[li] = currentTime;
          continue;
        }
        let nextStepTime = Math.max(nextStepTimeRef.current[li], currentTime);
        while (nextStepTime <= scheduleUntil) {
          const stepIndex = voiceStepRef.current[li] % playableLength;
          playStep(li, line, stepIndex, stepSeconds, nextStepTime);
          schedulePlayheadUpdate(li, stepIndex, nextStepTime, currentTime);
          voiceStepRef.current[li] += 1;
          voiceTickRef.current[li] += 1;
          nextStepTime += stepSeconds;
        }
        nextStepTimeRef.current[li] = nextStepTime;
      }
      timerRef.current = window.setTimeout(tick, SCHEDULER_INTERVAL_MS);
    };
    tick();
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      clearScheduledPlayheadUpdates();
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
    const exportVoiceIndices = getExportVoiceIndices(lines, lineCount);
    const exportVoices = exportVoiceIndices.length;
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

    for (let exportIndex = 0; exportIndex < exportVoices; exportIndex += 1) {
      const voiceIndex = exportVoiceIndices[exportIndex];
      const voice = lines[voiceIndex];
      const voiceTop = 120 + exportIndex * voiceBlockHeight;
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
          if (isStepDisabledForTimingMode(i, voiceLength, voice.timingMode)) {
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
    const exportVoiceCount = getExportVoiceIndices(lines, lineCount).length;
    const safeProgramName = baseProgramName
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const link = document.createElement("a");
    link.href = url;
    link.download = `tb303-${safeProgramName || "program"}-${exportVoiceCount}voice-sheet-${Date.now()}.png`;
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
      if (!Array.isArray(lineObj.steps) || lineObj.steps.length > STEPS || lineObj.steps.length < DEFAULT_PATTERN_LENGTH) {
        throw new Error(`Voice ${lineIndex + 1} must have between ${DEFAULT_PATTERN_LENGTH} and ${STEPS} steps.`);
      }
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
        delayTone: typeof paramsRaw.delayTone === "number" ? Number(paramsRaw.delayTone) : 8200,
        overdrive:
          typeof paramsRaw.overdrive === "number"
            ? Number(paramsRaw.overdrive)
            : typeof paramsRaw.distortion === "number"
              ? Number(paramsRaw.distortion)
              : 0,
        overdriveTone: typeof paramsRaw.overdriveTone === "number" ? Number(paramsRaw.overdriveTone) : 9200,
        distortion:
          typeof paramsRaw.overdrive === "number" && typeof paramsRaw.distortion === "number" ? Number(paramsRaw.distortion) : 0,
        distortionTone: typeof paramsRaw.distortionTone === "number" ? Number(paramsRaw.distortionTone) : 7600,
        reverb: typeof paramsRaw.reverb === "number" ? Number(paramsRaw.reverb) : 0,
        reverbTail: typeof paramsRaw.reverbTail === "number" ? Number(paramsRaw.reverbTail) : 2.0,
        reverbPreDelay: typeof paramsRaw.reverbPreDelay === "number" ? Number(paramsRaw.reverbPreDelay) : 0.02,
        reverbTone: typeof paramsRaw.reverbTone === "number" ? Number(paramsRaw.reverbTone) : 6800,
      };
      if (Object.values(params).some((v) => (typeof v === "number" ? !Number.isFinite(v) : false))) {
        throw new Error(`Voice ${lineIndex + 1} params contain invalid numbers.`);
      }

      const parsedSteps: Step[] = lineObj.steps.map((stepRaw, stepIndex) => {
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
      const steps: Step[] =
        parsedSteps.length === STEPS
          ? parsedSteps
          : [
              ...parsedSteps,
              ...Array.from({ length: STEPS - parsedSteps.length }, (): Step => ({
                pitch: null,
                timeMode: "rest",
                accent: false,
                slide: false,
                transpose: "none",
              })),
            ];

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
      setProjectTempo(parsed.tempo);
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
      return {
        id: lib.id,
        name: lib.id === "default" ? DEFAULT_LIBRARY_NAME : lib.name,
        createdAt,
        updatedAt,
      } satisfies LibraryRecord;
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
      libraryList.push({ id: "default", name: DEFAULT_LIBRARY_NAME, createdAt: now, updatedAt: now });
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

  const showUpdateDialog = (dialog: UpdateDialogState) => {
    setMobileProjectOpen(false);
    setUpdateDialog(dialog);
  };

  const showInitDialog = () => {
    setMobileProjectOpen(false);
    setIsInitDialogOpen(true);
  };

  const openLatestReleasePage = async (url = LATEST_RELEASE_URL) => {
    try {
      if (isTauri()) {
        await invoke("open_external_url", { url });
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not open the release page.";
      showUpdateDialog({
        kind: "error",
        currentVersion: APP_VERSION,
        message,
        releaseUrl: url,
      });
    }
  };

  const checkForAppUpdate = async () => {
    try {
      const response = await fetch(LATEST_RELEASE_API_URL, {
        headers: {
          Accept: "application/vnd.github+json",
        },
      });
      if (!response.ok) {
        throw new Error(`GitHub releases request failed (${response.status}).`);
      }
      const latestRelease = (await response.json()) as { tag_name?: string; html_url?: string };
      const latestTag = latestRelease.tag_name?.trim();
      const releaseUrl = latestRelease.html_url?.trim() || LATEST_RELEASE_URL;
      if (!latestTag) {
        showUpdateDialog({
          kind: "error",
          currentVersion: APP_VERSION,
          message: "Could not determine the latest release version.",
          releaseUrl,
        });
        return;
      }

      if (compareVersionTags(latestTag, APP_VERSION) <= 0) {
        showUpdateDialog({ kind: "up-to-date", currentVersion: APP_VERSION });
        return;
      }

      showUpdateDialog({
        kind: "available",
        currentVersion: APP_VERSION,
        latestVersion: latestTag,
        releaseUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not check for updates.";
      showUpdateDialog({
        kind: "error",
        currentVersion: APP_VERSION,
        message,
        releaseUrl: LATEST_RELEASE_URL,
      });
    }
  };

  const refreshLocalStorageData = async () => {
    const db = await openLocalDb();
    try {
      const [libraryRows, patternRows] = await Promise.all([
        getAllFromStore<LibraryRecord>(db, LIBRARIES_STORE),
        getAllFromStore<PatternRecord>(db, PATTERNS_STORE),
      ]);
      setLibraries(
        libraryRows
          .map((library) => ({
            ...library,
            name: library.id === "default" ? DEFAULT_LIBRARY_NAME : library.name,
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt),
      );
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
          store.put({ id: "default", name: DEFAULT_LIBRARY_NAME, createdAt: now, updatedAt: now } satisfies LibraryRecord);
        };
      });
    } finally {
      db.close();
    }
  };

  const createLibrary = async (libraryName: string) => {
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
    setPickerLibraryId(id);
    await refreshLocalStorageData();
  };

  const savePatternRecord = async ({
    patternId,
    libraryId,
    name,
    createdAt,
  }: {
    patternId?: string;
    libraryId: string;
    name: string;
    createdAt?: number;
  }) => {
    const now = Date.now();
    const id = patternId ?? `pat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = await openLocalDb();
    try {
      await runWrite(db, [PATTERNS_STORE, LIBRARIES_STORE], (tx) => {
        tx.objectStore(PATTERNS_STORE).put({
          id,
          libraryId,
          name,
          project: JSON.parse(JSON.stringify({ ...buildProjectSnapshot(), programName: name })) as ProjectData,
          createdAt: createdAt ?? now,
          updatedAt: now,
        } satisfies PatternRecord);
        const libReq = tx.objectStore(LIBRARIES_STORE).get(libraryId);
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
    setSelectedLibraryId(libraryId);
    setSelectedPatternId(id);
    return id;
  };

  const saveSelectedPattern = async () => {
    const selectedPattern = patterns.find((pattern) => pattern.id === selectedPatternId && pattern.libraryId === selectedLibraryId);
    const targetLibraryId = selectedLibraryId;
    const targetName = programName.trim() || selectedPattern?.name || "Pattern";
    const nameMatch = patterns.find((pattern) => pattern.libraryId === targetLibraryId && pattern.name === targetName);

    if (!selectedPattern) {
      setNewPatternModalMode("save");
      setNewPatternName(programName.trim() || DEFAULT_UNSAVED_PATTERN_NAME);
      setNewPatternLibraryId(targetLibraryId);
      setMobileProjectOpen(false);
      setIsLibraryPickerOpen(false);
      setIsNewPatternModalOpen(true);
      return;
    }

    if (targetName === selectedPattern.name) {
      await savePatternRecord({
        patternId: selectedPattern.id,
        libraryId: targetLibraryId,
        name: selectedPattern.name,
        createdAt: selectedPattern.createdAt,
      });
      return;
    }

    if (nameMatch && nameMatch.id !== selectedPattern.id) {
      const ok = window.confirm(`Pattern "${targetName}" already exists in this lib. Overwrite it?`);
      if (!ok) return;
      await savePatternRecord({
        patternId: nameMatch.id,
        libraryId: targetLibraryId,
        name: targetName,
        createdAt: nameMatch.createdAt,
      });
      return;
    }

    await savePatternRecord({ libraryId: targetLibraryId, name: targetName });
  };

  const createEmptyPattern = async (patternName: string, libraryId = selectedLibraryId) => {
    const trimmed = patternName.trim();
    if (!trimmed) return;
    const now = Date.now();
    const id = `pat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const targetLibraryId = libraryId;
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

  const openNewPatternModal = (libraryId = selectedLibraryId) => {
    setNewPatternModalMode("create");
    setNewPatternName("New Pattern");
    setNewPatternLibraryId(libraryId);
    setMobileProjectOpen(false);
    setIsLibraryPickerOpen(false);
    setIsNewPatternModalOpen(true);
  };

  const submitNewPattern = async () => {
    const trimmed = newPatternName.trim();
    if (!trimmed) {
      window.alert("Pattern name is required.");
      return;
    }
    setIsNewPatternModalOpen(false);
    if (newPatternModalMode === "save") {
      const nameMatch = patterns.find((pattern) => pattern.libraryId === newPatternLibraryId && pattern.name === trimmed);
      if (nameMatch) {
        const ok = window.confirm(`Pattern "${trimmed}" already exists in this lib. Overwrite it?`);
        if (!ok) return;
        await savePatternRecord({
          patternId: nameMatch.id,
          libraryId: newPatternLibraryId,
          name: trimmed,
          createdAt: nameMatch.createdAt,
        });
        return;
      }
      await savePatternRecord({ libraryId: newPatternLibraryId, name: trimmed });
      return;
    }
    await createEmptyPattern(trimmed, newPatternLibraryId);
  };

  const openNewLibraryModal = () => {
    setNewLibraryName("");
    setMobileProjectOpen(false);
    setIsLibraryPickerOpen(false);
    setIsNewLibraryModalOpen(true);
  };

  const submitNewLibrary = async () => {
    const trimmed = newLibraryName.trim();
    if (!trimmed) {
      window.alert("Library name is required.");
      return;
    }
    setIsNewLibraryModalOpen(false);
    await createLibrary(trimmed);
  };

  const openUnsavedEmptyPattern = (libraryId = selectedLibraryId) => {
    const blankProject = blankProjectState();
    const emptyProject: ProjectData = {
      ...blankProject,
      programName: DEFAULT_UNSAVED_PATTERN_NAME,
    };
    setSelectedLibraryId(libraryId);
    setSelectedPatternId("");
    loadPattern({
      id: "unsaved-empty",
      libraryId,
      name: DEFAULT_UNSAVED_PATTERN_NAME,
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
      resetPlaybackState();
      setWorkspaceView("editor");
      setProgramName(parsed.programName);
      setLineCount(parsed.lineCount);
      setScalePresetId(parsed.scalePresetId ?? "off");
      setScaleRoot(parsed.scaleRoot ?? "C");
      setProjectTempo(parsed.tempo);
      setSelectedLine(parsed.selectedLine);
      setLines(parsed.lines);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid stored pattern.";
      window.alert(`Load failed: ${message}`);
    }
  };

  const deletePatternById = async (patternId: string) => {
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

  const deletePatternRecord = async (pattern: PatternRecord) => {
    const ok = window.confirm(`Delete pattern "${pattern.name}"?`);
    if (!ok) return;
    await deletePatternById(pattern.id);
    if (pattern.id === selectedPatternId && pattern.libraryId === selectedLibraryId) {
      openUnsavedEmptyPattern(pattern.libraryId);
    }
  };

  const deleteLibraryById = async (libraryId: string) => {
    if (libraryId === "default") {
      window.alert("dlib cannot be deleted.");
      return;
    }
    const currentLibrary = libraries.find((library) => library.id === libraryId);
    const ok = window.confirm(`Delete library "${currentLibrary?.name ?? libraryId}" and all its patterns?`);
    if (!ok) return;
    const db = await openLocalDb();
    try {
      const allPatterns = await getAllFromStore<PatternRecord>(db, PATTERNS_STORE);
      const idsToDelete = allPatterns.filter((pattern) => pattern.libraryId === libraryId).map((pattern) => pattern.id);
      await runWrite(db, [PATTERNS_STORE, LIBRARIES_STORE], (tx) => {
        const patternStore = tx.objectStore(PATTERNS_STORE);
        idsToDelete.forEach((id) => patternStore.delete(id));
        tx.objectStore(LIBRARIES_STORE).delete(libraryId);
      });
    } finally {
      db.close();
    }
    if (pickerLibraryId === libraryId) {
      setPickerLibraryId("default");
    }
    if (selectedLibraryId === libraryId) {
      await refreshLocalStorageData();
      openUnsavedEmptyPattern("default");
      return;
    }
    await refreshLocalStorageData();
  };

  const runStorageAction = async (action: string) => {
    if (!action) return;
    if (action === "set-voices") {
      const value = window.prompt("Voice number (1-3)", String(lineCount));
      if (value === null) return;
      const parsed = Number(value);
      if (parsed !== 1 && parsed !== 2 && parsed !== 3) {
        window.alert("Voice number must be 1, 2, or 3.");
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
      openPatternPicker();
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
        window.alert("dlib cannot be deleted.");
        return;
      }
      await deleteLibraryById(selectedLibraryId);
      return;
    }

    if (action === "new-library") {
      openNewLibraryModal();
      return;
    }

    if (action === "save-pattern") {
      await saveSelectedPattern();
      return;
    }
    if (action === "new-pattern") {
      openNewPatternModal();
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
      await deletePatternRecord(selectedPattern);
      return;
    }
  };

  const resetPattern = () => {
    openUnsavedEmptyPattern(selectedLibraryId);
  };

  const initCurrentPattern = () => {
    showInitDialog();
  };

  useEffect(() => {
    if (workspaceView !== "sheet") return;
    const timeoutId = window.setTimeout(() => {
      const url = buildExportDataUrl();
      if (url) setExportPreviewUrl(url);
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [workspaceView, lines, lineCount, tempo, programName]);

  useEffect(() => {
    const mobileQuery = window.matchMedia("(max-width: 980px)");
    const orientationQuery = window.matchMedia("(orientation: landscape)");
    const syncLandscapeState = () => {
      const nextIsMobile = mobileQuery.matches;
      setIsMobileViewport(nextIsMobile);
      setMobileProjectOpen(false);
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
  const selectedSavedPattern = visiblePatterns.find((pattern) => pattern.id === selectedPatternId);
  const pickerPatterns = patterns.filter((pattern) => pattern.libraryId === pickerLibraryId);
  const shouldShowRotateOverlay = false;
  const controlsToggleLabel = "Controls";
  const modifiersToggleLabel = "Mods";
  const patternTimingLabel = selectedTimingMode === "normal" ? "♪" : "♪₃";
  const patternTimingAriaLabel = selectedTimingMode === "normal" ? "Regular note timing" : "Triplet note timing";
  const scaleEnabled = scalePresetId !== "off";
  const currentLibraryLabel = libraries.find((library) => library.id === selectedLibraryId)?.name ?? "Library";
  const currentPatternName = programName.trim() || selectedSavedPattern?.name || "Untitled";
  const currentPatternLabel = `${currentLibraryLabel} > ${currentPatternName}`;
  const fxOptions: Array<{ key: keyof FxVisibilitySettings; label: string }> = [
    { key: "delay", label: "Delay" },
    { key: "reverb", label: "Reverb" },
    { key: "overdrive", label: "Overdrive" },
    { key: "distortion", label: "Distortion" },
  ];
  const scalePitchClasses = scaleEnabled ? buildScalePitchClassSet(scaleRoot, scalePresetId) : null;
  const getPitchHighlightClass = (pitch: PitchName) => {
    if (!scalePitchClasses) return "";
    const pitchClass = toPitchClass(pitch);
    if (pitchClass === scaleRoot) return "scale-root";
    if (scalePitchClasses.has(pitchClass)) return "scale-member";
    return "";
  };
  const synthLabels = isMobileViewport
    ? { resonance: "RES", envMod: "ENV", accent: "ACC", volume: "VOL", delayTime: "TIME", feedback: "FDBK", delayMix: "MIX", overdrive: "DRV", distortion: "DIST", reverb: "REV" }
    : { resonance: "Resonance", envMod: "Env Mod", accent: "Accent", volume: "Volume", delayTime: "Delay Time", feedback: "Feedback", delayMix: "Delay Mix", overdrive: "Overdrive", distortion: "Distortion", reverb: "Reverb" };
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

  const toggleFxVisibility = (effect: FxMenuSection) => {
    setFxVisibility((prev) => {
      if (prev[effect]) {
        return { ...prev, [effect]: false };
      }
      const enabledCount = FX_VISIBILITY_ORDER.filter((key) => prev[key]).length;
      if (enabledCount >= MAX_VISIBLE_FX) {
        return prev;
      }
      return { ...prev, [effect]: true };
    });
  };

  const renderFxMenuControls = () => {
    const effectEnabled = fxVisibility[selectedFxMenu];
    const enabledEffectCount = FX_VISIBILITY_ORDER.filter((key) => fxVisibility[key]).length;
    const maxFxReached = !effectEnabled && enabledEffectCount >= MAX_VISIBLE_FX;

    if (selectedFxMenu === "delay") {
      return (
        <div className="fx-menu-panel">
          <div className="fx-menu-panel-header">
            <div>
              <div className="settings-subsection-label">Delay</div>
              <div className="settings-helper">Time, feedback, and mix live here.</div>
            </div>
            <button type="button" className={effectEnabled ? "selected" : ""} onClick={() => toggleFxVisibility("delay")} disabled={maxFxReached}>
              {effectEnabled ? "Enabled" : maxFxReached ? "3 Max" : "Disabled"}
            </button>
          </div>
          <div className="fx-menu-inline-controls">
            <button
              type="button"
              className={params.delaySync ? "selected" : ""}
              onClick={() => updateParams({ delaySync: !params.delaySync })}
              disabled={!effectEnabled}
            >
              {params.delaySync ? "Sync" : "Free"}
            </button>
            <select
              aria-label="Delay subdivision"
              value={params.delaySubdivision}
              disabled={!effectEnabled || !params.delaySync}
              onChange={(e) => updateParams({ delaySubdivision: e.currentTarget.value as DelaySubdivision })}
            >
              {DELAY_SUBDIVISIONS.map((subdivision) => (
                <option key={subdivision.value} value={subdivision.value}>
                  {subdivision.label}
                </option>
              ))}
            </select>
          </div>
          <div className="fx-menu-knobs fx-menu-knobs-delay">
            <KnobControl
              label="Delay Time"
              min={0}
              max={1}
              step={0.01}
              value={params.delaySync ? delayTimeFromTempo(tempo, params.delaySubdivision) : params.delayTime}
              disabled={!effectEnabled || params.delaySync}
              onChange={(v) => updateParams({ delayTime: v })}
              format={(v) => `${v.toFixed(2)}s`}
            />
            <KnobControl
              label="Feedback"
              min={0}
              max={0.92}
              step={0.01}
              value={params.delayFeedback}
              disabled={!effectEnabled}
              onChange={(v) => updateParams({ delayFeedback: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <KnobControl
              label="Delay Mix"
              min={0}
              max={1}
              step={0.01}
              value={params.delayMix}
              disabled={!effectEnabled}
              onChange={(v) => updateParams({ delayMix: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <KnobControl
              label="Tone"
              min={800}
              max={12000}
              step={100}
              value={params.delayTone}
              disabled={!effectEnabled}
              onChange={(v) => updateParams({ delayTone: v })}
              format={(v) => `${(v / 1000).toFixed(1)}k`}
            />
          </div>
        </div>
      );
    }

    if (selectedFxMenu === "reverb") {
      return (
        <div className="fx-menu-panel">
          <div className="fx-menu-panel-header">
            <div>
              <div className="settings-subsection-label">Reverb</div>
              <div className="settings-helper">Room amount plus the hidden tail length control.</div>
            </div>
            <button type="button" className={effectEnabled ? "selected" : ""} onClick={() => toggleFxVisibility("reverb")} disabled={maxFxReached}>
              {effectEnabled ? "Enabled" : maxFxReached ? "3 Max" : "Disabled"}
            </button>
          </div>
          <div className="fx-menu-knobs">
            <KnobControl
              label="Reverb"
              min={0}
              max={1}
              step={0.01}
              value={params.reverb}
              disabled={!effectEnabled}
              onChange={(v) => updateParams({ reverb: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <KnobControl
              label="Tail"
              min={0.4}
              max={4}
              step={0.1}
              value={params.reverbTail}
              disabled={!effectEnabled}
              onChange={(v) => updateParams({ reverbTail: v })}
              format={(v) => `${v.toFixed(1)}s`}
            />
            <KnobControl
              label="Pre Delay"
              min={0}
              max={0.18}
              step={0.01}
              value={params.reverbPreDelay}
              disabled={!effectEnabled}
              onChange={(v) => updateParams({ reverbPreDelay: v })}
              format={(v) => `${Math.round(v * 1000)}ms`}
            />
            <KnobControl
              label="Tone"
              min={800}
              max={12000}
              step={100}
              value={params.reverbTone}
              disabled={!effectEnabled}
              onChange={(v) => updateParams({ reverbTone: v })}
              format={(v) => `${(v / 1000).toFixed(1)}k`}
            />
          </div>
        </div>
      );
    }

    if (selectedFxMenu === "overdrive") {
      return (
        <div className="fx-menu-panel">
          <div className="fx-menu-panel-header">
            <div>
              <div className="settings-subsection-label">Overdrive</div>
              <div className="settings-helper">Softer drive before the heavier distortion stage.</div>
            </div>
            <button type="button" className={effectEnabled ? "selected" : ""} onClick={() => toggleFxVisibility("overdrive")} disabled={maxFxReached}>
              {effectEnabled ? "Enabled" : maxFxReached ? "3 Max" : "Disabled"}
            </button>
          </div>
          <div className="fx-menu-knobs">
            <KnobControl
              label="Overdrive"
              min={0}
              max={1}
              step={0.01}
              value={params.overdrive}
              disabled={!effectEnabled}
              onChange={(v) => updateParams({ overdrive: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <KnobControl
              label="Tone"
              min={800}
              max={14000}
              step={100}
              value={params.overdriveTone}
              disabled={!effectEnabled}
              onChange={(v) => updateParams({ overdriveTone: v })}
              format={(v) => `${(v / 1000).toFixed(1)}k`}
            />
          </div>
        </div>
      );
    }

    return (
      <div className="fx-menu-panel">
        <div className="fx-menu-panel-header">
          <div>
            <div className="settings-subsection-label">Distortion</div>
            <div className="settings-helper">Heavier drive after overdrive.</div>
          </div>
          <button type="button" className={effectEnabled ? "selected" : ""} onClick={() => toggleFxVisibility("distortion")} disabled={maxFxReached}>
            {effectEnabled ? "Enabled" : maxFxReached ? "3 Max" : "Disabled"}
          </button>
        </div>
        <div className="fx-menu-knobs">
          <KnobControl
            label="Distortion"
            min={0}
            max={1}
            step={0.01}
            value={params.distortion}
            disabled={!effectEnabled}
            onChange={(v) => updateParams({ distortion: v })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <KnobControl
            label="Tone"
            min={800}
            max={14000}
            step={100}
            value={params.distortionTone}
            disabled={!effectEnabled}
            onChange={(v) => updateParams({ distortionTone: v })}
            format={(v) => `${(v / 1000).toFixed(1)}k`}
          />
        </div>
      </div>
    );
  };

  const toggleMobileHeaderSection = (section: MobileHeaderSection) => {
    setMobileHeaderSection(section);
    setMobileProjectOpen(true);
  };

  const openPatternPicker = () => {
    setPickerLibraryId(selectedLibraryId);
    setIsLibraryPickerOpen(true);
    setMobileProjectOpen(false);
  };

  const renderMobileHeaderPanel = () => {
    if (!mobileProjectOpen) return null;

    if (mobileHeaderSection === "pattern") {
      return (
        <div className="mobile-group-panel" id="mobile-header-panel">
          <label className="mobile-group-field">
            Name
            <input type="text" value={programName} onChange={(e) => setProgramName(e.currentTarget.value)} />
          </label>
          <label className="mobile-group-field mobile-group-field-compact">
            Pattern length
            <select value={patternLength} onChange={(event) => updateVoicePatternLength(Number(event.currentTarget.value))}>
              {PATTERN_LENGTH_OPTIONS.map((length) => {
                return (
                  <option key={length} value={length}>
                    {length}
                  </option>
                );
              })}
            </select>
          </label>
          <div className="mobile-group-actions">
            <button type="button" onClick={initCurrentPattern}>
              Init
            </button>
            <button type="button" onClick={() => openNewPatternModal(selectedLibraryId)}>
              New
            </button>
            <button type="button" onClick={() => void runStorageAction("delete-pattern")} disabled={!selectedSavedPattern}>
              Delete
            </button>
          </div>
        </div>
      );
    }

    if (mobileHeaderSection === "scale") {
      return (
        <div className="mobile-group-panel mobile-group-panel-dual" id="mobile-header-panel">
          <label className="mobile-group-field">
            Root
            <select value={scaleRoot} onChange={(e) => setScaleRoot(e.currentTarget.value as PitchClass)} disabled={!scaleEnabled}>
              {PITCH_CLASSES.map((pitchClass) => (
                <option key={pitchClass} value={pitchClass}>
                  {pitchClass}
                </option>
              ))}
            </select>
          </label>
          <label className="mobile-group-field">
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
        </div>
      );
    }

    if (mobileHeaderSection === "fx") {
      return (
        <div className="mobile-group-panel" id="mobile-header-panel">
          <div className="settings-subsection">
            <div className="settings-subsection-label">Effects</div>
            <div className="settings-helper">Open an effect submenu to tweak its controls here.</div>
            <div className="mobile-group-actions mobile-group-actions-grid fx-settings-grid">
              {fxOptions.map((effect) => (
                <button
                  key={effect.key}
                  type="button"
                  aria-pressed={selectedFxMenu === effect.key}
                  className={selectedFxMenu === effect.key ? "selected" : ""}
                  onClick={() => setSelectedFxMenu(effect.key)}
                >
                  {effect.label}
                </button>
              ))}
            </div>
            {renderFxMenuControls()}
          </div>
        </div>
      );
    }

    return (
      <div className="mobile-group-panel" id="mobile-header-panel">
        <div className="mobile-group-actions mobile-group-actions-grid">
          <button type="button" onClick={() => void runStorageAction("set-voices")}>
            Voice number {lineCount}
          </button>
          <button type="button" onClick={() => void checkForAppUpdate()}>
            Update
          </button>
          <button type="button" onClick={isFullscreen ? exitFullscreen : enterFullscreen}>
            {isFullscreen ? "Exit Full" : "Full"}
          </button>
          <button type="button" onClick={() => void runStorageAction("import-json")}>
            Import
          </button>
          <button type="button" onClick={() => void runStorageAction("export-json")}>
            Export
          </button>
          <button type="button" onClick={() => void runStorageAction("export-png")}>
            Export PNG
          </button>
          <button type="button" onClick={() => void runStorageAction(googleAccessToken ? "google-drive-backup-now" : "google-drive-connect")}>
            {googleAccessToken ? "Backup" : "Google Drive"}
          </button>
        </div>
        {googleSyncMessage ? <span className={`google-sync-status mobile-google-sync-status ${googleSyncStatus}`}>{googleSyncMessage}</span> : null}
      </div>
    );
  };

  return (
    <main className="app">
      {isInitDialogOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setIsInitDialogOpen(false)}>
          <div
            className="modal-card mobile-project-modal update-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="init-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="init-dialog-title">Init pattern</h2>
              <button type="button" onClick={() => setIsInitDialogOpen(false)}>
                Close
              </button>
            </div>
            <div className="mobile-group-panel update-dialog-body">
              <p className="update-dialog-message">Reset this pattern and wipe its current settings?</p>
              <p className="update-dialog-note">This opens a fresh unsaved blank pattern in the current library.</p>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setIsInitDialogOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="selected"
                onClick={() => {
                  setIsInitDialogOpen(false);
                  resetPattern();
                }}
              >
                Init
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {updateDialog ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setUpdateDialog(null)}>
          <div
            className="modal-card mobile-project-modal update-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="update-dialog-title">Update</h2>
              <button type="button" onClick={() => setUpdateDialog(null)}>
                Close
              </button>
            </div>
            <div className="mobile-group-panel update-dialog-body">
              {updateDialog.kind === "available" ? (
                <>
                  <p className="update-dialog-message">A newer version is available.</p>
                  <div className="update-dialog-meta">
                    <span>Current</span>
                    <strong>{updateDialog.currentVersion}</strong>
                    <span>Latest</span>
                    <strong>{updateDialog.latestVersion}</strong>
                  </div>
                  <p className="update-dialog-note">Download will open in your device&apos;s default browser.</p>
                </>
              ) : updateDialog.kind === "up-to-date" ? (
                <p className="update-dialog-message">You already have the latest version ({updateDialog.currentVersion}).</p>
              ) : (
                <>
                  <p className="update-dialog-message">Could not check for updates.</p>
                  <p className="update-dialog-note">{updateDialog.message}</p>
                </>
              )}
            </div>
            <div className="modal-actions">
              {updateDialog.kind === "available" ? (
                <>
                  <button type="button" onClick={() => setUpdateDialog(null)}>
                    Later
                  </button>
                  <button
                    type="button"
                    className="selected"
                    onClick={() => {
                      const releaseUrl = updateDialog.releaseUrl;
                      setUpdateDialog(null);
                      void openLatestReleasePage(releaseUrl);
                    }}
                  >
                    Download
                  </button>
                </>
              ) : updateDialog.kind === "error" ? (
                <>
                  <button type="button" onClick={() => setUpdateDialog(null)}>
                    Close
                  </button>
                  <button
                    type="button"
                    className="selected"
                    onClick={() => {
                      const releaseUrl = updateDialog.releaseUrl;
                      setUpdateDialog(null);
                      void openLatestReleasePage(releaseUrl);
                    }}
                  >
                    Open releases
                  </button>
                </>
              ) : (
                <button type="button" className="selected" onClick={() => setUpdateDialog(null)}>
                  OK
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {isNewPatternModalOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setIsNewPatternModalOpen(false)}>
          <div
            className="modal-card new-pattern-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-pattern-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="new-pattern-title">{newPatternModalMode === "save" ? "Save pattern" : "New pattern"}</h2>
              <button type="button" onClick={() => setIsNewPatternModalOpen(false)}>
                Close
              </button>
            </div>
            <form
              className="modal-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitNewPattern();
              }}
            >
              <label className="modal-form-field">
                Pattern name
                <input autoFocus type="text" value={newPatternName} onChange={(event) => setNewPatternName(event.currentTarget.value)} />
              </label>
              <div className="modal-actions">
                <button type="button" onClick={() => setIsNewPatternModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="selected">
                  {newPatternModalMode === "save" ? "Save" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      {isNewLibraryModalOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setIsNewLibraryModalOpen(false)}>
          <div
            className="modal-card new-pattern-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-library-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="new-library-title">New library</h2>
              <button type="button" onClick={() => setIsNewLibraryModalOpen(false)}>
                Close
              </button>
            </div>
            <form
              className="modal-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitNewLibrary();
              }}
            >
              <label className="modal-form-field">
                Library name
                <input autoFocus type="text" value={newLibraryName} onChange={(event) => setNewLibraryName(event.currentTarget.value)} />
              </label>
              <div className="modal-actions">
                <button type="button" onClick={() => setIsNewLibraryModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="selected">
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
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
              <h2 id="library-picker-title">Libraries & patterns</h2>
              <button type="button" onClick={() => setIsLibraryPickerOpen(false)}>
                Close
              </button>
            </div>
            <div className="pattern-picker-layout">
              <div className="picker-section">
                <div className="picker-section-label">Libraries</div>
                <div className="library-picker-list">
                  {libraries.map((library) => (
                    <div key={library.id} className="picker-list-row">
                      <button
                        type="button"
                        className={library.id === pickerLibraryId ? "selected picker-list-button" : "picker-list-button"}
                        onClick={() => {
                          setPickerLibraryId(library.id);
                          setSelectedLibraryId(library.id);
                        }}
                      >
                        {library.name}
                      </button>
                      {library.id !== "default" ? (
                        <button
                          type="button"
                          className="picker-delete-button"
                          aria-label={`Delete library ${library.name}`}
                          title={`Delete ${library.name}`}
                          onClick={() => void deleteLibraryById(library.id)}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
              <div className="pattern-picker-panel picker-section">
                <div className="pattern-picker-panel-header">
                  <div className="pattern-picker-panel-title">Patterns</div>
                </div>
                {pickerPatterns.length > 0 ? (
                  <div className="pattern-picker-list">
                    {pickerPatterns.map((pattern) => (
                      <div key={pattern.id} className="picker-list-row">
                        <button
                          type="button"
                          className={pattern.id === selectedPatternId && pattern.libraryId === selectedLibraryId ? "selected picker-list-button" : "picker-list-button"}
                          onClick={() => {
                            setSelectedLibraryId(pattern.libraryId);
                            setSelectedPatternId(pattern.id);
                            loadPattern(pattern);
                            setIsLibraryPickerOpen(false);
                          }}
                        >
                          {pattern.name}
                        </button>
                        <button
                          type="button"
                          className="picker-delete-button"
                          aria-label={`Delete pattern ${pattern.name}`}
                          title={`Delete ${pattern.name}`}
                          onClick={() => void deletePatternRecord(pattern)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="pattern-picker-empty">
                    <span>Empty lib</span>
                  </div>
                )}
              </div>
            </div>
            <div className="pattern-picker-footer">
              <button type="button" onClick={() => openNewPatternModal(pickerLibraryId)}>
                Create pattern
              </button>
              <button type="button" onClick={openNewLibraryModal}>
                Create lib
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {mobileProjectOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setMobileProjectOpen(false)}>
          <div
            className="modal-card mobile-project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-project-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="mobile-project-title">Menu</h2>
              <button type="button" onClick={() => setMobileProjectOpen(false)}>
                Close
              </button>
            </div>
            <div className="mobile-header-groups" role="tablist" aria-label="Header menu groups">
              <button
                type="button"
                role="tab"
                aria-selected={mobileHeaderSection === "pattern"}
                className={mobileHeaderSection === "pattern" ? "selected" : ""}
                onClick={() => toggleMobileHeaderSection("pattern")}
                aria-controls="mobile-header-panel"
              >
                Pattern
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mobileHeaderSection === "scale"}
                className={mobileHeaderSection === "scale" ? "selected" : ""}
                onClick={() => toggleMobileHeaderSection("scale")}
                aria-controls="mobile-header-panel"
              >
                Scale
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mobileHeaderSection === "fx"}
                className={mobileHeaderSection === "fx" ? "selected" : ""}
                onClick={() => toggleMobileHeaderSection("fx")}
                aria-controls="mobile-header-panel"
              >
                FX
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mobileHeaderSection === "utilities"}
                className={mobileHeaderSection === "utilities" ? "selected" : ""}
                onClick={() => toggleMobileHeaderSection("utilities")}
                aria-controls="mobile-header-panel"
              >
                Settings
              </button>
            </div>
            {renderMobileHeaderPanel()}
          </div>
        </div>
      ) : null}
      {shouldShowRotateOverlay ? (
        <div className="rotate-overlay">
          <p>Rotate your phone to landscape to use 303 util.</p>
        </div>
      ) : null}
      <header className="panel header-panel">
        <input ref={importRef} className="import-json-input" type="file" accept=".json,application/json" onChange={importProjectJson} />
        {isMobileViewport ? (
          <>
            <div className="mobile-header-summary">
              <img className="app-corner-icon" src={APP_ICON_SRC} alt="" aria-hidden="true" />
              <button type="button" className="mobile-app-name" onClick={() => setMobileProjectOpen(true)} aria-label="Open settings menu">
                TB-303 util
              </button>
              <button type="button" className="mobile-pattern-display pattern-picker-button" title={currentPatternLabel} onClick={openPatternPicker}>
                {currentPatternLabel}
              </button>
              <div className="mobile-summary-actions">
                <button className={`play-button ${isPlaying ? "is-stopped" : "is-playing"}`} onClick={() => setIsPlaying((v) => !v)}>
                  {isPlaying ? "Stop" : "Play"}
                </button>
                <div className="header-length-select">
                  <select
                    className="mobile-length-select"
                    aria-label="Pattern length"
                    title="Pattern length"
                    value={patternLength}
                    onChange={(event) => updateVoicePatternLength(Number(event.currentTarget.value))}
                  >
                    {PATTERN_LENGTH_OPTIONS.map((length) => {
                      return (
                        <option key={length} value={length}>
                          {length}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <button
                  type="button"
                  className={`mobile-controls-toggle ${mobileControlsOpen ? "selected" : ""}`}
                  onClick={() => setMobileControlsOpen((open) => !open)}
                  aria-expanded={mobileControlsOpen}
                  aria-controls="mobile-hardware-controls"
                >
                  {controlsToggleLabel}
                </button>
                <button
                  type="button"
                  className={mobileModifiersOpen ? "mobile-modifiers-toggle selected" : "mobile-modifiers-toggle"}
                  onClick={() => setMobileModifiersOpen((open) => !open)}
                  aria-expanded={mobileModifiersOpen}
                  aria-controls="mobile-modifier-controls"
                >
                  {modifiersToggleLabel}
                </button>
                <button type="button" className="mobile-menu-button" onClick={() => openNewPatternModal(selectedLibraryId)} aria-label="New pattern" title="New pattern">
                  New
                </button>
                <button type="button" className="mobile-menu-button" onClick={initCurrentPattern} aria-label="Init pattern" title="Init pattern">
                  Init
                </button>
                <button type="button" className="mobile-menu-button" onClick={() => void saveSelectedPattern()}>
                  Save
                </button>
                {renderAuxControls("mobile-summary-aux")}
              </div>
            </div>
          </>
        ) : (
          <div className="mobile-header-summary desktop-header-summary">
            <img className="app-corner-icon" src={APP_ICON_SRC} alt="" aria-hidden="true" />
            <button type="button" className="mobile-app-name" onClick={() => setMobileProjectOpen(true)} aria-label="Open settings menu">
              TB-303 util
            </button>
            <button type="button" className="mobile-pattern-display pattern-picker-button" title={currentPatternLabel} onClick={openPatternPicker}>
              {currentPatternLabel}
            </button>
            <div className="mobile-summary-actions">
              <button className={`play-button ${isPlaying ? "is-stopped" : "is-playing"}`} onClick={() => setIsPlaying((v) => !v)}>
                {isPlaying ? "Stop" : "Play"}
              </button>
              <button
                type="button"
                className={`tempo-action-button desktop-header-tempo-button${selectedTimingMode === "triplet" ? " is-active" : ""}`}
                aria-label={patternTimingAriaLabel}
                title={patternTimingAriaLabel}
                onClick={togglePatternTimingMode}
              >
                {patternTimingLabel}
              </button>
              <button
                type="button"
                className={`tempo-action-button desktop-header-tempo-button${halfTempoBase === null ? "" : " is-active"}`}
                onClick={toggleHalfTempo}
                aria-label="Toggle half tempo"
                aria-pressed={halfTempoBase !== null}
                title="Half speed"
              >
                1/2
              </button>
              <div className="header-length-select">
                <select
                  className="mobile-length-select"
                  aria-label="Pattern length"
                  title="Pattern length"
                  value={patternLength}
                  onChange={(event) => updateVoicePatternLength(Number(event.currentTarget.value))}
                >
                  {PATTERN_LENGTH_OPTIONS.map((length) => {
                    return (
                      <option key={length} value={length}>
                        {length}
                      </option>
                    );
                  })}
                </select>
              </div>
              <button type="button" className="mobile-menu-button" onClick={() => openNewPatternModal(selectedLibraryId)} aria-label="New pattern" title="New pattern">
                New
              </button>
              <button type="button" className="mobile-menu-button" onClick={initCurrentPattern} aria-label="Init pattern" title="Init pattern">
                Init
              </button>
              <button type="button" className="mobile-menu-button" onClick={() => void saveSelectedPattern()}>
                Save
              </button>
            </div>
          </div>
        )}
      </header>

      <div className="workspace">
        <section className="panel hardware-panel">
          <div className="hardware-scroll">
            <div
              id="mobile-hardware-controls"
              className={`knob-groups ${isMobileViewport && !mobileControlsOpen ? "mobile-collapsed" : ""}`}
            >
              {isMobileViewport ? (
                <>
                  <div className="leading-controls">
                    <div className="tempo-controls">
                      <div className="tempo-button-stack" aria-label="Tempo modifiers">
                        <button
                          type="button"
                          className={`tempo-action-button${selectedTimingMode === "triplet" ? " is-active" : ""}`}
                          aria-label={patternTimingAriaLabel}
                          title={patternTimingAriaLabel}
                          onClick={togglePatternTimingMode}
                        >
                          {patternTimingLabel}
                        </button>
                        <button
                          type="button"
                          className={`tempo-action-button${halfTempoBase === null ? "" : " is-active"}`}
                          onClick={toggleHalfTempo}
                          aria-label="Toggle half tempo"
                          aria-pressed={halfTempoBase !== null}
                        >
                          1/2
                        </button>
                      </div>
                      <div className="bpm-knob-slot">
                        <KnobControl label="BPM" min={MIN_TEMPO} max={MAX_TEMPO} value={tempo} onChange={setTempoFromKnob} />
                      </div>
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
                    {fxVisibility.delay ? (
                      <>
                        <div className="stack-control delay-sync-slot">
                          <div className="stack-control-spacer" aria-hidden="true" />
                          <div className="delay-sync-control">
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
                          </div>
                        </div>
                        <KnobControl
                          label={synthLabels.delayTime}
                          min={0}
                          max={1}
                          step={0.01}
                          value={params.delaySync ? delayTimeFromTempo(tempo, params.delaySubdivision) : params.delayTime}
                          disabled={params.delaySync}
                          onChange={(v) => updateParams({ delayTime: v })}
                          format={(v) => `${v.toFixed(2)}s`}
                        />
                        <KnobControl label={synthLabels.feedback} min={0} max={0.92} step={0.01} value={params.delayFeedback} onChange={(v) => updateParams({ delayFeedback: v })} format={(v) => `${Math.round(v * 100)}%`} />
                        <KnobControl label={synthLabels.delayMix} min={0} max={1} step={0.01} value={params.delayMix} onChange={(v) => updateParams({ delayMix: v })} format={(v) => `${Math.round(v * 100)}%`} />
                      </>
                    ) : null}
                    {fxVisibility.reverb ? <KnobControl label={synthLabels.reverb} min={0} max={1} step={0.01} value={params.reverb} onChange={(v) => updateParams({ reverb: v })} format={(v) => `${Math.round(v * 100)}%`} /> : null}
                    {fxVisibility.overdrive ? <KnobControl label={synthLabels.overdrive} min={0} max={1} step={0.01} value={params.overdrive} onChange={(v) => updateParams({ overdrive: v })} format={(v) => `${Math.round(v * 100)}%`} /> : null}
                    {fxVisibility.distortion ? <KnobControl label={synthLabels.distortion} min={0} max={1} step={0.01} value={params.distortion} onChange={(v) => updateParams({ distortion: v })} format={(v) => `${Math.round(v * 100)}%`} /> : null}
                    <div className="stack-control pattern-transpose-control" aria-label="Pattern transpose controls">
                      <div className="pattern-transpose-stack">
                        <button type="button" className="tempo-action-button" aria-label="Transpose pattern up" title="Transpose pattern up" onClick={() => transposeCurrentPattern(1)}>
                          +
                        </button>
                        <button
                          type="button"
                          className="tempo-action-button"
                          aria-label="Restore original pattern"
                          title="Restore original pattern"
                          onClick={rollbackTransposedPattern}
                          disabled={!transposeOriginRef.current}
                        >
                          0
                        </button>
                        <button type="button" className="tempo-action-button" aria-label="Transpose pattern down" title="Transpose pattern down" onClick={() => transposeCurrentPattern(-1)}>
                          -
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="leading-controls desktop-leading-controls">
                    <div className="tempo-controls">
                      <div className="bpm-knob-slot desktop-bpm-knob-slot">
                        <KnobControl label="BPM" min={MIN_TEMPO} max={MAX_TEMPO} value={tempo} onChange={setTempoFromKnob} />
                      </div>
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
                    {fxVisibility.delay ? (
                      <>
                        <div className="stack-control delay-sync-slot">
                          <div className="stack-control-spacer" aria-hidden="true" />
                          <div className="delay-sync-control">
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
                          </div>
                        </div>
                        <KnobControl
                          label="Delay Time"
                          min={0}
                          max={1}
                          step={0.01}
                          value={params.delaySync ? delayTimeFromTempo(tempo, params.delaySubdivision) : params.delayTime}
                          disabled={params.delaySync}
                          onChange={(v) => updateParams({ delayTime: v })}
                          format={(v) => `${v.toFixed(2)}s`}
                        />
                        <KnobControl label="Feedback" min={0} max={0.92} step={0.01} value={params.delayFeedback} onChange={(v) => updateParams({ delayFeedback: v })} format={(v) => `${Math.round(v * 100)}%`} />
                        <KnobControl label="Delay Mix" min={0} max={1} step={0.01} value={params.delayMix} onChange={(v) => updateParams({ delayMix: v })} format={(v) => `${Math.round(v * 100)}%`} />
                      </>
                    ) : null}
                    {fxVisibility.reverb ? <KnobControl label="Reverb" min={0} max={1} step={0.01} value={params.reverb} onChange={(v) => updateParams({ reverb: v })} format={(v) => `${Math.round(v * 100)}%`} /> : null}
                    {fxVisibility.overdrive ? <KnobControl label="Overdrive" min={0} max={1} step={0.01} value={params.overdrive} onChange={(v) => updateParams({ overdrive: v })} format={(v) => `${Math.round(v * 100)}%`} /> : null}
                    {fxVisibility.distortion ? <KnobControl label="Distortion" min={0} max={1} step={0.01} value={params.distortion} onChange={(v) => updateParams({ distortion: v })} format={(v) => `${Math.round(v * 100)}%`} /> : null}
                    <div className="stack-control pattern-transpose-control" aria-label="Pattern transpose controls">
                      <div className="pattern-transpose-stack">
                        <button type="button" className="tempo-action-button" aria-label="Transpose pattern up" title="Transpose pattern up" onClick={() => transposeCurrentPattern(1)}>
                          +
                        </button>
                        <button
                          type="button"
                          className="tempo-action-button"
                          aria-label="Restore original pattern"
                          title="Restore original pattern"
                          onClick={rollbackTransposedPattern}
                          disabled={!transposeOriginRef.current}
                        >
                          0
                        </button>
                        <button type="button" className="tempo-action-button" aria-label="Transpose pattern down" title="Transpose pattern down" onClick={() => transposeCurrentPattern(-1)}>
                          -
                        </button>
                      </div>
                    </div>
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
            <div className="roll-header">
              <div className="pitch-col">Pitch</div>
              {Array.from({ length: patternLength }, (_, s) => (
              <button
                key={s}
                className={`step-head ${playhead === s ? "playhead" : ""} ${isStepDisabledForTimingMode(s, patternLength, selectedTimingMode) ? "disabled" : ""}`.trim()}
              >
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
                    const isDisabled = isStepDisabledForTimingMode(s, patternLength, selectedTimingMode);
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
                  const isDisabled = isStepDisabledForTimingMode(s, patternLength, selectedTimingMode);
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
                  const isDisabled = isStepDisabledForTimingMode(s, patternLength, selectedTimingMode);
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
                  const isDisabled = isStepDisabledForTimingMode(s, patternLength, selectedTimingMode);
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
                  const isDisabled = isStepDisabledForTimingMode(s, patternLength, selectedTimingMode);
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
                  const isDisabled = isStepDisabledForTimingMode(s, patternLength, selectedTimingMode);
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
