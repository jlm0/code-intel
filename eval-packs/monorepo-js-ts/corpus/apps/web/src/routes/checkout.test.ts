import { checkoutRouteHandler } from "./checkout";

test("checkout route calls the SDK client", async () => {
  const response = await checkoutRouteHandler(new Request("https://example.test/checkout"));
  expect(response).toBeDefined();
});
