/**
 * Claw Task Service — M9 Quantization Config + Benchmark Tests
 *
 * Unit tests for quantization configuration, validation, and simulation.
 *
 * Run: npx tsx tests/m9-quantization-test.ts
 *
 * Based on: M9 task spec (2026-08-01)
 */

import assert from 'node:assert';
import {
  QuantizationManager,
  QuantizationSimulator,
  createSimulator,
  validateConfig,
  MODE_DEFAULTS,
  SIZE_FACTORS,
  LATENCY_MULTIPLIERS,
  QUALITY_LOSS,
  type QuantizationMode,
  type QuantizationConfig,
} from '../src/quantization/index.js';

// ─── Test Runner ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

function section(title: string): void {
  console.log(`\n─── ${title} ───`);
}

// ─── Tests ────────────────────────────────────────────────────────

section('Quantization Config — Constants');

test('SIZE_FACTORS: FP32=1.0, FP16=0.5, INT8=0.25, INT4=0.125', () => {
  assert.strictEqual(SIZE_FACTORS.FP32, 1.0);
  assert.strictEqual(SIZE_FACTORS.FP16, 0.5);
  assert.strictEqual(SIZE_FACTORS.INT8, 0.25);
  assert.strictEqual(SIZE_FACTORS.INT4, 0.125);
});

test('LATENCY_MULTIPLIERS: FP32=1.0, all others < 1.0', () => {
  assert.strictEqual(LATENCY_MULTIPLIERS.FP32, 1.0);
  assert.ok(LATENCY_MULTIPLIERS.FP16 < 1.0);
  assert.ok(LATENCY_MULTIPLIERS.INT8 < LATENCY_MULTIPLIERS.FP16);
  assert.ok(LATENCY_MULTIPLIERS.INT4 < LATENCY_MULTIPLIERS.INT8);
});

test('QUALITY_LOSS: FP32=0, FP16<0.02, INT8<0.10, INT4<0.20', () => {
  assert.strictEqual(QUALITY_LOSS.FP32, 0.0);
  assert.ok(QUALITY_LOSS.FP16 < 0.02);
  assert.ok(QUALITY_LOSS.INT8 < 0.10);
  assert.ok(QUALITY_LOSS.INT4 < 0.20);
});

test('MODE_DEFAULTS: each mode has sensible defaults', () => {
  assert.strictEqual(MODE_DEFAULTS.FP32.mode, 'FP32');
  assert.strictEqual(MODE_DEFAULTS.FP16.mode, 'FP16');
  assert.strictEqual(MODE_DEFAULTS.INT8.mode, 'INT8');
  assert.strictEqual(MODE_DEFAULTS.INT4.mode, 'INT4');
  // INT8 should default to per-channel
  assert.strictEqual(MODE_DEFAULTS.INT8.perChannel, true);
  // INT8 should have calibration samples
  assert.ok((MODE_DEFAULTS.INT8.calibrationSamples ?? 0) > 0);
});

// ───────────────────────────────────────────────────────────────────

section('Quantization Config — Validation');

test('valid FP16 config passes validation', () => {
  const config: QuantizationConfig = {
    mode: 'FP16',
    calibrationStrategy: 'minmax',
    calibrationSamples: 100,
    symmetricWeights: false,
    symmetricActivations: false,
    layerOverrides: [],
    fuseLayers: true,
    perChannel: false,
    calibrationSeed: 0,
    maxMemoryBudgetMb: 0,
    qualityPriority: 0.95,
  };
  const result = validateConfig(config);
  assert.ok(result.valid, `Expected valid, errors: ${result.errors.join(', ')}`);
  assert.strictEqual(result.errors.length, 0);
});

test('invalid qualityPriority (> 1) fails validation', () => {
  const config: QuantizationConfig = {
    mode: 'INT8',
    calibrationStrategy: 'minmax',
    calibrationSamples: 200,
    symmetricWeights: true,
    symmetricActivations: false,
    layerOverrides: [],
    fuseLayers: true,
    perChannel: true,
    calibrationSeed: 0,
    maxMemoryBudgetMb: 0,
    qualityPriority: 1.5,
  };
  const result = validateConfig(config);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('qualityPriority')));
});

