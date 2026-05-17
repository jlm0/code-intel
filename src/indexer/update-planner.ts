import type { FileFingerprint } from "../schema/schemas.js";

export interface IncrementalPlanInput {
  previous: Map<string, FileFingerprint>;
  current: Map<string, FileFingerprint>;
  configChanged: boolean;
}

export interface IncrementalPlan {
  fullRebuild: boolean;
  added: FileFingerprint[];
  changed: FileFingerprint[];
  deleted: FileFingerprint[];
  unchanged: FileFingerprint[];
}

export function planIncrementalUpdate(input: IncrementalPlanInput): IncrementalPlan {
  if (input.configChanged) {
    return {
      fullRebuild: true,
      added: [],
      changed: [...input.current.values()].sort(compareFingerprint),
      deleted: [...input.previous.values()]
        .filter((file) => !input.current.has(fingerprintKey(file)))
        .sort(compareFingerprint),
      unchanged: [],
    };
  }

  const added: FileFingerprint[] = [];
  const changed: FileFingerprint[] = [];
  const deleted: FileFingerprint[] = [];
  const unchanged: FileFingerprint[] = [];

  for (const current of input.current.values()) {
    const previous = input.previous.get(fingerprintKey(current));
    if (!previous) {
      added.push(current);
    } else if (previous.contentHash === current.contentHash) {
      unchanged.push(current);
    } else {
      changed.push(current);
    }
  }

  for (const previous of input.previous.values()) {
    if (!input.current.has(fingerprintKey(previous))) {
      deleted.push(previous);
    }
  }

  return {
    fullRebuild: false,
    added: added.sort(compareFingerprint),
    changed: changed.sort(compareFingerprint),
    deleted: deleted.sort(compareFingerprint),
    unchanged: unchanged.sort(compareFingerprint),
  };
}

export function fingerprintKey(fingerprint: Pick<FileFingerprint, "repo" | "relativePath">): string {
  return `${fingerprint.repo}:${fingerprint.relativePath}`;
}

function compareFingerprint(left: FileFingerprint, right: FileFingerprint): number {
  return fingerprintKey(left).localeCompare(fingerprintKey(right));
}
