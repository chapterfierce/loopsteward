/**
 * Claw Task Service — Model Quantization Configuration (M9)
 *
 * Provides configuration management for model quantization modes:
 *   - FP16 (half-precision float)
 *   - INT8 (8-bit integer quantization)
 *   - INT4 (4-bit integer quantization)
 *   - FP32 (full-precision, baseline)
 *
 * Features:
 *   - Per-model quantization profile management
 *   - Calibration parameter configuration
 *   - Dynamic quantization range selection
 *   - Memory budget estimation
 *   - Quality/latency tradeoff hints
 *
 * Usage:
 *   import { QuantizationManager, QuantizationMode } from './quantization-config.js';
 *   const mgr = new QuantizationManager();
 *   mgr.applyConfig('intent-classifier', { mode: 'INT8', calibrationSamples: 200 });
 *   const profile = mgr.getProfile('intent-classifier');
 *
 * Based on: M9 task spec (2026-08-01)
 */

// ─── Quantization Types ───────────────────────────────────────────

/** Supported quantization modes */
export type QuantizationMode = 'FP32' | 'FP16' | 'INT8' | 'INT4';

/** Calibration strategy for quantization range determination */
export type CalibrationStrategy = 
  | 'minmax'      // Min-max calibration (fastest)
  | 'percentile'  // Percentile-based (robust to outliers)
  | 'mse'         // Mean squared error minimization
  | 'aciq'        // Analytical Clipping for Integer Quantization
  ;

/** Per-layer quantization configuration override */
export interface LayerQuantizationOverride {
  /** Layer name (e.g., 'encoder.layer.0.attention') */
  layerName: string;
  /** Override mode for this specific layer */
  mode: QuantizationMode;
  /** Whether to use symmetric quantization for this layer */
  symmetric: boolean;
}

/** Main quantization configuration */
export interface QuantizationConfig {
  /** Target quantization mode */
  mode: QuantizationMode;
  /** Calibration strategy for range determination */
  calibrationStrategy: CalibrationStrategy;
  /** Number of calibration samples (0 = use all available) */
  calibrationSamples: number;
  /** Whether to use symmetric quantization (default: false for weights, true for activations) */
  symmetricWeights: boolean;
  /** Whether to use symmetric quantization for activations */
  symmetricActivations: boolean;
  /** Per-layer overrides (takes precedence over global settings) */
  layerOverrides: LayerQuantizationOverride[];
  /** Whether to fuse layers (conv+bn+relu) for better quantization efficiency */
  fuseLayers: boolean;
  /** Whether to use per-channel quantization (vs per-tensor) */
  perChannel: boolean;
  /** Random initialization seed for calibration sampling (0 = deterministic) */
  calibrationSeed: number;
  /** Maximum memory budget in MB (0 = unlimited) */
  maxMemoryBudgetMb: number;
  /** Quality priority (0.0 = maximize speed, 1.0 = maximize quality) */
  qualityPriority: number;
}

/** Resolved quantization profile for a specific model */
export interface QuantizationProfile {
  /** Model identifier */
  modelId: string;
  /** Effective quantization mode */
  mode: QuantizationMode;
  /** Full resolved configuration */
  config: QuantizationConfig;
  /** Estimated model size in MB (after quantization) */
  estimatedSizeMb: number;
  /** Estimated memory savings percentage vs FP32 baseline */
  memorySavingPct: number;
  /** Estimated inference latency multiplier (1.0 = same as FP32) */
  latencyMultiplier: number;
  /** Estimated quality degradation (0.0 = no degradation, 1.0 = severe) */
  qualityLossEstimate: number;
  /** Number of layers with overrides */
  overriddenLayers: number;
  /** Timestamp when profile was created/updated */
  updatedAt: string;
}

// ─── Constants ────────────────────────────────────────────────────

