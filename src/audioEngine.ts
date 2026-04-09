type RefLike<T> = { current: T };

type EngineTranspose = "none" | "down" | "up";
type EnginePatternTimingMode = "normal" | "triplet";
type EngineDelaySubdivision = "1/4" | "1/4." | "1/8" | "1/8." | "1/8T" | "1/16" | "1/16." | "1/16T" | "1/32" | "1/32.";

type EngineStep = {
  pitch: string | null;
  timeMode: "note" | "tie" | "rest";
  accent: boolean;
  slide: boolean;
  transpose: EngineTranspose;
};

type EngineVoiceParams = {
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
  delaySubdivision: EngineDelaySubdivision;
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

type EngineLine = {
  timingMode: EnginePatternTimingMode;
  patternLength: number;
  steps: EngineStep[];
  params: EngineVoiceParams;
};

type NodeAudioLineVoice = {
  mode: "node";
  oscillator: OscillatorNode;
  preGain: GainNode;
  dcHighpass: BiquadFilterNode;
  filterA: BiquadFilterNode;
  filterB: BiquadFilterNode | null;
  toneHighpass: BiquadFilterNode | null;
  amp: GainNode;
  isLowPower: boolean;
  lastWaveform: OscillatorType;
  lastFrequency: number;
  lastToneHighpassFrequency: number;
  lastTune: number;
  lastGateReleaseTime: number;
};

type WorkletAudioLineVoice = {
  mode: "worklet";
  node: AudioWorkletNode;
  isLowPower: boolean;
  lastWaveform: OscillatorType;
  lastFrequency: number;
  lastToneHighpassFrequency: number;
  lastTune: number;
  lastGateReleaseTime: number;
};

type AudioLineVoice = NodeAudioLineVoice | WorkletAudioLineVoice;

export type AudioLineFx = {
  send: GainNode;
  dry: GainNode;
  output: GainNode;
  overdrive?: WaveShaperNode;
  overdriveTone?: BiquadFilterNode;
  overdriveWet?: GainNode;
  delaySend?: GainNode;
  delayWet?: GainNode;
  delay?: DelayNode;
  delayTone?: BiquadFilterNode;
  feedback?: GainNode;
  distortion?: WaveShaperNode;
  distortionTone?: BiquadFilterNode;
  distWet?: GainNode;
  reverbSend?: GainNode;
  reverbPreDelay?: DelayNode;
  reverbTone?: BiquadFilterNode;
  reverb?: ConvolverNode;
  reverbWet?: GainNode;
  voice: AudioLineVoice;
  isLowPower: boolean;
  lastDelayTime: number;
  lastFeedbackAmount: number;
  lastDelayMixAmount: number;
  lastDelayTone: number;
  lastDelayRouteAmount: number;
  lastOverdriveAmount: number;
  lastOverdriveTone: number;
  lastDistortionAmount: number;
  lastDistortionTone: number;
  lastReverbAmount: number;
  lastReverbTail: number;
  lastReverbPreDelay: number;
  lastReverbTone: number;
  lastOutputGain: number;
};

const PITCHES = ["B3", "A#3", "A3", "G#3", "G3", "F#3", "F3", "E3", "D#3", "D3", "C#3", "C3"] as const;

const DELAY_SUBDIVISION_BEATS: Record<EngineDelaySubdivision, number> = {
  "1/4": 1,
  "1/4.": 1.5,
  "1/8": 0.5,
  "1/8.": 0.75,
  "1/8T": 1 / 3,
  "1/16": 0.25,
  "1/16.": 0.375,
  "1/16T": 1 / 6,
  "1/32": 0.125,
  "1/32.": 0.1875,
};

const noteToMidi = (note: string): number => {
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

const noteToFrequency = (note: string): number => 440 * 2 ** ((noteToMidi(note) - 69) / 12);

const NOTE_FREQUENCY_BY_PITCH = Object.fromEntries(PITCHES.map((pitch) => [pitch, noteToFrequency(pitch)])) as Record<string, number>;
const MASTER_OUTPUT_GAIN = 0.68;
const LINE_OUTPUT_HEADROOM_GAIN = 0.62;
const MIN_FILTER_CUTOFF = 70;
const MAX_FILTER_CUTOFF = 5200;
const VOICE_RELEASE_SECONDS = 0.06;

const PLAYED_NOTE_FREQUENCY: Record<string, Record<EngineTranspose, number>> = Object.fromEntries(
  PITCHES.map((pitch) => [
    pitch,
    {
      none: NOTE_FREQUENCY_BY_PITCH[pitch],
      down: NOTE_FREQUENCY_BY_PITCH[pitch] / 2,
      up: NOTE_FREQUENCY_BY_PITCH[pitch] * 2,
    },
  ]),
) as Record<string, Record<EngineTranspose, number>>;

const OVERDRIVE_CURVE_CACHE = new Map<number, Float32Array>();
const DISTORTION_CURVE_CACHE = new Map<number, Float32Array>();
const REVERB_IMPULSE_CACHE = new Map<number, AudioBuffer>();
const WORKLET_PROCESSOR_NAME = "tb303-voice";
const WORKLET_MODULE_PATH = `${import.meta.env.BASE_URL}audio/tb303-voice-worklet.js`;
const WORKLET_READY_CONTEXTS = new WeakSet<AudioContext>();
const WORKLET_FAILED_CONTEXTS = new WeakSet<AudioContext>();
const WORKLET_LOADING_CONTEXTS = new WeakMap<AudioContext, Promise<boolean>>();

const isLowPowerAudioDevice = (): boolean => {
  if (typeof window === "undefined") return false;
  const compactViewport = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 980px)").matches : false;
  const mobileUserAgent = /\b(Android|iPhone|iPad|iPod|Mobile)\b/i.test(window.navigator.userAgent);
  return compactViewport || mobileUserAgent;
};

const supportsAudioWorklet = (): boolean =>
  typeof AudioWorkletNode !== "undefined" && typeof window !== "undefined" && !!window.AudioContext;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const normalize = (value: number, min: number, max: number): number => clamp((value - min) / (max - min), 0, 1);

const makeOverdriveCurve = (amount: number) => {
  const samples = 256;
  const curve = new Float32Array(samples);
  const drive = 1 + amount * 12;
  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
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

const getOverdriveCurve = (amount: number): Float32Array => {
  const cacheKey = Math.round(amount * 500);
  const cached = OVERDRIVE_CURVE_CACHE.get(cacheKey);
  if (cached) return cached;
  const curve = makeOverdriveCurve(cacheKey / 500);
  OVERDRIVE_CURVE_CACHE.set(cacheKey, curve);
  return curve;
};

const getDistortionCurve = (amount: number): Float32Array => {
  const cacheKey = Math.round(amount * 500);
  const cached = DISTORTION_CURVE_CACHE.get(cacheKey);
  if (cached) return cached;
  const curve = makeDistortionCurve(cacheKey / 500);
  DISTORTION_CURVE_CACHE.set(cacheKey, curve);
  return curve;
};

const makeImpulseResponse = (ctx: AudioContext, duration: number) => {
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const decay = (1 - i / length) ** 1.8;
      data[i] = (Math.random() * 2 - 1) * decay;
    }
  }
  return impulse;
};

