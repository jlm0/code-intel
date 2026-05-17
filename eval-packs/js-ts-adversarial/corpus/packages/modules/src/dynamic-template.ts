export async function loadLocale(lang: string): Promise<unknown> {
  return import(`./locales/${lang}.ts`);
}

export async function loadConditional(useEsm: boolean): Promise<unknown> {
  return useEsm ? import("./esm-entry") : import("./cjs-entry.cjs");
}
