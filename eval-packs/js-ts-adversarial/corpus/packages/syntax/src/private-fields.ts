export class CountingCache {
  static #instances = 0;
  static {
    CountingCache.#instances = 0;
  }

  #hits = 0;
  #store = new Map<string, number>();

  constructor() {
    CountingCache.#instances += 1;
  }

  static get instanceCount(): number {
    return CountingCache.#instances;
  }

  hit(key: string): number {
    this.#hits += 1;
    return this.#store.get(key) ?? 0;
  }

  set(key: string, value: number): void {
    this.#store.set(key, value);
  }

  get totalHits(): number {
    return this.#hits;
  }
}
