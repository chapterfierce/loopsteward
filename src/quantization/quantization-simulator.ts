/**
 * Claw Task Service — Quantization Simulator (M9)
 *
 * Simulates the effect of quantization on model inference by:
 *   - Simulating latency differences between FP32/FP16/INT8/INT4
 *   - Simulating memory footprint reduction
 *   - Simulating quality (confidence) degradation
 *
 * This is a lightweight simulation layer — no actual model weights are
 * quantized. It provides reproducible, configurable estimates for
 * benchmarking and A/B comparison purposes.
 *
 * Based on: M9 task spec (2026-08-01)
 */

import { QuantizationMode, QuantizationConfig, MODE_DEFAULTS, SIZE_FACTORS, LATENCY_MULTIPLIERS, QUALITY_LOSS } from './quantization-config.js';

// ─── Types ────────────────────────────────────────────────────────

/** Simulated inference result */
export interface SimulatedInference {
  /** Original output (FP32 baseline) */
  output: number;
  /** Quantized output (after simulated quantization) */
  quantizedOutput: number;
  /** Effective latency in microseconds */
  latencyUs: number;
  /** Estimated memory usage in MB */
  memoryMb: number;
  /** Simulated confidence degradation [0, 1] */
  qualityDrop: number;
  /** Mode used for this simulation */
  mode: QuantizationMode;
}

/** Configuration for the quantization simulator */
export interface SimulatorConfig {
  /** Baseline FP32 model size in MB */
  baselineSizeMb: number;
  /** Baseline FP32 inference latency in microseconds */
  baselineLatencyUs: number;
  /** Whether to add jitter to latency measurements (for realistic benchmarks) */
  addJitter: boolean;
  /** Jitter magnitude as fraction of latency (0.05 = ±5%) */
  jitterMagnitude: number;
  /** Random seed (0 = use Math.random) */
  seed: number;
}

// ─── Pseudo-Random Number Generator ────────────────────────────────

/** Mulberry32 seeded PRNG */
class Mulberry32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  /** Next float in [0, 1) */
  next(): number {
    this.state = (this.state + 0x6D2B79F5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Next float in [-1, 1) */
  nextSigned(): number {
    return this.next() * 2 - 1;
  }
}

// ─── Quantization Simulator ───────────────────────────────────────

/**
 * Simulates model quantization effects on latency, memory, and quality.
 */
export class QuantizationSimulator {
  private config: SimulatorConfig;
  private rng: Mulberry32 | null = null;

  constructor(config: Partial<SimulatorConfig> = {}) {
    this.config = {
      baselineSizeMb: config.baselineSizeMb ?? 100,
      baselineLatencyUs: config.baselineLatencyUs ?? 1000,
      addJitter: config.addJitter ?? true,
      jitterMagnitude: config.jitterMagnitude ?? 0.05,
      seed: config.seed ?? 0,
    };

    if (this.config.seed !== 0) {
      this.rng = new Mulberry32(this.config.seed);
    }
  }

  /**
   * Simulate a single inference with a given quantization mode.
   * @param input - Input value (e.g., embedding vector or logit)
   * @param mode - Quantization mode to simulate
   * @param config - Optional quantization config override
   * @returns Simulated inference result
   */
  simulate(
    input: number,
    mode: QuantizationMode,
    config?: Partial<QuantizationConfig>,
  ): SimulatedInference {
    const sizeFactor = SIZE_FACTORS[mode];
    const latencyMultiplier = LATENCY_MULTIPLIERS[mode];
    const qualityLoss = QUALITY_LOSS[mode];

    // Compute latency with optional jitter
    let latencyUs = this.config.baselineLatencyUs * latencyMultiplier;
    if (this.config.addJitter) {
      const jitter = this.randomJitter() * this.config.jitterMagnitude;
      latencyUs *= (1 + jitter);
    }
    latencyUs = Math.max(0.1, latencyUs); // Floor at 0.1μs

    // Compute memory
    const memoryMb = this.config.baselineSizeMb * sizeFactor;

    // Simulate quantization noise on the output
    // INT8: ±1/127 ≈ 0.008, INT4: ±1/7 ≈ 0.14, FP16: ±1/65519 ≈ 0.000015
    const quantizationNoise = this.computeQuantizationNoise(mode, config);
    const noise = this.randomNoise() * quantizationNoise;
    const quantizedOutput = input + noise;

    // Compute quality drop
    const qualityDrop = qualityLoss * (1 - (config?.qualityPriority ?? 0.9) * 0.5);

    return {
      output: input,
      quantizedOutput,
      latencyUs,
      memoryMb,
      qualityDrop,
      mode,
    };
  }

  /**
   * Simulate a batch of inferences.
   * @param inputs - Array of input values
   * @param mode - Quantization mode
   * @param config - Optional quantization config
   * @returns Array of simulated results
   */
  simulateBatch(
    inputs: number[],
    mode: QuantizationMode,
    config?: Partial<QuantizationConfig>,
  ): SimulatedInference[] {
    return inputs.map(input => this.simulate(input, mode, config));
  }

  /**
   * Compare all quantization modes for a given input.
   * @param input - Input value
   * @returns Map of mode → simulation result
   */
  compareAllModes(input: number): Record<QuantizationMode, SimulatedInference> {
    const modes: QuantizationMode[] = ['FP32', 'FP16', 'INT8', 'INT4'];
    const results: Partial<Record<QuantizationMode, SimulatedInference>> = {};

    for (const mode of modes) {
      results[mode] = this.simulate(input, mode);
    }

    return results as Record<QuantizationMode, SimulatedInference>;
  }

  /**
   * Get the effective quantization step size for a mode.
   * @param mode - Quantization mode
   * @returns Step size (difference between adjacent quantization levels)
   */
  getQuantizationStep(mode: QuantizationMode): number {
    switch (mode) {
      case 'FP32': return 1 / Math.pow(2, 23);  // 23-bit mantissa
      case 'FP16': return 1 / Math.pow(2, 10);  // 10-bit mantissa
      case 'INT8': return 1 / 127;
      case 'INT4': return 1 / 7;
      default: return 0;
    }
  }

  /**
   * Update simulator configuration.
   * @param config - Partial config to update
   */
  updateConfig(config: Partial<SimulatorConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.seed !== undefined) {
      this.rng = config.seed !== 0 ? new Mulberry32(config.seed) : null;
    }
  }

  /**
   * Get current simulator configuration.
   */
  getConfig(): SimulatorConfig {
    return { ...this.config };
  }

  // ─── Private helpers ───────────────────────────────────────────

  private randomJitter(): number {
    if (this.rng) return this.rng.nextSigned();
    return Math.random() * 2 - 1;
  }

  private randomNoise(): number {
    if (this.rng) return this.rng.nextSigned();
    return Math.random() * 2 - 1;
  }

  private computeQuantizationNoise(mode: QuantizationMode, config?: Partial<QuantizationConfig>): number {
    const step = this.getQuantizationStep(mode);
    // If per-channel is enabled, noise is slightly reduced
    const perChannelReduction = config?.perChannel ? 0.8 : 1.0;
    return step * perChannelReduction;
  }
}

// ─── Factory ──────────────────────────────────────────────────────

/**
 * Create a simulator with predefined model profiles.
 */
export function createSimulator(modelSizeMb: number, baselineLatencyUs: number, seed: number = 0): QuantizationSimulator {
  return new QuantizationSimulator({
    baselineSizeMb: modelSizeMb,
    baselineLatencyUs,
    seed,
    addJitter: true,  // Always add jitter; seeded mode is reproducible, seed=0 uses Math.random
    jitterMagnitude: 0.05,
  });
}
