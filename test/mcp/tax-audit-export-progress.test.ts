/**
 * EX5: tax_audit_export reports its progress (notifications/progress) when the request carries a progressToken, so a
 * client can keep a long export alive (the TypeScript SDK resets its 60 s request timeout on progress with
 * resetTimeoutOnProgress) – the first step (0), the last (all documents) and at most one a second between. Its
 * description says how large ranges are done: by month, or with `openszamla adohatosagi-export`.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

type Era = 'legacy' | 'modern';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const line = (unitPrice: string): LineInput => ({ description: 'Szerviz', quantity: '1', unit: 'db', unitPrice, vatCode: '27' });

async function connect(era: Era): Promise<{ t: TestApp; client: Client }> {
  const t = makeTestApp({ confirmMode: 'code' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
    t.cleanup();
  });
  t.app.updateSeller(SELLER_INPUT);
  const customerId = t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  for (const price of ['10000', '20000', '30000']) await t.app.issue((await t.app.createDraft({ customerId, lines: [line(price)] })).invoice.id);
  return { t, client };
}

describe('tax_audit_export progress (EX5)', () => {
  for (const era of ['legacy', 'modern'] as const) {
    it(`sends notifications/progress for a request with a progressToken (${era})`, async () => {
      const { client } = await connect(era);
      const progress: Array<{ progress: number; total?: number; message?: string }> = [];
      const r = (await client.callTool(
        { name: 'tax_audit_export', arguments: { from: '2026-10-01', to: '2026-10-31' } },
        { onprogress: (p) => progress.push(p), resetTimeoutOnProgress: true },
      )) as { isError?: boolean; structuredContent?: Record<string, unknown> };
      expect(r.isError ?? false).toBe(false);
      expect(r.structuredContent?.count).toBe(3);
      expect(progress[0]).toEqual({ progress: 0, total: 3, message: 'Adóhatósági export: 0 / 3 bizonylat kész.' });
      expect(progress.at(-1)).toEqual({ progress: 3, total: 3, message: 'Adóhatósági export: 3 / 3 bizonylat kész.' });
      const steps = progress.map((p) => p.progress);
      expect(steps).toEqual([...steps].sort((a, b) => a - b));
    });
  }

  it('says how to export a large range: by month, or on the command line', async () => {
    const { client } = await connect('legacy');
    const tool = (await client.listTools()).tools.find((x) => x.name === 'tax_audit_export');
    expect(tool?.description).toContain('split the range by month');
    expect(tool?.description).toContain('openszamla adohatosagi-export');
    expect(tool?.description).toContain('notifications/progress');
  });
});
