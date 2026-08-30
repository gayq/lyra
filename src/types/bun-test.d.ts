declare module "bun:test" {
  interface Matchers {
    toBe(expected: unknown): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toContain(expected: unknown): void;
    toMatch(expected: RegExp): void;
  }

  export function expect<T>(actual: T): Matchers;
  export function test(
    name: string,
    callback: () => void | Promise<void>,
  ): void;
}