const getImpulseResponse = (ctx: AudioContext, duration: number): AudioBuffer => {
  const normalizedDuration = Math.min(4, Math.max(0.4, duration));
  const cacheKey = Math.round(normalizedDuration * 10);
  const cached = REVERB_IMPULSE_CACHE.get(cacheKey);
  if (cached) return cached;
  const impulse = makeImpulseResponse(ctx, cacheKey / 10);
  REVERB_IMPULSE_CACHE.set(cacheKey, impulse);
  return impulse;
};

const ensureWorkletModule = async (ctx: AudioContext): Promise<boolean> => {
  if (WORKLET_FAILED_CONTEXTS.has(ctx)) return false;
  if (!supportsAudioWorklet() || !ctx.audioWorklet) return false;
  if (WORKLET_READY_CONTEXTS.has(ctx)) return true;
  const existing = WORKLET_LOADING_CONTEXTS.get(ctx);
  if (existing) return existing;

  const loading = ctx.audioWorklet
    .addModule(WORKLET_MODULE_PATH)
    .then(() => {
      WORKLET_READY_CONTEXTS.add(ctx);
      WORKLET_LOADING_CONTEXTS.delete(ctx);
      return true;
    })
    .catch(() => {
      WORKLET_FAILED_CONTEXTS.add(ctx);
      WORKLET_LOADING_CONTEXTS.delete(ctx);
      return false;
    });

  WORKLET_LOADING_CONTEXTS.set(ctx, loading);
  return loading;
};

const makeNodeVoice = (ctx: AudioContext, send: GainNode, lowPower = false): NodeAudioLineVoice => {
  const oscillator = ctx.createOscillator();
  const preGain = ctx.createGain();
  const dcHighpass = ctx.createBiquadFilter();
  const filterA = ctx.createBiquadFilter();
  const filterB = lowPower ? null : ctx.createBiquadFilter();
  const toneHighpass = lowPower ? null : ctx.createBiquadFilter();
  const amp = ctx.createGain();

  oscillator.type = "sawtooth";
  oscillator.frequency.value = 110;
  preGain.gain.value = 0.82;
  dcHighpass.type = "highpass";
  dcHighpass.frequency.value = 26;
  filterA.type = "lowpass";
  filterA.frequency.value = 320;
  filterA.Q.value = 1.1;
  if (filterB) {
    filterB.type = "lowpass";
    filterB.frequency.value = 280;
    filterB.Q.value = 0.9;
  }
  if (toneHighpass) {
    toneHighpass.type = "highpass";
    toneHighpass.frequency.value = 34;
  }
  amp.gain.value = 0.00001;

  oscillator.connect(preGain);
  preGain.connect(dcHighpass);
  dcHighpass.connect(filterA);
  if (filterB && toneHighpass) {
    filterA.connect(filterB);
    filterB.connect(toneHighpass);
    toneHighpass.connect(amp);
  } else {
    filterA.connect(amp);
  }
  amp.connect(send);
  oscillator.start();

  return {
    mode: "node",
    oscillator,
    preGain,
    dcHighpass,
    filterA,
    filterB,
    toneHighpass,
    amp,
    isLowPower: lowPower,
    lastWaveform: "sawtooth",
    lastFrequency: 110,
    lastToneHighpassFrequency: toneHighpass?.frequency.value ?? 0,
    lastTune: 0,
    lastGateReleaseTime: 0,
  };
};

