import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type MidiClockMode = "auto" | "device";
export type MidiRuntimeKind = "tauri" | "web" | "unsupported";
export type MidiRealtimeKind = "clock" | "start" | "continue" | "stop";

export type MidiInputPortInfo = {
  id: string;
  name: string;
};

export type MidiRealtimeEvent = {
  kind: MidiRealtimeKind;
  sourceId: string;
  sourceName: string;
  timestampMillis: number;
};

export type MidiClockRuntimeStartHandlers = {
  onRealtime: (event: MidiRealtimeEvent) => void;
  onInputsChanged: (inputs: MidiInputPortInfo[]) => void;
  onError: (message: string) => void;
};

export type MidiClockRuntimeStartResult = {
  runtime: MidiRuntimeKind;
  supported: boolean;
  inputs: MidiInputPortInfo[];
};

export interface MidiClockRuntime {
  readonly kind: MidiRuntimeKind;
  readonly supported: boolean;
  start(handlers: MidiClockRuntimeStartHandlers): Promise<MidiClockRuntimeStartResult>;
  refreshInputs(): Promise<MidiInputPortInfo[]>;
  stop(): Promise<void>;
}

type BrowserMidiMessageEvent = {
  data?: Uint8Array | number[];
  receivedTime?: number;
};

type BrowserMidiInput = {
  id: string;
  name?: string | null;
  state?: "connected" | "disconnected" | string;
  onmidimessage: ((event: BrowserMidiMessageEvent) => void) | null;
};

type BrowserMidiInputCollection = {
  values: () => IterableIterator<BrowserMidiInput>;
};

type BrowserMidiAccess = {
  inputs: BrowserMidiInputCollection;
  onstatechange: ((event: Event) => void) | null;
};

type NavigatorWithMidi = Navigator & {
  requestMIDIAccess?: () => Promise<BrowserMidiAccess>;
};

type TauriMidiErrorPayload = {
  message: string;
};

const TAURI_MIDI_REALTIME_EVENT = "midi-realtime";
const TAURI_MIDI_INPUTS_CHANGED_EVENT = "midi-inputs-changed";
const TAURI_MIDI_ERROR_EVENT = "midi-error";

const normalizeInputList = (inputs: MidiInputPortInfo[]): MidiInputPortInfo[] =>
  [...inputs]
    .filter((input) => typeof input.id === "string" && input.id.trim() && typeof input.name === "string")
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

const decodeRealtimeMessage = (
  sourceId: string,
  sourceName: string,
  data: Uint8Array | number[] | undefined,
  timestampMillis: number,
): MidiRealtimeEvent | null => {
  const status = data?.[0];
  if (status === 0xf8) return { kind: "clock", sourceId, sourceName, timestampMillis };
  if (status === 0xfa) return { kind: "start", sourceId, sourceName, timestampMillis };
  if (status === 0xfb) return { kind: "continue", sourceId, sourceName, timestampMillis };
  if (status === 0xfc) return { kind: "stop", sourceId, sourceName, timestampMillis };
  return null;
};

class UnsupportedMidiRuntime implements MidiClockRuntime {
  readonly kind = "unsupported" as const;

  readonly supported = false;

  async start(): Promise<MidiClockRuntimeStartResult> {
    return { runtime: this.kind, supported: false, inputs: [] };
  }

  async refreshInputs(): Promise<MidiInputPortInfo[]> {
    return [];
  }

  async stop(): Promise<void> {}
}

class WebMidiRuntime implements MidiClockRuntime {
  readonly kind = "web" as const;

  readonly supported = typeof window !== "undefined" && typeof (window.navigator as NavigatorWithMidi).requestMIDIAccess === "function";

  private midiAccess: BrowserMidiAccess | null = null;

  private boundHandlers: MidiClockRuntimeStartHandlers | null = null;

  private attachedInputs = new Map<string, BrowserMidiInput>();

  private detachInputHandlers() {
    for (const input of this.attachedInputs.values()) {
      input.onmidimessage = null;
    }
    this.attachedInputs.clear();
    if (this.midiAccess) {
      this.midiAccess.onstatechange = null;
    }
  }

  private listInputs(): MidiInputPortInfo[] {
    if (!this.midiAccess) return [];
    return normalizeInputList(
      Array.from(this.midiAccess.inputs.values())
        .filter((input) => input.state !== "disconnected")
        .map((input) => ({
          id: input.id,
          name: input.name?.trim() || "Unknown MIDI input",
        })),
    );
  }

