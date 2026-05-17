import type { InlineTypePayload } from "@adv/syntax/inline-type";

export class Repository<T extends { id: string }> {
  private readonly items = new Map<string, T>();

  upsert(item: T): T {
    this.items.set(item.id, item);
    return item;
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }
}

export const payloadRepository = new Repository<InlineTypePayload>();

export async function fetchPayload<T extends InlineTypePayload>(id: string): Promise<T> {
  return { id, value: 0 } as T;
}
