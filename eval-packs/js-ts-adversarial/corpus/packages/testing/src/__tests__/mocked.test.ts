import { describe, expect, it, vi } from "vitest";

import { consumeMocked } from "../mocked-target";

vi.mock("../mocked-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mocked-target")>();
  return {
    ...actual,
    mockedTarget: (label: string) => `mock:${label}`,
  };
});

describe("consumeMocked", () => {
  it("uses the mocked target", () => {
    expect(consumeMocked("a")).toBe("MOCK:A");
  });
});
