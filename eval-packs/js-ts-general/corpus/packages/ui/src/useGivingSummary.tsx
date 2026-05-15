import { GivingLedger, type GivingEntry, type GivingSummary } from "@fixture/core";

export function useGivingSummary(entries: GivingEntry[]): GivingSummary {
  const ledger = new GivingLedger();
  return ledger.summarize(entries);
}