  private attachInputHandlers() {
    if (!this.midiAccess || !this.boundHandlers) return;
    this.detachInputHandlers();
    this.midiAccess.onstatechange = () => {
      this.attachInputHandlers();
      this.boundHandlers?.onInputsChanged(this.listInputs());
    };
    for (const input of this.midiAccess.inputs.values()) {
      input.onmidimessage = (event) => {
        const midiEvent = decodeRealtimeMessage(
          input.id,
          input.name?.trim() || "Unknown MIDI input",
          event.data,
          typeof event.receivedTime === "number" ? event.receivedTime : performance.now(),
        );
        if (midiEvent) {
          this.boundHandlers?.onRealtime(midiEvent);
        }
      };
      this.attachedInputs.set(input.id, input);
    }
  }

  async start(handlers: MidiClockRuntimeStartHandlers): Promise<MidiClockRuntimeStartResult> {
    this.boundHandlers = handlers;
    if (!this.supported) {
      return { runtime: this.kind, supported: false, inputs: [] };
    }

    const requestMIDIAccess = (window.navigator as NavigatorWithMidi).requestMIDIAccess;
    if (!requestMIDIAccess) {
      return { runtime: this.kind, supported: false, inputs: [] };
    }
    this.midiAccess = await requestMIDIAccess.call(window.navigator as NavigatorWithMidi);
    this.attachInputHandlers();
    return {
      runtime: this.kind,
      supported: true,
      inputs: this.listInputs(),
    };
  }

  async refreshInputs(): Promise<MidiInputPortInfo[]> {
    if (!this.midiAccess) {
      const requestMIDIAccess = (window.navigator as NavigatorWithMidi).requestMIDIAccess;
      if (!requestMIDIAccess) {
        return [];
      }
      this.midiAccess = await requestMIDIAccess.call(window.navigator as NavigatorWithMidi);
      if (this.boundHandlers) {
        this.attachInputHandlers();
      }
    }
    return this.listInputs();
  }

  async stop(): Promise<void> {
    this.detachInputHandlers();
    this.boundHandlers = null;
  }
}

class TauriMidiRuntime implements MidiClockRuntime {
  readonly kind = "tauri" as const;

  readonly supported = true;

  private unlistenFns: UnlistenFn[] = [];

  private handlers: MidiClockRuntimeStartHandlers | null = null;

  async start(handlers: MidiClockRuntimeStartHandlers): Promise<MidiClockRuntimeStartResult> {
    await this.stop();
    this.handlers = handlers;

    const [unlistenRealtime, unlistenInputsChanged, unlistenError] = await Promise.all([
      listen<MidiRealtimeEvent>(TAURI_MIDI_REALTIME_EVENT, (event) => {
        this.handlers?.onRealtime(event.payload);
      }),
      listen<MidiInputPortInfo[]>(TAURI_MIDI_INPUTS_CHANGED_EVENT, (event) => {
        this.handlers?.onInputsChanged(normalizeInputList(event.payload));
      }),
      listen<TauriMidiErrorPayload>(TAURI_MIDI_ERROR_EVENT, (event) => {
        this.handlers?.onError(event.payload.message);
      }),
    ]);

    this.unlistenFns = [unlistenRealtime, unlistenInputsChanged, unlistenError];
    await invoke("midi_start_realtime_stream");
    const inputs = await this.refreshInputs();
    return {
      runtime: this.kind,
      supported: true,
      inputs,
    };
  }

  async refreshInputs(): Promise<MidiInputPortInfo[]> {
    const inputs = await invoke<MidiInputPortInfo[]>("midi_list_inputs");
    return normalizeInputList(inputs);
  }

  async stop(): Promise<void> {
    try {
      await invoke("midi_stop_realtime_stream");
    } catch {
      // Ignore stop failures when the backend was not started yet.
    }
    for (const unlisten of this.unlistenFns) {
      unlisten();
    }
    this.unlistenFns = [];
    this.handlers = null;
  }
}

export const createMidiClockRuntime = (): MidiClockRuntime => {
  if (isTauri()) {
    return new TauriMidiRuntime();
  }
  if (typeof window !== "undefined" && typeof (window.navigator as NavigatorWithMidi).requestMIDIAccess === "function") {
    return new WebMidiRuntime();
  }
  return new UnsupportedMidiRuntime();
};
