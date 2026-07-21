/**
 * Claw Task Service — LRU Cache Layer (Phase 3 M1)
 *
 * Provides O(1) get/set LRU caching for intent classification results.
 * Uses FNV-1a 32-bit hash as cache key for fast lookups.
 *
 * Design:
 *   - Generic LRUCache<K, V>: doubly-linked list + Map, O(1) get/set
 *   - IntentLRUCache: specialized cache for IntentResult with FNV-1a hash key
 *   - Default capacity: 1000 entries
 *   - Default TTL: 5 minutes (300,000 ms)
 *
 * Based on: phase3-m1-report.md (v1.0, 2026-07-15)
 */

import { IntentResult } from './types';

// ─── Doubly-Linked List Node ───────────────────────────────────────

interface DLLNode<K, V> {
  key: K;
  value: V;
  expiresAt: number;
  prev: DLLNode<K, V> | null;
  next: DLLNode<K, V> | null;
}

// ─── Generic LRU Cache ─────────────────────────────────────────────

/**
 * Generic LRU cache with TTL support.
 * Uses a doubly-linked list for O(1) eviction and a Map for O(1) lookups.
 */
export class LRUCache<K, V> {
  private capacity: number;
  private ttlMs: number;
  private map: Map<K, DLLNode<K, V>>;
  private head: DLLNode<K, V> | null; // Most recently used
  private tail: DLLNode<K, V> | null; // Least recently used

  // Stats
  private _hits: number = 0;
  private _misses: number = 0;
  private _evictions: number = 0;
  private _expirations: number = 0;

  constructor(capacity: number = 1000, ttlMs: number = 300_000) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.head = null;
    this.tail = null;
  }

  /**
   * Get a value from the cache.
   * Returns undefined if not found or expired.
   * Moves the accessed node to the head (most recently used).
   */
  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (!node) {
      this._misses++;
      return undefined;
    }

    // Check TTL expiration
    if (Date.now() > node.expiresAt) {
      this.removeNode(node);
      this.map.delete(key);
      this._expirations++;
      this._misses++;
      return undefined;
    }

    // Move to head (most recently used)
    this.moveToHead(node);
    this._hits++;
    return node.value;
  }

  /**
   * Set a value in the cache.
   * If at capacity, evicts the least recently used entry.
   */
  set(key: K, value: V): void {
    const existing = this.map.get(key);
    const expiresAt = Date.now() + this.ttlMs;

    if (existing) {
      // Update existing node
      existing.value = value;
      existing.expiresAt = expiresAt;
      this.moveToHead(existing);
      return;
    }

    // Create new node
    const node: DLLNode<K, V> = {
      key,
      value,
      expiresAt,
      prev: null,
      next: null,
    };

    this.map.set(key, node);
    this.addToHead(node);

    // Evict LRU if over capacity
    if (this.map.size > this.capacity) {
      const lru = this.tail;
      if (lru) {
        this.removeNode(lru);
        this.map.delete(lru.key);
        this._evictions++;
      }
    }
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: K): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    if (Date.now() > node.expiresAt) {
      this.removeNode(node);
      this.map.delete(key);
      this._expirations++;
      return false;
    }
    return true;
  }

  /**
   * Delete a key from the cache.
   */
  delete(key: K): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    this.removeNode(node);
    this.map.delete(key);
    return true;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  /**
   * Current number of entries in the cache.
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Maximum capacity of the cache.
   */
  getCapacity(): number {
    return this.capacity;
  }

  // ─── Stats ──────────────────────────────────────────────────────

  get hits(): number { return this._hits; }
  get misses(): number { return this._misses; }
  get evictions(): number { return this._evictions; }
  get expirations(): number { return this._expirations; }

  /**
   * Cache hit rate (0-1). Returns 0 if no accesses yet.
   */
  get hitRate(): number {
    const total = this._hits + this._misses;
    return total === 0 ? 0 : this._hits / total;
  }

  /**
   * Reset statistics counters (does not clear entries).
   */
  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
    this._expirations = 0;
  }

  // ─── Internal LinkedList Operations ─────────────────────────────

  private addToHead(node: DLLNode<K, V>): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;
    if (!this.tail) {
      this.tail = node;
    }
  }

  private removeNode(node: DLLNode<K, V>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  private moveToHead(node: DLLNode<K, V>): void {
    if (this.head === node) return;
    this.removeNode(node);
    this.addToHead(node);
  }
}

// ─── FNV-1a 32-bit Hash ────────────────────────────────────────────

/**
 * Compute FNV-1a 32-bit hash of a string.
 * Returns a hex string suitable for use as a Map key.
 *
 * Algorithm: FNV-1a offset basis 2166136261, prime 16777619.
 * Each byte: hash ^= byte; hash *= prime (with 32-bit wrap).
 */
export function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (2166136261)

  // Encode as UTF-8 to handle multibyte characters properly
  const bytes = Buffer.from(text, 'utf-8');

  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    // Multiply by FNV prime (16777619) with 32-bit wrap
    hash = Math.imul(hash, 0x01000193);
  }

  // Convert to unsigned 32-bit and return as hex string
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ─── Cache Stats Interface ─────────────────────────────────────────

export interface CacheStats {
  size: number;
  capacity: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  hitRate: number;
}

// ─── Intent LRU Cache ──────────────────────────────────────────────

/**
 * Specialized LRU cache for IntentResult.
 * Uses FNV-1a hash of input text as the cache key.
 */
export class IntentLRUCache {
  private cache: LRUCache<string, IntentResult>;

  constructor(capacity: number = 1000, ttlMs: number = 300_000) {
    this.cache = new LRUCache<string, IntentResult>(capacity, ttlMs);
  }

  /**
   * Get a cached IntentResult by input text.
   * Returns undefined if not found or expired.
   */
  get(text: string): IntentResult | undefined {
    const key = fnv1aHash(text);
    return this.cache.get(key);
  }

  /**
   * Cache an IntentResult with the input text as key.
   */
  set(text: string, result: IntentResult): void {
    const key = fnv1aHash(text);
    this.cache.set(key, result);
  }

  /**
   * Check if a text has a cached result.
   */
  has(text: string): boolean {
    const key = fnv1aHash(text);
    return this.cache.has(key);
  }

  /**
   * Clear all cached results.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    return {
      size: this.cache.size,
      capacity: this.cache.getCapacity(),
      hits: this.cache.hits,
      misses: this.cache.misses,
      evictions: this.cache.evictions,
      expirations: this.cache.expirations,
      hitRate: this.cache.hitRate,
    };
  }

  /**
   * Reset statistics counters (does not clear entries).
   */
  resetStats(): void {
    this.cache.resetStats();
  }
}
