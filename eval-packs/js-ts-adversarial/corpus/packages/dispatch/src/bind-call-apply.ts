function multiply(factor: number, value: number): number {
  return factor * value;
}

export const boundInvoker = multiply.bind(null, 3);

export function applyInvoker(value: number): number {
  return multiply.apply(null, [4, value]);
}

export function callInvoker(value: number): number {
  return multiply.call(null, 5, value);
}
