class TestStorage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.values.set(String(key), String(value));
  }
}

// Node 25 exposes process-level Web Storage that throws without
// --localstorage-file. Tests use this deterministic origin-local equivalent.
Object.defineProperty(globalThis, 'Storage', {
  configurable: true,
  value: TestStorage,
});
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new TestStorage(),
});
