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

export type AudioLineFx = {
  send: GainNode;
  dry: GainNode;
  output: GainNode;
  overdrive: WaveShaperNode;
  overdriveTone: BiquadFilterNode;
  overdriveWet: GainNode;
  delaySend: GainNode;
  delayWet: GainNode;
  delay: DelayNode;
  delayTone: BiquadFilterNode;
  feedback: GainNode;
  distortion: WaveShaperNode;
  distortionTone: BiquadFilterNode;
  distWet: GainNode;
  reverbSend: GainNode;
  reverbPreDelay: DelayNode;
  reverbTone: BiquadFilterNode;
  reverb: ConvolverNode;
  reverbWet: GainNode;
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

const REVERB_IMPULSE_CACHE = new Map<number, AudioBuffer>();

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

export const delayTimeFromTempo = (tempo: number, subdivision: EngineDelaySubdivision): number => (60 / tempo) * (DELAY_SUBDIVISION_BEATS[subdivision] ?? 0.5);

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
  param.setValueAtTime(param.value, now);
};

const smoothAudioParam = (param: AudioParam, next: number, now: number, rampSeconds = 0.03) => {
  holdAudioParam(param, now);
  param.linearRampToValueAtTime(next, now + rampSeconds);
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
  if (!audioRef.current || !masterRef.current) {
    const ctx = new Ctx();
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
  if (typeof lineIndex === "number" && !lineFxRef.current[lineIndex]) {
    const ctx = audioRef.current;
    const master = masterRef.current;
    if (!ctx || !master) return null;
    const send = ctx.createGain();
    const dry = ctx.createGain();
    const output = ctx.createGain();
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

    send.connect(dry);
    dry.connect(output);
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
    output.connect(master);

    overdrive.oversample = "2x";
    distortion.oversample = "4x";
    overdriveTone.type = "lowpass";
    distortionTone.type = "lowpass";
    delayTone.type = "lowpass";
    reverbTone.type = "lowpass";
    reverb.buffer = reverbBufferRef.current;
    dry.gain.value = 1;
    output.gain.value = LINE_OUTPUT_HEADROOM_GAIN;
    overdriveWet.gain.value = 0;
    delaySend.gain.value = 0;
    delayWet.gain.value = 0;
    feedback.gain.value = 0;
    distWet.gain.value = 0;
    reverbSend.gain.value = 0;
    reverbWet.gain.value = 0;

    lineFxRef.current[lineIndex] = {
      send,
      dry,
      output,
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
  }
  return { ctx: audioRef.current };
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

  const delayTime = params.delaySync ? delayTimeFromTempo(tempo, params.delaySubdivision) : params.delayTime;
  const nextDelayTime = Math.min(1, Math.max(0, delayTime));
  if (audioParamChanged(fx.lastDelayTime, nextDelayTime, 0.0005)) {
    smoothAudioParam(fx.delay.delayTime, nextDelayTime, now, 0.04);
    fx.lastDelayTime = nextDelayTime;
  }
  const feedbackAmount = Math.min(0.92, Math.max(0, params.delayFeedback));
  if (audioParamChanged(fx.lastFeedbackAmount, feedbackAmount)) {
    smoothAudioParam(fx.feedback.gain, feedbackAmount, now, 0.04);
    fx.lastFeedbackAmount = feedbackAmount;
  }
  const delayMixAmount = Math.min(1, Math.max(0, params.delayMix));
  if (audioParamChanged(fx.lastDelayMixAmount, delayMixAmount)) {
    smoothAudioParam(fx.delayWet.gain, delayMixAmount, now, 0.035);
    fx.lastDelayMixAmount = delayMixAmount;
  }
  const delayToneFrequency = Math.min(12000, Math.max(800, params.delayTone));
  if (audioParamChanged(fx.lastDelayTone, delayToneFrequency, 40)) {
    smoothAudioParam(fx.delayTone.frequency, delayToneFrequency, now, 0.035);
    fx.lastDelayTone = delayToneFrequency;
  }
  const overdriveAmount = Math.min(1, Math.max(0, params.overdrive));
  if (Math.abs(fx.lastOverdriveAmount - overdriveAmount) > 0.002) {
    fx.overdrive.curve = overdriveAmount <= 0.002 ? null : getOverdriveCurve(overdriveAmount);
    smoothAudioParam(fx.overdriveWet.gain, overdriveAmount, now, 0.03);
    fx.lastOverdriveAmount = overdriveAmount;
  }
  const overdriveToneFrequency = Math.min(14000, Math.max(800, params.overdriveTone));
  if (audioParamChanged(fx.lastOverdriveTone, overdriveToneFrequency, 40)) {
    smoothAudioParam(fx.overdriveTone.frequency, overdriveToneFrequency, now, 0.035);
    fx.lastOverdriveTone = overdriveToneFrequency;
  }
  const distortionAmount = Math.min(1, Math.max(0, params.distortion));
  if (Math.abs(fx.lastDistortionAmount - distortionAmount) > 0.002) {
    fx.distortion.curve = distortionAmount <= 0.002 ? null : getDistortionCurve(distortionAmount);
    smoothAudioParam(fx.distWet.gain, distortionAmount, now, 0.03);
    fx.lastDistortionAmount = distortionAmount;
  }
  const distortionToneFrequency = Math.min(14000, Math.max(800, params.distortionTone));
  if (audioParamChanged(fx.lastDistortionTone, distortionToneFrequency, 40)) {
    smoothAudioParam(fx.distortionTone.frequency, distortionToneFrequency, now, 0.035);
    fx.lastDistortionTone = distortionToneFrequency;
  }
  const reverbAmount = Math.min(1, Math.max(0, params.reverb));
  const reverbTail = Math.min(4, Math.max(0.4, params.reverbTail));
  const reverbPreDelay = Math.min(0.18, Math.max(0, params.reverbPreDelay));
  const reverbToneFrequency = Math.min(12000, Math.max(800, params.reverbTone));
  const delayRouteAmount = delayMixAmount;
  if (audioParamChanged(fx.lastDelayRouteAmount, delayRouteAmount)) {
    smoothAudioParam(fx.delaySend.gain, delayRouteAmount, now, 0.035);
    fx.lastDelayRouteAmount = delayRouteAmount;
  }
  if (audioParamChanged(fx.lastReverbTail, reverbTail, 0.05)) {
    fx.reverb.buffer = getImpulseResponse(ctx, reverbTail);
    fx.lastReverbTail = reverbTail;
  }
  if (audioParamChanged(fx.lastReverbPreDelay, reverbPreDelay, 0.002)) {
    smoothAudioParam(fx.reverbPreDelay.delayTime, reverbPreDelay, now, 0.04);
    fx.lastReverbPreDelay = reverbPreDelay;
  }
  if (audioParamChanged(fx.lastReverbTone, reverbToneFrequency, 40)) {
    smoothAudioParam(fx.reverbTone.frequency, reverbToneFrequency, now, 0.035);
    fx.lastReverbTone = reverbToneFrequency;
  }
  if (audioParamChanged(fx.lastReverbAmount, reverbAmount)) {
    smoothAudioParam(fx.reverbSend.gain, reverbAmount, now, 0.035);
    smoothAudioParam(fx.reverbWet.gain, reverbAmount, now, 0.05);
    fx.lastReverbAmount = reverbAmount;
  }

  return { ctx, fx };
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
  if (!ctx || !fx) {
    const graph = ensureAudioGraph(audioRef, masterRef, reverbBufferRef, lineFxRef, lineIndex);
    if (!graph) return;
    ctx = graph.ctx;
    fx = lineFxRef.current[lineIndex];
  }
  if (!fx) return;

  let noteSteps = 1;
  for (let s = stepIndex + 1; s < playableLength; s += 1) {
    if (steps[s].timeMode === "tie") noteSteps += 1;
    else break;
  }

  const now = startTime ?? ctx.currentTime;
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
  const transposeFrequency = PLAYED_NOTE_FREQUENCY[step.pitch];
  if (!transposeFrequency) return;
  const accentBoost = step.accent ? params.accent : 1;
  const targetGain = Math.max(0, params.volume * accentBoost);
  if (targetGain <= 0.0001) return;
  const freq = transposeFrequency[step.transpose];
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const amp = ctx.createGain();
  const accentFilterBoost = step.accent ? 1.9 : 1;
  osc.type = params.waveform;
  osc.frequency.setValueAtTime(freq, now);

  if (step.slide) {
    const prevIdx = (stepIndex - 1 + playableLength) % playableLength;
    const prevBase = findBaseStep(steps, prevIdx);
    if (prevBase !== null) {
      const prevStep = steps[prevBase];
      if (prevStep.pitch) {
        const prevTransposeFrequency = PLAYED_NOTE_FREQUENCY[prevStep.pitch];
        if (prevTransposeFrequency) {
          const prevFreq = prevTransposeFrequency[prevStep.transpose];
          osc.frequency.setValueAtTime(prevFreq, now);
          osc.frequency.linearRampToValueAtTime(freq, now + Math.min(0.2, params.decay * 0.8 + 0.06));
        }
      }
    }
  }

  filter.type = "lowpass";
  filter.Q.setValueAtTime(Math.min(30, params.resonance * accentFilterBoost), now);
  filter.frequency.setValueAtTime(params.cutoff, now);
  filter.frequency.exponentialRampToValueAtTime(Math.max(220, params.cutoff + params.envMod * accentFilterBoost), now + 0.02);
  filter.frequency.exponentialRampToValueAtTime(Math.max(140, params.cutoff * 0.58), now + params.decay * noteSteps);

  const gate = Math.max(0.12, noteSteps * stepLenSeconds * 0.92);
  amp.gain.setValueAtTime(0.0001, now);
  amp.gain.linearRampToValueAtTime(targetGain, now + 0.005);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(gate, params.decay * noteSteps));

  osc.connect(filter);
  filter.connect(amp);
  amp.connect(fx.send);
  osc.onended = () => {
    osc.disconnect();
    filter.disconnect();
    amp.disconnect();
  };

  osc.start(now);
  osc.stop(now + gate + 0.08);
};
