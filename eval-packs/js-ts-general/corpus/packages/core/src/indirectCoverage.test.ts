import { coverageTestHelper } from "./indirectCoverage";

it("covers implementation through helper", () => {
  expect(coverageTestHelper(1)).toBe(2);
});
