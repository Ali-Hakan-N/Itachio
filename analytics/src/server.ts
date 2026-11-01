import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createAnalyticsClient } from './clickhouse.js';
import { createAnalyticsMcpHandler } from './mcp.js';

const port = Number(process.env.MCP_PORT || 8787);
const host = process.env.MCP_HOST || '127.0.0.1';
const local = host === '127.0.0.1' || host === '::1' || host === 'localhost';
const token = process.env.MCP_BEARER_TOKEN || '';
if (!local && token.length < 32) throw new Error('MCP_BEARER_TOKEN (at least 32 characters) is required for non-loopback binds');
const client = createAnalyticsClient();
const handler = createAnalyticsMcpHandler(client);
const nodeHandler = toNodeHandler(handler);
const allowedHostname = process.env.MCP_PUBLIC_HOST || host;
const validateHost = local ? localhostHostValidation() : hostHeaderValidation([allowedHostname]);
const validateOrigin = local ? localhostOriginValidation() : originValidation([allowedHostname]);

const server = createServer((request, response) => {
  if (!validateHost(request, response) || !validateOrigin(request, response)) return;
  if (request.url !== '/mcp') {
    response.writeHead(404).end();
    return;
  }
  if (token) {
    const supplied = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const expected = Buffer.from(token);
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
      return;
    }
  }
  void nodeHandler(
    request as Parameters<typeof nodeHandler>[0],
    response as Parameters<typeof nodeHandler>[1],
  ).catch((error: unknown) => console.error('MCP request failed:', error));
});

server.listen(port, host, () => console.error(`Itachio MCP listening at http://${host}:${port}/mcp`));

async function shutdown() {
  await handler.close();
  await client.close();
  server.close();
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });