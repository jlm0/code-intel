import { multiHopFinal } from "@adv/modules/multi-hop";

export function consumeMultiHop(value: string): string {
  return multiHopFinal(value);
}
