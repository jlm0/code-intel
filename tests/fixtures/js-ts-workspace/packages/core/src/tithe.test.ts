import { calculateGivingTotal } from "./tithe";

it("calculates giving totals", () => {
  expect(calculateGivingTotal([1, 2, 3])).toBe(6);
});
