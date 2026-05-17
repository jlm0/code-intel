import type { InlineTypePayload } from "./inline-type";

export type PayloadKeys = keyof InlineTypePayload;

export type PayloadFieldType = typeof makeFieldDescriptor;

export type Stringified<T> = T extends string ? T : `${number}`;

export type FieldMap<T> = {
  [K in keyof T]: T[K] extends number ? "numeric" : "other";
};

export const makeFieldDescriptor = (value: InlineTypePayload): FieldMap<InlineTypePayload> => ({
  id: "other" as const,
  value: "numeric" as const,
});

export function describeStringified<T>(value: T): Stringified<T> {
  return value as Stringified<T>;
}
