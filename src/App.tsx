import { useEffect, useRef, useState, type SetStateAction } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { refreshToken as refreshNativeGoogleToken, signIn as signInWithNativeGoogle } from "@choochmeque/tauri-plugin-google-auth-api";
import packageJson from "../package.json";
import { ensureAudioGraph, playScheduledStep, prepareAudioGraph, stopAudioVoices, syncLineAudioState, type AudioLineFx } from "./audioEngine";
import {
  createMidiClockRuntime,
  type MidiClockMode,
  type MidiClockRuntime,
  type MidiInputPortInfo,
  type MidiRealtimeEvent,
} from "./midiClock";
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
type PatternSection = "A" | "B";

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

type MidiClockSettings = {
  enabled: boolean;
  mode: MidiClockMode;
  deviceId: string | null;
  delayOffsetMs: number;
};

type LineState = {
  timingMode: PatternTimingMode;
  patternLength: number;
  steps: Step[];
  params: VoiceParams;
};

type PatternSections = {
  A: LineState[];
  B: LineState[];
};

type UpdateDialogState =
  | { kind: "up-to-date"; currentVersion: string }
  | { kind: "available"; currentVersion: string; latestVersion: string; releaseUrl: string }
  | { kind: "error"; currentVersion: string; message: string; releaseUrl: string };

type ProjectData = {
  version: 1;
  programName: string;
  notes?: string;
  lineCount: 1 | 2 | 3;
  scalePresetId?: string;
  scaleRoot?: PitchClass;
  tempo: number;
  selectedLine: number;
  lines: LineState[];
  sections?: PatternSections;
  activeSection?: PatternSection;
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

type DebugMetricsState = {
  cpuPercent: number;
  cpuDetail: string;
  memoryLabel: string;
  memoryDetail: string;
};

type PerformanceMemoryInfo = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

type PerformanceWithDebugMemory = Performance & {
  memory?: PerformanceMemoryInfo;
  measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
};

type NavigatorWithDeviceMemory = Navigator & {
  deviceMemory?: number;
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
const MIDI_CLOCK_ENABLED_KEY = "tb303:midi-clock-enabled";
const MIDI_CLOCK_MODE_KEY = "tb303:midi-clock-mode";
const MIDI_CLOCK_DEVICE_ID_KEY = "tb303:midi-clock-device-id";
const MIDI_CLOCK_DELAY_OFFSET_KEY = "tb303:midi-clock-delay-offset-ms";
const DEFAULT_UNSAVED_PATTERN_NAME = "changeme";
const MAX_VISIBLE_FX = 3;
const FX_VISIBILITY_ORDER: Array<keyof FxVisibilitySettings> = ["delay", "reverb", "overdrive", "distortion"];
const DEFAULT_FX_VISIBILITY_SETTINGS: FxVisibilitySettings = {
  delay: true,
  reverb: true,
  overdrive: true,
  distortion: false,
};
const DEFAULT_MIDI_CLOCK_SETTINGS: MidiClockSettings = {
  enabled: false,
  mode: "auto",
  deviceId: null,
  delayOffsetMs: 0,
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

const makeEmptyStep = (): Step => ({
  pitch: null,
  timeMode: "rest",
  accent: false,
  slide: false,
  transpose: "none",
});

const makeLine = (): LineState => ({
  timingMode: "normal",
  patternLength: DEFAULT_PATTERN_LENGTH,
  steps: Array.from({ length: STEPS }, makeEmptyStep),
  params: defaultParams(),
});

const cloneLineStates = (source: LineState[]): LineState[] =>
  source.map((line) => ({
    ...line,
    steps: line.steps.map((step) => ({ ...step })),
    params: { ...line.params },
  }));

const makePatternSections = (lines: LineState[]): PatternSections => {
  const sectionA = cloneLineStates(lines);
  const sectionB = sectionA.map((line) => ({
    ...line,
    steps: Array.from({ length: STEPS }, makeEmptyStep),
  }));
  return {
    A: sectionA,
    B: sectionB,
  };
};

const DEFAULT_PROJECT_TEMPLATE: ProjectData = {
  version: 1,
  programName: "pattern 1",
  notes: "",
  lineCount: 2,
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
    notes: "",
    lineCount: 2,
    scalePresetId: "harmonic-minor",
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

type MobileHeaderSection = "pattern" | "scale" | "fx" | "midi" | "utilities";
type FxMenuSection = keyof FxVisibilitySettings;
type NewPatternModalMode = "create" | "save";

function KnobControl({ label, min, max, step = 1, value, onChange, format, disabled = false }: KnobProps) {
  const normalized = (value - min) / (max - min);
  const angle = -135 + normalized * 270;
  const style: React.CSSProperties & { "--angle": string } = { "--angle": `${angle}deg` };
  const [showValueOverlay, setShowValueOverlay] = useState(false);
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
    setShowValueOverlay(true);
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
    setShowValueOverlay(false);
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
    <div className={`knob-control${showValueOverlay ? " showing-value" : ""}`}>
      <span className="knob-label">{label}</span>
      <div
        className={`knob${showValueOverlay ? " showing-value" : ""}`}
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
        onLostPointerCapture={() => setShowValueOverlay(false)}
        onKeyDown={handleKeyDown}
        onBlur={() => setShowValueOverlay(false)}
      >
        <span className="knob-value">{displayValue}</span>
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

const getTieSpanLength = (steps: Step[], step: number, patternLength: number): number => {
  if (steps[step].timeMode !== "note" || !steps[step].pitch) return 1;
  let span = 1;
  for (let s = step + 1; s < patternLength; s += 1) {
    if (steps[s].timeMode !== "tie" || findBaseStep(steps, s) !== step) break;
    span += 1;
  }
  return span;
};

const getDelaySubdivisionIndex = (subdivision: DelaySubdivision): number => {
  const index = DELAY_SUBDIVISIONS.findIndex((entry) => entry.value === subdivision);
  return index === -1 ? 0 : index;
};

const getDelaySubdivisionLabel = (subdivision: DelaySubdivision): string =>
  DELAY_SUBDIVISIONS.find((entry) => entry.value === subdivision)?.label ?? DELAY_SUBDIVISIONS[0].label;

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
    const normalized = normalizeFxVisibilitySettings({
      delay: parsed.delay !== false,
      reverb: parsed.reverb !== false,
      overdrive: parsed.overdrive !== false,
      distortion: parsed.distortion === true,
    });
    if (normalized.distortion && !normalized.overdrive) {
      return {
        ...normalized,
        overdrive: true,
        distortion: false,
      };
    }
    return normalized;
  } catch {
    return DEFAULT_FX_VISIBILITY_SETTINGS;
  }
};

const loadMidiClockSettings = (): MidiClockSettings => {
  const enabled = window.localStorage.getItem(MIDI_CLOCK_ENABLED_KEY) === "1";
  const mode = window.localStorage.getItem(MIDI_CLOCK_MODE_KEY) === "device" ? "device" : "auto";
  const storedDeviceId = window.localStorage.getItem(MIDI_CLOCK_DEVICE_ID_KEY)?.trim() || "";
  const rawDelayOffset = Number(window.localStorage.getItem(MIDI_CLOCK_DELAY_OFFSET_KEY) ?? "0");
  return {
    ...DEFAULT_MIDI_CLOCK_SETTINGS,
    enabled,
    mode,
    deviceId: storedDeviceId || null,
    delayOffsetMs: Number.isFinite(rawDelayOffset) ? Math.max(-100, Math.min(100, Math.round(rawDelayOffset))) : 0,
  };
};

const stepSecondsForTimingMode = (tempo: number, mode: PatternTimingMode): number => (60 / tempo) / (mode === "triplet" ? 3 : 4);
const pulsesPerStepForTimingMode = (mode: PatternTimingMode): number => (mode === "triplet" ? 8 : 6);
const VISIBLE_SCHEDULER_LOOKAHEAD_SECONDS = 0.3;
const HIDDEN_SCHEDULER_LOOKAHEAD_SECONDS = 2.2;
const VISIBLE_SCHEDULER_INTERVAL_MS = 25;
const HIDDEN_SCHEDULER_INTERVAL_MS = 250;
const TRANSPORT_START_LEAD_SECONDS = 0.08;
const MIDI_CLOCK_DELTA_WINDOW = 12;

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
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
};

const formatDeviceMemory = (gigabytes: number): string => `${Number.isInteger(gigabytes) ? gigabytes.toFixed(0) : gigabytes.toFixed(1)} GB`;

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));

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

const wrapSheetNotes = (ctx: CanvasRenderingContext2D, notes: string, maxWidth: number): string[] => {
  const normalized = notes.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const wrapped: string[] = [];
  const paragraphs = normalized.split("\n");

  paragraphs.forEach((paragraph) => {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      wrapped.push("");
      return;
    }
    let currentLine = "";
    words.forEach((word) => {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (!currentLine || ctx.measureText(candidate).width <= maxWidth) {
        currentLine = candidate;
        return;
      }
      wrapped.push(currentLine);
      currentLine = word;
    });
    if (currentLine) wrapped.push(currentLine);
  });

  return wrapped;
};

const getSheetNotesHeight = (ctx: CanvasRenderingContext2D, notes: string, maxWidth: number): number => {
  ctx.save();
  ctx.font = "22px Arial";
  const lineCount = wrapSheetNotes(ctx, notes, maxWidth).length;
  ctx.restore();
  return lineCount === 0 ? 88 : Math.max(96, 72 + lineCount * 30);
};

const drawRoundedRectPath = (
  ctx: CanvasRenderingContext2D,
  { x, y, width, height, radius }: { x: number; y: number; width: number; height: number; radius: number },
) => {
  const cornerRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + cornerRadius, y);
  ctx.lineTo(x + width - cornerRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + cornerRadius);
  ctx.lineTo(x + width, y + height - cornerRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - cornerRadius, y + height);
  ctx.lineTo(x + cornerRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - cornerRadius);
  ctx.lineTo(x, y + cornerRadius);
  ctx.quadraticCurveTo(x, y, x + cornerRadius, y);
  ctx.closePath();
};

