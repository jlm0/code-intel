import "./polyfills";

export let sideEffectFlag = false;

export function markSideEffect(): void {
  sideEffectFlag = true;
}
