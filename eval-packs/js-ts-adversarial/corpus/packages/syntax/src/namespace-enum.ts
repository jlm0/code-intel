export enum Severity {
  Info = "info",
  Warning = "warning",
  Error = "error",
}

export const enum FastFlag {
  Off = 0,
  On = 1,
}

export namespace FileStatus {
  export interface Snapshot {
    severity: Severity;
    message: string;
  }

  export function from(severity: Severity, message: string): Snapshot {
    return { severity, message };
  }

  export namespace Filters {
    export function bySeverity(items: Snapshot[], severity: Severity): Snapshot[] {
      return items.filter((item) => item.severity === severity);
    }
  }
}

export function fileStatuses(messages: string[]): FileStatus.Snapshot[] {
  return messages.map((message) => FileStatus.from(Severity.Info, message));
}

export function errorOnly(items: FileStatus.Snapshot[]): FileStatus.Snapshot[] {
  return FileStatus.Filters.bySeverity(items, Severity.Error);
}