const makeWorkletVoice = (ctx: AudioContext, send: GainNode, lowPower = false): WorkletAudioLineVoice => {
  const node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { lowPower },
  });
  node.connect(send);

  return {
    mode: "worklet",
    node,
    isLowPower: lowPower,
    lastWaveform: "sawtooth",
    lastFrequency: 110,
    lastToneHighpassFrequency: 0,
    lastTune: 0,
    lastGateReleaseTime: 0,
  };
};

export const delayTimeFromTempo = (tempo: number, subdivision: EngineDelaySubdivision): number =>
  (60 / tempo) * (DELAY_SUBDIVISION_BEATS[subdivision] ?? 0.5);

const playablePatternLengthForMode = (patternLength: number, mode: EnginePatternTimingMode): number =>
  mode === "triplet" ? Math.max(1, patternLength - Math.floor(patternLength / 4)) : patternLength;

const audioParamChanged = (previous: number, next: number, threshold = 0.002): boolean =>
  !Number.isFinite(previous) || Math.abs(previous - next) > threshold;

const holdAudioParam = (param: AudioParam, now: number) => {
  const paramWithHold = param as AudioParam & Partial<{ cancelAndHoldAtTime: (time: number) => void }>;
  if (typeof paramWithHold.cancelAndHoldAtTime === "function") {
    paramWithHold.cancelAndHoldAtTime(now);
    return;
  }
  param.cancelScheduledValues(now);
};

const smoothAudioParam = (param: AudioParam, next: number, now: number, rampSeconds = 0.03) => {
  holdAudioParam(param, now);
  param.linearRampToValueAtTime(next, now + rampSeconds);
};

const voiceWaveformForParams = (waveform: OscillatorType): OscillatorType => (waveform === "square" ? "square" : "sawtooth");

const tuneMultiplier = (tune: number): number => 2 ** (tune / 12);

const cutoffContour = (params: EngineVoiceParams, accented: boolean) => {
  const cutoffNorm = normalize(params.cutoff, 180, 2400);
  const resonanceNorm = normalize(params.resonance, 0, 22);
  const accentNorm = accented ? normalize(params.accent, 1, 2.5) : 0;
  const base = MIN_FILTER_CUTOFF + cutoffNorm ** 2.05 * 1900 + resonanceNorm * 110;
  const envDepth = 160 + params.envMod * (0.82 + accentNorm * 0.48);
  const peak = clamp(base + envDepth, base + 60, MAX_FILTER_CUTOFF);
  const tail = clamp(base * (0.66 + resonanceNorm * 0.06) + accentNorm * 90, MIN_FILTER_CUTOFF, MAX_FILTER_CUTOFF * 0.82);
  const qA = 0.9 + resonanceNorm ** 1.45 * 21;
  const qB = 0.85 + resonanceNorm ** 1.2 * 8.5;
  return { base, peak, tail, qA, qB };
};

const ampContour = (params: EngineVoiceParams, accented: boolean) => {
  const accentNorm = accented ? normalize(params.accent, 1, 2.5) : 0;
  const attackSeconds = accented ? 0.0025 : 0.0035;
  const decaySeconds = clamp(params.decay * (accented ? 0.9 : 1), 0.06, 0.8);
  const sustainFloor = 0.18 + accentNorm * 0.1;
  const peak = clamp(params.volume * (accented ? 1.06 + accentNorm * 0.12 : 1), 0, 0.72);
  return { attackSeconds, decaySeconds, sustainFloor, peak };
};

const filterHoldTime = (gateSeconds: number): number => Math.max(0.025, gateSeconds * 0.18);
const slideSecondsForParams = (params: EngineVoiceParams): number => clamp(0.11 + params.decay * 0.1, 0.11, 0.16);

const setVoiceWaveform = (voice: AudioLineVoice, waveform: OscillatorType) => {
  const nextWaveform = voiceWaveformForParams(waveform);
  if (voice.lastWaveform === nextWaveform) return;
  if (voice.mode === "node") {
    voice.oscillator.type = nextWaveform;
    voice.preGain.gain.value = nextWaveform === "square" ? 0.72 : 0.82;
  } else {
    voice.node.port.postMessage({ type: "waveform", waveform: nextWaveform });
  }
  voice.lastWaveform = nextWaveform;
};

const releaseVoiceAtTime = (voice: AudioLineVoice, time: number, releaseSeconds = VOICE_RELEASE_SECONDS) => {
  const safeTime = Math.max(time, 0);
  if (voice.mode === "node") {
    holdAudioParam(voice.amp.gain, safeTime);
    voice.amp.gain.setTargetAtTime(0.00001, safeTime, Math.max(0.01, releaseSeconds * 0.35));
  } else {
    voice.node.port.postMessage({ type: "release", time: safeTime, releaseSeconds });
  }
  voice.lastGateReleaseTime = safeTime + releaseSeconds;
};

const getPreviousSoundingBaseStep = <TStep extends EngineStep>(
  steps: TStep[],
  stepIndex: number,
  findBaseStep: (steps: TStep[], step: number) => number | null,
): number | null => {
  if (stepIndex <= 0) return null;
  if (steps[stepIndex - 1].timeMode === "rest") return null;
  return findBaseStep(steps, stepIndex - 1);
};

