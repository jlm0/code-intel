export type Success<T> = { kind: "success"; data: T };
export type Failure = { kind: "failure"; error: string };
export type Result<T> = Success<T> | Failure;

export function unwrap<T>(result: Result<T>): T {
  if (result.kind === "success") {
    return result.data;
  }
  throw new Error(result.error);
}

export function describe<T>(result: Result<T>): string {
  switch (result.kind) {
    case "success":
      return `ok:${String(result.data)}`;
    case "failure":
      return `err:${result.error}`;
  }
}
