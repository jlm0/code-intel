import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { McpEvalCase, McpEvalStep, McpStepExpectation } from "./eval-pack.js";
import type { McpEvalCaseResult, McpEvalStepResult } from "./results.js";

export interface RunMcpEvalCaseInput {
  indexPath: string;
  workspacePath: string;
  embeddingProvider?: string;
  embeddingModel?: string;
}

interface ToolPayload {
  tool?: string;
  guidance?: {
    nextTools?: string[];
  };
  result?: unknown;
}

interface ToolCallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

export async function runMcpEvalCase(
  testCase: McpEvalCase,
  input: RunMcpEvalCaseInput,
): Promise<McpEvalCaseResult> {
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
  const client = new Client({ name: "code-intel-eval", version: "0.1.0" });

  try {
    await client.connect(transport);
    const listedTools = await client.listTools();
    const toolsByName = new Map(listedTools.tools.map((tool) => [tool.name, tool]));
    const missingTools = testCase.requiredTools.filter((tool) => !toolsByName.has(tool));
    const requiredOutputSchemaTools = testCase.requiredTools.length > 0
      ? testCase.requiredTools
      : listedTools.tools.map((tool) => tool.name);
    const missingOutputSchemas = requiredOutputSchemaTools.filter((tool) => !toolsByName.get(tool)?.outputSchema);
    const context: Record<string, unknown> = { steps: {} };
    const stepResults: McpEvalStepResult[] = [];

    for (const step of testCase.steps) {
      const stepResult = await runStep({
        client,
        step,
        context,
        hasOutputSchema: Boolean(toolsByName.get(step.tool)?.outputSchema),
      });
      stepResults.push(stepResult);
    }

    const status = missingTools.length === 0 &&
      missingOutputSchemas.length === 0 &&
      stepResults.every((step) => step.status === "pass")
      ? "pass"
      : "fail";
    return {
      id: testCase.id,
      name: testCase.name,
      gate: testCase.gate,
      status,
      latencyMs: Math.round(performance.now() - start),
      requiredTools: testCase.requiredTools,
      steps: stepResults,
      actual: {
        tools: listedTools.tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right)),
        missingTools,
        missingOutputSchemas,
      },
      failureClass: status === "pass" ? undefined : testCase.failureClassHint ?? "mcp",
    };
  } finally {
    await client.close();
  }
}

async function runStep(input: {
  client: Client;
  step: McpEvalStep;
  context: Record<string, unknown>;
  hasOutputSchema: boolean;
}): Promise<McpEvalStepResult> {
  const issues: string[] = [];
  const args = resolveTemplates(input.step.arguments, input.context) as Record<string, unknown>;
  let result: ToolCallResult;
  try {
    result = await input.client.callTool({ name: input.step.tool, arguments: args }) as ToolCallResult;
  } catch (error) {
    return {
      id: input.step.id,
      tool: input.step.tool,
      status: "fail",
      issues: [`tool call threw: ${(error as Error).message}`],
      actual: emptyStepActual(input.hasOutputSchema),
    };
  }

  const textPayload = parseTextPayload(result);
  const structuredPayload = result.structuredContent as ToolPayload | undefined;
  const contentMatchesStructuredContent = Boolean(
    structuredPayload && textPayload && JSON.stringify(structuredPayload) === JSON.stringify(textPayload),
  );

  if (input.step.expect.error) {
    if (!result.isError) {
      issues.push("expected tool error");
    }
    return finishStep(input, result, structuredPayload, contentMatchesStructuredContent, issues);
  }

  if (result.isError) {
    issues.push("tool returned an error");
  }
  if (!structuredPayload) {
    issues.push("missing structuredContent");
  }
  if (!contentMatchesStructuredContent) {
    issues.push("text content does not match structuredContent");
  }
  if (structuredPayload?.tool !== input.step.tool) {
    issues.push(`payload tool mismatch: expected ${input.step.tool}, received ${String(structuredPayload?.tool)}`);
  }
  issues.push(...evaluateExpectation(input.step.expect, structuredPayload, input.context));

  return finishStep(input, result, structuredPayload, contentMatchesStructuredContent, issues);
}

function finishStep(
  input: {
    step: McpEvalStep;
    context: Record<string, unknown>;
    hasOutputSchema: boolean;
  },
  result: ToolCallResult,
  structuredPayload: ToolPayload | undefined,
  contentMatchesStructuredContent: boolean,
  issues: string[],
): McpEvalStepResult {
  if (structuredPayload) {
    const steps = input.context.steps as Record<string, unknown>;
    steps[input.step.id] = structuredPayload;
  }
  const queryResults = queryResultItems(structuredPayload);
  const actual = {
    isError: Boolean(result.isError),
    hasStructuredContent: Boolean(structuredPayload),
    contentMatchesStructuredContent,
    hasOutputSchema: input.hasOutputSchema,
    resultCount: queryResults?.length,
    files: collectFiles(structuredPayload),
    symbols: collectSymbols(structuredPayload),
    ids: collectIds(structuredPayload),
    guidanceNextTools: structuredPayload?.guidance?.nextTools ?? [],
  };
  return {
    id: input.step.id,
    tool: input.step.tool,
    status: issues.length === 0 ? "pass" : "fail",
    issues,
    actual,
  };
}