const shouldSlideIntoStep = <TStep extends EngineStep>(
  steps: TStep[],
  stepIndex: number,
  findBaseStep: (steps: TStep[], step: number) => number | null,
): boolean => {
  const current = steps[stepIndex];
  if (current.timeMode !== "note" || !current.pitch) return false;
  const previousBaseStep = getPreviousSoundingBaseStep(steps, stepIndex, findBaseStep);
  if (previousBaseStep === null) return false;
  const previous = steps[previousBaseStep];
  return previous.timeMode === "note" && !!previous.pitch && previous.slide;
};

const getSequencedGateSteps = <TStep extends EngineStep>(
  steps: TStep[],
  stepIndex: number,
  playableLength: number,
  findBaseStep: (steps: TStep[], step: number) => number | null,
): number => {
  let noteSteps = 1;
  for (let s = stepIndex + 1; s < playableLength; s += 1) {
    if (steps[s].timeMode === "tie") {
      noteSteps += 1;
      continue;
    }
    break;
  }

  let gateSteps = noteSteps;
  let sourceStepIndex = stepIndex;
  let cursor = stepIndex + noteSteps;
  while (cursor < playableLength) {
    const sourceStep = steps[sourceStepIndex];
    if (sourceStep.timeMode !== "note" || !sourceStep.pitch || !sourceStep.slide) break;
    const next = steps[cursor];
    if (next.timeMode !== "note" || !next.pitch || !shouldSlideIntoStep(steps, cursor, findBaseStep)) break;
    gateSteps += 1;
    sourceStepIndex = cursor;
    cursor += 1;
    while (cursor < playableLength && steps[cursor].timeMode === "tie") {
      gateSteps += 1;
      cursor += 1;
    }
  }

  return gateSteps;
};

export const ensureAudioGraph = (
  audioRef: RefLike<AudioContext | null>,
  masterRef: RefLike<GainNode | null>,
  reverbBufferRef: RefLike<AudioBuffer | null>,
  lineFxRef: RefLike<Array<AudioLineFx | null>>,
  lineIndex?: number,
) => {
  const Ctx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  const lowPower = isLowPowerAudioDevice();
  if (!audioRef.current || !masterRef.current) {
    const ctx = lowPower ? new Ctx({ latencyHint: "playback" }) : new Ctx();
    const master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    master.gain.value = MASTER_OUTPUT_GAIN;
    limiter.threshold.value = -20;
    limiter.knee.value = 12;
    limiter.ratio.value = 5;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.22;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    audioRef.current = ctx;
    masterRef.current = master;
    reverbBufferRef.current = getImpulseResponse(ctx, 2.0);
  }
  const ctx = audioRef.current;
  if (!ctx) return null;
  const shouldWaitForWorklet = supportsAudioWorklet() && !WORKLET_READY_CONTEXTS.has(ctx) && !WORKLET_FAILED_CONTEXTS.has(ctx);
  if (shouldWaitForWorklet && !WORKLET_LOADING_CONTEXTS.has(ctx)) {
    void ensureWorkletModule(ctx);
  }
  if (typeof lineIndex === "number" && !lineFxRef.current[lineIndex]) {
    const master = masterRef.current;
    if (!master) return null;
    if (shouldWaitForWorklet) return { ctx };
    const send = ctx.createGain();
    const dry = ctx.createGain();
    const output = ctx.createGain();
    const voice = WORKLET_READY_CONTEXTS.has(ctx) ? makeWorkletVoice(ctx, send, lowPower) : makeNodeVoice(ctx, send, lowPower);

    send.connect(dry);
    dry.connect(output);
    output.connect(master);
    dry.gain.value = 1;
    output.gain.value = LINE_OUTPUT_HEADROOM_GAIN;

    const baseFx: AudioLineFx = {
      send,
      dry,
      output,
      voice,
      isLowPower: lowPower,
      lastDelayTime: Number.NaN,
      lastFeedbackAmount: Number.NaN,
      lastDelayMixAmount: Number.NaN,
      lastDelayTone: Number.NaN,
      lastDelayRouteAmount: Number.NaN,
      lastOverdriveAmount: -1,
      lastOverdriveTone: Number.NaN,
      lastDistortionAmount: -1,
      lastDistortionTone: Number.NaN,
      lastReverbAmount: Number.NaN,
      lastReverbTail: Number.NaN,
      lastReverbPreDelay: Number.NaN,
      lastReverbTone: Number.NaN,
      lastOutputGain: Number.NaN,
    };

    if (!lowPower) {
      const overdrive = ctx.createWaveShaper();
      const overdriveTone = ctx.createBiquadFilter();
      const overdriveWet = ctx.createGain();
      const delaySend = ctx.createGain();
      const delayWet = ctx.createGain();
      const delay = ctx.createDelay(1.0);
      const delayTone = ctx.createBiquadFilter();
      const feedback = ctx.createGain();
      const distortion = ctx.createWaveShaper();
      const distortionTone = ctx.createBiquadFilter();
      const distWet = ctx.createGain();
      const reverbSend = ctx.createGain();
      const reverbPreDelay = ctx.createDelay(0.2);
      const reverbTone = ctx.createBiquadFilter();
      const reverb = ctx.createConvolver();
      const reverbWet = ctx.createGain();

      send.connect(overdrive);
      overdrive.connect(overdriveTone);
      overdriveTone.connect(overdriveWet);
      overdriveWet.connect(output);
      overdriveTone.connect(distortion);
      distortion.connect(distortionTone);
      distortionTone.connect(distWet);
      distWet.connect(output);
      distortionTone.connect(delaySend);
      distortionTone.connect(reverbSend);

      delaySend.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(delayTone);
      delayTone.connect(delayWet);
      delayWet.connect(output);

      reverbSend.connect(reverbPreDelay);
      reverbPreDelay.connect(reverbTone);
      reverbTone.connect(reverb);
      reverb.connect(reverbWet);
      reverbWet.connect(output);

      overdrive.oversample = "2x";
      distortion.oversample = "4x";
      overdriveTone.type = "lowpass";
      distortionTone.type = "lowpass";
      delayTone.type = "lowpass";
      reverbTone.type = "lowpass";
      reverb.buffer = reverbBufferRef.current;
      overdriveWet.gain.value = 0;
      delaySend.gain.value = 0;
      delayWet.gain.value = 0;
      feedback.gain.value = 0;
      distWet.gain.value = 0;
      reverbSend.gain.value = 0;
      reverbWet.gain.value = 0;

      Object.assign(baseFx, {
        overdrive,
        overdriveTone,
        overdriveWet,
        delaySend,
        delayWet,
        delay,
        delayTone,
        feedback,
        distortion,
        distortionTone,
        distWet,
        reverbSend,
        reverbPreDelay,
        reverbTone,
        reverb,
        reverbWet,
      });
    }

    lineFxRef.current[lineIndex] = baseFx;
  }
  return { ctx };
};