/** Default configuration per quantization mode */
export const MODE_DEFAULTS: Record<QuantizationMode, Partial<QuantizationConfig>> = {
  FP32: {
    mode: 'FP32',
    symmetricWeights: false,
    symmetricActivations: false,
    perChannel: false,
    fuseLayers: false,
    qualityPriority: 1.0,
  },
  FP16: {
    mode: 'FP16',
    symmetricWeights: false,
    symmetricActivations: false,
    perChannel: false,
    fuseLayers: true,
    qualityPriority: 0.95,
  },
  INT8: {
    mode: 'INT8',
    symmetricWeights: true,
    symmetricActivations: false,
    perChannel: true,
    fuseLayers: true,
    calibrationSamples: 200,
    qualityPriority: 0.80,
  },
  INT4: {
    mode: 'INT4',
    symmetricWeights: true,
    symmetricActivations: true,
    perChannel: true,
    fuseLayers: true,
    calibrationSamples: 500,
    qualityPriority: 0.60,
  },
};

/** Model size reduction factors (relative to FP32 = 1.0) */
export const SIZE_FACTORS: Record<QuantizationMode, number> = {
  FP32: 1.0,
  FP16: 0.5,
  INT8: 0.25,
  INT4: 0.125,
};

/** Estimated latency multipliers (1.0 = FP32 baseline) */
export const LATENCY_MULTIPLIERS: Record<QuantizationMode, number> = {
  FP32: 1.0,
  FP16: 0.75,  // ~25% faster (SIMD half-precision)
  INT8: 0.50,  // ~50% faster (integer ops)
  INT4: 0.40,  // ~60% faster, but higher overhead for dequantization
};

/** Estimated quality loss (0.0 = no loss, 1.0 = severe) */
export const QUALITY_LOSS: Record<QuantizationMode, number> = {
  FP32: 0.0,
  FP16: 0.01,  // Near-lossless
  INT8: 0.05,  // Minor degradation
  INT4: 0.15,  // Noticeable degradation
};

// ─── Validation ───────────────────────────────────────────────────

/** Validation result */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a quantization configuration.
 * @param config - Configuration to validate
 * @param modelSizeMb - Optional model size in MB (for memory budget checks)
 * @returns Validation result with errors and warnings
 */
