export function executeCoverageTarget(input: number): number {
  return input + 1;
}

export function coverageTestHelper(input: number): number {
  return executeCoverageTarget(input);
}
