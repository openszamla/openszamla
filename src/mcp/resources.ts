/** MCP resources: setup status, VAT codes, invoices (JSON + PDF) and customers, addressable by URI. */
import { ResourceNotFoundError, ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { isAppError } from '../core/errors.ts';
import { singleLine } from '../core/format.ts';
import { listVatCodes } from '../core/vat.ts';
import type { ToolContext } from './tools.ts';
import { customerView, invoiceDetail } from './views.ts';

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

/** An id that does not exist is the protocol's "resource not found" (-32602 with data.uri), not an internal error. */
async function orNotFound<T>(uri: URL, read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') throw new ResourceNotFoundError(uri.href, e.message);
    throw e;
  }
}

export function registerResources(server: McpServer, ctx: ToolContext): void {
  const { app, resourceBase } = ctx;

  server.registerResource(
    'setup',
    `${resourceBase}setup`,
    { title: 'OpenSzámla beállítások', description: 'Eladó adatai, sorszámtartományok, NAV-állapot (titkok nélkül)', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(app.status()) }] }),
  );

  server.registerResource(
    'vat-codes',
    `${resourceBase}vat-codes`,
    { title: 'ÁFA-kódok', description: 'Az összes ÁFA-kód: kulcs, NAV-megfeleltetés, kötelező szöveges megjelölés', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(listVatCodes()) }] }),
  );

  server.registerResource(
    'invoice',
    new ResourceTemplate(`${resourceBase}invoices/{id}`, {
      list: async () => ({
        resources: app.findInvoices({ status: ['issued', 'cancelled'], limit: 50 }).items.map((inv) => ({
          uri: `${resourceBase}invoices/${inv.id}`,
          name: `${inv.number ?? inv.id} – ${singleLine(inv.customer.name)}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    { title: 'Számla', description: 'Egy számla összes adata JSON-ban', mimeType: 'application/json' },
    async (uri, vars) => {
      const inv = await orNotFound(uri, () => app.getInvoice(one(vars.id)));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(invoiceDetail(inv)) }] };
    },
  );

  server.registerResource(
    'invoice-pdf',
    new ResourceTemplate(`${resourceBase}invoices/{id}/pdf`, { list: undefined }),
    {
      title: 'Számla PDF',
      description: 'A számla PDF-je: kiállított bizonylatnál a kiállításkor megőrzött eredeti, bájtra pontosan (piszkozatnál tervezet)',
      mimeType: 'application/pdf',
    },
    async (uri, vars) => {
      // The kept original's bytes (invoice_pdf gives its kind and sha256).
      const r = await orNotFound(uri, () => app.pdf(one(vars.id), { base64: true }));
      return { contents: [{ uri: uri.href, mimeType: 'application/pdf', blob: r.base64 ?? '' }] };
    },
  );

  server.registerResource(
    'customer',
    new ResourceTemplate(`${resourceBase}customers/{id}`, {
      list: async () => ({
        resources: app.findCustomers({ limit: 100 }).items.map((c) => ({ uri: `${resourceBase}customers/${c.id}`, name: singleLine(c.name), mimeType: 'application/json' })),
      }),
    }),
    { title: 'Vevő', description: 'Vevő (partner) adatai', mimeType: 'application/json' },
    async (uri, vars) => {
      const c = await orNotFound(uri, () => app.getCustomer(one(vars.id)));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(customerView(c)) }] };
    },
  );
}
