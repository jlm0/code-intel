export async function fetchReceipt(id: string): Promise<Response> {
  return fetch(`/api/receipts/${id}`);
}
