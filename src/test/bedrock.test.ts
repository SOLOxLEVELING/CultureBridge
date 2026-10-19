import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractToolUses,
  extractText,
  toolResultMessage,
} from "../lib/bedrock";
import type { ContentBlock, ToolUseBlock } from "@aws-sdk/client-bedrock-runtime";

// --- extractToolUses ---

describe("extractToolUses", () => {
  it("extracts tool use blocks from mixed content", () => {
    const toolUse: ToolUseBlock = {
      toolUseId: "call-1",
      name: "get_weather",
      input: { city: "Berlin" },
    };
    const content: ContentBlock[] = [
      { text: "Let me check the weather." },
      { toolUse },
    ];
    const uses = extractToolUses(content);
    assert.equal(uses.length, 1);
    assert.equal(uses[0].toolUseId, "call-1");
    assert.equal(uses[0].name, "get_weather");
    assert.deepEqual(uses[0].input, { city: "Berlin" });
  });

  it("returns empty array when no tool uses present", () => {
    const content: ContentBlock[] = [{ text: "Hello world" }];
    const uses = extractToolUses(content);
    assert.equal(uses.length, 0);
  });

  it("extracts multiple tool uses", () => {
    const content: ContentBlock[] = [
      {
        toolUse: {
          toolUseId: "call-1",
          name: "tool_a",
          input: { x: 1 },
        },
      },
      { text: "between calls" },
      {
        toolUse: {
          toolUseId: "call-2",
          name: "tool_b",
          input: { y: 2 },
        },
      },
    ];
    const uses = extractToolUses(content);
    assert.equal(uses.length, 2);
    assert.equal(uses[0].name, "tool_a");
    assert.equal(uses[1].name, "tool_b");
  });

  it("handles empty content array", () => {
    assert.equal(extractToolUses([]).length, 0);
  });
});

// --- extractText ---

describe("extractText", () => {
  it("joins text blocks from mixed content", () => {
    const content: ContentBlock[] = [
      { text: "Hello " },
      {
        toolUse: {
          toolUseId: "call-1",
          name: "test",
          input: {},
        },
      },
      { text: "world" },
    ];
    assert.equal(extractText(content), "Hello world");
  });

  it("returns empty string for no text blocks", () => {
    const content: ContentBlock[] = [
      {
        toolUse: {
          toolUseId: "call-1",
          name: "test",
          input: {},
        },
      },
    ];
    assert.equal(extractText(content), "");
  });

  it("returns empty string for empty content", () => {
    assert.equal(extractText([]), "");
  });
});

// --- toolResultMessage ---

describe("toolResultMessage", () => {
  it("creates a user turn with tool result content", () => {
    const msg = toolResultMessage("call-1", { temperature: 22 });
    assert.equal(msg.role, "user");
    assert.equal(msg.content.length, 1);

    const block = msg.content[0];
    assert.ok("toolResult" in block);
    if ("toolResult" in block) {
      assert.equal(block.toolResult!.toolUseId, "call-1");
      assert.equal(block.toolResult!.content!.length, 1);
      const resultBlock = block.toolResult!.content![0];
      assert.ok("json" in resultBlock);
      if ("json" in resultBlock) {
        assert.deepEqual(resultBlock.json, { temperature: 22 });
      }
    }
  });

  it("wraps null result as json", () => {
    const msg = toolResultMessage("call-2", null);
    assert.equal(msg.role, "user");
    const block = msg.content[0];
    assert.ok("toolResult" in block);
  });
});
