// Noise, made with Web Audio: a few seconds of it in a buffer, looped. White is every frequency alike;
// pink falls off by 3 dB an octave (Paul Kellet's filter); brown by 6 (a leaky running sum). Nothing is
// fetched, so it plays offline and needs no network.

export type Color = "white" | "pink" | "brown";

export const COLORS: readonly Color[] = ["white", "pink", "brown"];

/** `length` samples of noise of a color, from `random` (Math.random, or a seeded one in tests). */
export function noiseSamples(color: Color, length: number, random: () => number = Math.random): Float32Array {
  const out = new Float32Array(length);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0,
    last = 0;
  for (let i = 0; i < length; i++) {
    const white = random() * 2 - 1;
    if (color === "white") out[i] = white * 0.5;
    else if (color === "pink") {
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    } else {
      last = (last + 0.02 * white) / 1.02;
      out[i] = last * 3.5;
    }
  }
  return out;
}

/** A looping noise source at a volume, playing in `context`. */
export class NoisePlayer {
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode;

  constructor(
    private context: AudioContext,
    readonly color: Color,
    volume: number,
  ) {
    this.gain = context.createGain();
    this.gain.gain.value = volume;
    this.gain.connect(context.destination);
  }

  get playing(): boolean {
    return !!this.source;
  }

  get volume(): number {
    return this.gain.gain.value;
  }

  set volume(v: number) {
    this.gain.gain.setTargetAtTime(Math.min(Math.max(v, 0), 1), this.context.currentTime, 0.05);
  }

  play(): void {
    if (this.source) return;
    void this.context.resume();
    const seconds = 4;
    const buffer = this.context.createBuffer(1, this.context.sampleRate * seconds, this.context.sampleRate);
    buffer.copyToChannel(noiseSamples(this.color, buffer.length) as Float32Array<ArrayBuffer>, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.gain);
    source.start();
    this.source = source;
  }

  pause(): void {
    this.source?.stop();
    this.source?.disconnect();
    this.source = null;
  }
}
