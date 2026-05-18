export interface InlineTypePayload {
  id: string;
  value: number;
}

export function makeInlinePayload(id: string, value: number): InlineTypePayload {
  return { id, value };
}
