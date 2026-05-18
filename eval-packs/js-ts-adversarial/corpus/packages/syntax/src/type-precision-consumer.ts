import type { PayloadEnvelope, PrecisionMap } from "./type-precision";
import {
  defaultTypeStore,
  errorSeverity,
  infoSeverity,
  summarizeEnvelope,
} from "./type-precision";

export function consumeEnvelope(envelope: PayloadEnvelope): PrecisionMap<PayloadEnvelope["entity"]> {
  const saved = defaultTypeStore.save(envelope.entity);
  summarizeEnvelope(envelope);
  if (errorSeverity === infoSeverity) {
    throw new Error("unexpected severity equality");
  }
  return {} as PrecisionMap<typeof saved>;
}

export function onlyInfoSeverity(): boolean {
  return infoSeverity === "info";
}
