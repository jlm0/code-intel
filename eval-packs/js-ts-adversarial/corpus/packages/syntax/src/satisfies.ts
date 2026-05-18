import type { InlineTypePayload } from "./inline-type";

export const declaredPayload = {
  id: "static",
  value: 42,
} satisfies InlineTypePayload;

export function asPayload(input: { id: string; value: number }) {
  return input satisfies InlineTypePayload;
}
