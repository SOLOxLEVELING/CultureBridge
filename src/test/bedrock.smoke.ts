import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  converse,
  extractToolUses,
  extractText,
  toolResultMessage,
} from "../lib/bedrock";
import type { ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";

if (!process.env.SMOKE) {
  console.log("Skipping Bedrock smoke tests (set SMOKE=1 to run)");
  process.exit(0);
}

const TOOL_CONFIG: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "get_current_temperature",
        description:
          "Returns the current temperature in Celsius for a given city.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              city: {
                type: "string",
                description: "The city name, e.g. Berlin",
              },
            },
            required: ["city"],
          },
        },
      },
    },
  ],
};

describe("Bedrock Converse — live tool-use round trip", () => {
  it("model invokes the test tool and returns a final response", async () => {
    const turn1 = await converse({
      system: "You are a helpful assistant. Use tools when needed.",
      messages: [
        {
          role: "user",
          content: [{ text: "What is the current temperature in Berlin?" }],
        },
      ],
      tools: TOOL_CONFIG,
    });

    console.log("Turn 1 stop reason:", turn1.stopReason);
    console.log("Turn 1 input tokens:", turn1.inputTokens);
    console.log("Turn 1 output tokens:", turn1.outputTokens);
    console.log("Turn 1 latency:", turn1.latencyMs, "ms");

    assert.equal(turn1.stopReason, "tool_use");

    const toolUses = extractToolUses(turn1.content);
    assert.ok(toolUses.length > 0, "model should invoke at least one tool");

    const call = toolUses[0];
    assert.equal(call.name, "get_current_temperature");
    assert.ok(call.toolUseId, "tool use must have an ID");
    console.log("Tool call:", call.name, JSON.stringify(call.input));

    const resultMsg = toolResultMessage(call.toolUseId!, {
      city: "Berlin",
      temperature_celsius: 18,
      condition: "partly cloudy",
    });

    const turn2 = await converse({
      system: "You are a helpful assistant. Use tools when needed.",
      messages: [
        {
          role: "user",
          content: [{ text: "What is the current temperature in Berlin?" }],
        },
        { role: "assistant", content: turn1.content },
        resultMsg,
      ],
      tools: TOOL_CONFIG,
    });

    console.log("Turn 2 stop reason:", turn2.stopReason);
    console.log("Turn 2 input tokens:", turn2.inputTokens);
    console.log("Turn 2 output tokens:", turn2.outputTokens);
    console.log("Turn 2 latency:", turn2.latencyMs, "ms");

    assert.equal(turn2.stopReason, "end_turn");

    const finalText = extractText(turn2.content);
    assert.ok(finalText.length > 0, "model should produce a text response");
    assert.ok(
      finalText.includes("18") || finalText.toLowerCase().includes("berlin"),
      "response should reference the temperature or city",
    );
    console.log("Final response:", finalText.slice(0, 200));
  });
});
