import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getStatus } from "../../src/core/status.js";

describe("status", () => {
  it("does not treat an active pointer to a generation without a manifest as indexed", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-status-partial-generation-"));
    try {
      const generationId = "partial-generation";
      await mkdir(join(indexPath, "generations", generationId), { recursive: true });
      await writeFile(
        join(indexPath, "current.json"),
        JSON.stringify({
          generationId,
          databasePath: `generations/${generationId}/code-intel.lbug`,
        }),
      );

      await expect(getStatus({ workspace: indexPath, indexPath })).resolves.toMatchObject({
        indexed: false,
        manifestPath: join(indexPath, "generations", generationId, "manifest.json"),
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });
});