function evaluateExpectation(
  expectation: McpStepExpectation,
  payload: ToolPayload | undefined,
  context: Record<string, unknown>,
): string[] {
  const issues: string[] = [];
  const files = collectFiles(payload);
  const symbols = collectSymbols(payload);
  const ids = collectIds(payload);
  const queryResults = queryResultItems(payload) ?? [];

  for (const field of expectation.resultFields) {
    if (!hasPath(payload?.result, field)) {
      issues.push(`missing result field ${field}`);
    }
  }
  for (const file of expectation.files.map((value) => String(resolveTemplates(value, context)))) {
    if (!files.includes(file)) {
      issues.push(`missing expected file ${file}`);
    }
  }
  for (const file of expectation.notFiles.map((value) => String(resolveTemplates(value, context)))) {
    if (files.includes(file)) {
      issues.push(`unexpected file ${file}`);
    }
  }
  for (const symbol of expectation.symbols.map((value) => String(resolveTemplates(value, context)))) {
    if (!symbols.includes(symbol)) {
      issues.push(`missing expected symbol ${symbol}`);
    }
  }
  for (const id of expectation.ids.map((value) => String(resolveTemplates(value, context)))) {
    if (!ids.includes(id)) {
      issues.push(`missing expected id ${id}`);
    }
  }
  if (expectation.rankingReasons && !queryResults.some(hasRankingReasons)) {
    issues.push("missing ranking reasons");
  }
  if (expectation.relationshipEvidence && !queryResults.some(hasRelationshipEvidence)) {
    issues.push("missing relationship evidence");
  }
  if (expectation.pathEdges && !queryResults.some(hasPathEdges)) {
    issues.push("missing path edge metadata");
  }
  if (expectation.excerpt && !queryResults.some((item) => typeof item.excerpt === "string" && item.excerpt.length > 0)) {
    issues.push("missing source excerpt");
  }
  if (expectation.allowExcerpts === false && queryResults.some((item) => typeof item.excerpt === "string")) {
    issues.push("unexpected source excerpt");
  }
  if (expectation.maxExcerptBytes) {
    const tooLarge = queryResults
      .map((item) => typeof item.excerpt === "string" ? Buffer.byteLength(item.excerpt, "utf8") : 0)
      .some((size) => size > (expectation.maxExcerptBytes ?? Number.POSITIVE_INFINITY));
    if (tooLarge) {
      issues.push(`source excerpt exceeds ${expectation.maxExcerptBytes} bytes`);
    }
  }
  if (expectation.maxResultCount && queryResults.length > expectation.maxResultCount) {
    issues.push(`result count exceeds ${expectation.maxResultCount}`);
  }
  return issues;
}

function parseTextPayload(result: ToolCallResult): unknown {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function queryResultItems(payload: ToolPayload | undefined): Array<Record<string, unknown>> | undefined {
  const result = payload?.result as { results?: unknown } | undefined;
  return Array.isArray(result?.results)
    ? result.results.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : undefined;
}

function collectFiles(payload: ToolPayload | undefined): string[] {
  const files = new Set<string>();
  for (const item of queryResultItems(payload) ?? []) {
    if (typeof item.file === "string") {
      files.add(item.file);
    }
  }
  const file = (payload?.result as { file?: { relativePath?: unknown } } | undefined)?.file;
  if (typeof file?.relativePath === "string") {
    files.add(file.relativePath);
  }
  const symbols = (payload?.result as { symbols?: unknown } | undefined)?.symbols;
  if (Array.isArray(symbols)) {
    for (const symbol of symbols) {
      if (symbol && typeof symbol === "object" && typeof (symbol as { file?: unknown }).file === "string") {
        files.add((symbol as { file: string }).file);
      }
    }
  }
  return [...files];
}

function collectSymbols(payload: ToolPayload | undefined): string[] {
  const symbols = new Set<string>();
  for (const item of queryResultItems(payload) ?? []) {
    const symbol = item.symbol;
    if (symbol && typeof symbol === "object" && typeof (symbol as { name?: unknown }).name === "string") {
      symbols.add((symbol as { name: string }).name);
    }
  }
  const diagnosticSymbols = (payload?.result as { symbols?: unknown } | undefined)?.symbols;
  if (Array.isArray(diagnosticSymbols)) {
    for (const symbol of diagnosticSymbols) {
      if (symbol && typeof symbol === "object" && typeof (symbol as { name?: unknown }).name === "string") {
        symbols.add((symbol as { name: string }).name);
      }
    }
  }
  return [...symbols];
}

function collectIds(payload: ToolPayload | undefined): string[] {
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

function resolveTemplates(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exactTemplate = value.match(/^\{\{(.+)}}$/);
    if (exactTemplate) {
      return getContextPath(context, exactTemplate[1].trim());
    }
    return value.replaceAll(/\{\{(.+?)}}/g, (_match, path: string) =>
      String(getContextPath(context, path.trim())),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, context));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, resolveTemplates(nestedValue, context)]),
    );
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

function emptyStepActual(hasOutputSchema: boolean): McpEvalStepResult["actual"] {
  return {
    isError: true,
    hasStructuredContent: false,
    contentMatchesStructuredContent: false,
    hasOutputSchema,
    files: [],
    symbols: [],
    ids: [],
    guidanceNextTools: [],
  };
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
