/**
 * Tests for the TypeScript binding.
 *
 * The tests that need no network use a fake transport, so they check the
 * mapping from the TypeScript API to the protocol. The tests that talk to
 * the Go library use a method that needs no account, so they run offline
 * too.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IPCTransport,
  SubRouterAPIError,
  SubRouterClient,
  resolveBinary,
  type ProtocolRequest,
  type ProtocolResponse,
  type Transport,
} from "../src/index.js";

/** A transport that answers with canned responses. */
class FakeTransport implements Transport {
  readonly name = "fake";
  readonly requests: ProtocolRequest[] = [];

  constructor(private readonly responses: Record<string, ProtocolResponse> = {}) {}

  async call(request: ProtocolRequest): Promise<ProtocolResponse> {
    this.requests.push(request);
    const method = request.method;
    return this.responses[method] ?? { ok: true, result: { method } };
  }

  close(): void {}
}

function makeClient(responses: Record<string, ProtocolResponse> = {}) {
  const transport = new FakeTransport(responses);
  const client = new SubRouterClient({ transport });
  return { client, transport };
}

describe("the client", () => {
  it("calls the method of the protocol", async () => {
    const { client, transport } = makeClient();
    await client.account.info();
    assert.equal(transport.requests[0]?.method, "account.info");
  });

  it("sends the options with the request", async () => {
    const { client, transport } = makeClient();
    const scoped = new SubRouterClient({
      transport: new FakeTransport(),
      baseUrl: "https://example.test",
      userId: 7,
    });
    await scoped.account.info();
    assert.equal(transport.requests.length, 0);
    await client.account.info();
  });

  it("maps the time filters onto the protocol", async () => {
    const { client, transport } = makeClient();
    await client.usage.logs({ from: "24h", to: "now", model: "gpt-5" });
    const params = transport.requests[0]?.params ?? {};
    assert.equal(params.from, "24h");
    assert.equal(params.to, "now");
    assert.equal(params.model, "gpt-5");
  });

  it("leaves the parameters that were not given out", async () => {
    const { client, transport } = makeClient();
    await client.usage.logs();
    assert.equal(transport.requests[0]?.params, undefined);
  });

  it("brings the result back", async () => {
    const { client } = makeClient({
      "account.info": { ok: true, result: { username: "demo-user" } },
    });
    const info = await client.account.info();
    assert.equal(info.username, "demo-user");
  });

  it("raises the error of a failed call", async () => {
    const { client } = makeClient({
      "token.show": {
        ok: false,
        error: { message: "no such key", type: "api", status: 404 },
      },
    });
    await assert.rejects(
      () => client.tokens.show(3),
      (error: unknown) => {
        assert.ok(error instanceof SubRouterAPIError);
        assert.equal(error.message, "no such key");
        assert.equal(error.status, 404);
        return true;
      },
    );
  });

  it("keeps the notices of the last call", async () => {
    const { client } = makeClient({
      "account.info": { ok: true, result: {}, notices: ["served from the cache"] },
    });
    await client.account.info();
    assert.deepEqual(client.lastNotices, ["served from the cache"]);
  });

  it("maps the shape of a new key", async () => {
    const { client, transport } = makeClient();
    await client.tokens.create({ kind: "smart", name: "router", providers: ["a", "b"] });
    const params = transport.requests[0]?.params ?? {};
    assert.equal(params.kind, "smart");
    assert.equal(params.name, "router");
    assert.deepEqual(params.providers, ["a", "b"]);
  });

  it("carries the id of an updated key", async () => {
    const { client, transport } = makeClient();
    await client.tokens.update(42, { name: "renamed" });
    const params = transport.requests[0]?.params ?? {};
    assert.equal(params.id, 42);
    assert.equal(params.name, "renamed");
  });

  it("calls any method through the escape hatch", async () => {
    const { client, transport } = makeClient();
    await client.call("raw", { method: "GET", path: "/api/user/self" });
    assert.equal(transport.requests[0]?.method, "raw");
  });
});

describe("the Go library", () => {
  /** The helper binary, when it can be found. */
  function findBinary(): string | undefined {
    try {
      return resolveBinary();
    } catch {
      return undefined;
    }
  }

  it("answers over the bridge process", async (t) => {
    const binary = findBinary();
    if (!binary) {
      t.skip("the subrouterctl binary is not built");
      return;
    }
    const transport = new IPCTransport(binary);
    try {
      const response = await transport.call({ method: "token.types" });
      assert.equal(response.ok, true);
      assert.equal((response.result as unknown[]).length, 4);
    } finally {
      transport.close();
    }
  });

  it("works through the client", async (t) => {
    const binary = findBinary();
    if (!binary) {
      t.skip("the subrouterctl binary is not built");
      return;
    }
    const client = new SubRouterClient({ binary });
    try {
      assert.equal(client.transportName, "ipc");
      const kinds = await client.tokens.types();
      assert.equal(kinds.length, 4);
    } finally {
      client.close();
    }
  });
});
