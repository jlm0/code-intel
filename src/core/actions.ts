import type { CliActions } from "../cli/program.js";
import { runHealth } from "./health.js";
import { getStatus } from "./status.js";

const notImplemented = async () => ({
  status: "not_implemented",
});

export function createDefaultActions(): CliActions {
  return {
    index: notImplemented,
    update: notImplemented,
    status: getStatus,
    health: runHealth,
    search: notImplemented,
    semantic: notImplemented,
    findSymbol: notImplemented,
    references: notImplemented,
    callers: notImplemented,
    callees: notImplemented,
    expandContext: notImplemented,
    getContext: notImplemented,
    tracePath: notImplemented,
    eval: notImplemented,
    mcp: notImplemented,
  };
}
