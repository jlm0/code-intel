export function calculateGivingTotal(amounts: number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0);
}

export function formatGivingReceipt(name: string, total: number): string {
  return `${name}:${calculateGivingTotal([total])}`;
}
