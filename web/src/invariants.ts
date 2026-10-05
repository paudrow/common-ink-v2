// What must always hold, checked where the app changes it (docs/TESTING.md). Free unless test levers
// turn the checks on; then a broken one is a console error, which fails a browser test.

type Report = (name: string, problems: string[]) => void;

let report: Report | null = null;

/** Check `problems` (none when all is well) only while levers listen. */
export function checkInvariant(name: string, problems: () => string[]): void {
  if (!report) return;
  const found = problems();
  if (found.length) report(name, found);
}

export function reportInvariants(to: Report): void {
  report = to;
}
