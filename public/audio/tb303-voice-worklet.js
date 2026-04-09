class TB303VoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.lowPower = !!options.processorOptions?.lowPower;
    this.waveform = "sawtooth";
    this.phase = 0;
    this.currentFreq = 110;
    this.glideStartTime = 0;
    this.glideEndTime = 0;
    this.glideStartFreq = 110;
    this.glideTargetFreq = 110;
    this.filterValue = 320;
    this.filterStartTime = 0;
    this.filterEndTime = 0;
    this.filterStartValue = 320;
    this.filterTargetValue = 320;
    this.filterBase = 320;
    this.filterPeak = 460;
    this.filterTail = 280;
    this.filterPeakTime = 0;
    this.filterReleaseTime = 0;
    this.filterQ = 1.1;
    this.gainValue = 0.00001;
    this.gainStartTime = 0;
    this.gainEndTime = 0;
    this.gainStartValue = 0.00001;
    this.gainTargetValue = 0.00001;
    this.ampPeak = 0.4;
    this.ampSustain = 0.1;
    this.ampAttackEndTime = 0;
    this.ampSustainTime = 0;
    this.releaseTime = 0;
    this.releaseSeconds = 0.06;
    this.releaseArmed = false;
    this.releaseStartGain = 0.00001;
    this.releaseStartTime = 0;
    this.noteActive = false;
    this.events = [];
    this.filterStageA = 0;
    this.filterStageB = 0;
    this.dcInput = 0;
    this.dcOutput = 0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "waveform") {
        this.waveform = data.waveform === "square" ? "square" : "sawtooth";
        return;
      }
      this.events.push(data);
      this.events.sort((a, b) => a.time - b.time);
    };
  }

  startRelease(time, releaseSeconds) {
    this.releaseArmed = true;
    this.releaseStartTime = time;
    this.releaseSeconds = Math.max(0.01, releaseSeconds || 0.06);
    this.releaseStartGain = Math.max(this.gainValue, 0.00001);
  }

  applyEvent(event) {
    if (event.type === "release") {
      this.startRelease(event.time, event.releaseSeconds);
      return;
    }

    if (event.type !== "note") return;

    this.noteActive = true;
    this.filterQ = Number.isFinite(event.filterQ) ? event.filterQ : 1.1;
    this.releaseTime = event.releaseTime;
    this.releaseSeconds = event.releaseSeconds;
    this.releaseArmed = false;

    if (event.slide) {
      this.glideStartTime = event.time;
      this.glideEndTime = event.time + event.slideSeconds;
      this.glideStartFreq = this.currentFreq;
      this.glideTargetFreq = event.freq;

      this.filterStartTime = event.time;
      this.filterEndTime = event.time + event.slideSeconds;
      this.filterStartValue = this.filterValue;
      this.filterTargetValue = event.slideFilterTarget;

      this.gainStartTime = event.time;
      this.gainEndTime = event.time + event.slideSeconds;
      this.gainStartValue = this.gainValue;
      this.gainTargetValue = event.slideGainTarget;
      return;
    }

    this.currentFreq = event.freq;
    this.glideStartTime = event.time;
    this.glideEndTime = event.time;
    this.glideStartFreq = event.freq;
    this.glideTargetFreq = event.freq;

    this.filterBase = event.filterBase;
    this.filterPeak = event.filterPeak;
    this.filterTail = event.filterTail;
    this.filterPeakTime = event.filterPeakTime;
    this.filterReleaseTime = event.releaseTime;
    this.filterValue = event.filterBase;
    this.filterStartValue = event.filterBase;
    this.filterTargetValue = event.filterBase;
    this.filterStartTime = event.time;
    this.filterEndTime = event.time;

    this.gainValue = 0.00001;
    this.ampPeak = event.ampPeak;
    this.ampSustain = event.ampSustain;
    this.ampAttackEndTime = event.time + event.attackSeconds;
    this.ampSustainTime = event.sustainTime;
    this.gainStartValue = 0.00001;
    this.gainTargetValue = event.ampPeak;
    this.gainStartTime = event.time;
    this.gainEndTime = this.ampAttackEndTime;
  }

  updateNoteState(time) {
    if (this.glideEndTime > this.glideStartTime && time < this.glideEndTime) {
      const progress = (time - this.glideStartTime) / Math.max(this.glideEndTime - this.glideStartTime, 1e-6);
      const startFreq = Math.max(this.glideStartFreq, 1);
      const targetFreq = Math.max(this.glideTargetFreq, 1);
      this.currentFreq = startFreq * (targetFreq / startFreq) ** Math.min(Math.max(progress, 0), 1);
    } else if (this.glideEndTime > this.glideStartTime) {
      this.currentFreq = this.glideTargetFreq;
    }

    if (this.filterEndTime > this.filterStartTime && time < this.filterEndTime) {
      const progress = (time - this.filterStartTime) / Math.max(this.filterEndTime - this.filterStartTime, 1e-6);
      this.filterValue = this.filterStartValue + (this.filterTargetValue - this.filterStartValue) * Math.min(Math.max(progress, 0), 1);
    } else if (this.filterEndTime > this.filterStartTime) {
      this.filterValue = this.filterTargetValue;
    } else if (this.noteActive) {
      if (time < this.filterPeakTime) {
        const progress = (time - this.filterStartTime) / Math.max(this.filterPeakTime - this.filterStartTime, 1e-6);
        this.filterValue = this.filterBase + (this.filterPeak - this.filterBase) * Math.min(Math.max(progress, 0), 1);
      } else if (time < this.filterReleaseTime) {
        const progress = (time - this.filterPeakTime) / Math.max(this.filterReleaseTime - this.filterPeakTime, 1e-6);
        this.filterValue = this.filterPeak + (this.filterTail - this.filterPeak) * Math.min(Math.max(progress, 0), 1);
      } else {
        this.filterValue = this.filterTail;
      }
    }

    if (this.gainEndTime > this.gainStartTime && time < this.gainEndTime) {
      const progress = (time - this.gainStartTime) / Math.max(this.gainEndTime - this.gainStartTime, 1e-6);
      this.gainValue = this.gainStartValue + (this.gainTargetValue - this.gainStartValue) * Math.min(Math.max(progress, 0), 1);
    } else if (this.gainEndTime > this.gainStartTime) {
      this.gainValue = this.gainTargetValue;
    } else if (this.noteActive) {
      if (time < this.ampAttackEndTime) {
        const progress = (time - this.gainStartTime) / Math.max(this.ampAttackEndTime - this.gainStartTime, 1e-6);
        this.gainValue = 0.00001 + (this.ampPeak - 0.00001) * Math.min(Math.max(progress, 0), 1);
      } else if (time < this.ampSustainTime) {
        const progress = (time - this.ampAttackEndTime) / Math.max(this.ampSustainTime - this.ampAttackEndTime, 1e-6);
        this.gainValue = this.ampPeak + (this.ampSustain - this.ampPeak) * Math.min(Math.max(progress, 0), 1);
      } else {
        this.gainValue = this.ampSustain;
      }
    }

    if (time >= this.releaseTime && !this.releaseArmed) {
      this.startRelease(this.releaseTime, this.releaseSeconds);
    }

    if (this.releaseArmed && time >= this.releaseStartTime) {
      const progress = (time - this.releaseStartTime) / Math.max(this.releaseSeconds, 1e-6);
      if (progress >= 1) {
        this.gainValue = 0.00001;
        this.noteActive = false;
        this.releaseArmed = false;
      } else {
        this.gainValue = this.releaseStartGain * (0.00001 / this.releaseStartGain) ** progress;
      }
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? null;

    for (let i = 0; i < left.length; i += 1) {
      const time = currentTime + i / sampleRate;
      while (this.events.length > 0 && this.events[0].time <= time + 1e-6) {
        this.applyEvent(this.events.shift());
      }

      this.updateNoteState(time);

      let sample = 0;
      if (this.noteActive || this.gainValue > 0.00002) {
        const phaseStep = this.currentFreq / sampleRate;
        this.phase += phaseStep;
        this.phase -= Math.floor(this.phase);
        sample = this.waveform === "square" ? (this.phase < 0.5 ? 1 : -1) : this.phase * 2 - 1;
        sample *= this.waveform === "square" ? 0.72 : 0.82;

        const cutoff = Math.min(Math.max(this.filterValue, 70), 5200);
        const alpha = cutoff / (cutoff + sampleRate / (2 * Math.PI));
        const resonance = Math.min(Math.max((this.filterQ - 0.9) / 26, 0), 0.35);
        const filteredInput = sample - this.filterStageB * resonance;
        this.filterStageA += alpha * (filteredInput - this.filterStageA);
        this.filterStageB += alpha * (this.filterStageA - this.filterStageB);
        sample = this.lowPower ? this.filterStageA : this.filterStageB;
        const dcBlocked = sample - this.dcInput + 0.995 * this.dcOutput;
        this.dcInput = sample;
        this.dcOutput = dcBlocked;
        sample = dcBlocked * this.gainValue;
      }

      left[i] = sample;
      if (right) right[i] = sample;
    }

    return true;
  }
}

registerProcessor("tb303-voice", TB303VoiceProcessor);
