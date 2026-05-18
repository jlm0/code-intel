import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { CliMcpEvalCase, CliMcpEvalStep, McpStepExpectation } from "./eval-pack.js";
import type { CliMcpEvalCaseResult, CliMcpEvalStepResult } from "./results.js";

const execFileAsync = promisify(execFile);

export interface RunCliMcpEvalCaseInput {
  indexPath: string;
  workspacePath: string;
  embeddingProvider?: string;
  embeddingModel?: string;
}

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload?: unknown;
}

interface ToolPayload {
  tool?: string;
  result?: unknown;
}

interface ToolCallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

export async function runCliMcpEvalCase(
  testCase: CliMcpEvalCase,
  input: RunCliMcpEvalCaseInput,
): Promise<CliMcpEvalCaseResult> {
  const start = performance.now();
  const cliPath = await resolveCliPath();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cliPath,
      "mcp",
      "--workspace",
      input.workspacePath,
      "--index-path",
      input.indexPath,
      ...(input.embeddingProvider ? ["--embedding-provider", input.embeddingProvider] : []),
      ...(input.embeddingModel ? ["--embedding-model", input.embeddingModel] : []),
    ],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "code-intel-cli-mcp-eval", version: "0.1.0" });

  try {
    await client.connect(transport);
    const context: Record<string, unknown> = { steps: {} };
    const stepResults: CliMcpEvalStepResult[] = [];

    for (const step of testCase.steps) {
      stepResults.push(await runStep({
        cliPath,
        client,
        input,
        step,
        context,
      }));
    }

    const status = stepResults.every((step) => step.status === "pass") ? "pass" : "fail";
    return {
      id: testCase.id,
      name: testCase.name,
      gate: testCase.gate,
      status,
      latencyMs: Math.round(performance.now() - start),
      steps: stepResults,
      actual: {
        stepCount: stepResults.length,
        failedSteps: stepResults.filter((step) => step.status === "fail").map((step) => step.id),
      },
      failureClass: status === "pass" ? undefined : testCase.failureClassHint ?? "cli-mcp-parity",
    };
  } finally {
    await client.close();
  }
}

async function runStep(input: {
  cliPath: string;
  client: Client;
  input: RunCliMcpEvalCaseInput;
  step: CliMcpEvalStep;
  context: Record<string, unknown>;
}): Promise<CliMcpEvalStepResult> {
  const issues: string[] = [];
  const cliArgs = resolveTemplates(input.step.cliArgs, input.context).map(String);
  const mcpArguments = resolveTemplates(input.step.mcpArguments, input.context) as Record<string, unknown>;
  const cli = await runCli({
    cliPath: input.cliPath,
    args: cliArgs,
    input: input.input,
  });
  const mcp = await callMcpTool(input.client, input.step.mcpTool, mcpArguments);
  const mcpTextPayload = parseTextPayload(mcp.result);
  const mcpStructuredPayload = mcp.result.structuredContent as ToolPayload | undefined;
  const contentMatchesStructuredContent = Boolean(
    mcpStructuredPayload && mcpTextPayload && JSON.stringify(mcpStructuredPayload) === JSON.stringify(mcpTextPayload),
  );

  if (input.step.expect.error) {
    if (cli.exitCode === 0) {
      issues.push("expected CLI error");
    }
    if (!mcp.result.isError && !mcp.threw) {
      issues.push("expected MCP tool error");
    }
    await releaseMcpQueryEngine(input.client);
    return finishStep(input.step, cli, mcp, undefined, false, issues);
  }

  if (cli.exitCode !== 0) {
    issues.push(`CLI exited ${cli.exitCode}: ${cli.stderr.trim()}`);
  }
  if (mcp.threw) {
    issues.push(`MCP tool threw: ${mcp.errorMessage}`);
  }
  if (mcp.result.isError) {
    issues.push("MCP tool returned an error");
  }
  if (!mcpStructuredPayload) {
    issues.push("MCP result missing structuredContent");
  }
  if (!contentMatchesStructuredContent) {
    issues.push("MCP text content does not match structuredContent");
  }
  if (mcpStructuredPayload?.tool !== input.step.mcpTool) {
    issues.push(`MCP payload tool mismatch: expected ${input.step.mcpTool}, received ${String(mcpStructuredPayload?.tool)}`);
  }
  if (cli.payload !== undefined && mcpStructuredPayload?.result !== undefined) {
    const parity = payloadsAreEquivalent(cli.payload, mcpStructuredPayload.result);
    if (!parity) {
      issues.push("CLI JSON result does not match MCP structured result");
    }
  }

  issues.push(...evaluateExpectation("CLI", input.step.expect, cli.payload, input.context));
  issues.push(...evaluateExpectation("MCP", input.step.expect, mcpStructuredPayload?.result, input.context));
  const steps = input.context.steps as Record<string, unknown>;
  steps[input.step.id] = {
    cli: cli.payload,
    mcp: mcpStructuredPayload,
  };
  await releaseMcpQueryEngine(input.client);

  return finishStep(input.step, cli, mcp, mcpStructuredPayload, contentMatchesStructuredContent, issues);
}

