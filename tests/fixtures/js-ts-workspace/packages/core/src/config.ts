export function readWebhookSecret(): string {
  return process.env.WEBHOOK_SECRET ?? "";
}
