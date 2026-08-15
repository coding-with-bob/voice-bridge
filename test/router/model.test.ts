import { describe, expect, test } from "bun:test";
import { extractJson, claudeCliArgs } from "../../src/router/model.ts";

describe("extractJson", () => {
  test("reads a bare object", () => {
    expect(extractJson('{"action":"clarify","question":"which?"}')).toEqual({
      action: "clarify",
      question: "which?",
    });
  });

  test("tolerates surrounding whitespace and newlines", () => {
    expect(extractJson('\n\n  {"action":"clarify"}  \n')).toEqual({ action: "clarify" });
  });

  test("unwraps a fenced block", () => {
    expect(extractJson('```json\n{"action":"clarify"}\n```')).toEqual({ action: "clarify" });
    expect(extractJson('```\n{"action":"clarify"}\n```')).toEqual({ action: "clarify" });
  });

  test("salvages an object framed by prose", () => {
    const text = 'Sure! Here is the decision:\n{"action":"clarify","question":"which?"}\nHope that helps.';
    expect(extractJson(text)).toEqual({ action: "clarify", question: "which?" });
  });

  test("handles braces inside string values", () => {
    const text = '{"action":"new","cwd":"/tmp","request":"print {a: 1} to the log","ack":"ok"}';
    expect(extractJson(text)).toMatchObject({ request: "print {a: 1} to the log" });
  });

  test("handles escaped quotes inside string values", () => {
    const text = '{"action":"clarify","question":"did you mean \\"craft\\"?"}';
    expect(extractJson(text)).toMatchObject({ question: 'did you mean "craft"?' });
  });

  test("handles nested objects", () => {
    expect(extractJson('{"action":"clarify","meta":{"nested":{"deep":1}}}')).toMatchObject({
      meta: { nested: { deep: 1 } },
    });
  });

  test("returns null when there is nothing to salvage", () => {
    expect(extractJson("I could not decide, sorry.")).toBeNull();
    expect(extractJson("")).toBeNull();
    expect(extractJson("{ unterminated")).toBeNull();
    expect(extractJson("[1, 2, 3]")).toBeNull();
    expect(extractJson('"just a string"')).toBeNull();
  });
});

describe("claudeCliArgs", () => {
  test("isolates the call from the owner's settings, memory and tools", () => {
    const args = claudeCliArgs("claude-opus-5", "system text");
    expect(args).toContain("--setting-sources");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--allowed-tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  });

  test("passes the model and the system prompt through", () => {
    const args = claudeCliArgs("some-model", "system text");
    expect(args[args.indexOf("--model") + 1]).toBe("some-model");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("system text");
    expect(args).toContain("-p");
  });
});
