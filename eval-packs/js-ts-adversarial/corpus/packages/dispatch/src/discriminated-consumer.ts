import { unwrap, describe as describeResult, type Result } from "./discriminated";

export function consumeResult<T>(result: Result<T>): string {
  if (result.kind === "success") {
    return String(unwrap(result));
  }
  return describeResult(result);
}
