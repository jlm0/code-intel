import buildDefaultReceipt from "@fixture/core/default-tool";
import { calculateTotalAlias } from "@fixture/core/barrel";
import * as CoreBarrel from "@fixture/core/barrel";

export function useBarrelSummary(amounts: number[]): string {
  const total = calculateTotalAlias(amounts);
  const ledger = new CoreBarrel.GivingLedger();
  ledger.summarize(amounts.map((amount) => ({ amount })));
  return buildDefaultReceipt("fixture", total);
}