export const prepareAudioGraph = async (
  audioRef: RefLike<AudioContext | null>,
  masterRef: RefLike<GainNode | null>,
  reverbBufferRef: RefLike<AudioBuffer | null>,
) => {
  const graph = ensureAudioGraph(audioRef, masterRef, reverbBufferRef, { current: [] });
  const ctx = graph?.ctx ?? audioRef.current;
  if (!ctx) return null;
  await ensureWorkletModule(ctx);
  return { ctx };
};

const ensureOverdriveFx = (ctx: AudioContext, fx: AudioLineFx) => {
  if (fx.overdrive && fx.overdriveTone && fx.overdriveWet) return;
  const overdrive = ctx.createWaveShaper();
  const overdriveTone = ctx.createBiquadFilter();
  const overdriveWet = ctx.createGain();
  fx.send.connect(overdrive);
  overdrive.connect(overdriveTone);
  overdriveTone.connect(overdriveWet);
  overdriveWet.connect(fx.output);
  overdrive.oversample = fx.isLowPower ? "none" : "2x";
  overdriveTone.type = "lowpass";
  overdriveWet.gain.value = 0;
  fx.overdrive = overdrive;
  fx.overdriveTone = overdriveTone;
  fx.overdriveWet = overdriveWet;
};

const ensureDelayFx = (ctx: AudioContext, fx: AudioLineFx) => {
  if (fx.delaySend && fx.delayWet && fx.delay && fx.delayTone && fx.feedback) return;
  const delaySend = ctx.createGain();
  const delayWet = ctx.createGain();
  const delay = ctx.createDelay(1.0);
  const delayTone = ctx.createBiquadFilter();
  const feedback = ctx.createGain();
  fx.send.connect(delaySend);
  delaySend.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(delayTone);
  delayTone.connect(delayWet);
  delayWet.connect(fx.output);
  delaySend.gain.value = 0;
  delayWet.gain.value = 0;
  feedback.gain.value = 0;
  delayTone.type = "lowpass";
  fx.delaySend = delaySend;
  fx.delayWet = delayWet;
  fx.delay = delay;
  fx.delayTone = delayTone;
  fx.feedback = feedback;
};

const ensureDistortionFx = (ctx: AudioContext, fx: AudioLineFx) => {
  if (fx.distortion && fx.distortionTone && fx.distWet) return;
  const distortion = ctx.createWaveShaper();
  const distortionTone = ctx.createBiquadFilter();
  const distWet = ctx.createGain();
  fx.send.connect(distortion);
  distortion.connect(distortionTone);
  distortionTone.connect(distWet);
  distWet.connect(fx.output);
  distortion.oversample = fx.isLowPower ? "none" : "4x";
  distortionTone.type = "lowpass";
  distWet.gain.value = 0;
  fx.distortion = distortion;
  fx.distortionTone = distortionTone;
  fx.distWet = distWet;
};

const ensureReverbFx = (ctx: AudioContext, fx: AudioLineFx, buffer: AudioBuffer | null) => {
  if (fx.reverbSend && fx.reverbPreDelay && fx.reverbTone && fx.reverb && fx.reverbWet) return;
  const reverbSend = ctx.createGain();
  const reverbPreDelay = ctx.createDelay(0.2);
  const reverbTone = ctx.createBiquadFilter();
  const reverb = ctx.createConvolver();
  const reverbWet = ctx.createGain();
  fx.send.connect(reverbSend);
  reverbSend.connect(reverbPreDelay);
  reverbPreDelay.connect(reverbTone);
  reverbTone.connect(reverb);
  reverb.connect(reverbWet);
  reverbWet.connect(fx.output);
  reverbTone.type = "lowpass";
  reverb.buffer = buffer;
  reverbSend.gain.value = 0;
  reverbWet.gain.value = 0;
  fx.reverbSend = reverbSend;
  fx.reverbPreDelay = reverbPreDelay;
  fx.reverbTone = reverbTone;
  fx.reverb = reverb;
  fx.reverbWet = reverbWet;
};

