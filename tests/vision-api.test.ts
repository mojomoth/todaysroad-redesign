import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "../app/api/route/segment/route";

test("vision endpoint exposes availability, rejects invalid requests and handles upstream output", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  const request = (body: unknown, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/route/segment", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    delete process.env.OPENAI_API_KEY;
    assert.deepEqual(await GET().json(), { enabled: false });
    assert.equal((await POST(request({}))).status, 503);
    process.env.OPENAI_API_KEY = "test-key-never-sent-to-network";
    assert.equal((await POST(request({}, "http://other.test"))).status, 403);
    assert.equal((await POST(request({ image: "https://example.com", width: 512, height: 512 }))).status, 400);
    assert.equal((await POST(request({ image: "data:image/png;base64,YQ==", width: 512, height: 512 }))).status, 400);
    const header = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(header);
    header.writeUInt32BE(512, 16); header.writeUInt32BE(512, 20);
    const body = { image: `data:image/png;base64,${header.toString("base64")}`, width: 512, height: 512 };
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, "https://api.openai.com/v1/responses");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.store, false);
      assert.equal(payload.text.format.type, "json_schema");
      assert.equal(payload.input[0].content[0].image_url, body.image);
      return Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: '{"elements":[]}' }] }] });
    };
    const result = await POST(request(body));
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { elements: [] });
    assert.equal(calls, 1);
    globalThis.fetch = async () => Response.json({ status: "incomplete", output: [] });
    assert.equal((await POST(request(body))).status, 502);
    globalThis.fetch = async () => { throw new Error("upstream secret must not leak"); };
    const failed = await POST(request(body));
    assert.equal(failed.status, 502);
    assert.equal((await failed.text()).includes("secret"), false);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    globalThis.fetch = originalFetch;
  }
});
