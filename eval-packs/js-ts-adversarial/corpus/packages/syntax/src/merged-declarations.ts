export interface MergeThing {
  id: string;
}

export namespace MergeThing {
  export type Key = keyof MergeThing;

  export function keyOf(input: MergeThing): Key {
    return input.id === "" ? "label" : "id";
  }
}

export interface MergeThing {
  label?: string;
}

export function useMerged(input: MergeThing): MergeThing.Key {
  return MergeThing.keyOf(input);
}
