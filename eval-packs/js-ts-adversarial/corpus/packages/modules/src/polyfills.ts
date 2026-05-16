declare global {
  // eslint-disable-next-line no-var
  var __advPolyfillInstalled: boolean | undefined;
}

if (typeof globalThis.__advPolyfillInstalled === "undefined") {
  globalThis.__advPolyfillInstalled = true;
}

export {};
