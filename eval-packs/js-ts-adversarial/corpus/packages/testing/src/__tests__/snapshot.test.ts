import { describe, expect, it } from "vitest";

import { snapshotTarget } from "../snapshot-target";

describe("snapshotTarget", () => {
  it("matches snapshot for stable input", () => {
    expect(snapshotTarget(7)).toMatchSnapshot();
  });

  it("matches inline snapshot", () => {
    expect(snapshotTarget(1)).toMatchInlineSnapshot();
  });
});