const drawExportKnob = (
  ctx: CanvasRenderingContext2D,
  {
    cx,
    cy,
    radius,
    label,
    normalized,
  }: { cx: number; cy: number; radius: number; label: string; normalized: number },
) => {
  const startAngle = (Math.PI * 3) / 4;
  const endAngle = (Math.PI * 9) / 4;
  const pointerAngle = startAngle + clampUnit(normalized) * (endAngle - startAngle);

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.strokeStyle = "#181818";
  ctx.lineWidth = 3;
  ctx.fillStyle = "#fffdf8";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  for (let tick = 0; tick <= 10; tick += 1) {
    const angle = startAngle + (tick / 10) * (endAngle - startAngle);
    const inner = radius + 6;
    const outer = radius + (tick % 5 === 0 ? 18 : 13);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
    ctx.stroke();
  }

  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(pointerAngle) * (radius - 10), cy + Math.sin(pointerAngle) * (radius - 10));
  ctx.stroke();

  ctx.fillStyle = "#111";
  ctx.font = "700 17px Arial";
  ctx.fillText(label, cx, cy - radius - 16);
  ctx.restore();
};

const drawWaveformPreview = (
  ctx: CanvasRenderingContext2D,
  {
    x,
    y,
    width,
    height,
    waveform,
  }: { x: number; y: number; width: number; height: number; waveform: OscillatorType },
) => {
  const itemGap = 14;
  const itemWidth = (width - itemGap) / 2;
  const variants: Array<{ key: OscillatorType }> = [
    { key: "sawtooth" },
    { key: "square" },
  ];

  variants.forEach((variant, index) => {
    const itemX = x + index * (itemWidth + itemGap);
    const active = waveform === variant.key;
    const iconWidth = itemWidth * 0.12;
    const iconHeight = height * 0.16;
    const iconLeft = itemX + (itemWidth - iconWidth) / 2;
    const iconRight = iconLeft + iconWidth;
    const iconTop = y + (height - iconHeight) / 2;
    const iconBottom = iconTop + iconHeight;
    ctx.save();
    ctx.fillStyle = active ? "#111" : "#fffdf8";
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 2.5;
    ctx.fillRect(itemX, y, itemWidth, height);
    ctx.strokeRect(itemX, y, itemWidth, height);

    ctx.strokeStyle = active ? "#fffdf8" : "#111";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    if (variant.key === "sawtooth") {
      const baseY = iconBottom;
      const topY = iconTop;
      const leftX = iconLeft;
      const middleX = (iconLeft + iconRight) / 2;
      const rightX = iconRight;
      ctx.moveTo(leftX, baseY);
      ctx.lineTo(leftX, topY);
      ctx.lineTo(middleX, baseY);
      ctx.lineTo(middleX, topY);
      ctx.lineTo(rightX, baseY);
    } else {
      const lowY = iconBottom;
      const highY = iconTop;
      const leftX = iconLeft;
      const quarter = iconWidth / 4;
      ctx.moveTo(leftX, lowY);
      ctx.lineTo(leftX, highY);
      ctx.lineTo(leftX + quarter * 2, highY);
      ctx.lineTo(leftX + quarter * 2, lowY);
      ctx.lineTo(leftX + quarter * 4, lowY);
      ctx.lineTo(leftX + quarter * 4, highY);
      ctx.lineTo(iconRight, highY);
    }
    ctx.stroke();
    ctx.restore();
  });
};

