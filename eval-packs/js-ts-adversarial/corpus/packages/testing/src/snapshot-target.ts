export function snapshotTarget(value: number): { value: number; label: string } {
  return { value, label: `value:${value}` };
}
