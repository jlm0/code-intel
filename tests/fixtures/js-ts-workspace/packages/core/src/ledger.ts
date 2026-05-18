import { calculateGivingTotal, type GivingEntry, type GivingSummary } from "./tithe";

export class GivingLedger {
  summarize(entries: GivingEntry[]): GivingSummary {
    return { total: calculateGivingTotal(entries.map((entry) => entry.amount)) };
  }
}
