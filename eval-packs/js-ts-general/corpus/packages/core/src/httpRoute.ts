import { createReceiptEnvelope, DefaultReceiptWriter } from "./types";

const app = {
  post(_path: string, handler: () => unknown): unknown {
    return handler();
  },
};

export const receiptRoutes = app.post("/receipts", () =>
  createReceiptEnvelope(new DefaultReceiptWriter()),
);
