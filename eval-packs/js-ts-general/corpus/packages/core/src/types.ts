export interface ReceiptWriter {
  writeReceipt(total: number): string;
}

export class BaseReceiptWriter {
  protected prefix = "receipt";
}

export class DefaultReceiptWriter extends BaseReceiptWriter implements ReceiptWriter {
  writeReceipt(total: number): string {
    return `${this.prefix}:${total}`;
  }
}

export type ReceiptEnvelope<T extends ReceiptWriter> = {
  writer: T;
};

export function createReceiptEnvelope<T extends ReceiptWriter>(writer: T): ReceiptEnvelope<T> {
  return { writer };
}