async function runCli(input: {
  cliPath: string;
  args: string[];
  input: RunCliMcpEvalCaseInput;
}): Promise<CliRunResult> {
  const args = [
    input.cliPath,
    ...input.args,
    "--workspace",
    input.input.workspacePath,
    "--index-path",
    input.input.indexPath,
    ...(input.input.embeddingProvider ? ["--embedding-provider", input.input.embeddingProvider] : []),
    ...(input.input.embeddingModel ? ["--embedding-model", input.input.embeddingModel] : []),
    "--json",
  ];
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: process.cwd(),
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
      payload: parseJson(String(result.stdout)),
    };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      exitCode: typeof code === "number" ? code : 1,
      stdout: String((error as { stdout?: unknown }).stdout ?? ""),
      stderr: String((error as { stderr?: unknown }).stderr ?? ""),
    };
  }
}

async function callMcpTool(client: Client, name: string, args: Record<string, unknown>): Promise<{
  result: ToolCallResult;
  threw: boolean;
  errorMessage?: string;
}> {
  try {
    return {
      result: await client.callTool({ name, arguments: args }) as ToolCallResult,
      threw: false,
    };
  } catch (error) {
    return {
      result: {},
      threw: true,
      errorMessage: (error as Error).message,
    };
  }
}

async function releaseMcpQueryEngine(client: Client): Promise<void> {
  try {
    await client.callTool({ name: "health", arguments: {} });
  } catch {
    // The parity result is based on the explicit step tool. Release best-effort.
  }
}

function finishStep(
  step: CliMcpEvalStep,
  cli: CliRunResult,
  mcp: { result: ToolCallResult; threw: boolean },
  mcpStructuredPayload: ToolPayload | undefined,
  contentMatchesStructuredContent: boolean,
  issues: string[],
): CliMcpEvalStepResult {
  const cliPayload = cli.payload;
  const mcpResult = mcpStructuredPayload?.result;
  const parity = cliPayload !== undefined && mcpResult !== undefined
    ? payloadsAreEquivalent(cliPayload, mcpResult)
    : step.expect.error && cli.exitCode !== 0 && (mcp.result.isError || mcp.threw);
  return {
    id: step.id,
    cliArgs: step.cliArgs,
    mcpTool: step.mcpTool,
    status: issues.length === 0 ? "pass" : "fail",
    issues,
    actual: {
      cliExitCode: cli.exitCode,
      mcpIsError: Boolean(mcp.result.isError || mcp.threw),
      parity: parity && (step.expect.error || contentMatchesStructuredContent),
      resultCount: queryResultItems(cliPayload)?.length,
      files: collectFiles(cliPayload),
      symbols: collectSymbols(cliPayload),
      ids: collectIds(cliPayload),
    },
  };
}

