/**
 * Tests for the AI merge endpoint resolver.
 */
import { describe, it, expect } from "vitest";
import {
  buildOllamaBody,
  buildOpenAiChatBody,
  resolveAiMergeEndpoint,
} from "../../src/core/aiMergeEndpoint.js";

describe("resolveAiMergeEndpoint", () => {
  it("defaults to vscode-lm", () => {
    expect(resolveAiMergeEndpoint(undefined).kind).toBe("vscode-lm");
    expect(resolveAiMergeEndpoint("").kind).toBe("vscode-lm");
    expect(resolveAiMergeEndpoint("vscode-lm").kind).toBe("vscode-lm");
  });

  it("recognises ollama and lm-studio sentinels", () => {
    const o = resolveAiMergeEndpoint("ollama");
    expect(o.kind).toBe("ollama");
    expect(o.url).toContain("11434");
    expect(o.bodyShape).toBe("ollama");
    expect(o.warnsExternalNetwork).toBe(false);
    const l = resolveAiMergeEndpoint("lm-studio");
    expect(l.kind).toBe("lm-studio");
    expect(l.url).toContain("1234");
    expect(l.bodyShape).toBe("openai-chat");
  });

  it("treats arbitrary http(s) URL as custom", () => {
    const r = resolveAiMergeEndpoint("http://localhost:5000/v1/chat/completions");
    expect(r.kind).toBe("custom");
    expect(r.url).toBe("http://localhost:5000/v1/chat/completions");
    expect(r.warnsExternalNetwork).toBe(false);
  });

  it("flags external-network URL", () => {
    const r = resolveAiMergeEndpoint("https://api.example.com/v1/chat");
    expect(r.kind).toBe("custom");
    expect(r.warnsExternalNetwork).toBe(true);
  });

  it("falls back to vscode-lm on garbage value", () => {
    expect(resolveAiMergeEndpoint("ftp://example.com").kind).toBe("vscode-lm");
    expect(resolveAiMergeEndpoint("garbage").kind).toBe("vscode-lm");
  });
});

describe("body builders", () => {
  it("buildOllamaBody shapes the prompt", () => {
    expect(buildOllamaBody("llama3", "merge")).toEqual({
      model: "llama3",
      prompt: "merge",
      stream: false,
    });
  });

  it("buildOpenAiChatBody emits system + user messages", () => {
    const b = buildOpenAiChatBody("gpt-4o-mini", "you are a helper", "merge X with Y");
    expect(b.messages).toHaveLength(2);
    expect(b.messages[0]?.role).toBe("system");
    expect(b.messages[1]?.role).toBe("user");
    expect(b.stream).toBe(false);
  });
});
