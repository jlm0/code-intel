export function runOverload(value: string): string;
export function runOverload(value: number): number;
export function runOverload(value: boolean): boolean;
export function runOverload(value: string | number | boolean): string | number | boolean {
  return value;
}

export class OverloadHost {
  handle(value: string): string;
  handle(value: number): number;
  handle(value: string | number): string | number {
    return typeof value === "string" ? value.toUpperCase() : value * 2;
  }
}