function evaluateExpectation(
  label: string,
  expectation: McpStepExpectation,
  payload: unknown,
  context: Record<string, unknown>,
): string[] {
  const issues: string[] = [];
  const files = collectFiles(payload);
  const symbols = collectSymbols(payload);
  const ids = collectIds(payload);
  const queryResults = queryResultItems(payload) ?? [];

  for (const field of expectation.resultFields) {
    if (!hasPath(payload, field)) {
      issues.push(`${label} missing result field ${field}`);
    }
  }
  for (const file of expectation.files.map((value) => String(resolveTemplates(value, context)))) {
    if (!files.includes(file)) {
      issues.push(`${label} missing expected file ${file}`);
    }
  }
  for (const file of expectation.notFiles.map((value) => String(resolveTemplates(value, context)))) {
    if (files.includes(file)) {
      issues.push(`${label} returned unexpected file ${file}`);
    }
  }
  for (const symbol of expectation.symbols.map((value) => String(resolveTemplates(value, context)))) {
    if (!symbols.includes(symbol)) {
      issues.push(`${label} missing expected symbol ${symbol}`);
    }
  }
  for (const id of expectation.ids.map((value) => String(resolveTemplates(value, context)))) {
    if (!ids.includes(id)) {
      issues.push(`${label} missing expected id ${id}`);
    }
  }
  if (expectation.rankingReasons && !queryResults.some(hasRankingReasons)) {
    issues.push(`${label} missing ranking reasons`);
  }
  if (expectation.relationshipEvidence && !queryResults.some(hasRelationshipEvidence)) {
    issues.push(`${label} missing relationship evidence`);
  }
  if (expectation.pathEdges && !queryResults.some(hasPathEdges)) {
    issues.push(`${label} missing path edge metadata`);
  }
  if (expectation.excerpt && !queryResults.some((item) => typeof item.excerpt === "string" && item.excerpt.length > 0)) {
    issues.push(`${label} missing source excerpt`);
  }
  if (expectation.allowExcerpts === false && queryResults.some((item) => typeof item.excerpt === "string")) {
    issues.push(`${label} returned unexpected source excerpt`);
  }
  if (expectation.maxExcerptBytes) {
    const tooLarge = queryResults
      .map((item) => typeof item.excerpt === "string" ? Buffer.byteLength(item.excerpt, "utf8") : 0)
      .some((size) => size > (expectation.maxExcerptBytes ?? Number.POSITIVE_INFINITY));
    if (tooLarge) {
      issues.push(`${label} source excerpt exceeds ${expectation.maxExcerptBytes} bytes`);
    }
  }
  if (expectation.maxResultCount && queryResults.length > expectation.maxResultCount) {
    issues.push(`${label} result count exceeds ${expectation.maxResultCount}`);
  }
  return issues;
}

function payloadsAreEquivalent(left: unknown, right: unknown): boolean {
  return stableStringify(normalizePayload(left)) === stableStringify(normalizePayload(right));
}

function normalizePayload(payload: unknown): unknown {
  const queryResults = queryResultItems(payload);
  if (queryResults) {
    return {
      results: queryResults.map((item) => ({
        id: item.id,
        kind: item.kind,
        file: item.file,
        range: item.range,
        symbol: item.symbol,
        matchedSignals: item.matchedSignals ?? [],
        excerpt: item.excerpt,
        rankingReasons: (item.metadata as { ranking?: { reasons?: unknown[] } } | undefined)?.ranking?.reasons ?? [],
        relationship: normalizeRelationship((item.metadata as { relationship?: unknown } | undefined)?.relationship),
        pathEdges: normalizePathEdges((item.metadata as { pathEdges?: unknown } | undefined)?.pathEdges),
      })),
    };
  }
  const diagnostic = payload as {
    matched?: unknown;
    file?: { relativePath?: unknown; status?: unknown; queryability?: unknown };
    symbols?: unknown;
  } | undefined;
  if (diagnostic && typeof diagnostic === "object" && ("matched" in diagnostic || "file" in diagnostic || "symbols" in diagnostic)) {
    return {
      matched: diagnostic.matched,
      file: diagnostic.file
        ? {
            relativePath: diagnostic.file.relativePath,
            status: diagnostic.file.status,
            queryability: diagnostic.file.queryability,
          }
        : undefined,
      symbols: Array.isArray(diagnostic.symbols)
        ? diagnostic.symbols.map((symbol) => {
            const item = symbol as { name?: unknown; file?: unknown; kind?: unknown; queryability?: unknown };
            return {
              name: item.name,
              file: item.file,
              kind: item.kind,
              queryability: item.queryability,
            };
          })
        : undefined,
    };
  }
  return payload;
}

