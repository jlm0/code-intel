export function mockedTarget(label: string): string {
  return `real:${label}`;
}

export function consumeMocked(label: string): string {
  return mockedTarget(label).toUpperCase();
}