export function validateConfig(config: QuantizationConfig, modelSizeMb?: number): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check quality priority range
  if (config.qualityPriority < 0 || config.qualityPriority > 1) {
    errors.push(`qualityPriority must be in [0, 1], got ${config.qualityPriority}`);
  }

  // Check calibration samples
  if (config.calibrationSamples < 0) {
    errors.push(`calibrationSamples must be >= 0, got ${config.calibrationSamples}`);
  }

  // INT4 with low calibration samples warning
  if (config.mode === 'INT4' && config.calibrationSamples < 200) {
    warnings.push(
      `INT4 quantization with only ${config.calibrationSamples} calibration samples ` +
      `(recommended: >= 200 for stable results)`
    );
  }

  // INT8 without per-channel warning
  if (config.mode === 'INT8' && !config.perChannel) {
    warnings.push(
      'INT8 without perChannel quantization may cause significant accuracy loss for some layers'
    );
  }

  // Layer overrides validation
  const layerNames = new Set<string>();
  for (const override of config.layerOverrides) {
    if (layerNames.has(override.layerName)) {
      errors.push(`Duplicate layer override for: ${override.layerName}`);
    }
    layerNames.add(override.layerName);
  }

  // Memory budget check
  if (modelSizeMb !== undefined && config.maxMemoryBudgetMb > 0) {
    const estimatedSize = modelSizeMb * SIZE_FACTORS[config.mode];
    if (estimatedSize > config.maxMemoryBudgetMb) {
      errors.push(
        `Estimated quantized size ${estimatedSize.toFixed(1)}MB exceeds ` +
        `memory budget ${config.maxMemoryBudgetMb}MB`
      );
    }
  }

  // INT4 without symmetric weights warning
  if (config.mode === 'INT4' && !config.symmetricWeights) {
    warnings.push('INT4 without symmetric weights is uncommon and may not be supported by all runtimes');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ─── Quantization Manager ─────────────────────────────────────────

/**
 * Manages quantization profiles for multiple models.
 * Provides CRUD operations and profile resolution.
 */
export class QuantizationManager {
  private profiles: Map<string, QuantizationProfile> = new Map();
  private modelSizes: Map<string, number> = new Map();

  /**
   * Register a model with its FP32 size in MB.
   * @param modelId - Unique model identifier
   * @param sizeMb - Model size in FP32 (full precision) in MB
   */
  registerModel(modelId: string, sizeMb: number): void {
    this.modelSizes.set(modelId, sizeMb);
  }

  /**
   * Apply a quantization configuration to a model.
   * Creates or updates the model's quantization profile.
   * @param modelId - Model identifier (must be registered first)
   * @param configPartial - Partial config (merged with mode defaults)
   * @returns Resolved quantization profile
   */
  applyConfig(modelId: string, configPartial: Partial<QuantizationConfig>): QuantizationProfile {
    const sizeMb = this.modelSizes.get(modelId);
    if (sizeMb === undefined) {
      throw new Error(`Model "${modelId}" not registered. Call registerModel() first.`);
    }

    // Determine mode (from partial or default to FP16)
    const mode = configPartial.mode ?? 'FP16';
    const defaults = MODE_DEFAULTS[mode];

    // Merge: defaults < configPartial
    const config: QuantizationConfig = {
      mode,
      calibrationStrategy: configPartial.calibrationStrategy ?? 'minmax',
      calibrationSamples: configPartial.calibrationSamples ?? defaults.calibrationSamples ?? 100,
      symmetricWeights: configPartial.symmetricWeights ?? defaults.symmetricWeights ?? false,
      symmetricActivations: configPartial.symmetricActivations ?? defaults.symmetricActivations ?? false,
      layerOverrides: configPartial.layerOverrides ?? [],
      fuseLayers: configPartial.fuseLayers ?? defaults.fuseLayers ?? false,
      perChannel: configPartial.perChannel ?? defaults.perChannel ?? false,
      calibrationSeed: configPartial.calibrationSeed ?? 0,
      maxMemoryBudgetMb: configPartial.maxMemoryBudgetMb ?? 0,
      qualityPriority: configPartial.qualityPriority ?? defaults.qualityPriority ?? 0.9,
    };

    // Validate
    const validation = validateConfig(config, sizeMb);
    if (!validation.valid) {
      throw new Error(
        `Invalid quantization config for model "${modelId}":\n  ` +
        validation.errors.join('\n  ')
      );
    }

    // Compute profile estimates
    const estimatedSizeMb = sizeMb * SIZE_FACTORS[mode];
    const memorySavingPct = (1 - SIZE_FACTORS[mode]) * 100;
    const latencyMultiplier = LATENCY_MULTIPLIERS[mode];
    const qualityLossEstimate = QUALITY_LOSS[mode];

    // Adjust quality loss based on quality priority
    const adjustedQualityLoss = qualityLossEstimate * (1 - config.qualityPriority * 0.5);

    const profile: QuantizationProfile = {
      modelId,
      mode,
      config,
      estimatedSizeMb: Math.round(estimatedSizeMb * 100) / 100,
      memorySavingPct: Math.round(memorySavingPct * 10) / 10,
      latencyMultiplier,
      qualityLossEstimate: Math.round(adjustedQualityLoss * 1000) / 1000,
      overriddenLayers: config.layerOverrides.length,
      updatedAt: new Date().toISOString(),
    };

    this.profiles.set(modelId, profile);
    return profile;
  }

  /**
   * Get the quantization profile for a model.
   * @param modelId - Model identifier
   * @returns Profile or undefined if not configured
   */
  getProfile(modelId: string): QuantizationProfile | undefined {
    return this.profiles.get(modelId);
  }

  /**
   * List all configured model profiles.
   * @returns Array of all quantization profiles
   */
  listProfiles(): QuantizationProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Remove a model's quantization profile.
   * @param modelId - Model identifier
   * @returns true if profile was removed
   */
  removeProfile(modelId: string): boolean {
    return this.profiles.delete(modelId);
  }

  /**
   * Compare two quantization modes for a given model.
   * @param modelId - Model identifier (must be registered)
   * @param modeA - First quantization mode
   * @param modeB - Second quantization mode
   * @returns Comparison result
   */
  compareModes(modelId: string, modeA: QuantizationMode, modeB: QuantizationMode): QuantizationComparison {
    const sizeMb = this.modelSizes.get(modelId);
    if (sizeMb === undefined) {
      throw new Error(`Model "${modelId}" not registered.`);
    }

    const profileA = this.estimateProfile(modelId, modeA, sizeMb);
    const profileB = this.estimateProfile(modelId, modeB, sizeMb);

    return {
      modelId,
      modeA,
      modeB,
      profileA,
      profileB,
      sizeDeltaMb: profileB.estimatedSizeMb - profileA.estimatedSizeMb,
      latencyDelta: profileB.latencyMultiplier - profileA.latencyMultiplier,
      qualityDelta: profileB.qualityLossEstimate - profileA.qualityLossEstimate,
      memorySavingDeltaPct: profileB.memorySavingPct - profileA.memorySavingPct,
    };
  }

  /**
   * Get all available quantization modes.
   * @returns Array of modes ordered by precision (highest first)
   */
  getAvailableModes(): QuantizationMode[] {
    return ['FP32', 'FP16', 'INT8', 'INT4'];
  }

  /**
   * Estimate a profile without persisting it.
   * @internal
   */
  private estimateProfile(modelId: string, mode: QuantizationMode, sizeMb: number): QuantizationProfile {
    const defaults = MODE_DEFAULTS[mode];
    const config: QuantizationConfig = {
      mode,
      calibrationStrategy: 'minmax',
      calibrationSamples: defaults.calibrationSamples ?? 100,
      symmetricWeights: defaults.symmetricWeights ?? false,
      symmetricActivations: defaults.symmetricActivations ?? false,
      layerOverrides: [],
      fuseLayers: defaults.fuseLayers ?? false,
      perChannel: defaults.perChannel ?? false,
      calibrationSeed: 0,
      maxMemoryBudgetMb: 0,
      qualityPriority: defaults.qualityPriority ?? 0.9,
    };

    return {
      modelId,
      mode,
      config,
      estimatedSizeMb: Math.round(sizeMb * SIZE_FACTORS[mode] * 100) / 100,
      memorySavingPct: Math.round((1 - SIZE_FACTORS[mode]) * 1000) / 10,
      latencyMultiplier: LATENCY_MULTIPLIERS[mode],
      qualityLossEstimate: QUALITY_LOSS[mode],
      overriddenLayers: 0,
      updatedAt: new Date().toISOString(),
    };
  }
}

// ─── Comparison Types ─────────────────────────────────────────────

/** Quantization mode comparison result */
export interface QuantizationComparison {
  modelId: string;
  modeA: QuantizationMode;
  modeB: QuantizationMode;
  profileA: QuantizationProfile;
  profileB: QuantizationProfile;
  /** Size difference (B - A) in MB (negative = B is smaller) */
  sizeDeltaMb: number;
  /** Latency multiplier difference (B - A, negative = B is faster) */
  latencyDelta: number;
  /** Quality loss difference (B - A, positive = B has more loss) */
  qualityDelta: number;
  /** Memory saving difference in percentage points (B - A) */
  memorySavingDeltaPct: number;
}

// ─── Exports ──────────────────────────────────────────────────────

export type {
  QuantizationConfig,
  QuantizationProfile,
  LayerQuantizationOverride,
  CalibrationStrategy,
};
