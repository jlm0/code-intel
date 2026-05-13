import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";

const cliPath = new URL("../../dist/cli/main.js", import.meta.url).pathname;

describe("fixture eval", () => {
  beforeAll(async () => {
    await execa("npm", ["run", "build"]);
  });

  it("passes the built-in fixture evaluation suite", async () => {
    const result = await execa("node", [cliPath, "eval", "--json"]);
    const payload = JSON.parse(result.stdout);

    expect(payload.status).toBe("pass");
    expect(payload.cases.map((testCase: { name: string }) => testCase.name)).toEqual(
      expect.arrayContaining([
        "exported function",
        "react hook",
        "caller relationship",
        "semantic concept",
      ]),
    );
  });
});
