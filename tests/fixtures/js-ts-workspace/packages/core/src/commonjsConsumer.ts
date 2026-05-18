const { createContributionSchedule } = require("@fixture/legacy");

export function scheduleContributions(values: number[]): number[] {
  return createContributionSchedule(values);
}