test('negative calibrationSamples fails validation', () => {
  const config: QuantizationConfig = {
    mode: 'INT8',
    calibrationStrategy: 'minmax',
    calibrationSamples: -1,
    symmetricWeights: true,
    symmetricActivations: false,
    layerOverrides: [],
    fuseLayers: true,
    perChannel: true,
    calibrationSeed: 0,
    maxMemoryBudgetMb: 0,
    qualityPriority: 0.8,
  };
  const result = validateConfig(config);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('calibrationSamples')));
});

test('INT4 with low calibration samples produces warning', () => {
  const config: QuantizationConfig = {
    mode: 'INT4',
    calibrationStrategy: 'minmax',
    calibrationSamples: 50,
    symmetricWeights: true,
    symmetricActivations: true,
    layerOverrides: [],
    fuseLayers: true,
    perChannel: true,
    calibrationSeed: 0,
    maxMemoryBudgetMb: 0,
    qualityPriority: 0.6,
  };
  const result = validateConfig(config);
  assert.ok(result.valid);
  assert.ok(result.warnings.some(w => w.includes('INT4')));
});

test('memory budget exceeded fails validation', () => {
  const config: QuantizationConfig = {
    mode: 'FP32',
    calibrationStrategy: 'minmax',
    calibrationSamples: 100,
    symmetricWeights: false,
    symmetricActivations: false,
    layerOverrides: [],
    fuseLayers: false,
    perChannel: false,
    calibrationSeed: 0,
    maxMemoryBudgetMb: 50, // 50MB budget for a 100MB model
    qualityPriority: 1.0,
  };
  const result = validateConfig(config, 100); // model size = 100MB
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('memory budget')));
});

test('duplicate layer overrides fail validation', () => {
  const config: QuantizationConfig = {
    mode: 'INT8',
    calibrationStrategy: 'minmax',
    calibrationSamples: 200,
    symmetricWeights: true,
    symmetricActivations: false,
    layerOverrides: [
      { layerName: 'layer.0', mode: 'INT8', symmetric: true },
      { layerName: 'layer.0', mode: 'INT4', symmetric: true },
    ],
    fuseLayers: true,
    perChannel: true,
    calibrationSeed: 0,
    maxMemoryBudgetMb: 0,
    qualityPriority: 0.8,
  };
  const result = validateConfig(config);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes('Duplicate')));
});

// ───────────────────────────────────────────────────────────────────

section('Quantization Manager');

test('registerModel + applyConfig creates profile', () => {
  const mgr = new QuantizationManager();
  mgr.registerModel('test-model', 200);

  const profile = mgr.applyConfig('test-model', { mode: 'INT8', calibrationSamples: 300 });

  assert.strictEqual(profile.modelId, 'test-model');
  assert.strictEqual(profile.mode, 'INT8');
  assert.strictEqual(profile.estimatedSizeMb, 50); // 200 * 0.25
  assert.strictEqual(profile.memorySavingPct, 75); // (1 - 0.25) * 100
  assert.strictEqual(profile.latencyMultiplier, LATENCY_MULTIPLIERS.INT8);
  assert.strictEqual(profile.overriddenLayers, 0);
  assert.ok(profile.updatedAt);
});

test('applyConfig without registerModel throws', () => {
  const mgr = new QuantizationManager();
  assert.throws(
    () => mgr.applyConfig('unknown-model', { mode: 'FP16' }),
    /not registered/,
  );
});

test('getProfile returns undefined for unconfigured model', () => {
  const mgr = new QuantizationManager();
  mgr.registerModel('model-a', 100);
  assert.strictEqual(mgr.getProfile('model-b'), undefined);
});

test('listProfiles returns all configured profiles', () => {
  const mgr = new QuantizationManager();
  mgr.registerModel('m1', 100);
  mgr.registerModel('m2', 200);
  mgr.applyConfig('m1', { mode: 'FP16' });
  mgr.applyConfig('m2', { mode: 'INT8' });

  const profiles = mgr.listProfiles();
  assert.strictEqual(profiles.length, 2);
  assert.ok(profiles.some(p => p.modelId === 'm1'));
  assert.ok(profiles.some(p => p.modelId === 'm2'));
});

