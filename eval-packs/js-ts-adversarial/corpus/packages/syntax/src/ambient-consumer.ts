import { untypedHelper, UNTYPED_TOKEN } from "untyped-helper";

export function callUntyped(label: string): string {
  return `${UNTYPED_TOKEN}:${untypedHelper(label)}`;
}
