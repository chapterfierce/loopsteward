/**
 * Claw Task Service — Quantization Module Index (M9)
 *
 * Public API for the quantization subsystem.
 *
 * Usage:
 *   import { QuantizationManager, QuantizationSimulator, ... } from '../quantization/index.js';
 */

export {
  // Types
  type QuantizationMode,
  type QuantizationConfig,
  type QuantizationProfile,
  type LayerQuantizationOverride,
  type CalibrationStrategy,
  type ValidationResult,
  type QuantizationComparison,
  // Constants
  MODE_DEFAULTS,
  SIZE_FACTORS,
  LATENCY_MULTIPLIERS,
  QUALITY_LOSS,
  // Functions
  validateConfig,
  // Class
  QuantizationManager,
} from './quantization-config.js';

export {
  // Types
  type SimulatedInference,
  type SimulatorConfig,
  // Class
  QuantizationSimulator,
  // Factory
  createSimulator,
} from './quantization-simulator.js';
