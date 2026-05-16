type ClassDecoratorContext = { kind: "class"; name: string | undefined };
type ClassMethodDecoratorContext = { kind: "method"; name: string };
type ClassAccessorDecoratorContext = { kind: "accessor"; name: string };

export function logged<T extends new (...args: unknown[]) => unknown>(
  value: T,
  _context: ClassDecoratorContext,
): T {
  return value;
}

export function logMethod(
  value: (...args: unknown[]) => unknown,
  _context: ClassMethodDecoratorContext,
): (...args: unknown[]) => unknown {
  return function logged(this: unknown, ...args: unknown[]) {
    return value.apply(this, args);
  };
}

export function logAccessor<T>(
  value: { get: () => T; set: (v: T) => void },
  _context: ClassAccessorDecoratorContext,
): typeof value {
  return value;
}

@logged
export class LoggedService {
  @logAccessor
  accessor active: boolean = false;

  @logMethod
  process(input: string): string {
    return input.trim();
  }
}