test('removeProfile removes and returns true', () => {
  const mgr = new QuantizationManager();
  mgr.registerModel('m1', 100);
  mgr.applyConfig('m1', { mode: 'FP16' });

  assert.strictEqual(mgr.removeProfile('m1'), true);
  assert.strictEqual(mgr.getProfile('m1'), undefined);
  assert.strictEqual(mgr.removeProfile('m1'), false);
});

test('compareModes returns correct deltas', () => {
  const mgr = new QuantizationManager();
  mgr.registerModel('compare-model', 100);

  const comparison = mgr.compareModes('compare-model', 'FP16', 'INT8');

  assert.strictEqual(comparison.modelId, 'compare-model');
  assert.strictEqual(comparison.modeA, 'FP16');
  assert.strictEqual(comparison.modeB, 'INT8');
  // INT8 should be smaller than FP16
  assert.ok(comparison.sizeDeltaMb < 0, `Expected negative size delta, got ${comparison.sizeDeltaMb}`);
  // INT8 should be faster than FP16
  assert.ok(comparison.latencyDelta < 0, `Expected negative latency delta, got ${comparison.latencyDelta}`);
  // INT8 should have more quality loss than FP16
  assert.ok(comparison.qualityDelta > 0, `Expected positive quality delta, got ${comparison.qualityDelta}`);
  // INT8 should save more memory than FP16
  assert.ok(comparison.memorySavingDeltaPct > 0);
});

test('layerOverrides count is reflected in profile', () => {
  const mgr = new QuantizationManager();
  mgr.registerModel('override-model', 100);

  const profile = mgr.applyConfig('override-model', {
    mode: 'INT8',
    layerOverrides: [
      { layerName: 'encoder.0', mode: 'INT4', symmetric: true },
      { layerName: 'encoder.1', mode: 'FP16', symmetric: false },
    ],
  });

  assert.strictEqual(profile.overriddenLayers, 2);
});

test('getAvailableModes returns all 4 modes ordered by precision', () => {
  const mgr = new QuantizationManager();
  const modes = mgr.getAvailableModes();
  assert.deepStrictEqual(modes, ['FP32', 'FP16', 'INT8', 'INT4']);
});

// ───────────────────────────────────────────────────────────────────

section('Quantization Simulator');

test('simulate FP32 returns baseline values', () => {
  const sim = createSimulator(100, 1000, 42);
  const result = sim.simulate(5.0, 'FP32');

  assert.strictEqual(result.mode, 'FP32');
  assert.strictEqual(result.output, 5.0);
  assert.ok(result.memoryMb > 99 && result.memoryMb < 101); // ~100MB
  assert.strictEqual(result.qualityDrop, 0);
});

test('simulate INT8 reduces memory by 4x', () => {
  const sim = createSimulator(100, 1000, 42);
  const result = sim.simulate(5.0, 'INT8');

  assert.ok(result.memoryMb > 24 && result.memoryMb < 26); // ~25MB
});

test('simulate INT4 reduces memory by 8x', () => {
  const sim = createSimulator(100, 1000, 42);
  const result = sim.simulate(5.0, 'INT4');

  assert.ok(result.memoryMb > 12 && result.memoryMb < 13); // ~12.5MB
});

test('simulate FP16 has lower latency than FP32', () => {
  const sim = createSimulator(100, 1000, 42);
  const fp32 = sim.simulate(1.0, 'FP32');
  const fp16 = sim.simulate(1.0, 'FP16');

  assert.ok(fp16.latencyUs < fp32.latencyUs, 'FP16 should be faster than FP32');
});

test('simulate INT8 has lower latency than FP16', () => {
  const sim = createSimulator(100, 1000, 42);
  const fp16 = sim.simulate(1.0, 'FP16');
  const int8 = sim.simulate(1.0, 'INT8');

  assert.ok(int8.latencyUs < fp16.latencyUs, 'INT8 should be faster than FP16');
});

test('simulate with seed produces deterministic results', () => {
  const sim1 = createSimulator(100, 1000, 42);
  const sim2 = createSimulator(100, 1000, 42);

  for (let i = 0; i < 10; i++) {
    const r1 = sim1.simulate(i, 'INT8');
    const r2 = sim2.simulate(i, 'INT8');
    assert.strictEqual(r1.latencyUs, r2.latencyUs, `Iteration ${i}: latency should match`);
    assert.strictEqual(r1.quantizedOutput, r2.quantizedOutput, `Iteration ${i}: output should match`);
  }
});