export const syncLineAudioState = ({
  lineIndex,
  params,
  tempo,
  audioRef,
  masterRef,
  reverbBufferRef,
  lineFxRef,
  atTime,
}: {
  lineIndex: number;
  params: EngineVoiceParams;
  tempo: number;
  audioRef: RefLike<AudioContext | null>;
  masterRef: RefLike<GainNode | null>;
  reverbBufferRef: RefLike<AudioBuffer | null>;
  lineFxRef: RefLike<Array<AudioLineFx | null>>;
  atTime?: number;
}) => {
  let ctx = audioRef.current;
  let fx = lineFxRef.current[lineIndex];
  if ((!ctx || !fx) && audioRef.current) {
    const graph = ensureAudioGraph(audioRef, masterRef, reverbBufferRef, lineFxRef, lineIndex);
    if (!graph) return null;
    ctx = graph.ctx;
    fx = lineFxRef.current[lineIndex];
  }
  if (!ctx || !fx) return null;

  const now = atTime ?? ctx.currentTime;
  const outputGain = params.volume <= 0.0001 ? 0 : LINE_OUTPUT_HEADROOM_GAIN;
  if (audioParamChanged(fx.lastOutputGain, outputGain, 0.0005)) {
    smoothAudioParam(fx.output.gain, outputGain, now, 0.03);
    fx.lastOutputGain = outputGain;
  }

  setVoiceWaveform(fx.voice, params.waveform);
  const toneHighpassFrequency = params.waveform === "square" ? 44 : 34;
  if (fx.voice.mode === "node" && fx.voice.toneHighpass && audioParamChanged(fx.voice.lastToneHighpassFrequency, toneHighpassFrequency, 0.5)) {
    smoothAudioParam(fx.voice.toneHighpass.frequency, toneHighpassFrequency, now, 0.02);
    fx.voice.lastToneHighpassFrequency = toneHighpassFrequency;
  }

  const delayTime = params.delaySync ? delayTimeFromTempo(tempo, params.delaySubdivision) : params.delayTime;
  const nextDelayTime = Math.min(1, Math.max(0, delayTime));
  const feedbackAmount = Math.min(0.92, Math.max(0, params.delayFeedback));
  const delayMixAmount = Math.min(1, Math.max(0, params.delayMix));
  const delayToneFrequency = Math.min(12000, Math.max(800, params.delayTone));
  const delayRouteAmount = delayMixAmount;
  const delayEnabled = delayMixAmount > 0.002 || feedbackAmount > 0.002;
  if (delayEnabled) {
    ensureDelayFx(ctx, fx);
  }
  if (fx.delay && audioParamChanged(fx.lastDelayTime, nextDelayTime, 0.0005)) {
    smoothAudioParam(fx.delay.delayTime, nextDelayTime, now, 0.04);
    fx.lastDelayTime = nextDelayTime;
  }
  if (fx.feedback && audioParamChanged(fx.lastFeedbackAmount, delayEnabled ? feedbackAmount : 0)) {
    smoothAudioParam(fx.feedback.gain, delayEnabled ? feedbackAmount : 0, now, 0.04);
    fx.lastFeedbackAmount = delayEnabled ? feedbackAmount : 0;
  }
  if (fx.delayWet && audioParamChanged(fx.lastDelayMixAmount, delayEnabled ? delayMixAmount : 0)) {
    smoothAudioParam(fx.delayWet.gain, delayEnabled ? delayMixAmount : 0, now, 0.035);
    fx.lastDelayMixAmount = delayEnabled ? delayMixAmount : 0;
  }
  if (fx.delayTone && audioParamChanged(fx.lastDelayTone, delayToneFrequency, 40)) {
    smoothAudioParam(fx.delayTone.frequency, delayToneFrequency, now, 0.035);
    fx.lastDelayTone = delayToneFrequency;
  }
  if (fx.delaySend && audioParamChanged(fx.lastDelayRouteAmount, delayEnabled ? delayRouteAmount : 0)) {
    smoothAudioParam(fx.delaySend.gain, delayEnabled ? delayRouteAmount : 0, now, 0.035);
    fx.lastDelayRouteAmount = delayEnabled ? delayRouteAmount : 0;
  }

  const overdriveAmount = Math.min(1, Math.max(0, params.overdrive));
  if (overdriveAmount > 0.002) {
    ensureOverdriveFx(ctx, fx);
  }
  if (fx.overdrive && fx.overdriveWet && Math.abs(fx.lastOverdriveAmount - overdriveAmount) > 0.002) {
    fx.overdrive.curve = overdriveAmount <= 0.002 ? null : getOverdriveCurve(overdriveAmount);
    smoothAudioParam(fx.overdriveWet.gain, overdriveAmount, now, 0.03);
    fx.lastOverdriveAmount = overdriveAmount;
  }
  const overdriveToneFrequency = Math.min(14000, Math.max(800, params.overdriveTone));
  if (fx.overdriveTone && audioParamChanged(fx.lastOverdriveTone, overdriveToneFrequency, 40)) {
    smoothAudioParam(fx.overdriveTone.frequency, overdriveToneFrequency, now, 0.035);
    fx.lastOverdriveTone = overdriveToneFrequency;
  }
  const distortionAmount = Math.min(1, Math.max(0, params.distortion));
  if (distortionAmount > 0.002) {
    ensureDistortionFx(ctx, fx);
  }
  if (fx.distortion && fx.distWet && Math.abs(fx.lastDistortionAmount - distortionAmount) > 0.002) {
    fx.distortion.curve = distortionAmount <= 0.002 ? null : getDistortionCurve(distortionAmount);
    smoothAudioParam(fx.distWet.gain, distortionAmount, now, 0.03);
    fx.lastDistortionAmount = distortionAmount;
  }
  const distortionToneFrequency = Math.min(14000, Math.max(800, params.distortionTone));
  if (fx.distortionTone && audioParamChanged(fx.lastDistortionTone, distortionToneFrequency, 40)) {
    smoothAudioParam(fx.distortionTone.frequency, distortionToneFrequency, now, 0.035);
    fx.lastDistortionTone = distortionToneFrequency;
  }
  const reverbAmount = Math.min(1, Math.max(0, params.reverb));
  const reverbTail = Math.min(4, Math.max(0.4, params.reverbTail));
  const reverbPreDelay = Math.min(0.18, Math.max(0, params.reverbPreDelay));
  const reverbToneFrequency = Math.min(12000, Math.max(800, params.reverbTone));
  if (reverbAmount > 0.002) {
    ensureReverbFx(ctx, fx, reverbBufferRef.current);
  }
  if (fx.reverb && audioParamChanged(fx.lastReverbTail, reverbTail, 0.05)) {
    fx.reverb.buffer = getImpulseResponse(ctx, reverbTail);
    fx.lastReverbTail = reverbTail;
  }
  if (fx.reverbPreDelay && audioParamChanged(fx.lastReverbPreDelay, reverbPreDelay, 0.002)) {
    smoothAudioParam(fx.reverbPreDelay.delayTime, reverbPreDelay, now, 0.04);
    fx.lastReverbPreDelay = reverbPreDelay;
  }
  if (fx.reverbTone && audioParamChanged(fx.lastReverbTone, reverbToneFrequency, 40)) {
    smoothAudioParam(fx.reverbTone.frequency, reverbToneFrequency, now, 0.035);
    fx.lastReverbTone = reverbToneFrequency;
  }
  if (fx.reverbSend && fx.reverbWet && audioParamChanged(fx.lastReverbAmount, reverbAmount)) {
    smoothAudioParam(fx.reverbSend.gain, reverbAmount, now, 0.035);
    smoothAudioParam(fx.reverbWet.gain, reverbAmount, now, 0.05);
    fx.lastReverbAmount = reverbAmount;
  }

  return { ctx, fx };
};

