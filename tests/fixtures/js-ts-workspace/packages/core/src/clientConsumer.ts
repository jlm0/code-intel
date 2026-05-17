import { fixtureClient } from "./client";

export function createReceiptViaClient(total: number): number {
  return fixtureClient.receipt.create(total);
}