function normalizeRelationship(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const relationship = value as {
    kind?: unknown;
    traversalDirection?: unknown;
    seedId?: unknown;
    evidenceSources?: unknown;
    confidence?: unknown;
    fallbackReason?: unknown;
  };
  return {
    kind: relationship.kind,
    traversalDirection: relationship.traversalDirection,
    seedId: relationship.seedId,
    evidenceSources: Array.isArray(relationship.evidenceSources) ? relationship.evidenceSources : [],
    confidence: relationship.confidence,
    fallbackReason: relationship.fallbackReason,
  };
}

function normalizePathEdges(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((edge) => normalizeRelationship(edge))
    : undefined;
}

function parseTextPayload(result: ToolCallResult): unknown {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    return undefined;
  }
  return parseJson(text);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function queryResultItems(payload: unknown): Array<Record<string, unknown>> | undefined {
  const result = payload as { results?: unknown } | undefined;
  return Array.isArray(result?.results)
    ? result.results.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : undefined;
}

function collectFiles(payload: unknown): string[] {
  const files = new Set<string>();
  for (const item of queryResultItems(payload) ?? []) {
    if (typeof item.file === "string") {
      files.add(item.file);
    }
  }
  const file = (payload as { file?: { relativePath?: unknown } } | undefined)?.file;
  if (typeof file?.relativePath === "string") {
    files.add(file.relativePath);
  }
  const symbols = (payload as { symbols?: unknown } | undefined)?.symbols;
  if (Array.isArray(symbols)) {
    for (const symbol of symbols) {
      if (symbol && typeof symbol === "object" && typeof (symbol as { file?: unknown }).file === "string") {
        files.add((symbol as { file: string }).file);
      }
    }
  }
  return [...files];
}

function collectSymbols(payload: unknown): string[] {
  const symbols = new Set<string>();
  for (const item of queryResultItems(payload) ?? []) {
    const symbol = item.symbol;
    if (symbol && typeof symbol === "object" && typeof (symbol as { name?: unknown }).name === "string") {
      symbols.add((symbol as { name: string }).name);
    }
  }
  const diagnosticSymbols = (payload as { symbols?: unknown } | undefined)?.symbols;
  if (Array.isArray(diagnosticSymbols)) {
    for (const symbol of diagnosticSymbols) {
      if (symbol && typeof symbol === "object" && typeof (symbol as { name?: unknown }).name === "string") {
        symbols.add((symbol as { name: string }).name);
      }
    }
  }
  return [...symbols];
}

function collectIds(payload: unknown): string[] {
  return (queryResultItems(payload) ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string");
}

function hasRankingReasons(item: Record<string, unknown>): boolean {
  const ranking = (item.metadata as { ranking?: { reasons?: unknown } } | undefined)?.ranking;
  return Array.isArray(ranking?.reasons) && ranking.reasons.length > 0;
}

function hasRelationshipEvidence(item: Record<string, unknown>): boolean {
  const relationship = (item.metadata as { relationship?: { evidenceSources?: unknown } } | undefined)?.relationship;
  return Array.isArray(relationship?.evidenceSources) && relationship.evidenceSources.length > 0;
}

function hasPathEdges(item: Record<string, unknown>): boolean {
  const metadata = item.metadata as { pathEdges?: unknown } | undefined;
  return Array.isArray(metadata?.pathEdges) && metadata.pathEdges.length > 0;
}

function hasPath(value: unknown, path: string): boolean {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

function resolveTemplates<T>(value: T, context: Record<string, unknown>): T {
  if (typeof value === "string") {
    const exactTemplate = value.match(/^\{\{(.+)}}$/);
    if (exactTemplate) {
      return getContextPath(context, exactTemplate[1].trim()) as T;
    }
    return value.replaceAll(/\{\{(.+?)}}/g, (_match, path: string) =>
      String(getContextPath(context, path.trim())),
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, context)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, resolveTemplates(nestedValue, context)]),
    ) as T;
  }
  return value;
}

function getContextPath(context: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      return current[Number(part)];
    }
    if (current && typeof current === "object") {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, context);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortForStableJson(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortForStableJson(item)]),
    );
  }
  return value;
}

async function resolveCliPath(): Promise<string> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../cli/main.js"),
    resolve(process.cwd(), "dist/cli/main.js"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`Unable to find built code-intel CLI at ${candidates.join(" or ")}`);
}
