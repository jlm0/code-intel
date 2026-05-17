import { type InlineTypePayload, makeInlinePayload } from "./inline-type";

export function consumeInlineTypePayload(id: string, value: number): InlineTypePayload {
  return makeInlinePayload(id, value);
}
