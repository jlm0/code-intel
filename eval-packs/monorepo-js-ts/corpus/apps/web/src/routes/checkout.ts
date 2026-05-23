import { createApiClient } from "@fixture/sdk";
import { sharedFormat } from "@fixture/shared";

export async function checkoutRouteHandler(request: Request) {
  const client = createApiClient({ token: request.headers.get("authorization") ?? "" });
  const result = await client.checkout(sharedFormat("checkout"));
  return Response.json(result);
}
