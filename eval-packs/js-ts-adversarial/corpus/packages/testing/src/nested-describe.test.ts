import { describe, expect, it } from "vitest";

import { snapshotTarget } from "./snapshot-target";

describe("outer suite", () => {
  describe("inner suite A", () => {
    it("nested A test", () => {
      expect(snapshotTarget(10).value).toBe(10);
    });
  });

  describe("inner suite B", () => {
    describe("deepest", () => {
      it("nested deepest test", () => {
        expect(snapshotTarget(20).label).toBe("value:20");
      });
    });
  });
});
