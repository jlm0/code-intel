import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";

import { schemaVersion, type QueryResult } from "../schema/schemas.js";
import { normalizeRelativePath } from "../core/ids.js";

const defaultGlobs = [
  "!node_modules",
  "!dist",
  "!build",
  "!.next",
  "!coverage",
  "!.git",
];

export interface SearchTextInput {
  pattern: string;
  repoPaths: string[];
  limit: number;
}

export async function searchText(input: SearchTextInput): Promise<QueryResult> {
  const results: QueryResult["results"] = [];
  for (const repoPath of input.repoPaths.map((path) => resolve(path))) {
    const matches = await runRipgrep(input.pattern, repoPath, input.limit - results.length);
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
): Promise<QueryResult["results"]> {
  if (limit <= 0) {
    return [];
  }

  const args = [
    "--json",
    "--hidden",
    ...defaultGlobs.flatMap((glob) => ["--glob", glob]),
    pattern,
    repoPath,
  ];

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        rejectPromise(new Error(stderr || `rg exited with status ${code}`));
        return;
      }
      resolvePromise(parseRipgrepJson(stdout, repoPath, limit));
    });
  });
}

function parseRipgrepJson(stdout: string, repoPath: string, limit: number): QueryResult["results"] {
  const results: QueryResult["results"] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const event = JSON.parse(line) as RipgrepEvent;
    if (event.type !== "match") {
      continue;
    }
    const absolutePath = event.data.path.text;
    const relativePath = normalizeRelativePath(relative(repoPath, absolutePath));
    const lineNumber = event.data.line_number;
    results.push({
      id: `search:${relativePath}#${lineNumber}`,
      kind: "File",
      repo: repoPath.split("/").at(-1) ?? repoPath,
      file: relativePath,
      range: { startLine: lineNumber, endLine: lineNumber },
      matchedSignals: ["exact_text"],
      excerpt: event.data.lines.text.trimEnd(),
      metadata: { absolutePath },
    });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

interface RipgrepEvent {
  type: "begin" | "end" | "match" | "summary";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
  };
}
