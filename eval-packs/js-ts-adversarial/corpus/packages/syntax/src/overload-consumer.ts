import { runOverload, OverloadHost } from "./overloads";

export function consumeOverloads(): { fromFunc: string; fromMethod: number } {
  const host = new OverloadHost();
  return {
    fromFunc: runOverload("hi"),
    fromMethod: host.handle(7),
  };
}