export const stopAudioVoices = (
  audioRef: RefLike<AudioContext | null>,
  lineFxRef: RefLike<Array<AudioLineFx | null>>,
  atTime?: number,
) => {
  const ctx = audioRef.current;
  if (!ctx) return;
  const now = atTime ?? ctx.currentTime;
  for (const fx of lineFxRef.current) {
    if (!fx) continue;
    releaseVoiceAtTime(fx.voice, now, 0.045);
  }
};

export const playScheduledStep = <TStep extends EngineStep, TLine extends Omit<EngineLine, "steps"> & { steps: TStep[] }>({
  lineIndex,
  line,
  stepIndex,
  stepLenSeconds,
  startTime,
  tempo,
  audioRef,
  masterRef,
  reverbBufferRef,
  lineFxRef,
  findBaseStep,
}: {
  lineIndex: number;
  line: TLine;
  stepIndex: number;
  stepLenSeconds: number;
  startTime?: number;
  tempo: number;
  audioRef: RefLike<AudioContext | null>;
  masterRef: RefLike<GainNode | null>;
  reverbBufferRef: RefLike<AudioBuffer | null>;
  lineFxRef: RefLike<Array<AudioLineFx | null>>;
  findBaseStep: (steps: TStep[], step: number) => number | null;
}) => {
  const { steps, params, patternLength, timingMode } = line;
  const step = steps[stepIndex];
  if (step.timeMode !== "note" || !step.pitch) return;
  const playableLength = playablePatternLengthForMode(patternLength, timingMode);

  let ctx = audioRef.current;
  let fx = lineFxRef.current[lineIndex];
  const hadFx = !!fx;
  if (!ctx || !fx) {
    const graph = ensureAudioGraph(audioRef, masterRef, reverbBufferRef, lineFxRef, lineIndex);
    if (!graph) return;
    ctx = graph.ctx;
    fx = lineFxRef.current[lineIndex];
  }
  if (!fx) return;

  const now = startTime ?? ctx.currentTime;
  if (!hadFx) {
    syncLineAudioState({
      lineIndex,
      params,
      tempo,
      audioRef,
      masterRef,
      reverbBufferRef,
      lineFxRef,
      atTime: now,
    });
  }

  const voice = fx.voice;
  setVoiceWaveform(voice, params.waveform);

  const transposeFrequency = PLAYED_NOTE_FREQUENCY[step.pitch];
  if (!transposeFrequency) return;
  const freq = transposeFrequency[step.transpose] * tuneMultiplier(params.tune);
  const isSlideStep = shouldSlideIntoStep(steps, stepIndex, findBaseStep);
  const gateSteps = getSequencedGateSteps(steps, stepIndex, playableLength, findBaseStep);
  const gateSeconds = Math.max(0.11, gateSteps * stepLenSeconds * 0.98);
  const amp = ampContour(params, step.accent);
  const filter = cutoffContour(params, step.accent);
  const peakTime = now + filterHoldTime(gateSeconds);
  const releaseTime = now + Math.max(gateSeconds, amp.decaySeconds);
  const qRampTime = now + 0.012;

  if (voice.mode === "worklet") {
    const slideSeconds = isSlideStep ? slideSecondsForParams(params) : 0;
    const slideFilterTarget = clamp(filter.base + (step.accent ? 180 : 60), MIN_FILTER_CUTOFF, MAX_FILTER_CUTOFF);
    const slideGainTarget = Math.max(0.00001, amp.peak * (step.accent ? 1.02 : 0.92));
    voice.node.port.postMessage({
      type: "note",
      time: now,
      freq,
      slide: isSlideStep,
      slideSeconds,
      releaseTime,
      releaseSeconds: VOICE_RELEASE_SECONDS,
      filterBase: filter.base,
      filterPeak: filter.peak,
      filterTail: filter.tail,
      filterPeakTime: peakTime,
      filterQ: filter.qA,
      ampPeak: amp.peak,
      ampSustain: Math.max(0.00001, amp.peak * amp.sustainFloor),
      attackSeconds: amp.attackSeconds,
      sustainTime: now + Math.max(0.035, gateSeconds * 0.38),
      slideFilterTarget,
      slideGainTarget,
    });
    voice.lastFrequency = freq;
    voice.lastTune = params.tune;
    voice.lastGateReleaseTime = releaseTime + VOICE_RELEASE_SECONDS;
    return;
  }

  holdAudioParam(voice.filterA.Q, now);
  voice.filterA.Q.linearRampToValueAtTime(filter.qA, qRampTime);
  if (voice.filterB) {
    holdAudioParam(voice.filterB.Q, now);
    voice.filterB.Q.linearRampToValueAtTime(filter.qB, qRampTime);
  }

  if (isSlideStep) {
    const slideSeconds = slideSecondsForParams(params);
    const slideArrivalTime = now + slideSeconds;
    const slideFilterTarget = clamp(filter.base + (step.accent ? 180 : 60), MIN_FILTER_CUTOFF, MAX_FILTER_CUTOFF);
    const slideGainTarget = Math.max(0.00001, amp.peak * (step.accent ? 1.02 : 0.92));
    holdAudioParam(voice.oscillator.frequency, now);
    const fromFrequency = Math.max(1, voice.lastFrequency || freq);
    voice.oscillator.frequency.setValueAtTime(fromFrequency, now);
    voice.oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, freq), slideArrivalTime);

    holdAudioParam(voice.filterA.frequency, now);
    voice.filterA.frequency.linearRampToValueAtTime(slideFilterTarget, slideArrivalTime);
    if (voice.filterB) {
      holdAudioParam(voice.filterB.frequency, now);
      voice.filterB.frequency.linearRampToValueAtTime(clamp(slideFilterTarget * 0.84, MIN_FILTER_CUTOFF, MAX_FILTER_CUTOFF), slideArrivalTime);
    }

    holdAudioParam(voice.amp.gain, now);
    voice.amp.gain.linearRampToValueAtTime(slideGainTarget, slideArrivalTime);

    if (releaseTime > voice.lastGateReleaseTime - 0.005) {
      releaseVoiceAtTime(voice, releaseTime, VOICE_RELEASE_SECONDS);
    }
  } else {
    holdAudioParam(voice.oscillator.frequency, now);
    voice.oscillator.frequency.setValueAtTime(Math.max(1, freq), now);

    holdAudioParam(voice.filterA.frequency, now);
    voice.filterA.frequency.setValueAtTime(clamp(filter.base, MIN_FILTER_CUTOFF, MAX_FILTER_CUTOFF), now);
    voice.filterA.frequency.exponentialRampToValueAtTime(clamp(filter.peak, filter.base + 1, MAX_FILTER_CUTOFF), peakTime);
    voice.filterA.frequency.exponentialRampToValueAtTime(clamp(filter.tail, MIN_FILTER_CUTOFF, MAX_FILTER_CUTOFF), releaseTime);
    if (voice.filterB) {
      holdAudioParam(voice.filterB.frequency, now);
      voice.filterB.frequency.setValueAtTime(clamp(filter.base * 0.84, MIN_FILTER_CUTOFF, MAX_FILTER_CUTOFF), now);
      voice.filterB.frequency.exponentialRampToValueAtTime(clamp(filter.peak * 0.9, filter.base + 1, MAX_FILTER_CUTOFF), peakTime);
      voice.filterB.frequency.exponentialRampToValueAtTime(clamp(filter.tail * 0.84, MIN_FILTER_CUTOFF, MAX_FILTER_CUTOFF), releaseTime);
    }

    holdAudioParam(voice.amp.gain, now);
    voice.amp.gain.setValueAtTime(0.00001, now);
    voice.amp.gain.linearRampToValueAtTime(Math.max(0.00001, amp.peak), now + amp.attackSeconds);
    voice.amp.gain.exponentialRampToValueAtTime(Math.max(0.00001, amp.peak * amp.sustainFloor), now + Math.max(0.035, gateSeconds * 0.38));
    releaseVoiceAtTime(voice, releaseTime, VOICE_RELEASE_SECONDS);
  }

  voice.lastFrequency = freq;
  voice.lastTune = params.tune;
};
