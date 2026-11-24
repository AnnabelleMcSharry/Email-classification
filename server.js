import { CosmosClient } from "@azure/cosmos";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from "zod/v4";

const endpoint = process.env.COSMOS_ENDPOINT || "https://cosmos-to-cowork.documents.azure.com:443/";
const key = process.env.COSMOS_KEY;
const databaseId = process.env.COSMOS_DATABASE || "cowork-email-db";
const containerId = process.env.COSMOS_CONTAINER || "events";
const port = Number(process.env.PORT || 3000);

if (!key) throw new Error("Missing COSMOS_KEY environment variable.");

const cosmos = new CosmosClient({ endpoint, key });
const container = cosmos.database(databaseId).container(containerId);

function buildServer() {
  const server = new McpServer(
    { name: "cosmos-writer", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "write_cowork_event",
    {
      description: "Write one cowork event document into Cosmos DB",
      inputSchema: {
        tenantId: z.string().min(1),
        eventType: z.string().min(1),
        payload: z.record(z.any()),
        correlationId: z.string().min(1).optional()
      }
    },
    async ({ tenantId, eventType, payload, correlationId }) => {
      const id = correlationId ?? crypto.randomUUID();

      const doc = {
        id,
        tenantId,
        eventType,
        payload,
        createdAt: new Date().toISOString()
      };

      await container.items.upsert(doc);

      return {
        content: [{ type: "text", text: `Inserted/updated document id=${id}` }]
      };
    }
  );

  return server;
}

const app = createMcpExpressApp();
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  return next();
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null
  });
});

app.listen(port, () => {
  console.log(`MCP HTTP server listening on port ${port}`);
});
