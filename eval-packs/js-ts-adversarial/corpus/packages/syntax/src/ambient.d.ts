declare module "untyped-helper" {
  export function untypedHelper(input: string): string;
  export const UNTYPED_TOKEN: string;
}

declare global {
  interface Window {
    __advWindowFlag?: boolean;
  }
}

export {};
