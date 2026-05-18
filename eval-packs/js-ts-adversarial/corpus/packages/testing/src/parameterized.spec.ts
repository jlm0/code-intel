import { describe, expect, it, test } from "vitest";

import { snapshotTarget } from "./snapshot-target";

describe.each([
  { label: "zero", value: 0 },
  { label: "one", value: 1 },
])("snapshotTarget [$label]", ({ value }) => {
  it("returns the labeled value", () => {
    expect(snapshotTarget(value).value).toBe(value);
  });
});

test.each([2, 4, 6])("doubles to even %d", (value) => {
  expect(snapshotTarget(value).value % 2).toBe(0);
});
