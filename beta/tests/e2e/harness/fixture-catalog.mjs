import { createHash } from "node:crypto";
import { createServer } from "node:http";

export const TINY_AGENT_SOURCE = `from agents.basic_agent import BasicAgent


class TinyFixtureAgent(BasicAgent):
    def __init__(self):
        self.name = "TinyFixture"
        self.metadata = {
            "name": self.name,
            "description": "Returns a deterministic fixture result.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return "TINY_FIXTURE_OK"
`;

function send(res, status, contentType, body) {
  const bytes = Buffer.from(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": bytes.length,
    "content-type": contentType,
  });
  res.end(bytes);
}

export async function startFixtureCatalog({
  agentSource = TINY_AGENT_SOURCE,
  id = "tiny-fixture",
  name = "Tiny Fixture",
} = {}) {
  const sha256 = createHash("sha256").update(agentSource).digest("hex");
  let catalogUrl = null;
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", catalogUrl || "http://127.0.0.1");
    requests.push(url.pathname);
    if (url.pathname === "/bootstrap.json") {
      send(res, 200, "application/json; charset=utf-8", JSON.stringify({
        generated_at: "2026-01-01T00:00:00.000Z",
        rapplications: [],
        schema: "rapp-store/1.0",
      }));
      return;
    }
    if (url.pathname === "/index.json") {
      send(res, 200, "application/json; charset=utf-8", JSON.stringify({
        generated_at: "2026-01-01T00:00:00.000Z",
        rapplications: [{
          category: "testing",
          id,
          license: "MIT",
          name,
          quality_tier: "test",
          singleton_bytes: Buffer.byteLength(agentSource),
          singleton_filename: "tiny_fixture_agent.py",
          singleton_sha256: sha256,
          singleton_url: new URL("/tiny_fixture_agent.py", catalogUrl).href,
          summary: "A deterministic loopback-only E2E fixture.",
          version: "1.0.0",
        }],
        schema: "rapp-store/1.0",
      }));
      return;
    }
    if (url.pathname === "/tiny_fixture_agent.py") {
      send(res, 200, "text/x-python; charset=utf-8", agentSource);
      return;
    }
    send(res, 404, "text/plain; charset=utf-8", "not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Fixture catalog did not bind a loopback port.");
  }
  catalogUrl = `http://127.0.0.1:${address.port}/index.json`;
  return {
    agentSource,
    bootstrapCatalogUrl: new URL("/bootstrap.json", catalogUrl).href,
    catalogUrl,
    id,
    name,
    requests,
    sha256,
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections?.();
      });
    },
  };
}
