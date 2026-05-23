export enum CheckoutState {
  Pending = "pending",
  Paid = "paid"
}

export interface GeneratedCheckoutContract {
  id: string;
  label: string;
  state: "pending" | "paid";
}

export namespace CheckoutNamespace {
  export interface AuditRecord {
    id: string;
  }
}
