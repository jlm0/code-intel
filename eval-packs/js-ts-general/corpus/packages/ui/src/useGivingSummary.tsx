import { GivingLedger } from "@fixture/core";

export function useGivingSummary(entries: number[]) {
  const ledger = new GivingLedger();
  return ledger.summarize(entries);
}
