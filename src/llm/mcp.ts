// MCP bridge: exposes a bot's tool set (actions + observe/chat/memory) as an MCP server, so
// agent CLIs (Claude Code, Codex, OpenCode, anything MCP-capable) can drive the bot.
//
//   const bridge = await startMcpHttp(tools, { port: 0 })   // streamable HTTP on 127.0.0.1
//   bridge.url, bridge.token                                 // give these to the client
//
// The HTTP endpoint is stateless (a fresh MCP server per request, no sessions) and only
// listens on loopback. Every request must carry `Authorization: Bearer <token>`, so other
// local users and processes can't drive the bot.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolHost } from './types.ts'

/**
 * Builds an MCP server over a tool host. Uses raw JSON schemas (our action catalog already
 * has them), so the handlers are set on the low-level server.
 */
export function buildMcpServer (host: ToolHost, name = 'minecraft'): McpServer {
  const mcp = new McpServer({ name, version: '0.1.0' }, { capabilities: { tools: {} } })
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: host.list().map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as any }))
  }))
  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const res = await host.call(req.params.name, req.params.arguments ?? {})
    return { content: [{ type: 'text', text: res.text }], isError: !res.ok }
  })
  return mcp
}

export interface McpHttpOptions {
  /** Port on 127.0.0.1. 0 picks a free one. */
  port?: number
  host?: string
  /** Bearer token clients must send. Generated when omitted. */
  token?: string
  /** URL path. Default /mcp. */
  path?: string
  name?: string
}

export interface McpHttpBridge {
  url: string
  token: string
  port: number
  close (): Promise<void>
}

export async function startMcpHttp (tools: ToolHost, opts: McpHttpOptions = {}): Promise<McpHttpBridge> {
  const host = opts.host ?? '127.0.0.1'
  const path = opts.path ?? '/mcp'
  const token = opts.token ?? randomBytes(24).toString('base64url')
  const expected = Buffer.from(`Bearer ${token}`)

  const server = createServer((req, res) => { void handle(req, res) })

  async function handle (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== path) return send(res, 404, 'not found')
    const auth = Buffer.from(String(req.headers.authorization ?? ''))
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return send(res, 401, 'unauthorized')
    if (req.method !== 'POST') return send(res, 405, 'method not allowed (stateless server, POST only)')
    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return send(res, 400, 'bad json')
    }
    const mcp = buildMcpServer(tools, opts.name)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void mcp.close() })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      if (!res.headersSent) send(res, 500, (e as Error).message)
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, () => { server.off('error', reject); resolve() })
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://${host}:${port}${path}`,
    token,
    port,
    close: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
}

function send (res: ServerResponse, status: number, msg: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' }).end(msg)
}

function readBody (req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
