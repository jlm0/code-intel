import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";

import { truncateUtf8Bytes } from "../core/text.js";
import { schemaVersion, type QueryResult } from "../schema/schemas.js";
import { normalizeRelativePath } from "../core/ids.js";
import { defaultRipgrepIgnoreGlobs } from "../workspace/ignore.js";

const maxRipgrepJsonLineBytes = 1_000_000;
const maxExcerptBytes = 16_000;

export interface SearchTextInput {
  pattern: string;
  repoPaths: string[];
  limit: number;
  includeIgnored?: boolean;
  allowedHiddenDirectories?: string[];
}

export async function searchText(input: SearchTextInput): Promise<QueryResult> {
  const results: QueryResult["results"] = [];
  for (const repoPath of input.repoPaths.map((path) => resolve(path))) {
    const matches = await runRipgrep(input.pattern, repoPath, input.limit - results.length, {
      includeIgnored: input.includeIgnored === true,
      allowedHiddenDirectories: input.allowedHiddenDirectories,
    });
    results.push(...matches);
    if (results.length >= input.limit) {
      break;
    }
  }

  return {
    schemaVersion,
    query: input.pattern,
    results: results.slice(0, input.limit),
  };
}

async function runRipgrep(
  pattern: string,
  repoPath: string,
  limit: number,
  options: { includeIgnored: boolean; allowedHiddenDirectories?: string[] },
): Promise<QueryResult["results"]> {
  if (limit <= 0) {
    return [];
  }

  const args = [
    "--json",
    "--fixed-strings",
    "--max-columns",
    String(maxExcerptBytes),
    "--hidden",
    ...defaultRipgrepIgnoreGlobs(options).flatMap((glob) => ["--glob", glob]),
    "--",
    pattern,
    repoPath,
  ];

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const results: QueryResult["results"] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectOnce(new Error("rg timed out after 10000ms"));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      if (Buffer.byteLength(stdoutBuffer, "utf8") > maxRipgrepJsonLineBytes) {
        child.kill("SIGTERM");
        rejectOnce(new Error("rg JSON line exceeded maximum supported size"));
        return;
      }
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = parseRipgrepJsonLine(line, repoPath);
        if (match) {
          results.push(match);
        }
        if (results.length >= limit) {
          child.kill("SIGTERM");
          break;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectOnce);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      const finalMatch = parseRipgrepJsonLine(stdoutBuffer, repoPath);
      if (finalMatch && results.length < limit) {
        results.push(finalMatch);
      }
      if (code !== 0 && code !== 1) {
        if (results.length > 0) {
          resolveOnce(results.slice(0, limit));
          return;
        }
        rejectOnce(new Error(stderr || `rg exited with status ${code}`));
        return;
      }
      resolveOnce(results.slice(0, limit));
    });

    function resolveOnce(value: QueryResult["results"]): void {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    }

    function rejectOnce(error: Error): void {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rejectPromise(error);
      }
    }
  });
}

function parseRipgrepJsonLine(line: string, repoPath: string): QueryResult["results"][number] | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const event = JSON.parse(line) as RipgrepEvent;
    if (event.type !== "match") {
      return undefined;
    }
    const absolutePath = event.data.path.text;
    const relativePath = normalizeRelativePath(relative(repoPath, absolutePath));
    const lineNumber = event.data.line_number;
    return {
      id: `search:${relativePath}#${lineNumber}`,
      kind: "File",
      repo: repoPath.split("/").at(-1) ?? repoPath,
      file: relativePath,
      range: { startLine: lineNumber, endLine: lineNumber },
      matchedSignals: ["exact_text"],
      excerpt: truncateUtf8Bytes(event.data.lines.text.trimEnd(), maxExcerptBytes),
      metadata: { absolutePath },
    };
  } catch {
    return undefined;
  }
}

interface RipgrepEvent {
  type: "begin" | "end" | "match" | "summary";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
  };
}
