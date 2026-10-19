import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  Message,
  SystemContentBlock,
  ToolConfiguration,
  ConverseCommandOutput,
  ContentBlock,
  ToolUseBlock,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";

// --- Configuration ---

const DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const DEFAULT_MAX_TOKENS = 1024;

export interface BedrockConfig {
  region?: string;
  modelId?: string;
  maxTokens?: number;
}

function getConfig(): Required<BedrockConfig> {
  const region = process.env.AWS_REGION;
  if (!region) throw new Error("AWS_REGION environment variable is not set");

  return {
    region,
    modelId: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

// --- Singleton client ---

let runtimeClient: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!runtimeClient) {
    const config = getConfig();
    runtimeClient = new BedrockRuntimeClient({ region: config.region });
  }
  return runtimeClient;
}

// --- Types ---

export interface ConverseTurn {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ConverseInput {
  system?: string;
  messages: ConverseTurn[];
  tools?: ToolConfiguration;
  maxTokens?: number;
  modelId?: string;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "content_filtered";

export interface ConverseOutput {
  content: ContentBlock[];
  stopReason: StopReason;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

// --- Core converse call ---

export async function converse(input: ConverseInput): Promise<ConverseOutput> {
  const config = getConfig();
  const client = getClient();

  const system: SystemContentBlock[] | undefined = input.system
    ? [{ text: input.system }]
    : undefined;

  const messages: Message[] = input.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const command = new ConverseCommand({
    modelId: input.modelId ?? config.modelId,
    messages,
    system,
    toolConfig: input.tools,
    inferenceConfig: {
      maxTokens: input.maxTokens ?? config.maxTokens,
    },
  });

  const response: ConverseCommandOutput = await client.send(command);

  const outputContent = response.output?.message?.content ?? [];
  const stopReason = (response.stopReason ?? "end_turn") as StopReason;
  const usage = response.usage;

  return {
    content: outputContent,
    stopReason,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    latencyMs: response.metrics?.latencyMs ?? 0,
  };
}

// --- Helpers ---

export function extractToolUses(content: ContentBlock[]): ToolUseBlock[] {
  const results: ToolUseBlock[] = [];
  for (const block of content) {
    if ("toolUse" in block && block.toolUse != null) {
      results.push(block.toolUse);
    }
  }
  return results;
}

export function extractText(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if ("text" in block && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

export function toolResultMessage(
  toolUseId: string,
  result: unknown,
): ConverseTurn {
  return {
    role: "user",
    content: [
      {
        toolResult: {
          toolUseId,
          content: [{ json: result as DocumentType }],
        },
      },
    ],
  };
}

// --- For testing ---

export function resetClient(): void {
  runtimeClient = null;
}
