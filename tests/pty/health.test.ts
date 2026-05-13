import { execa } from "execa";
import { spawn } from "node-pty";
import { beforeAll, describe, expect, it } from "vitest";

const cliPath = new URL("../../dist/cli/main.js", import.meta.url).pathname;

describe.skipIf(!canSpawnPty())("TTY CLI behavior", () => {
  beforeAll(async () => {
    await execa("npm", ["run", "build"]);
  });

  it("renders human health output when stdout is a TTY", async () => {
    const output = await runPty(["health"]);

    expect(output).toContain("status:");
    expect(output).toContain("node:");
    expect(output).not.toContain('"schemaVersion"');
  });
});

function runPty(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const terminal = spawn(process.execPath, [cliPath, ...args], {
      cols: 100,
      rows: 30,
      cwd: new URL("../..", import.meta.url).pathname,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    });
    let output = "";
    terminal.onData((chunk) => {
      output += chunk;
    });
    terminal.onExit(({ exitCode }) => {
      if (exitCode === 0) {
        resolve(output);
      } else {
        reject(new Error(`PTY exited with ${exitCode}: ${output}`));
      }
    });
  });
}

function canSpawnPty(): boolean {
  try {
    const terminal = spawn("/bin/echo", ["ok"], {
      cols: 10,
      rows: 5,
      cwd: new URL("../..", import.meta.url).pathname,
      env: { PATH: process.env.PATH ?? "" },
    });
    terminal.kill();
    return true;
  } catch {
    return false;
  }
}
