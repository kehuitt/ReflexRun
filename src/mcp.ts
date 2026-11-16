import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { registerMemoryTools } from './memory/mcp.js';

export async function serveMcp(config: { memory: string; headed?: boolean; profile?: string }) {
  const server = new McpServer({ name: 'reflexrun', version: '0.3.0' });
  let browser: Browser | undefined, context: BrowserContext | undefined;
  const getContext = async () => {
    if (!context) {
      if (config.profile)
        context = await chromium.launchPersistentContext(config.profile, {
          headless: !config.headed,
        });
      else {
        browser = await chromium.launch({ headless: !config.headed });
        context = await browser.newContext();
      }
    }
    return context;
  };
  const memory = registerMemoryTools(server, {
    memory: config.memory,
    context: getContext,
  });
  const shutdown = async () => {
    await memory.close();
    await context?.close();
    await browser?.close();
    await server.close();
  };
  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
  await server.connect(new StdioServerTransport());
}
