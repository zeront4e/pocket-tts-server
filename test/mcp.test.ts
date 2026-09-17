/*
Copyright 2026 zeront4e (https://github.com/zeront4e)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Tests for the MCP server endpoint (POST /mcp, GET /mcp/audio/<id>).
// Calls the handlers with synthetic Request objects (no live sidecar needed):
// the generate_speech success path is covered by live verification, here we
// test the JSON-RPC surface, validation, auth, and the audio cache routes.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { buildGenerateSpeechContent, mcpHandler } from "../src/routes/mcp.js";
import { type SynthesizedAudio } from "../src/routes/tts.js";
import { createServer } from "../src/server.js";

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://mcp.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // MCP streamable HTTP clients must accept both content types.
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function rpc(body: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await mcpHandler(mcpRequest(body, headers));
  return { status: res.status, json: await res.json().catch(() => null) };
}

const savedEnv: Record<string, string | undefined> = {};

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  beforeAll(() => {
    for (const [key, value] of Object.entries(vars)) {
      savedEnv[key] = Bun.env[key];
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  });

  return fn();
}

describe("MCP handshake", () => {
  test("initialize returns server info and capabilities (stateless: no session id)", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });

    expect(status).toBe(200);
    expect(json.id).toBe(1);
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.serverInfo.name).toBe("pocket-tts-server");
    expect(json.result.serverInfo.version).toBeTruthy();
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.instructions).toContain("generate_speech");
  });

  test("ping returns an empty result", async () => {
    const { status, json } = await rpc({ jsonrpc: "2.0", id: 2, method: "ping" });

    expect(status).toBe(200);
    expect(json.result).toEqual({});
  });

  test("notifications are accepted with 202 and no body", async () => {
    const res = await mcpHandler(
      mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("batches are answered with a JSON array", async () => {
    const { status, json } = await rpc([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);

    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect(json.map((m: any) => m.id)).toEqual([1, 2]);
    expect(json[1].result.tools).toBeDefined();
  });

  test("invalid JSON body is a parse error (-32700)", async () => {
    const res = await mcpHandler(
      new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: "{not json",
      }),
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe(-32700);
  });

  test("unknown method is -32601", async () => {
    const { status, json } = await rpc({ jsonrpc: "2.0", id: 3, method: "no/such-method" });

    expect(status).toBe(200);
    expect(json.error.code).toBe(-32601);
  });
});

describe("MCP tools", () => {
  test("tools/list exposes generate_speech and list_voices with input schemas", async () => {
    const { status, json } = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" });

    expect(status).toBe(200);
    const tools = json.result.tools;

    expect(tools.map((t: any) => t.name).sort()).toEqual(["generate_speech", "list_voices"]);

    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }

    const generate = tools.find((t: any) => t.name === "generate_speech");

    expect(generate.inputSchema.required).toEqual(["text"]);
    expect(generate.inputSchema.properties.format.enum).toContain("opus");
  });

  test("list_voices returns a text listing", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "list_voices", arguments: { lang: "en" } },
    });

    expect(status).toBe(200);
    expect(json.result.isError).toBeUndefined();
    const text = json.result.content.find((c: any) => c.type === "text").text;

    expect(text).toContain('Voices for "en"');
    expect(text).toContain("alba");
    expect(text).toContain("(default)");
  });

  test("list_voices with an unknown language fails as a tool error", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "list_voices", arguments: { lang: "fr" } },
    });

    // zod rejects it; the SDK reports it as an MCP tool error (isError).
    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("list_voices");
  });

  test("generate_speech without text is a validation error", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "generate_speech", arguments: {} },
    });

    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("text");
  });

  test("generate_speech reports sidecar failures as isError tool results", async () => {
    // No sidecar is running in the test environment: the call must come back
    // as an MCP tool error (isError), not a JSON-RPC error.
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "generate_speech", arguments: { text: "Hallo", lang: "de" } },
    });

    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("not ready");
  });

  test("unknown tool name is a tool error (isError)", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });

    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("nope");
  });
});

describe("generate_speech result content (non-base64 by default)", () => {
  const audio: SynthesizedAudio = {
    buffer: Buffer.from([0x12, 0x34, 0x56]),
    format: "opus",
    contentType: "audio/opus",
    lang: "de",
  };
  const baseUrl = "http://mcp.test";

  test("default (inline=false): resource_link + text, no base64 audio block", () => {
    const content = buildGenerateSpeechContent(audio, baseUrl, "abc-123", "juergen", false);

    expect(content.some((c) => c.type === "audio")).toBe(false);

    const link = content.find((c) => c.type === "resource_link") as any;
    expect(link).toBeDefined();
    expect(link.uri).toBe("http://mcp.test/mcp/audio/abc-123");
    expect(link.mimeType).toBe("audio/opus");
    expect(link.size).toBe(3);

    const textBlock = content.find((c) => c.type === "text") as any;
    expect(textBlock.text).toContain("not inlined");
  });

  test("inline=true: also embeds a base64 audio block matching the buffer", () => {
    const content = buildGenerateSpeechContent(audio, baseUrl, "abc-123", "juergen", true);
    const audioBlock = content.find((c) => c.type === "audio") as any;

    expect(audioBlock).toBeDefined();
    expect(audioBlock.data).toBe(Buffer.from([0x12, 0x34, 0x56]).toString("base64"));
    expect(audioBlock.mimeType).toBe("audio/opus");
  });
});

describe("MCP auth (MCP_API_KEY)", () => {
  withEnv({ MCP_API_KEY: "test-key", MODEL_DIR: undefined, MODEL_DIR_EN: undefined }, async () => {
    test("rejects requests without the bearer key", async () => {
      const res = await mcpHandler(mcpRequest({ jsonrpc: "2.0", id: 1, method: "ping" }));

      expect(res.status).toBe(401);
    });

    test("rejects a wrong key", async () => {
      const res = await mcpHandler(
        mcpRequest({ jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: "Bearer wrong" }),
      );

      expect(res.status).toBe(401);
    });

    test("accepts the right key", async () => {
      const res = await mcpHandler(
        mcpRequest({ jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: "Bearer test-key" }),
      );

      expect(res.status).toBe(200);
    });
  });
});

describe("MCP routes (via the real HTTP server)", () => {
  test("GET /mcp is 405, unknown audio ids are 404, handshake works over HTTP", async () => {
    const savedPort = Bun.env.PORT;
    Bun.env.PORT = "0"; // ephemeral port (3001 may already be in use)
    let server;

    try {
      server = await createServer();
      const base = `http://127.0.0.1:${server.port}`;

      const getMcp = await fetch(`${base}/mcp`);

      expect(getMcp.status).toBe(405);
      expect(getMcp.headers.get("allow")).toBe("POST");

      const unknown = await fetch(`${base}/mcp/audio/00000000-0000-4000-8000-000000000000`);

      expect(unknown.status).toBe(404);

      // Full handshake over the real HTTP stack.
      const init = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }),
      });

      expect(init.status).toBe(200);
      const initJson = await init.json();

      expect(initJson.result.serverInfo.name).toBe("pocket-tts-server");
    } finally {
      server?.stop(true);
      if (savedPort === undefined) delete Bun.env.PORT;
      else Bun.env.PORT = savedPort;
    }
  }, 30_000);
});
