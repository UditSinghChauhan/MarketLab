/**
 * A small, fast, deterministic 64-bit hash for engine state.
 *
 * It is two independent 32-bit accumulators fed the same stream of integers.
 * Each step is a bijection of its accumulator (xor, then multiply by an odd
 * number), so changing any single input always changes the result. It uses
 * only 32-bit integer arithmetic, so Node and every browser agree bit for bit.
 *
 * It detects divergence between two honest replays. It is not cryptographic
 * and does not resist a deliberate attempt to forge a collision.
 */
export class StateHasher {
  private a = 0x811c9dc5;
  private b = 0x9e3779b9;

  /** Mixes in a non-negative safe integer (up to 2^53), as two 32-bit halves. */
  int(value: number): this {
    this.word(value >>> 0);
    this.word(Math.floor(value / 0x1_0000_0000) >>> 0);
    return this;
  }

  /** Mixes in a string, length first, so "ab","c" and "a","bc" differ. */
  str(value: string): this {
    this.word(value.length);
    for (let i = 0; i < value.length; i++) this.word(value.charCodeAt(i));
    return this;
  }

  private word(x: number): void {
    this.a = Math.imul(this.a ^ x, 0x01000193);
    this.b = Math.imul(this.b ^ x, 0x85ebca6b) + 0x27d4eb2f;
    this.b = (this.b << 13) | (this.b >>> 19);
  }

  /** Sixteen lowercase hex digits. */
  digest(): string {
    const hex = (n: number) => (avalanche(n) >>> 0).toString(16).padStart(8, "0");
    return hex(this.a) + hex(this.b ^ this.a);
  }
}

/** Final mixing step (MurmurHash3's fmix32), so nearby states give unrelated digests. */
function avalanche(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}
