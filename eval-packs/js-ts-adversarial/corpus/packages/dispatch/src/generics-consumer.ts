import { Repository, fetchPayload } from "./generics";
import type { InlineTypePayload } from "@adv/syntax/inline-type";

export const namedRepository = new Repository<InlineTypePayload>();

export async function preload(id: string): Promise<InlineTypePayload> {
  const payload = await fetchPayload<InlineTypePayload>(id);
  namedRepository.upsert(payload);
  return payload;
}
