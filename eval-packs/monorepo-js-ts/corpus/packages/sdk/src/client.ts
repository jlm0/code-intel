import type { GeneratedCheckoutContract } from "../types/generated/checkout-contract";

export const SDK_FEATURE_FLAGS = {
  checkout: true,
  retries: 2,
};

export function createApiClient(input: { token: string }) {
  return {
    async checkout(label: string): Promise<GeneratedCheckoutContract> {
      return {
        id: input.token || "anonymous",
        label,
        state: "paid",
      };
    },
  };
}
