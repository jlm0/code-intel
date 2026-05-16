import { describe, expect, it, vi } from "vitest";

vi.mock("./nonexistent-target", () => ({
  unreal: () => "unreal",
}));

describe("orphan mock", () => {
  it("does not target a real module", () => {
    expect(true).toBe(true);
  });
});
