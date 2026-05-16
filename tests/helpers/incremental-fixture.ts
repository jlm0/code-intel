import { cp, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

export async function copyFixtureWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "code-intel-fixture-copy-"));
  await cp(fixturePath, workspaceRoot, { recursive: true });
  return workspaceRoot;
}

export async function mutateFixtureWorkspace(workspaceRoot: string): Promise<void> {
  await writeFile(
    join(workspaceRoot, "packages/core/src/blessing.ts"),
    [
      "export function createBlessingNote(name: string): string {",
      "  return `Blessing:${name}`;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, "packages/core/src/ledger.ts"),
    [
      "import { formatGivingReceipt } from \"./tithe\";",
      "",
      "export class GivingLedger {",
      "  summarize(entries: number[]): string {",
      "    return formatGivingReceipt(\"ledger\", entries.length);",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await unlink(join(workspaceRoot, "packages/core/src/duplicateMethods.ts"));
  await unlink(join(workspaceRoot, "packages/core/src/tithe.test.ts"));
}
