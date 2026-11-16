/** The parts of a frame's script, in the order the frame runs them. */
const FRAME_PARTS = ['session', 'layout', 'hud', 'scene', 'world', 'portraits', 'overlays'] as const;
export type FramePart = (typeof FRAME_PARTS)[number];

/** What one frame cost the main thread, in milliseconds, and what it drew. */
export interface FrameSample {
  /** Since the frame before, by the frames' own timestamps. */
  intervalMs: number;
  parts: Record<FramePart, number>;
  drawCalls: number;
  triangles: number;
  programs: number;
  canvas: { width: number; height: number; pixelRatio: number };
}

export interface FrameStatsSummary {
  frames: number;
  fps: number;
  intervalMs: Spread;
  scriptMs: Spread;
  /** Each part's mean; together they sum to the script's mean. */
  partsMs: Record<FramePart, number>;
  drawCalls: number;
  triangles: number;
  programs: number;
  canvas: { width: number; height: number; pixelRatio: number };
}

interface Spread {
  p50: number;
  p95: number;
  max: number;
}

/** About five seconds at 60 frames a second, so a read says how the game draws now. */
const FRAME_STATS_FRAMES = 300;

/**
 * The last frames' costs, for measuring a device where no profiler reaches, such as a phone. The
 * script's time is the frame callback's alone. So an interval longer than the display's refresh
 * with little script in it is a frame waiting on something else: the GPU, or work between frames.
 */
export class FrameStats {
  private readonly samples: FrameSample[] = [];

  record(sample: FrameSample): void {
    this.samples.push(sample);
    if (this.samples.length > FRAME_STATS_FRAMES) this.samples.shift();
  }

  summary(): FrameStatsSummary | undefined {
    const samples = this.samples;
    const last = samples.at(-1);
    if (last === undefined) return undefined;
    const intervals = samples.map((sample) => sample.intervalMs);
    const meanOf = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      frames: samples.length,
      fps: round(1000 / meanOf(intervals)),
      intervalMs: spread(intervals),
      scriptMs: spread(samples.map((sample) => FRAME_PARTS.reduce((sum, part) => sum + sample.parts[part], 0))),
      partsMs: Object.fromEntries(FRAME_PARTS.map((part) => [part, round(meanOf(samples.map((sample) => sample.parts[part])))])) as Record<FramePart, number>,
      drawCalls: Math.round(meanOf(samples.map((sample) => sample.drawCalls))),
      triangles: Math.round(meanOf(samples.map((sample) => sample.triangles))),
      programs: last.programs,
      canvas: { ...last.canvas },
    };
  }
}

function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number): number => round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!);
  return { p50: at(0.5), p95: at(0.95), max: round(sorted.at(-1)!) };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
