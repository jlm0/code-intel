import { FileStatus, Severity, errorOnly, fileStatuses } from "./namespace-enum";

export function highlightErrors(messages: string[]): FileStatus.Snapshot[] {
  const all = fileStatuses(messages);
  const elevated = all.map((entry) =>
    FileStatus.from(Severity.Error, entry.message),
  );
  return errorOnly(elevated);
}
