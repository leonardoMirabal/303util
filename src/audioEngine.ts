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
  distortion: number;
  reverb: number;
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
  lastDelayTime: number;
  lastFeedbackAmount: number;
  lastDelayMixAmount: number;
  lastDelayRouteAmount: number;
  lastDistortionAmount: number;
  lastReverbAmount: number;
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

const DISTORTION_CURVE_CACHE = new Map<number, Float32Array>();

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

const getDistortionCurve = (amount: number): Float32Array => {
  const cacheKey = Math.round(amount * 500);
  const cached = DISTORTION_CURVE_CACHE.get(cacheKey);
  if (cached) return cached;
  const curve = makeDistortionCurve(cacheKey / 500);
  DISTORTION_CURVE_CACHE.set(cacheKey, curve);
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

export const delayTimeFromTempo = (tempo: number, subdivision: EngineDelaySubdivision): number => (60 / tempo) * (DELAY_SUBDIVISION_BEATS[subdivision] ?? 0.5);

const playablePatternLengthForMode = (patternLength: number, mode: EnginePatternTimingMode): number =>
  mode === "triplet" ? Math.max(1, patternLength - Math.floor(patternLength / 4)) : patternLength;

const audioParamChanged = (previous: number, next: number, threshold = 0.002): boolean =>
  !Number.isFinite(previous) || Math.abs(previous - next) > threshold;

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
    master.gain.value = 0.8;
    master.connect(ctx.destination);
    audioRef.current = ctx;
    masterRef.current = master;
    reverbBufferRef.current = makeImpulseResponse(ctx);
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
    send.connect(distSend);
    distSend.connect(distortion);
    distortion.connect(distWet);
    distWet.connect(master);
    distortion.connect(delaySend);

    delaySend.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(delayWet);
    delayWet.connect(master);

    delay.connect(reverbSend);
    reverbSend.connect(reverb);
    reverb.connect(reverbWet);
    reverbWet.connect(master);

    distortion.oversample = "4x";
    reverb.buffer = reverbBufferRef.current;
    dry.gain.value = 1;
    delaySend.gain.value = 0;
    delayWet.gain.value = 0;
    feedback.gain.value = 0;
    distSend.gain.value = 1;
    distWet.gain.value = 0;
    reverbSend.gain.value = 0;
    reverbWet.gain.value = 0;

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
      lastDelayTime: Number.NaN,
      lastFeedbackAmount: Number.NaN,
      lastDelayMixAmount: Number.NaN,
      lastDelayRouteAmount: Number.NaN,
      lastDistortionAmount: -1,
      lastReverbAmount: Number.NaN,
    };
  }
  return { ctx: audioRef.current };
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
  const transposeFrequency = PLAYED_NOTE_FREQUENCY[step.pitch];
  if (!transposeFrequency) return;
  const freq = transposeFrequency[step.transpose];
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const amp = ctx.createGain();
  const accentBoost = step.accent ? params.accent : 1;
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
  amp.gain.exponentialRampToValueAtTime(params.volume * accentBoost, now + 0.005);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(gate, params.decay * noteSteps));

  osc.connect(filter);
  filter.connect(amp);
  amp.connect(fx.send);
  osc.onended = () => {
    osc.disconnect();
    filter.disconnect();
    amp.disconnect();
  };

  const delayTime = params.delaySync ? delayTimeFromTempo(tempo, params.delaySubdivision) : params.delayTime;
  const nextDelayTime = Math.min(1, Math.max(0.02, delayTime));
  if (audioParamChanged(fx.lastDelayTime, nextDelayTime, 0.0005)) {
    fx.delay.delayTime.setValueAtTime(nextDelayTime, now);
    fx.lastDelayTime = nextDelayTime;
  }
  const feedbackAmount = Math.min(0.92, Math.max(0, params.delayFeedback));
  if (audioParamChanged(fx.lastFeedbackAmount, feedbackAmount)) {
    fx.feedback.gain.setValueAtTime(feedbackAmount, now);
    fx.lastFeedbackAmount = feedbackAmount;
  }
  const delayMixAmount = Math.min(1, Math.max(0, params.delayMix));
  if (audioParamChanged(fx.lastDelayMixAmount, delayMixAmount)) {
    fx.delayWet.gain.setValueAtTime(delayMixAmount, now);
    fx.lastDelayMixAmount = delayMixAmount;
  }
  const distortionAmount = Math.min(1, Math.max(0, params.distortion));
  if (Math.abs(fx.lastDistortionAmount - distortionAmount) > 0.002) {
    fx.distortion.curve = distortionAmount <= 0.002 ? null : getDistortionCurve(distortionAmount);
    fx.distWet.gain.setValueAtTime(distortionAmount, now);
    fx.lastDistortionAmount = distortionAmount;
  }
  const reverbAmount = Math.min(1, Math.max(0, params.reverb));
  const delayRouteAmount = Math.max(delayMixAmount, reverbAmount);
  if (audioParamChanged(fx.lastDelayRouteAmount, delayRouteAmount)) {
    fx.delaySend.gain.setValueAtTime(delayRouteAmount, now);
    fx.lastDelayRouteAmount = delayRouteAmount;
  }
  if (audioParamChanged(fx.lastReverbAmount, reverbAmount)) {
    fx.reverbSend.gain.setValueAtTime(reverbAmount, now);
    fx.reverbWet.gain.setValueAtTime(reverbAmount, now);
    fx.lastReverbAmount = reverbAmount;
  }

  osc.start(now);
  osc.stop(now + gate + 0.08);
};
