import { calculateGivingTotal } from "./tithe";

export class GivingLedger {
  summarize(entries: number[]): number {
    return calculateGivingTotal(entries);
  }
}