const drawTimeMarker = (
  ctx: CanvasRenderingContext2D,
  {
    x,
    y,
    width,
    height,
    timeMode,
  }: { x: number; y: number; width: number; height: number; timeMode: TimeMode },
) => {
  const centerX = x + width / 2;
  const centerY = y + height / 2;

  ctx.save();
  ctx.strokeStyle = "#111";
  ctx.fillStyle = "#111";

  if (timeMode === "note") {
    ctx.beginPath();
    ctx.arc(centerX, centerY, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (timeMode === "tie") {
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(centerX, centerY, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(centerX - 10, centerY);
  ctx.lineTo(centerX + 10, centerY);
  ctx.stroke();
  ctx.restore();
};

const drawSheetAppLogo = (
  ctx: CanvasRenderingContext2D,
  { x, y, size }: { x: number; y: number; size: number },
) => {
  const centerX = x + size / 2;
  const centerY = y + size / 2;
  const knobRadius = size * 0.42;
  const knobGradient = ctx.createRadialGradient(centerX - knobRadius * 0.18, centerY - knobRadius * 0.18, knobRadius * 0.18, centerX, centerY, knobRadius);
  knobGradient.addColorStop(0, "#f2f2f2");
  knobGradient.addColorStop(1, "#cfcfcf");

  ctx.save();
  ctx.fillStyle = "#111";
  drawRoundedRectPath(ctx, { x, y, width: size, height: size, radius: size * 0.12 });
  ctx.fill();
  ctx.fillStyle = knobGradient;
  ctx.beginPath();
  ctx.arc(centerX, centerY, knobRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#d0d0d0";
  ctx.lineWidth = Math.max(2, size * 0.035);
  ctx.stroke();
  ctx.strokeStyle = "#111";
  ctx.lineWidth = Math.max(3, size * 0.055);
  ctx.beginPath();
  ctx.moveTo(centerX, centerY);
  ctx.lineTo(centerX + size * 0.19, centerY - size * 0.19);
  ctx.stroke();
  ctx.restore();
};

const drawVoiceSheet = (
  ctx: CanvasRenderingContext2D,
  {
    width,
    height,
    voice,
    voiceIndex,
    tempo,
    programName,
    notes,
  }: { width: number; height: number; voice: LineState; voiceIndex: number; tempo: number; programName: string; notes: string },
) => {
  const margin = 36;
  const headerHeight = 132;
  const gridTop = margin + headerHeight + 20;
  const voiceLength = clampPatternLength(voice.patternLength, voice.timingMode);
  const activeSteps = voice.steps.slice(0, voiceLength);
  const rowLabels = ["NOTE", "TIME", "U/D", "ACC", "SLIDE"] as const;
  const rowHeight = 50;
  const headerRowHeight = 44;
  const labelWidth = 120;
  const gridWidth = width - margin * 2;
  const stepCellWidth = (gridWidth - labelWidth) / voiceLength;
  const footerTop = gridTop + headerRowHeight + rowLabels.length * rowHeight + 28;
  const footerHeight = 126;
  const summaryTop = footerTop + footerHeight + 24;
  const summaryHeight = getSheetNotesHeight(ctx, notes, gridWidth - 32);
  const waveformWidth = 220;
  const knobAreaX = margin + waveformWidth + 24;
  const knobAreaWidth = width - margin - knobAreaX;

  ctx.fillStyle = "#f8f6ef";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#121212";
  ctx.lineWidth = 4;
  ctx.strokeRect(12, 12, width - 24, height - 24);

  const metaWidth = 360;
  const metaX = width - margin - metaWidth;
  const brandWidth = 128;
  const brandDividerX = margin + brandWidth;
  const logoSize = 92;
  const logoX = margin + Math.round((brandWidth - logoSize) / 2);
  const logoY = margin + Math.round((headerHeight - logoSize) / 2);
  const headerTextX = brandDividerX + 24;
  const headerTitleY = margin + 60;
  const headerVoiceY = margin + 96;

  ctx.fillStyle = "#111";
  ctx.font = "700 34px Arial";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(programName.trim() || "pattern", headerTextX, headerTitleY);
  ctx.font = "700 18px Arial";
  ctx.fillText(`Voice ${voiceIndex + 1}`, headerTextX, headerVoiceY);

  ctx.strokeRect(margin, margin, width - margin * 2, headerHeight);
  drawSheetAppLogo(ctx, { x: logoX, y: logoY, size: logoSize });
  ctx.beginPath();
  ctx.moveTo(brandDividerX, margin);
  ctx.lineTo(brandDividerX, margin + headerHeight);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(metaX, margin);
  ctx.lineTo(metaX, margin + headerHeight);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(metaX, margin + 44);
  ctx.lineTo(width - margin, margin + 44);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(metaX, margin + 88);
  ctx.lineTo(width - margin, margin + 88);
  ctx.stroke();

  ctx.font = "700 18px Arial";
  ctx.fillText(`Tempo`, metaX + 16, margin + 28);
  ctx.fillText(`Timing`, metaX + 16, margin + 72);
  ctx.fillText(`Length`, metaX + 16, margin + 116);
  ctx.font = "700 28px Arial";
  ctx.fillText(`${tempo} BPM`, metaX + 120, margin + 31);
  ctx.fillText(voice.timingMode === "triplet" ? "Triplet" : "Normal", metaX + 120, margin + 75);
  ctx.fillText(String(voiceLength), metaX + 120, margin + 119);

  ctx.strokeRect(margin, gridTop, gridWidth, headerRowHeight + rowLabels.length * rowHeight);
  ctx.beginPath();
  ctx.moveTo(margin + labelWidth, gridTop);
  ctx.lineTo(margin + labelWidth, gridTop + headerRowHeight + rowLabels.length * rowHeight);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(margin, gridTop + headerRowHeight);
  ctx.lineTo(width - margin, gridTop + headerRowHeight);
  ctx.stroke();

  for (let stepIndex = 0; stepIndex < voiceLength; stepIndex += 1) {
    const x = margin + labelWidth + stepCellWidth * stepIndex;
    if (stepIndex % 4 === 0) {
      ctx.save();
      ctx.fillStyle = stepIndex % 8 === 0 ? "#efebe2" : "#f5f2eb";
      ctx.fillRect(x, gridTop + 1, stepCellWidth, headerRowHeight + rowLabels.length * rowHeight - 2);
      ctx.restore();
    }
  }

  for (let stepIndex = 0; stepIndex <= voiceLength; stepIndex += 1) {
    const x = margin + labelWidth + stepCellWidth * stepIndex;
    const isBarLine = stepIndex < voiceLength && stepIndex % 4 === 0;
    ctx.save();
    ctx.lineWidth = isBarLine ? 3 : 1.5;
    ctx.strokeStyle = "#121212";
    ctx.beginPath();
    ctx.moveTo(x, gridTop);
    ctx.lineTo(x, gridTop + headerRowHeight + rowLabels.length * rowHeight);
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#121212";
  ctx.beginPath();
  ctx.moveTo(margin, gridTop + headerRowHeight);
  ctx.lineTo(width - margin, gridTop + headerRowHeight);
  ctx.stroke();
  ctx.restore();

  for (let stepIndex = 0; stepIndex < voiceLength; stepIndex += 4) {
    const x = margin + labelWidth + stepCellWidth * stepIndex;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#121212";
    ctx.beginPath();
    ctx.moveTo(x, gridTop);
    ctx.lineTo(x, gridTop + headerRowHeight);
    ctx.stroke();
    ctx.restore();
  }

  for (let stepIndex = 0; stepIndex < voiceLength; stepIndex += 1) {
    const x = margin + labelWidth + stepCellWidth * stepIndex;
    ctx.fillStyle = "#111";
    ctx.font = "700 18px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(stepIndex + 1), x + stepCellWidth / 2, gridTop + headerRowHeight / 2);
  }

  rowLabels.forEach((rowLabel, rowIndex) => {
    const y = gridTop + headerRowHeight + rowHeight * rowIndex;
    if (rowIndex > 0) {
      ctx.beginPath();
      ctx.moveTo(margin, y);
      ctx.lineTo(width - margin, y);
      ctx.stroke();
    }
    ctx.fillStyle = "#111";
    ctx.textAlign = "left";
    ctx.font = "700 18px Arial";
    ctx.fillText(rowLabel, margin + 14, y + rowHeight / 2 + 1);

    for (let stepIndex = 0; stepIndex < voiceLength; stepIndex += 1) {
      const step = activeSteps[stepIndex];
      const x = margin + labelWidth + stepCellWidth * stepIndex;
      let value = "";
      if (rowLabel === "NOTE") value = step.timeMode === "note" && step.pitch ? shortNote(step.pitch) : step.timeMode === "tie" ? "~" : "";
      if (rowLabel === "U/D") value = step.transpose === "up" ? "U" : step.transpose === "down" ? "D" : "";
      if (rowLabel === "ACC") value = step.accent ? "x" : "";
      if (rowLabel === "SLIDE") value = step.slide ? "x" : "";
      if (rowLabel === "TIME") {
        drawTimeMarker(ctx, { x, y, width: stepCellWidth, height: rowHeight, timeMode: step.timeMode });
        continue;
      }
      if (!value) continue;
      ctx.textAlign = "center";
      ctx.font = rowLabel === "NOTE" ? "700 18px Arial" : "700 20px Arial";
      ctx.fillText(value, x + stepCellWidth / 2, y + rowHeight / 2 + 1);
    }
  });

  ctx.strokeRect(margin, summaryTop, gridWidth, summaryHeight);
  ctx.font = "700 24px Arial";
  ctx.textAlign = "left";
  ctx.fillText("Notes", margin + 16, summaryTop + 34);
  ctx.font = "22px Arial";
  wrapSheetNotes(ctx, notes, gridWidth - 32).forEach((line, index) => {
    ctx.fillText(line, margin + 16, summaryTop + 74 + index * 30);
  });

  ctx.strokeRect(margin, footerTop, waveformWidth, footerHeight);
  ctx.font = "700 16px Arial";
  ctx.fillText("Waveform", margin + 16, footerTop + 28);
  drawWaveformPreview(ctx, {
    x: margin + 16,
    y: footerTop + 38,
    width: waveformWidth - 32,
    height: footerHeight - 54,
    waveform: voice.params.waveform,
  });

  ctx.strokeRect(knobAreaX, footerTop, knobAreaWidth, footerHeight);
  const knobSpecs = [
    { label: "Cutoff", valueText: String(Math.round(voice.params.cutoff)), normalized: (voice.params.cutoff - 180) / (2400 - 180) },
    { label: "Resonance", valueText: voice.params.resonance.toFixed(1), normalized: voice.params.resonance / 22 },
    { label: "Env Mod", valueText: String(Math.round(voice.params.envMod)), normalized: voice.params.envMod / 2600 },
    { label: "Decay", valueText: voice.params.decay.toFixed(2), normalized: (voice.params.decay - 0.08) / (0.6 - 0.08) },
    { label: "Accent", valueText: voice.params.accent.toFixed(2), normalized: (voice.params.accent - 1) / (2.5 - 1) },
  ];
  const knobCenterY = footerTop + footerHeight / 2 + 8;
  const knobRadius = Math.min(24, Math.max(18, knobAreaWidth / 22));
  const knobSpacing = knobAreaWidth / knobSpecs.length;

  knobSpecs.forEach((knob, index) => {
    drawExportKnob(ctx, {
      cx: knobAreaX + knobSpacing * index + knobSpacing / 2,
      cy: knobCenterY,
      radius: knobRadius,
      label: knob.label,
      normalized: knob.normalized,
    });
  });
};

function App() {
  const midiRuntimeRef = useRef<MidiClockRuntime | null>(null);
  if (!midiRuntimeRef.current) {
    midiRuntimeRef.current = createMidiClockRuntime();
  }
  const midiRuntime = midiRuntimeRef.current;
  const [lineCount, setLineCount] = useState<1 | 2 | 3>(DEFAULT_PROJECT_STATE.lineCount);
  const [tempo, setTempo] = useState(DEFAULT_PROJECT_STATE.tempo);
  const [halfTempoBase, setHalfTempoBase] = useState<number | null>(null);
  const [programName, setProgramName] = useState(DEFAULT_PROJECT_STATE.programName);
  const [sheetNotes, setSheetNotes] = useState(DEFAULT_PROJECT_STATE.notes ?? "");
  const [scalePresetId, setScalePresetId] = useState<string>(DEFAULT_PROJECT_STATE.scalePresetId ?? "off");
  const [scaleRoot, setScaleRoot] = useState<PitchClass>(DEFAULT_PROJECT_STATE.scaleRoot ?? "C");
  const [workspaceView, setWorkspaceView] = useState<"editor" | "sheet">("editor");
  const [patternSections, setPatternSections] = useState<PatternSections>(() => makePatternSections(DEFAULT_PROJECT_STATE.lines));
  const [activePatternSection, setActivePatternSection] = useState<PatternSection>("A");
  const lines = patternSections[activePatternSection];
  const setLines = (updater: SetStateAction<LineState[]>) => {
    setPatternSections((prev) => {
      const currentLines = prev[activePatternSection];
      const nextLines = typeof updater === "function" ? (updater as (prevState: LineState[]) => LineState[])(currentLines) : updater;
      return { ...prev, [activePatternSection]: nextLines };
    });
  };
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
  const [midiClockSettings, setMidiClockSettings] = useState<MidiClockSettings>(() => loadMidiClockSettings());
  const [midiInputs, setMidiInputs] = useState<MidiInputPortInfo[]>([]);
  const [midiStatus, setMidiStatus] = useState<"idle" | "connecting" | "waiting" | "synced" | "unsupported" | "error">(
    midiRuntime.supported ? "idle" : "unsupported",
  );
  const [midiStatusMessage, setMidiStatusMessage] = useState(
    midiRuntime.supported ? "MIDI clock input is off." : "MIDI input is not supported in this runtime.",
  );
  const [midiCurrentSource, setMidiCurrentSource] = useState<MidiInputPortInfo | null>(null);
  const [midiClockTempo, setMidiClockTempo] = useState<number | null>(null);
  const [debugMetrics, setDebugMetrics] = useState<DebugMetricsState>({
    cpuPercent: 0,
    cpuDetail: "Main-thread load estimate.",
    memoryLabel: "Unavailable",
    memoryDetail: "Browser memory details are not exposed here.",
  });

  const importRef = useRef<HTMLInputElement | null>(null);
  const sheetNotesRef = useRef<HTMLTextAreaElement | null>(null);
  const voiceStepRef = useRef<number[]>(Array.from({ length: MAX_LINES }, () => 0));
  const voiceTickRef = useRef<number[]>(Array.from({ length: MAX_LINES }, () => 0));
  const nextStepTimeRef = useRef<number[]>(Array.from({ length: MAX_LINES }, () => 0));
  const transportStartTimeRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const reverbBufferRef = useRef<AudioBuffer | null>(null);
  const lineFxRef = useRef<Array<AudioLineFx | null>>(Array.from({ length: MAX_LINES }, () => null));
  const playheadRef = useRef(-1);
  const isPlayingRef = useRef(false);
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
  const midiClockSettingsRef = useRef(midiClockSettings);
  const midiClockPulseCounterRef = useRef<number[]>(Array.from({ length: MAX_LINES }, () => 0));
  const midiSourceLockRef = useRef<MidiInputPortInfo | null>(null);
  const midiLastClockTimestampRef = useRef<number | null>(null);
  const midiRecentClockDeltasRef = useRef<number[]>([]);
  const midiSmoothedTempoRef = useRef<number | null>(null);
  const midiClockTimeoutRef = useRef<number | null>(null);
  const effectiveTempoRef = useRef(tempo);
  const halfTempoBaseRef = useRef<number | null>(halfTempoBase);
  const midiTransportArmedRef = useRef<null | { resetPosition: boolean }>(null);

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

  const resetPlaybackState = (startTime = audioRef.current?.currentTime ?? 0) => {
    clearScheduledPlayheadUpdates();
    setPlayheadValue(-1);
    voiceStepRef.current.fill(0);
    voiceTickRef.current.fill(0);
    nextStepTimeRef.current.fill(startTime);
  };

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

  const clearMidiClockTimeout = () => {
    if (midiClockTimeoutRef.current !== null) {
      window.clearTimeout(midiClockTimeoutRef.current);
      midiClockTimeoutRef.current = null;
    }
  };

  const clearMidiClockTracking = (clearSourceLock = false) => {
    clearMidiClockTimeout();
    midiClockPulseCounterRef.current.fill(0);
    midiLastClockTimestampRef.current = null;
    midiRecentClockDeltasRef.current = [];
    midiTransportArmedRef.current = null;
    midiSmoothedTempoRef.current = null;
    setMidiClockTempo(null);
    if (clearSourceLock) {
      midiSourceLockRef.current = null;
      setMidiCurrentSource(null);
    }
  };

  const stopMidiTransport = (preservePosition = true, clearSourceLock = false) => {
    transportStartTimeRef.current = null;
    clearScheduledPlayheadUpdates();
    setPlayheadValue(-1);
    midiClockPulseCounterRef.current.fill(0);
    midiTransportArmedRef.current = null;
    stopAudioVoices(audioRef, lineFxRef);
    isPlayingRef.current = false;
    setIsPlaying(false);
    if (!preservePosition) {
      resetPlaybackState();
    }
    if (clearSourceLock) {
      midiSourceLockRef.current = null;
      setMidiCurrentSource(null);
    }
  };

  const updateMidiStatusForWaitingSource = (message: string) => {
    setMidiStatus("waiting");
    setMidiStatusMessage(message);
  };

  const refreshMidiInputs = async () => {
    if (!midiRuntime.supported) return;
    try {
      const inputs = await midiRuntime.refreshInputs();
      setMidiInputs(inputs);
      if (!midiClockSettingsRef.current.enabled) {
        setMidiStatus("idle");
        setMidiStatusMessage(inputs.length > 0 ? "MIDI clock input is off." : "No MIDI inputs are available yet.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not refresh MIDI inputs.";
      setMidiStatus("error");
      setMidiStatusMessage(message);
    }
  };

  const acceptMidiSourceEvent = (event: MidiRealtimeEvent): boolean => {
    const settings = midiClockSettingsRef.current;
    if (!settings.enabled) return false;

    if (settings.mode === "device") {
      if (!settings.deviceId || event.sourceId !== settings.deviceId) {
        return false;
      }
      setMidiCurrentSource({ id: event.sourceId, name: event.sourceName });
      return true;
    }

    const lockedSource = midiSourceLockRef.current;
    if (lockedSource && lockedSource.id !== event.sourceId) {
      return false;
    }
    if (!lockedSource) {
      const nextSource = { id: event.sourceId, name: event.sourceName };
      midiSourceLockRef.current = nextSource;
      setMidiCurrentSource(nextSource);
    }
    return true;
  };

  const armMidiClockTimeout = () => {
    clearMidiClockTimeout();
    midiClockTimeoutRef.current = window.setTimeout(() => {
      stopMidiTransport(true, midiClockSettingsRef.current.mode === "auto");
      clearMidiClockTracking(midiClockSettingsRef.current.mode === "auto");
      updateMidiStatusForWaitingSource(
        midiClockSettingsRef.current.mode === "device"
          ? "Waiting for MIDI clock from the selected device."
          : "Waiting for MIDI clock. Auto mode will lock to the next active source.",
      );
    }, 1500);
  };

  const setMidiClockEnabled = async (enabled: boolean) => {
    if (enabled && midiRuntime.supported) {
      transportStartTimeRef.current = null;
      isPlayingRef.current = false;
      setIsPlaying(false);
      stopAudioVoices(audioRef, lineFxRef);
      resetPlaybackState();
      clearMidiClockTracking(true);
      try {
        const graph = await prepareAudio();
        if (graph?.ctx.state === "suspended") {
          await graph.ctx.resume();
        }
      } catch {
        // Keep MIDI enablement independent from whether audio could be resumed right now.
      }
    }

    if (!enabled) {
      clearMidiClockTracking(true);
      stopMidiTransport(false, true);
      setMidiInputs([]);
      setMidiStatus(midiRuntime.supported ? "idle" : "unsupported");
      setMidiStatusMessage(midiRuntime.supported ? "MIDI clock input is off." : "MIDI input is not supported in this runtime.");
    }

    setMidiClockSettings((prev) => ({ ...prev, enabled }));
  };

  const setMidiClockUiMode = async (mode: "off" | "auto" | "device") => {
    if (mode === "off") {
      await setMidiClockEnabled(false);
      return;
    }

    if (!midiClockSettingsRef.current.enabled) {
      await setMidiClockEnabled(true);
    }

    if (midiRuntime.kind === "web") {
      await refreshMidiInputs();
    }

    clearMidiClockTracking(true);
    stopMidiTransport(true, true);
    setMidiStatus("waiting");
    setMidiStatusMessage(
      mode === "device"
        ? "Waiting for MIDI clock from the selected device."
        : "Waiting for MIDI clock. Auto mode will lock to the first active source.",
    );

    setMidiClockSettings((prev) => ({
      ...prev,
      enabled: true,
      mode: mode === "device" ? "device" : "auto",
      deviceId: prev.deviceId ?? (mode === "device" ? midiInputs[0]?.id ?? null : prev.deviceId),
    }));
  };

  const midiClockScheduleOffsetSeconds = (): number => midiClockSettingsRef.current.delayOffsetMs / 1000;

  const buildProjectSnapshot = (): ProjectData => ({
    version: 1,
    programName,
    notes: sheetNotes,
    lineCount,
    scalePresetId,
    scaleRoot,
    tempo,
    selectedLine,
    lines,
    sections: patternSections,
    activeSection: activePatternSection,
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
  const prepareAudio = () => prepareAudioGraph(audioRef, masterRef, reverbBufferRef);
  const togglePlaybackTransport = async () => {
    if (midiClockSettingsRef.current.enabled && midiSmoothedTempoRef.current !== null) {
      updateMidiStatusForWaitingSource("Playback is following the selected MIDI clock source.");
      return;
    }

    if (isPlaying) {
      transportStartTimeRef.current = null;
      isPlayingRef.current = false;
      setIsPlaying(false);
      stopAudioVoices(audioRef, lineFxRef);
      resetPlaybackState();
      return;
    }

    try {
      const graph = await prepareAudio();
      if (!graph) return;
      if (graph.ctx.state === "suspended") {
        await graph.ctx.resume();
      }
      for (let li = 0; li < lineCountRef.current; li += 1) {
        ensureAudio(li);
      }
      const transportStartTime = graph.ctx.currentTime + TRANSPORT_START_LEAD_SECONDS;
      syncAllLineAudioState(Math.max(graph.ctx.currentTime, transportStartTime - 0.05));
      transportStartTimeRef.current = transportStartTime;
      isPlayingRef.current = true;
      setIsPlaying(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start audio.";
      window.alert(message);
    }
  };

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

  const selectPatternSection = (section: PatternSection) => {
    if (section === activePatternSection) return;
    transposeOriginRef.current = null;
    setActivePatternSection(section);
    if (isPlayingRef.current) {
      resetPlaybackState();
    }
  };
  const togglePatternSection = () => {
    selectPatternSection(activePatternSection === "A" ? "B" : "A");
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
      tempo: effectiveTempoRef.current,
      audioRef,
      masterRef,
      reverbBufferRef,
      lineFxRef,
      findBaseStep,
    });
  };
  const syncAllLineAudioState = (atTime?: number) => {
    const ctx = audioRef.current;
    if (!ctx) return;
    const now = atTime ?? ctx.currentTime;
    const linesNow = linesRef.current;
    for (let li = 0; li < lineCountRef.current; li += 1) {
      syncLineAudioState({
        lineIndex: li,
        params: applyFxVisibilityToParams(linesNow[li].params),
        tempo: effectiveTempoRef.current,
        audioRef,
        masterRef,
        reverbBufferRef,
        lineFxRef,
        atTime: now,
      });
    }
  };

  const scheduleMidiStepAtTime = (lineIndex: number, stepTime: number, currentTime: number) => {
    const line = linesRef.current[lineIndex];
    if (!line) return;
    const voiceLength = clampPatternLength(line.patternLength, line.timingMode);
    const playableLength = playablePatternLengthForMode(voiceLength, line.timingMode);
    if (playableLength <= 0) return;
    const stepIndex = voiceStepRef.current[lineIndex] % playableLength;
    playStep(lineIndex, line, stepIndex, stepSecondsForTimingMode(Math.max(1, effectiveTempoRef.current), line.timingMode), stepTime);
    schedulePlayheadUpdate(lineIndex, stepIndex, stepTime, currentTime);
    voiceStepRef.current[lineIndex] += 1;
    voiceTickRef.current[lineIndex] += 1;
  };

  const startMidiTransportFromExternal = async (resetPosition: boolean) => {
    const graph = await prepareAudio();
    if (!graph) return;
    if (graph.ctx.state === "suspended") {
      try {
        await graph.ctx.resume();
      } catch {
        setMidiStatus("error");
        setMidiStatusMessage("Audio is blocked. Tap the MIDI enable button again to unlock audio output.");
        return;
      }
    }
    for (let li = 0; li < lineCountRef.current; li += 1) {
      ensureAudio(li);
    }

    const currentTime = graph.ctx.currentTime;
    syncAllLineAudioState(currentTime);

    if (resetPosition) {
      stopAudioVoices(audioRef, lineFxRef, currentTime + 0.001);
      resetPlaybackState(currentTime);
    }

    midiClockPulseCounterRef.current.fill(0);
    midiTransportArmedRef.current = { resetPosition };
    isPlayingRef.current = false;
    setIsPlaying(false);
  };

  const handleMidiRealtimeEvent = async (event: MidiRealtimeEvent) => {
    if (!acceptMidiSourceEvent(event)) return;
    const sourceLabel = event.sourceName;

    if (event.kind === "clock") {
      const previousTimestamp = midiLastClockTimestampRef.current;
      midiLastClockTimestampRef.current = event.timestampMillis;
      if (previousTimestamp !== null) {
        const delta = event.timestampMillis - previousTimestamp;
        if (delta > 1 && delta < 1000) {
          const recentDeltas = midiRecentClockDeltasRef.current;
          recentDeltas.push(delta);
          if (recentDeltas.length > MIDI_CLOCK_DELTA_WINDOW) {
            recentDeltas.shift();
          }
          const averageDelta = recentDeltas.reduce((sum, value) => sum + value, 0) / recentDeltas.length;
          const instantTempo = 60000 / (averageDelta * 24);
          const smoothedTempo =
            midiSmoothedTempoRef.current === null || recentDeltas.length < 4
              ? instantTempo
              : midiSmoothedTempoRef.current * 0.55 + instantTempo * 0.45;
          midiSmoothedTempoRef.current = smoothedTempo;
          setMidiClockTempo(smoothedTempo);
        }
      }
      armMidiClockTimeout();
      setMidiStatus("synced");
      setMidiStatusMessage(`Receiving MIDI clock from ${sourceLabel}.`);

      const ctx = audioRef.current;
      const currentTime = ctx?.currentTime ?? 0;
      const stepTime = Math.max(currentTime + 0.001, currentTime + 0.01 + midiClockScheduleOffsetSeconds());
      if (midiTransportArmedRef.current) {
        midiTransportArmedRef.current = null;
        for (let li = 0; li < lineCountRef.current; li += 1) {
          scheduleMidiStepAtTime(li, stepTime, currentTime);
        }
        isPlayingRef.current = true;
        setIsPlaying(true);
        return;
      }
      if (!isPlayingRef.current) return;
      for (let li = 0; li < lineCountRef.current; li += 1) {
        midiClockPulseCounterRef.current[li] += 1;
        const line = linesRef.current[li];
        if (!line) continue;
        const pulsesPerStep = pulsesPerStepForTimingMode(line.timingMode) * (halfTempoBaseRef.current === null ? 1 : 2);
        if (midiClockPulseCounterRef.current[li] < pulsesPerStep) continue;
        midiClockPulseCounterRef.current[li] -= pulsesPerStep;
        scheduleMidiStepAtTime(li, stepTime, currentTime);
      }
      return;
    }

    if (event.kind === "start") {
      clearMidiClockTracking(midiClockSettingsRef.current.mode === "auto");
      setMidiCurrentSource({ id: event.sourceId, name: event.sourceName });
      if (midiClockSettingsRef.current.mode === "auto") {
        midiSourceLockRef.current = { id: event.sourceId, name: event.sourceName };
      }
      updateMidiStatusForWaitingSource(`MIDI start received from ${sourceLabel}. Waiting for the first clock boundary...`);
      await startMidiTransportFromExternal(true);
      return;
    }

    if (event.kind === "continue") {
      updateMidiStatusForWaitingSource(`MIDI continue received from ${sourceLabel}. Waiting for the next clock boundary...`);
      await startMidiTransportFromExternal(false);
      return;
    }

    clearMidiClockTracking(midiClockSettingsRef.current.mode === "auto");
    stopMidiTransport(true, midiClockSettingsRef.current.mode === "auto");
    updateMidiStatusForWaitingSource(`MIDI stop received from ${sourceLabel}.`);
  };

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);
  useEffect(() => {
    midiClockSettingsRef.current = midiClockSettings;
  }, [midiClockSettings]);
  useEffect(() => {
    halfTempoBaseRef.current = halfTempoBase;
  }, [halfTempoBase]);
  useEffect(() => {
    const nextTempo =
      midiClockSettings.enabled && midiClockTempo !== null
        ? halfTempoBase === null
          ? midiClockTempo
          : midiClockTempo / 2
        : tempo;
    effectiveTempoRef.current = Math.max(1, nextTempo);
  }, [halfTempoBase, midiClockSettings.enabled, midiClockTempo, tempo]);
  useEffect(() => {
    const ctx = audioRef.current;
    if (!ctx) return;
    syncAllLineAudioState(ctx.currentTime);
  }, [fxVisibility, halfTempoBase, lineCount, lines, tempo, midiClockTempo, midiClockSettings.enabled]);
  useEffect(() => {
    lineCountRef.current = lineCount;
  }, [lineCount]);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);
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
    if (!selectedPatternId) return;
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
    if (!selectedPattern) return;
    try {
      const raw = typeof selectedPattern.project === "string" ? JSON.parse(selectedPattern.project) : selectedPattern.project;
      const parsed = validateProjectData(raw);
      if (JSON.stringify(parsed) === JSON.stringify(buildProjectSnapshot())) {
        return;
      }
    } catch {
      // Fall through and let loadPattern surface any stored-pattern issues.
    }
    loadPattern(selectedPattern);
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
    window.localStorage.setItem(MIDI_CLOCK_ENABLED_KEY, midiClockSettings.enabled ? "1" : "0");
    window.localStorage.setItem(MIDI_CLOCK_MODE_KEY, midiClockSettings.mode);
    window.localStorage.setItem(MIDI_CLOCK_DELAY_OFFSET_KEY, String(midiClockSettings.delayOffsetMs));
    if (midiClockSettings.deviceId) {
      window.localStorage.setItem(MIDI_CLOCK_DEVICE_ID_KEY, midiClockSettings.deviceId);
    } else {
      window.localStorage.removeItem(MIDI_CLOCK_DEVICE_ID_KEY);
    }
  }, [midiClockSettings]);

  useEffect(() => {
    if (!midiRuntime.supported || midiRuntime.kind !== "tauri") return;
    void refreshMidiInputs();
  }, [midiRuntime]);

  useEffect(() => {
    if (!midiClockSettings.enabled) {
      void midiRuntime.stop();
      return;
    }
    if (!midiRuntime.supported) {
      setMidiStatus("unsupported");
      setMidiStatusMessage("MIDI input is not supported in this runtime.");
      return;
    }

    let cancelled = false;
    setMidiStatus("connecting");
    setMidiStatusMessage("Connecting to MIDI inputs...");

    void (async () => {
      try {
        const result = await midiRuntime.start({
          onRealtime: (event) => {
            void handleMidiRealtimeEvent(event);
          },
          onInputsChanged: (inputs) => {
            setMidiInputs(inputs);
          },
          onError: (message) => {
            setMidiStatus("error");
            setMidiStatusMessage(message);
          },
        });
        if (cancelled) {
          return;
        }
        setMidiInputs(result.inputs);
        setMidiStatus("waiting");
        setMidiStatusMessage(
          result.inputs.length > 0
            ? midiClockSettingsRef.current.mode === "device"
              ? "Waiting for MIDI clock from the selected device."
              : "Waiting for MIDI clock. Auto mode will lock to the first active source."
            : "No MIDI inputs are available yet.",
        );
        if (midiClockSettingsRef.current.mode === "device" && !midiClockSettingsRef.current.deviceId && result.inputs[0]) {
          setMidiClockSettings((prev) => ({ ...prev, deviceId: result.inputs[0].id }));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not start MIDI input.";
        setMidiStatus("error");
        setMidiStatusMessage(message);
      }
    })();

    return () => {
      cancelled = true;
      clearMidiClockTimeout();
      void midiRuntime.stop();
    };
  }, [midiClockSettings.enabled, midiRuntime]);

  useEffect(() => {
    if (!midiClockSettings.enabled || midiRuntime.kind !== "web") return;

    let cancelled = false;
    const unlockAudio = async () => {
      const graph = await prepareAudio();
      if (cancelled || !graph || graph.ctx.state !== "suspended") return;
      try {
        await graph.ctx.resume();
      } catch {
        // Browsers can still reject resume until a later gesture; keep listening.
      }
    };
    const handleInteraction = () => {
      void unlockAudio();
    };

    window.addEventListener("pointerdown", handleInteraction, { passive: true });
    window.addEventListener("keydown", handleInteraction);

    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", handleInteraction);
      window.removeEventListener("keydown", handleInteraction);
    };
  }, [midiClockSettings.enabled, midiRuntime.kind]);

  useEffect(() => {
    if (!midiClockSettings.enabled) return;
    clearMidiClockTracking(true);
    stopMidiTransport(true, true);
    setMidiStatus("waiting");
    setMidiStatusMessage(
      midiClockSettings.mode === "device"
        ? "Waiting for MIDI clock from the selected device."
        : "Waiting for MIDI clock. Auto mode will lock to the first active source.",
    );
  }, [midiClockSettings.enabled, midiClockSettings.mode]);

  useEffect(() => {
    if (!midiClockSettings.enabled) return;
    if (midiClockSettings.mode === "device" && !midiClockSettings.deviceId && midiInputs[0]) {
      setMidiClockSettings((prev) => ({ ...prev, deviceId: midiInputs[0].id }));
      return;
    }

    if (midiClockSettings.mode === "device" && midiClockSettings.deviceId && !midiInputs.some((input) => input.id === midiClockSettings.deviceId)) {
      stopMidiTransport(true, false);
      clearMidiClockTracking(false);
      setMidiCurrentSource(null);
      setMidiStatus("waiting");
      setMidiStatusMessage("The selected MIDI input is not available.");
      return;
    }

    if (midiCurrentSource && !midiInputs.some((input) => input.id === midiCurrentSource.id)) {
      stopMidiTransport(true, midiClockSettings.mode === "auto");
      clearMidiClockTracking(midiClockSettings.mode === "auto");
      setMidiStatus("waiting");
      setMidiStatusMessage(
        midiClockSettings.mode === "device"
          ? "The selected MIDI input is not available."
          : "Waiting for MIDI clock. Auto mode will lock to the next active source.",
      );
    }
  }, [midiClockSettings.deviceId, midiClockSettings.enabled, midiClockSettings.mode, midiCurrentSource, midiInputs]);

  useEffect(() => {
    transposeOriginRef.current = null;
  }, [selectedLibraryId, selectedPatternId, activePatternSection]);
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
    if (midiClockSettings.enabled && midiClockTempo !== null) return;
    if (!isPlaying) return;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    let cancelled = false;

    void (async () => {
      const graph = await prepareAudio();
      if (cancelled) return;
      if (graph?.ctx.state === "suspended") {
        await graph.ctx.resume();
      }
      for (let li = 0; li < lineCountRef.current; li += 1) {
        ensureAudio(li);
      }

      const ctx = graph?.ctx ?? audioRef.current;
      const startTime = Math.max(transportStartTimeRef.current ?? 0, (ctx?.currentTime ?? 0) + 0.01);
      syncAllLineAudioState(Math.max(ctx?.currentTime ?? 0, startTime - 0.05));
      transportStartTimeRef.current = null;
      resetPlaybackState(startTime);
      const normalStepSeconds = stepSecondsForTimingMode(effectiveTempoRef.current, "normal");
      const tripletStepSeconds = stepSecondsForTimingMode(effectiveTempoRef.current, "triplet");
      const visibleLookaheadSeconds = VISIBLE_SCHEDULER_LOOKAHEAD_SECONDS;
      const visibleSchedulerIntervalMs = VISIBLE_SCHEDULER_INTERVAL_MS;
      const tick = () => {
        if (cancelled) return;
        const ctx = audioRef.current;
        if (!ctx) return;
        const currentTime = ctx.currentTime;
        const isHidden = document.visibilityState === "hidden";
        const scheduleUntil = currentTime + (isHidden ? HIDDEN_SCHEDULER_LOOKAHEAD_SECONDS : visibleLookaheadSeconds);
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
        timerRef.current = window.setTimeout(tick, isHidden ? HIDDEN_SCHEDULER_INTERVAL_MS : visibleSchedulerIntervalMs);
      };
      tick();
    })();
    return () => {
      cancelled = true;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      clearScheduledPlayheadUpdates();
    };
  }, [isPlaying, midiClockSettings.enabled, tempo, midiClockTempo]);

  useEffect(() => {
    if (isPlaying) return;
    stopAudioVoices(audioRef, lineFxRef);
  }, [isPlaying]);

  const buildExportDataUrl = () => {
    const exportVoiceIndices = getExportVoiceIndices(lines, lineCount);
    const sheetGap = 28;
    const sheetWidth = 1400;
    const metricsCanvas = document.createElement("canvas");
    const metricsCtx = metricsCanvas.getContext("2d");
    if (!metricsCtx) return null;
    const sheetHeight = 718 + getSheetNotesHeight(metricsCtx, sheetNotes, sheetWidth - 72 - 32);
    const canvas = document.createElement("canvas");
    canvas.width = sheetWidth;
    canvas.height = exportVoiceIndices.length * sheetHeight + Math.max(0, exportVoiceIndices.length - 1) * sheetGap;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ece7dc";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    exportVoiceIndices.forEach((voiceIndex, exportIndex) => {
      ctx.save();
      ctx.translate(0, exportIndex * (sheetHeight + sheetGap));
      drawVoiceSheet(ctx, {
        width: sheetWidth,
        height: sheetHeight,
        voice: lines[voiceIndex],
        voiceIndex,
        tempo,
        programName,
        notes: sheetNotes,
      });
      ctx.restore();
    });
    return canvas.toDataURL("image/png");
  };

  const buildSafeExportName = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const buildExportPngFileName = () => {
    const baseProgramName = programName.trim() || "program";
    const exportVoiceCount = getExportVoiceIndices(lines, lineCount).length;
    const safeProgramName = buildSafeExportName(baseProgramName);
    return `tb303-${safeProgramName || "program"}-${exportVoiceCount}voice-sheet-${Date.now()}.png`;
  };

  const saveAndroidExportPng = async (url: string) => {
    const fileName = buildExportPngFileName();
    const [, base64Data] = url.split(",", 2);
    if (!base64Data) throw new Error("Generated PNG data was empty.");
    await invoke("save_android_png", { fileName, base64Data });
    window.alert(`PNG saved to Pictures/303util as ${fileName}.`);
  };

  const generateExportPreview = () => {
    const url = buildExportDataUrl();
    if (url) setExportPreviewUrl(url);
  };
  const exportSheetPng = async (urlOverride?: string) => {
    const url = urlOverride ?? buildExportDataUrl();
    if (!url) {
      window.alert("PNG export preview could not be generated.");
      return;
    }
    setExportPreviewUrl(url);
    if (isAndroidTauriApp) {
      try {
        await saveAndroidExportPng(url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.alert(`PNG export failed: ${message}`);
      }
      return;
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = buildExportPngFileName();
    link.click();
  };
  const savePreviewPng = async () => {
    if (!exportPreviewUrl) return;
    await exportSheetPng(exportPreviewUrl);
  };

  const exportProjectJson = () => {
    const payload = buildProjectSnapshot();
    const baseProgramName = programName.trim() || "program";
    const safeProgramName = buildSafeExportName(baseProgramName);
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
    const validateLineCollection = (source: unknown, label: string): LineState[] => {
      if (!Array.isArray(source) || source.length < 1 || source.length > MAX_LINES) {
        throw new Error(`${label} must contain between 1 and ${MAX_LINES} voice entries.`);
      }
      const sourceLines = [...source];
      while (sourceLines.length < MAX_LINES) sourceLines.push(makeLine());
      return sourceLines.map((line, lineIndex): LineState => {
        if (!line || typeof line !== "object") throw new Error(`${label} voice ${lineIndex + 1} is invalid.`);
        const lineObj = line as Record<string, unknown>;
        if (!Array.isArray(lineObj.steps) || lineObj.steps.length > STEPS || lineObj.steps.length < DEFAULT_PATTERN_LENGTH) {
          throw new Error(`${label} voice ${lineIndex + 1} must have between ${DEFAULT_PATTERN_LENGTH} and ${STEPS} steps.`);
        }
        if (!lineObj.params || typeof lineObj.params !== "object") throw new Error(`${label} voice ${lineIndex + 1} params are invalid.`);
        const timingMode: PatternTimingMode =
          lineObj.timingMode === "triplet" || lineObj.timingMode === "normal" ? lineObj.timingMode : "normal";
        const patternLength = typeof lineObj.patternLength === "number" ? lineObj.patternLength : mapLegacyPatternLength(undefined);
        if (!Number.isFinite(patternLength) || patternLength < 4 || patternLength > maxPatternLengthForMode(timingMode)) {
          throw new Error(`${label} voice ${lineIndex + 1} patternLength must be between 4 and ${maxPatternLengthForMode(timingMode)}.`);
        }
        const paramsRaw = lineObj.params as Record<string, unknown>;
        if (paramsRaw.waveform !== "sawtooth" && paramsRaw.waveform !== "square") throw new Error(`${label} voice ${lineIndex + 1} waveform is invalid.`);

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
          throw new Error(`${label} voice ${lineIndex + 1} params contain invalid numbers.`);
        }

        const parsedSteps: Step[] = lineObj.steps.map((stepRaw, stepIndex) => {
          if (!stepRaw || typeof stepRaw !== "object") throw new Error(`${label} voice ${lineIndex + 1}, step ${stepIndex + 1} is invalid.`);
          const step = stepRaw as Record<string, unknown>;
          if (step.timeMode !== "note" && step.timeMode !== "tie" && step.timeMode !== "rest") {
            throw new Error(`${label} voice ${lineIndex + 1}, step ${stepIndex + 1} has invalid timeMode.`);
          }
          if (step.transpose !== "none" && step.transpose !== "down" && step.transpose !== "up") {
            throw new Error(`${label} voice ${lineIndex + 1}, step ${stepIndex + 1} has invalid transpose.`);
          }
          if (typeof step.accent !== "boolean" || typeof step.slide !== "boolean") {
            throw new Error(`${label} voice ${lineIndex + 1}, step ${stepIndex + 1} has invalid flags.`);
          }
          const pitch = step.pitch === null ? null : isPitchName(step.pitch) ? step.pitch : null;
          if (step.timeMode === "note" && !pitch) {
            throw new Error(`${label} voice ${lineIndex + 1}, step ${stepIndex + 1} note step must have a valid pitch.`);
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
    };

    const activeSection: PatternSection = data.activeSection === "B" ? "B" : "A";
    const sectionsRaw = data.sections;
    let normalizedSections: PatternSections;
    if (sectionsRaw && typeof sectionsRaw === "object") {
      const sectionRecord = sectionsRaw as Partial<Record<PatternSection, unknown>>;
      if (!sectionRecord.A || !sectionRecord.B) throw new Error("sections must include both A and B.");
      normalizedSections = {
        A: validateLineCollection(sectionRecord.A, "sections.A"),
        B: validateLineCollection(sectionRecord.B, "sections.B"),
      };
    } else {
      normalizedSections = makePatternSections(validateLineCollection(data.lines, "lines"));
    }
    const activeLines = normalizedSections[activeSection];

    return {
      version: 1,
      programName: data.programName,
      notes: typeof data.notes === "string" ? data.notes : "",
      lineCount: data.lineCount,
      scalePresetId,
      scaleRoot,
      tempo: data.tempo,
      selectedLine: Math.min(data.selectedLine, data.lineCount - 1),
      lines: activeLines,
      sections: normalizedSections,
      activeSection,
    };
  };

  const importProjectJson = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const parsed = validateProjectData(JSON.parse(text));
      setProgramName(parsed.programName);
      setSheetNotes(parsed.notes ?? "");
      setLineCount(parsed.lineCount);
      setScalePresetId(parsed.scalePresetId ?? "off");
      setScaleRoot(parsed.scaleRoot ?? "C");
      setProjectTempo(parsed.tempo);
      setSelectedLine(parsed.selectedLine);
      setPatternSections(parsed.sections ?? makePatternSections(parsed.lines));
      setActivePatternSection(parsed.activeSection ?? "A");
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

    if (!selectedPattern) {
      setNewPatternModalMode("save");
      setNewPatternName(programName.trim() || DEFAULT_UNSAVED_PATTERN_NAME);
      setNewPatternLibraryId(targetLibraryId);
      setMobileProjectOpen(false);
      setIsLibraryPickerOpen(false);
      setIsNewPatternModalOpen(true);
      return;
    }

    await savePatternRecord({
      patternId: selectedPattern.id,
      libraryId: targetLibraryId,
      name: targetName,
      createdAt: selectedPattern.createdAt,
    });
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
      setSheetNotes(parsed.notes ?? "");
      setLineCount(parsed.lineCount);
      setScalePresetId(parsed.scalePresetId ?? "off");
      setScaleRoot(parsed.scaleRoot ?? "C");
      setProjectTempo(parsed.tempo);
      setSelectedLine(parsed.selectedLine);
      setPatternSections(parsed.sections ?? makePatternSections(parsed.lines));
      setActivePatternSection(parsed.activeSection ?? "A");
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
      await exportSheetPng();
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
    const blankProject = blankProjectState();
    const currentPattern = patterns.find((pattern) => pattern.id === selectedPatternId && pattern.libraryId === selectedLibraryId);
    setIsPlaying(false);
    resetPlaybackState();
    setWorkspaceView("editor");
    setSelectedLibraryId(currentPattern?.libraryId ?? selectedLibraryId);
    setSelectedPatternId(currentPattern?.id ?? selectedPatternId);
    setProgramName(currentPattern?.name ?? programName);
    setLineCount(blankProject.lineCount);
    setScalePresetId(blankProject.scalePresetId ?? "off");
    setScaleRoot(blankProject.scaleRoot ?? "C");
    setProjectTempo(blankProject.tempo);
    setSelectedLine(blankProject.selectedLine);
    setSheetNotes(blankProject.notes ?? "");
    setPatternSections(makePatternSections(blankProject.lines));
    setActivePatternSection("A");
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
  }, [workspaceView, lines, lineCount, tempo, programName, sheetNotes]);

  useEffect(() => {
    const textarea = sheetNotesRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(52, textarea.scrollHeight)}px`;
  }, [sheetNotes, workspaceView]);

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
  useEffect(() => {
    const perf = window.performance as PerformanceWithDebugMemory;
    const nav = window.navigator as NavigatorWithDeviceMemory;
    const sampleIntervalMs = 500;
    const detailedMemoryEvery = 4;
    let cancelled = false;
    let sampling = false;
    let sampleCount = 0;
    let smoothedCpu = 0;
    let lastTick = perf.now();

    const sampleMetrics = async () => {
      if (cancelled || sampling) return;
      sampling = true;
      try {
        const now = perf.now();
        if (document.visibilityState === "hidden") {
          lastTick = now;
          if (!cancelled) {
            setDebugMetrics((prev) => ({ ...prev, cpuPercent: 0, cpuDetail: "Paused while the tab is hidden." }));
          }
          return;
        }

        const elapsedMs = now - lastTick;
        lastTick = now;
        const blockedMs = Math.max(0, elapsedMs - sampleIntervalMs);
        const instantCpu = Math.min(100, (blockedMs / sampleIntervalMs) * 100);
        smoothedCpu = smoothedCpu === 0 ? instantCpu : smoothedCpu * 0.72 + instantCpu * 0.28;
        sampleCount += 1;

        const heap = perf.memory;
        const deviceMemory = nav.deviceMemory;
        let pageBytes: number | null = null;
        if (sampleCount % detailedMemoryEvery === 0 && typeof perf.measureUserAgentSpecificMemory === "function") {
          try {
            const memoryBreakdown = await perf.measureUserAgentSpecificMemory();
            pageBytes = memoryBreakdown.bytes;
          } catch {
            pageBytes = null;
          }
        }

        const memoryParts: string[] = [];
        let memoryLabel = "Unavailable";
        if (heap) {
          const availableBytes = Math.max(0, heap.jsHeapSizeLimit - heap.usedJSHeapSize);
          memoryLabel = formatBytes(availableBytes);
          memoryParts.push(`used ${formatBytes(heap.usedJSHeapSize)}`);
          memoryParts.push(`heap ${formatBytes(availableBytes)} free`);
          memoryParts.push(`limit ${formatBytes(heap.jsHeapSizeLimit)}`);
        } else if (pageBytes !== null) {
          memoryLabel = formatBytes(pageBytes);
          memoryParts.push(`page ${formatBytes(pageBytes)}`);
        }
        if (typeof deviceMemory === "number") {
          memoryParts.push(`device ${formatDeviceMemory(deviceMemory)}`);
          if (memoryLabel === "Unavailable") {
            memoryLabel = formatDeviceMemory(deviceMemory);
          }
        }

        if (!cancelled) {
          setDebugMetrics({
            cpuPercent: Math.round(smoothedCpu),
            cpuDetail: blockedMs > 0 ? `${Math.round(blockedMs)} ms blocked over the last 0.5 s.` : "Main thread is currently keeping up.",
            memoryLabel,
            memoryDetail: memoryParts.length > 0 ? memoryParts.join(" · ") : "Browser memory details are not exposed here.",
          });
        }
      } finally {
        sampling = false;
      }
    };

    void sampleMetrics();
    const intervalId = window.setInterval(() => {
      void sampleMetrics();
    }, sampleIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const selectedTimingMode = lines[selectedLine].timingMode;
  const params = lines[selectedLine].params;
  const patternLength = clampPatternLength(lines[selectedLine].patternLength, selectedTimingMode);
  const visiblePatterns = patterns.filter((pattern) => pattern.libraryId === selectedLibraryId);
  const selectedSavedPattern = visiblePatterns.find((pattern) => pattern.id === selectedPatternId);
  const savedPatternSnapshot = (() => {
    if (!selectedSavedPattern) return null;
    try {
      const raw = typeof selectedSavedPattern.project === "string" ? JSON.parse(selectedSavedPattern.project) : selectedSavedPattern.project;
      return validateProjectData(raw);
    } catch {
      return null;
    }
  })();
  const hasUnsavedChanges =
    !savedPatternSnapshot || JSON.stringify(buildProjectSnapshot()) !== JSON.stringify(savedPatternSnapshot);
  const pickerPatterns = patterns.filter((pattern) => pattern.libraryId === pickerLibraryId);
  const shouldShowRotateOverlay = false;
  const controlsToggleLabel = "Controls";
  const modifiersToggleLabel = "Mods";
  const patternTimingLabel = selectedTimingMode === "normal" ? "♪" : "♪₃";
  const patternTimingAriaLabel = selectedTimingMode === "normal" ? "Regular note timing" : "Triplet note timing";
  const scaleEnabled = scalePresetId !== "off";
  const currentLibraryLabel = libraries.find((library) => library.id === selectedLibraryId)?.name ?? "Library";
  const currentPatternName = programName.trim() || selectedSavedPattern?.name || "Untitled";
  const currentPatternLabel = `${currentLibraryLabel} > ${currentPatternName}${hasUnsavedChanges ? " *" : ""}`;
  const isMidiClockTransportActive = midiClockSettings.enabled && midiClockTempo !== null;
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
    return "scale-outside";
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

  const renderBpmVisualizer = (extraClassName?: string) => (
    <div
      className={extraClassName ? `bpm-visualizer ${extraClassName}` : "bpm-visualizer"}
      aria-label={
        midiClockSettings.enabled && midiClockTempo !== null
          ? `External MIDI clock active at ${Math.round(effectiveTempoRef.current)} BPM`
          : `Tempo ${Math.round(effectiveTempoRef.current)} BPM`
      }
      title={midiClockSettings.enabled && midiClockTempo !== null ? `${Math.round(effectiveTempoRef.current)} BPM (MIDI)` : `${tempo} BPM`}
    >
      <span>{midiClockSettings.enabled && midiClockTempo !== null ? "EXT" : Math.round(effectiveTempoRef.current)}</span>
    </div>
  );

  const renderMidiSettingsPanel = () => {
    const runtimeLabel = midiRuntime.kind === "tauri" ? "App" : midiRuntime.kind === "web" ? "Browser" : "Unsupported";
    const manualMode = midiClockSettings.mode === "device";
    const midiUiMode: "off" | "auto" | "device" = !midiClockSettings.enabled ? "off" : manualMode ? "device" : "auto";
    const selectedDeviceAvailable = midiClockSettings.deviceId ? midiInputs.some((input) => input.id === midiClockSettings.deviceId) : false;

    return (
      <div className="mobile-group-panel" id="mobile-header-panel">
        <div className="settings-subsection">
          <div className="settings-subsection-label">MIDI</div>
          <div className="settings-helper">Choose Off, Auto, or MIDI In. Auto follows any active clock source, and MIDI In locks to the device you choose manually.</div>
          <div className="midi-status-grid">
            <div className="midi-status-card">
              <span className="debug-metric-label">Runtime</span>
              <strong className="debug-metric-value">{runtimeLabel}</strong>
              <span className="debug-metric-detail">
                {midiRuntime.supported ? "Realtime MIDI input is available here." : "This runtime cannot receive MIDI input."}
              </span>
            </div>
            <div className="midi-status-card">
              <span className="debug-metric-label">Status</span>
              <strong className="debug-metric-value">{midiStatus.toUpperCase()}</strong>
              <span className="debug-metric-detail">{midiStatusMessage}</span>
            </div>
            <div className="midi-status-card">
              <span className="debug-metric-label">Source</span>
              <strong className="debug-metric-value">{midiCurrentSource?.name ?? (midiUiMode === "device" ? "MIDI In" : midiUiMode === "auto" ? "Auto" : "Off")}</strong>
              <span className="debug-metric-detail">
                {midiCurrentSource
                  ? `${midiCurrentSource.name}${midiClockTempo !== null ? ` · ${Math.round(effectiveTempoRef.current)} BPM${halfTempoBase === null ? "" : " (1/2)"}` : ""}`
                  : midiUiMode === "off"
                    ? "MIDI clock input is disabled."
                    : manualMode
                    ? selectedDeviceAvailable
                      ? "Waiting for the selected device."
                      : "Choose the correct input device."
                    : selectedDeviceAvailable
                      ? "Auto is on. The selected device is preferred, but any active source can lock first."
                      : "Waiting to lock to the first active source."}
               </span>
             </div>
           </div>
          <div className="mobile-group-actions midi-toggle-grid">
            <button type="button" className={midiUiMode === "off" ? "selected" : ""} onClick={() => void setMidiClockUiMode("off")} disabled={!midiRuntime.supported}>
              Off
            </button>
            <button type="button" className={midiUiMode === "auto" ? "selected" : ""} onClick={() => void setMidiClockUiMode("auto")} disabled={!midiRuntime.supported}>
              Auto
            </button>
            <button type="button" className={midiUiMode === "device" ? "selected" : ""} onClick={() => void setMidiClockUiMode("device")} disabled={!midiRuntime.supported}>
              MIDI In
            </button>
            <button type="button" onClick={() => void refreshMidiInputs()} disabled={!midiRuntime.supported}>
              Refresh
            </button>
          </div>
          <label className="mobile-group-field">
            MIDI input device
            <select
              value={midiClockSettings.deviceId ?? ""}
              onChange={(event) => setMidiClockSettings((prev) => ({ ...prev, deviceId: event.currentTarget.value || null }))}
              disabled={midiUiMode === "off" || !midiRuntime.supported}
            >
              <option value="">{midiInputs.length > 0 ? "Select input" : "No MIDI inputs available"}</option>
              {midiInputs.map((input) => (
                <option key={input.id} value={input.id}>
                  {input.name}
                </option>
              ))}
            </select>
          </label>
          <label className="mobile-group-field">
            MIDI delay offset
            <input
              type="number"
              min={-100}
              max={100}
              step={1}
              value={midiClockSettings.delayOffsetMs}
              onChange={(event) =>
                setMidiClockSettings((prev) => ({
                  ...prev,
                  delayOffsetMs: Math.max(-100, Math.min(100, Math.round(Number(event.currentTarget.value) || 0))),
                }))
              }
              disabled={!midiClockSettings.enabled}
            />
          </label>
        </div>
      </div>
    );
  };

  const renderDebugPanel = () => (
    <div className="settings-subsection debug-metrics-panel">
      <div className="settings-subsection-label">Debug</div>
      <div className="settings-helper">CPU is an estimate of main-thread pressure, useful for tracking audio crackles.</div>
      <div className="debug-metrics-grid">
        <div className="debug-metric-card">
          <span className="debug-metric-label">CPU</span>
          <strong className="debug-metric-value">{debugMetrics.cpuPercent}%</strong>
          <span className="debug-metric-detail">{debugMetrics.cpuDetail}</span>
        </div>
        <div className="debug-metric-card">
          <span className="debug-metric-label">Memory</span>
          <strong className="debug-metric-value">{debugMetrics.memoryLabel}</strong>
          <span className="debug-metric-detail">{debugMetrics.memoryDetail}</span>
        </div>
      </div>
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
          <div className="fx-menu-inline-controls fx-menu-inline-controls-single">
            <button
              type="button"
              className={params.delaySync ? "selected" : ""}
              onClick={() => updateParams({ delaySync: !params.delaySync })}
              disabled={!effectEnabled}
            >
              {params.delaySync ? "Sync" : "Free"}
            </button>
          </div>
          <div className="fx-menu-knobs fx-menu-knobs-delay">
            <KnobControl
              label="Delay Time"
              min={0}
              max={params.delaySync ? DELAY_SUBDIVISIONS.length - 1 : 1}
              step={params.delaySync ? 1 : 0.01}
              value={params.delaySync ? getDelaySubdivisionIndex(params.delaySubdivision) : params.delayTime}
              disabled={!effectEnabled}
              onChange={(v) =>
                params.delaySync
                  ? updateParams({ delaySubdivision: DELAY_SUBDIVISIONS[Math.round(v)]?.value ?? DELAY_SUBDIVISIONS[0].value })
                  : updateParams({ delayTime: v })
              }
              format={(v) => (params.delaySync ? getDelaySubdivisionLabel(DELAY_SUBDIVISIONS[Math.round(v)]?.value ?? DELAY_SUBDIVISIONS[0].value) : `${v.toFixed(2)}s`)}
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
          <div className="mobile-group-field">
            Section
            <button
              type="button"
              className={`pattern-section-button${activePatternSection === "B" ? " selected" : ""}`}
              onClick={togglePatternSection}
              aria-label={`Switch to section ${activePatternSection === "A" ? "B" : "A"}`}
              title={`Switch to section ${activePatternSection === "A" ? "B" : "A"}`}
            >
              {activePatternSection}
            </button>
          </div>
          <div className="mobile-group-actions">
            <button type="button" onClick={initCurrentPattern}>
              Init
            </button>
            <button type="button" onClick={() => openNewPatternModal(selectedLibraryId)}>
              New
            </button>
            <button type="button" className={hasUnsavedChanges ? "selected" : ""} onClick={() => void saveSelectedPattern()}>
              Save
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

    if (mobileHeaderSection === "midi") {
      return renderMidiSettingsPanel();
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
        {renderDebugPanel()}
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
              <p className="update-dialog-note">This keeps the current pattern and resets its steps, controls, and modes to the init defaults.</p>
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
                aria-selected={mobileHeaderSection === "midi"}
                className={mobileHeaderSection === "midi" ? "selected" : ""}
                onClick={() => toggleMobileHeaderSection("midi")}
                aria-controls="mobile-header-panel"
              >
                MIDI
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
                {renderBpmVisualizer()}
                <button
                  className={`play-button ${isPlaying ? "is-stopped" : "is-playing"}`}
                  onClick={() => void togglePlaybackTransport()}
                  disabled={isMidiClockTransportActive}
                  title={isMidiClockTransportActive ? "Transport is controlled by MIDI clock." : undefined}
                >
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
                  className={`pattern-section-button${activePatternSection === "B" ? " selected" : ""}`}
                  onClick={togglePatternSection}
                  aria-label={`Switch to section ${activePatternSection === "A" ? "B" : "A"}`}
                  title={`Switch to section ${activePatternSection === "A" ? "B" : "A"}`}
                >
                  {activePatternSection}
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
                <button type="button" className={`mobile-menu-button${hasUnsavedChanges ? " save-button-dirty" : ""}`} onClick={() => void saveSelectedPattern()}>
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
              {renderBpmVisualizer("desktop-bpm-visualizer")}
                <button
                  className={`play-button ${isPlaying ? "is-stopped" : "is-playing"}`}
                  onClick={() => void togglePlaybackTransport()}
                  disabled={isMidiClockTransportActive}
                  title={isMidiClockTransportActive ? "Transport is controlled by MIDI clock." : undefined}
                >
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
              <button
                type="button"
                className={`pattern-section-button${activePatternSection === "B" ? " selected" : ""}`}
                onClick={togglePatternSection}
                aria-label={`Switch to section ${activePatternSection === "A" ? "B" : "A"}`}
                title={`Switch to section ${activePatternSection === "A" ? "B" : "A"}`}
              >
                {activePatternSection}
              </button>
              <button type="button" className="mobile-menu-button" onClick={() => openNewPatternModal(selectedLibraryId)} aria-label="New pattern" title="New pattern">
                New
              </button>
              <button type="button" className="mobile-menu-button" onClick={initCurrentPattern} aria-label="Init pattern" title="Init pattern">
                Init
              </button>
              <button type="button" className={`mobile-menu-button${hasUnsavedChanges ? " save-button-dirty" : ""}`} onClick={() => void saveSelectedPattern()}>
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
                      <KnobControl label={synthLabels.volume} min={0} max={0.8} step={0.01} value={params.volume} onChange={(v) => updateParams({ volume: v })} format={(v) => `${Math.round(v * 100)}%`} />
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
                          </div>
                        </div>
                        <KnobControl
                          label={synthLabels.delayTime}
                          min={0}
                          max={params.delaySync ? DELAY_SUBDIVISIONS.length - 1 : 1}
                          step={params.delaySync ? 1 : 0.01}
                          value={params.delaySync ? getDelaySubdivisionIndex(params.delaySubdivision) : params.delayTime}
                          onChange={(v) =>
                            params.delaySync
                              ? updateParams({ delaySubdivision: DELAY_SUBDIVISIONS[Math.round(v)]?.value ?? DELAY_SUBDIVISIONS[0].value })
                              : updateParams({ delayTime: v })
                          }
                          format={(v) => (params.delaySync ? getDelaySubdivisionLabel(DELAY_SUBDIVISIONS[Math.round(v)]?.value ?? DELAY_SUBDIVISIONS[0].value) : `${v.toFixed(2)}s`)}
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
                      <KnobControl label="Volume" min={0} max={0.8} step={0.01} value={params.volume} onChange={(v) => updateParams({ volume: v })} format={(v) => `${Math.round(v * 100)}%`} />
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
                          </div>
                        </div>
                        <KnobControl
                          label="Delay Time"
                          min={0}
                          max={params.delaySync ? DELAY_SUBDIVISIONS.length - 1 : 1}
                          step={params.delaySync ? 1 : 0.01}
                          value={params.delaySync ? getDelaySubdivisionIndex(params.delaySubdivision) : params.delayTime}
                          onChange={(v) =>
                            params.delaySync
                              ? updateParams({ delaySubdivision: DELAY_SUBDIVISIONS[Math.round(v)]?.value ?? DELAY_SUBDIVISIONS[0].value })
                              : updateParams({ delayTime: v })
                          }
                          format={(v) => (params.delaySync ? getDelaySubdivisionLabel(DELAY_SUBDIVISIONS[Math.round(v)]?.value ?? DELAY_SUBDIVISIONS[0].value) : `${v.toFixed(2)}s`)}
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
                    const tieBaseStep = step.timeMode === "tie" ? findBaseStep(lines[selectedLine].steps, s) : null;
                    const isTieContinuation = tieBaseStep !== null && lines[selectedLine].steps[tieBaseStep]?.pitch === pitch;
                    if (isTieContinuation) {
                      return null;
                    }
                    const tieSpanLength = isNote ? getTieSpanLength(lines[selectedLine].steps, s, patternLength) : 1;
                    return (
                      <button
                        key={`${pitch}-${s}`}
                        className={`cell ${isNote ? "note" : ""} ${tieSpanLength > 1 ? "note-span" : ""} ${isDisabled ? "disabled" : ""} ${getPitchHighlightClass(pitch)}`.trim()}
                        onClick={() => placePitch(selectedLine, s, pitch)}
                        disabled={isDisabled}
                        style={tieSpanLength > 1 ? ({ gridColumn: `span ${tieSpanLength}` } as React.CSSProperties) : undefined}
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
              <div className="lane-row modifier-row">
                <div className="lane-label">MOD</div>
                {Array.from({ length: patternLength }, (_, s) => {
                  const step = lines[selectedLine].steps[s];
                  const isDisabled = isStepDisabledForTimingMode(s, patternLength, selectedTimingMode);
                  const isNoteStep = step.timeMode === "note" && !!step.pitch;
                  const controlsDisabled = isDisabled || !isNoteStep;
                  if (!isNoteStep) {
                    return (
                      <div
                        key={`mods-${s}`}
                        className={`modifier-pad modifier-empty ${isDisabled ? "disabled" : ""}`.trim()}
                        aria-hidden="true"
                      />
                    );
                  }
                  return (
                    <div key={`mods-${s}`} className={`modifier-pad ${controlsDisabled ? "disabled" : ""}`.trim()}>
                      <button
                        type="button"
                        className={`modifier-button mod-up ${step.transpose === "up" ? "selected" : ""}`.trim()}
                        onClick={() => toggleTranspose(selectedLine, s, "up")}
                        disabled={controlsDisabled}
                        aria-label={`Step ${s + 1} up octave`}
                      >
                        U
                      </button>
                      <button
                        type="button"
                        className={`modifier-button mod-down ${step.transpose === "down" ? "selected" : ""}`.trim()}
                        onClick={() => toggleTranspose(selectedLine, s, "down")}
                        disabled={controlsDisabled}
                        aria-label={`Step ${s + 1} down octave`}
                      >
                        D
                      </button>
                      <button
                        type="button"
                        className={`modifier-button mod-accent ${step.accent ? "selected" : ""}`.trim()}
                        onClick={() => toggleFlag(selectedLine, s, "accent")}
                        disabled={controlsDisabled}
                        aria-label={`Step ${s + 1} accent`}
                      >
                        A
                      </button>
                      <button
                        type="button"
                        className={`modifier-button mod-slide ${step.slide ? "selected" : ""}`.trim()}
                        onClick={() => toggleFlag(selectedLine, s, "slide")}
                        disabled={controlsDisabled}
                        aria-label={`Step ${s + 1} slide`}
                      >
                        S
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="lane-row time-row">
                <div className="lane-label">TIME</div>
                {Array.from({ length: patternLength }, (_, s) => {
                  const step = lines[selectedLine].steps[s];
                  const isDisabled = isStepDisabledForTimingMode(s, patternLength, selectedTimingMode);
                  return (
                    <div key={`time-${s}`} className={`lane-time ${isDisabled ? "disabled" : ""}`.trim()}>
                      <button className={step.timeMode === "note" ? "selected lane-time-note" : "lane-time-note"} onClick={() => setStepMode(selectedLine, s, "note")} disabled={isDisabled}>
                        N
                      </button>
                      <button className={step.timeMode === "tie" ? "selected lane-time-tie" : "lane-time-tie"} onClick={() => setStepMode(selectedLine, s, "tie")} disabled={isDisabled}>
                        T
                      </button>
                      <button className={step.timeMode === "rest" ? "selected lane-time-rest" : "lane-time-rest"} onClick={() => setStepMode(selectedLine, s, "rest")} disabled={isDisabled}>
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
            <div className="sheet-notes-editor">
              <label htmlFor="sheet-notes">Sheet notes</label>
              <textarea
                id="sheet-notes"
                ref={sheetNotesRef}
                value={sheetNotes}
                onChange={(event) => setSheetNotes(event.currentTarget.value)}
                placeholder="Add notes for the exported sheet"
              />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

export default App;
