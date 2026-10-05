// Seeded random inputs for property tests, with no dependencies. Every run is the same unless FUZZ_SEED
// changes the seed; FUZZ_RUNS sets how many cases each property tries.

export type Rng = ReturnType<typeof rng>;
export type Gen<T> = (r: Rng) => T;

/** mulberry32: a small, fast PRNG with a 32-bit seed. */
export function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const r = {
    next,
    /** A whole number from `lo` to `hi`, both included. */
    int,
    bool: (p = 0.5) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)],
    array: <T>(min: number, max: number, gen: Gen<T>): T[] => Array.from({ length: int(min, max) }, () => gen(r)),
  };
  return r;
}

const SEED = Number(process.env.FUZZ_SEED ?? 20261005) >>> 0;
const RUNS = process.env.FUZZ_RUNS ? Number(process.env.FUZZ_RUNS) : null;

function failure<T>(check: (value: T) => void, value: T): Error | null {
  try {
    check(value);
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** The shortest sequence that still fails, found by dropping one step at a time until none can go. */
function shrink<T>(check: (value: T[]) => void, value: T[], error: Error): [T[], Error] {
  for (let i = 0; i < value.length; ) {
    const smaller = value.toSpliced(i, 1);
    const e = failure(check, smaller);
    if (e) [value, error, i] = [smaller, e, 0];
    else i++;
  }
  return [value, error];
}

/**
 * Check a property on `runs` generated cases. Case i is generated from seed FUZZ_SEED + i, so a failure
 * names the seed that reproduces it alone. An array input (a sequence of steps) is shrunk first.
 */
export function forAll<T>(gen: Gen<T>, check: (value: T) => void, { runs = 100 }: { runs?: number } = {}): void {
  for (let i = 0; i < (RUNS ?? runs); i++) {
    const seed = (SEED + i) >>> 0;
    const value = gen(rng(seed));
    const error = failure(check, value);
    if (!error) continue;
    const [input, cause] = Array.isArray(value) ? shrink(check as (v: unknown[]) => void, value, error) : [value, error];
    throw new Error(
      `Property failed on case ${i} of seed ${SEED} (FUZZ_SEED=${seed} FUZZ_RUNS=1 runs it alone).\n${cause.message}\nInput${Array.isArray(value) ? `, shrunk from ${value.length} steps to ${(input as unknown[]).length}` : ""}: ${JSON.stringify(input)}`,
      { cause },
    );
  }
}