test('simulate without seed (seed=0) produces varied results', () => {
  const sim = createSimulator(100, 1000, 0);
  const results: number[] = [];
  for (let i = 0; i < 20; i++) {
    const r = sim.simulate(1.0, 'INT8');
    results.push(r.latencyUs);
  }
  // With random jitter, not all values should be identical
  const unique = new Set(results.map(r => Math.round(r * 1000) / 1000));
  assert.ok(unique.size > 1, 'Expected varied results with seed=0 (random jitter)');
});

test('simulateBatch processes multiple inputs', () => {
  const sim = createSimulator(100, 1000, 42);
  const inputs = [1.0, 2.0, 3.0, 4.0, 5.0];
  const results = sim.simulateBatch(inputs, 'INT8');

  assert.strictEqual(results.length, inputs.length);
  for (let i = 0; i < inputs.length; i++) {
    assert.strictEqual(results[i].output, inputs[i]);
    assert.strictEqual(results[i].mode, 'INT8');
  }
});

test('compareAllModes returns results for all 4 modes', () => {
  const sim = createSimulator(100, 1000, 42);
  const results = sim.compareAllModes(5.0);

  assert.ok(results.FP32);
  assert.ok(results.FP16);
  assert.ok(results.INT8);
  assert.ok(results.INT4);
});

test('getQuantizationStep returns correct step sizes', () => {
  const sim = createSimulator(100, 1000, 42);

  const step32 = sim.getQuantizationStep('FP32');
  const step16 = sim.getQuantizationStep('FP16');
  const step8 = sim.getQuantizationStep('INT8');
  const step4 = sim.getQuantizationStep('INT4');

  assert.ok(step32 < step16);
  assert.ok(step16 < step8);
  assert.ok(step8 < step4);
});

test('updateConfig changes simulator behavior', () => {
  const sim = createSimulator(100, 1000, 42);
  const before = sim.simulate(1.0, 'INT8');

  sim.updateConfig({ baselineLatencyUs: 2000 });
  const after = sim.simulate(1.0, 'INT8');

  assert.ok(after.latencyUs > before.latencyUs, 'Latency should increase with higher baseline');
});

test('getConfig returns current configuration', () => {
  const sim = createSimulator(150, 800, 42);
  const config = sim.getConfig();

  assert.strictEqual(config.baselineSizeMb, 150);
  assert.strictEqual(config.baselineLatencyUs, 800);
  assert.strictEqual(config.seed, 42);
  assert.strictEqual(config.addJitter, true);
});

// ───────────────────────────────────────────────────────────────────

section('Integration — Manager + Simulator');

test('Manager profile estimates match simulator', () => {
  const sizeMb = 200;
  const mgr = new QuantizationManager();
  mgr.registerModel('integ-model', sizeMb);

  const profile = mgr.applyConfig('integ-model', { mode: 'INT8' });
  const sim = createSimulator(sizeMb, 500, 42);
  const simResult = sim.simulate(0, 'INT8');

  assert.strictEqual(profile.estimatedSizeMb, simResult.memoryMb);
  assert.strictEqual(profile.latencyMultiplier, LATENCY_MULTIPLIERS.INT8);
});

test('Full workflow: register → apply → compare → list → remove', () => {
  const mgr = new QuantizationManager();

  // Register
  mgr.registerModel('workflow-model', 150);
  assert.strictEqual(mgr.listProfiles().length, 0);

  // Apply FP16
  const fp16Profile = mgr.applyConfig('workflow-model', { mode: 'FP16' });
  assert.strictEqual(fp16Profile.mode, 'FP16');
  assert.strictEqual(mgr.listProfiles().length, 1);

  // Compare modes
  const comparison = mgr.compareModes('workflow-model', 'FP32', 'INT8');
  assert.ok(comparison.sizeDeltaMb < 0); // INT8 is smaller

  // Remove
  assert.strictEqual(mgr.removeProfile('workflow-model'), true);
  assert.strictEqual(mgr.listProfiles().length, 0);
});

// ─── Main ──────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));

if (failed > 0) {
  process.exitCode = 1;
  console.log('\n  ❌ Some tests failed.');
} else {
  console.log('\n  ✅ All M9 quantization tests passed!');
}
