import type { InlineTypePayload } from "./inline-type";
import { Severity } from "./namespace-enum";

export interface EntityBase {
  id: string;
}

export type EntityEnvelope<T extends EntityBase = InlineTypePayload> = {
  entity: T;
  keys: keyof T;
  value: T[keyof T];
};

export type ExtractEntity<T> = T extends EntityEnvelope<infer Entity> ? Entity : never;

export type PayloadEnvelope = EntityEnvelope<InlineTypePayload>;

export type PrecisionMap<T extends EntityBase> = {
  [Key in keyof T as `field_${Extract<Key, string>}`]: T[Key] extends number ? "numeric" : "other";
};

export class TypeStore<T extends EntityBase = InlineTypePayload> {
  private readonly items = new Map<string, T>();

  save(item: T): T {
    this.items.set(item.id, item);
    return item;
  }
}

export const defaultTypeStore = new TypeStore<InlineTypePayload>();

export const errorSeverity = Severity.Error;

export const infoSeverity = Severity.Info;

export type RecursiveEnvelope = {
  next?: RecursiveEnvelope;
  payload: InlineTypePayload;
};

export function summarizeEnvelope(input: PayloadEnvelope): Severity {
  return input.entity.value > 0 ? errorSeverity : infoSeverity;
}
