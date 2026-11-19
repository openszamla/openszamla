/**
 * MCP tools (TypeScript SDK v2 – serves both the 2025 and the 2026-07-28 protocol era).
 *
 * Each tool is a thin adapter over the OpenSzamla service: validate input (zod), call the service,
 * return a compact JSON result as text AND as structuredContent (Codex shows the model only the
 * latter). Errors are returned as tool results with isError=true and an actionable Hungarian hint.
 *
 * Irreversible operations (invoice_issue, invoice_cancel, nav_send_to_configured_environment) need a server-issued
 * confirmation code that only a preview returns (invoice_draft / invoice_get / invoice_cancel_preview / nav_sync) – see
 * confirm.ts.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  acceptedContent,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { dec } from '../core/decimal.ts';
import { AppError, isAppError } from '../core/errors.ts';
import { formatMoney, singleLine } from '../core/format.ts';
import type { Invoice, ValidationIssue } from '../core/types.ts';
import { COMMON_UNITS } from '../core/units.ts';
import { listVatCodes } from '../core/vat.ts';
import type { CorrectionChainTotals, InvoiceView, NavInvoiceResult, OpenSzamla, StornoPreview } from '../service/app.ts';
import type { ConfirmMode } from '../service/config.ts';
import type { CustomerInput, DraftInput, DraftPatch, LineInput, ProductInput, SellerInput } from '../service/inputs.ts';
import { codeFingerprint, mintConfirmCode, verifyConfirmCode } from './confirm.ts';
import { mcpErrorHint } from './hints.ts';
import { customerInput, customerSaveInput, dateBasis, decimal, isoDate, language, lineInput, pagination, paymentMethod, periodFrom, periodTo, vatCode } from './schemas.ts';
import { customerView, invoiceDetail, invoiceSummary, issuesView, productView, seriesView } from './views.ts';

type Json = Record<string, unknown>;
type Content = CallToolResult['content'];
type ToolResult = CallToolResult | InputRequiredResult;

export interface ToolContext {
  app: OpenSzamla;
  confirmMode: ConfirmMode;
  /** URI scheme prefix for resources, e.g. "openszamla://". */
  resourceBase: string;
  /** Send notifications/resources/list_changed after issuing, cancelling and saving a customer (stdio). */
  resourceListChanged: boolean;
  /** This instance serves one 2025-era request of the stateless HTTP endpoint: no elicitation dialog is possible. */
  statelessLegacyHttp?: boolean;
}

const REQUIRES_USER = { 'anthropic/requiresUserInteraction': true };

/** Drops undefined members so service inputs stay clean. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function ok(data: Json, extra: Content = []): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }, ...extra], structuredContent: data };
}

/**
 * An AppError as a tool result gives it: the service's surface-neutral texts with the MCP advice for its code added
 * to the hint (mcpErrorHint), and the validation issues in its details with theirs (issuesView).
 */
function appErrorJson(e: AppError): Json {
  const json = e.toJSON();
  const issues = e.details?.issues;
  const details = Array.isArray(issues) ? { ...e.details, issues: issuesView(issues as ValidationIssue[]) } : e.details;
  return { ...json, hint: mcpErrorHint(e), details };
}

export function errorResult(e: unknown): CallToolResult {
  const error = isAppError(e)
    ? appErrorJson(e)
    : { code: 'INTERNAL_ERROR', message: e instanceof Error ? e.message : String(e), hint: 'Váratlan hiba – próbáld újra, vagy nézd meg a szerver naplóját (stderr).' };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }], structuredContent: { error } };
}

function run(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  return Promise.resolve()
    .then(fn)
    .catch((e: unknown) => errorResult(e));
}

function pdfLink(ctx: ToolContext, inv: Invoice): Content {
  return [
    {
      type: 'resource_link',
      uri: `${ctx.resourceBase}invoices/${inv.id}/pdf`,
      name: `${inv.number ?? inv.id}.pdf`,
      mimeType: 'application/pdf',
      description: `PDF – ${inv.number ?? 'piszkozat'}`,
    },
  ];
}

/**
 * invoice_get's `pdf`: the resource, the kind and SHA-256 invoice_pdf gives (pdfInfo), and the file it serves when that
 * is there (pdfFile; the regenerated one for a document issued before originals were kept). A PDF that cannot be served
 * (DOCUMENT_MISSING, DOCUMENT_INTEGRITY_FAILED) leaves path, kind and sha256 null and names the problem.
 */
function pdfReference(ctx: ToolContext, app: OpenSzamla, inv: Invoice): Json {
  const uri = `${ctx.resourceBase}invoices/${inv.id}/pdf`;
  try {
    const info = app.pdfInfo(inv.id);
    return { uri, path: app.pdfFile(inv.id), kind: info.kind, sha256: info.sha256 };
  } catch (e) {
    if (!isAppError(e)) throw e;
    return { uri, path: null, kind: null, sha256: null, problem: { code: e.code, message: e.message, hint: e.hint } };
  }
}

function money(inv: Invoice, v: string): string {
  return formatMoney(v, inv.currency, 'hu');
}

/**
 * Every quotation mark („ ” “ ‟ " ‘ ’ ‚ ‛ « » ‹ › and the others of Unicode's Quotation_Mark property), and the common
 * look-alikes of a double quote Unicode does not count among them: ʺ ˝ ˮ ″ ‶ 〃 ״ ❛ ❜ ❝ ❞ 🙶 🙷 🙸 (U+02BA, U+02DD,
 * U+02EE, U+2033, U+2036, U+3003, U+05F4, U+275B–U+275E, U+1F676–U+1F678).
 */
const QUOTATION_MARK = /[\p{Quotation_Mark}\u02BA\u02DD\u02EE\u2033\u2036\u3003\u05F4\u275B-\u275E\u{1F676}-\u{1F678}]/gu;
/** A double quote made of two characters – two (or more) commas for „, apostrophes for " –: one apostrophe. */
const DOUBLED_MARK = /,{2,}|'{2,}/g;

/**
 * Third-party text (a buyer name, a storno reason) in a summary or a confirmation dialog: on one line,
 * between Hungarian quotes, at most `max` characters – so it reads as data and cannot pose as the
 * program's own sentences. A quotation mark inside it (or a look-alike, QUOTATION_MARK) becomes an apostrophe ('),
 * and a run of them – or of commas – one apostrophe, so it cannot close the quotation and go on as the program's
 * text. Summaries and dialogs give it after the program's facts.
 */
function quoted(text: string, max = 100): string {
  const chars = Array.from(singleLine(text).replace(QUOTATION_MARK, "'").replace(DOUBLED_MARK, "'"));
  return `„${chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('')}”`;
}

/** Tells the client that the resource list (issued documents, customers) changed – when it can listen (stdio). */
function resourcesChanged(server: McpServer, ctx: ToolContext): void {
  if (!ctx.resourceListChanged || !server.isConnected()) return;
  server.server.sendResourceListChanged().catch(() => undefined);
}

/** "A(z) 1., 3. tétel egységára bruttó …" – lines whose unit price includes VAT (also when taken from a product). */
function grossBasisNote(inv: Invoice): string {
  const gross = inv.lines.filter((l) => l.priceBasis === 'gross');
  if (!gross.length) return '';
  if (gross.length === inv.lines.length && gross.length > 1) return ' Minden tétel egységára bruttó (az ÁFÁ-t tartalmazza).';
  return ` A(z) ${gross.map((l) => `${l.lineNo}.`).join(', ')} tétel egységára bruttó (az ÁFÁ-t tartalmazza).`;
}

/** Document type with article, accusative, for the confirmation dialogs ("Kiállítod az előlegszámlát?"). */
const DOCUMENT_ACCUSATIVE: Record<Invoice['documentType'], string> = {
  invoice: 'a számlát',
  advance: 'az előlegszámlát',
  final: 'a végszámlát',
  modification: 'a módosító számlát',
  storno: 'a sztornó számlát',
  proforma: 'a díjbekérőt',
};

/** What happens with NAV reporting – a díjbekérő is not reported; without a NAV connection it must be done later. */
function navSentence(app: OpenSzamla, documentType: Invoice['documentType'], submitToNav: boolean | undefined, original?: Invoice | null): string {
  if (documentType === 'proforma') return 'A díjbekérő nem számla, a NAV-nak nem kerül jelentésre.';
  // A storno or modification is reported only after its original: "at once" would be untrue while that one is not accepted.
  if (original && app.config.nav && !app.config.navProblem && !app.navOriginalAccepted(original)) {
    return `A NAV-jelentése az eredeti számla (${original.number}) jelentésére vár: a NAV azt még nem fogadta be (NAV-állapota: ${original.navStatus}), a javító bizonylatot pedig csak utána fogadja el – előbb azt kell rendezni (nav_sync).`;
  }
  if (!app.config.nav) return 'A NAV-kapcsolat nincs beállítva: a számlát utólag haladéktalanul jelenteni kell a NAV-nak (nav_sync).';
  if (app.config.navProblem) return 'A NAV-kapcsolat beállítása hibás: a számlát a beállítás javítása után haladéktalanul jelenteni kell a NAV-nak (nav_sync).';
  const test = app.config.nav.environment === 'test' ? ' A NAV-kapcsolat TESZT környezetre mutat: éles adatszolgáltatás NEM történik.' : '';
  if (!(submitToNav ?? app.config.navAutoSubmit)) return `A NAV-jelentést ezután a nav_sync végzi.${test}`;
  return test ? `A NAV tesztrendszerének kerül jelentésre.${test}` : 'A NAV-nak azonnal jelentésre kerül.';
}

/** The markPaid sentence of the issue dialog, by what markPaid will record (markPaidAmount): a payment, a refund, or nothing. */
function markPaidSentence(amount: string): string {
  const v = dec(amount);
  if (v.gt(0)) return ' A vevő kifizette: a befizetés a kiállítás napjával rögzítésre kerül.';
  if (v.lt(0)) return ' Visszatérítés a vevőnek: a visszafizetés a kiállítás napjával rögzítésre kerül.';
  return '';
}

/** "NAV: <status>" of a result summary with the environment – in the test system nothing is reported for real. */
function navStatusText(app: OpenSzamla, inv: Invoice): string {
  const env = app.config.nav && !app.config.navProblem ? app.config.nav.environment : null;
  if (inv.navStatus === 'not_applicable' || !env) return `NAV: ${inv.navStatus}.`;
  return env === 'test' ? `NAV (TESZT környezet): ${inv.navStatus} – éles adatszolgáltatás NEM történt.` : `NAV (éles környezet): ${inv.navStatus}.`;
}

/**
 * The time limit of one call that contacts NAV (nav_sync, nav_send_to_configured_environment; NavRunOptions.budgetMs):
 * MCP clients give up on a tool call after about 60 s (the TypeScript SDK's default, Codex's tool_timeout_sec), and
 * then the agent cannot learn what was sent.
 */
const NAV_CALL_BUDGET_MS = 45_000;

/** Why a run left invoices as they were (NavInvoiceResult.notProcessed), and what to do – a sentence each. */
const NOT_PROCESSED_TEXT: Record<NonNullable<NavInvoiceResult['notProcessed']>, (n: number) => string> = {
  time: (n) => `${n} számlára ebben a hívásban nem jutott idő (a NAV-ra szánt ${NAV_CALL_BUDGET_MS / 1000} mp letelt): futtasd újra a nav_sync-et, a következő hívás folytatja.`,
  outage: (n) => `${n} számlához a program nem fordult a NAV-hoz, mert a NAV ebben a futásban nem volt elérhető: futtasd később újra a nav_sync-et.`,
  pause: (n) => `${n} számlához a program nem fordult a NAV-hoz, mert a NAV szünetet kért (Retry-After): a megjegyzésben megadott időpont után futtasd újra a nav_sync-et.`,
};

/**
 * The result of a run (nav_sync, nav_send_to_configured_environment): how many were reported HERE – an invoice reported
 * only to the other NAV system does not count –, and the invoices the run did not get to (notProcessed) with what to do.
 */
function navSyncResult(app: OpenSzamla, results: NavInvoiceResult[], extra: Json = {}): CallToolResult {
  const environment = app.config.nav?.environment ?? null;
  const done = results.filter((r) => (r.navStatus === 'done' || r.navStatus === 'done_with_warnings') && r.environment === environment).length;
  const where = environment === 'test' ? ' a NAV TESZT rendszerébe – éles adatszolgáltatás NEM történt' : environment === 'production' ? ' (éles környezet)' : '';
  const left = results.filter((r) => r.notProcessed !== undefined);
  const why = (['time', 'outage', 'pause'] as const)
    .map((k) => [k, left.filter((r) => r.notProcessed === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => ` ${NOT_PROCESSED_TEXT[k](n)}`)
    .join('');
  return ok({
    summary: `${results.length} számla feldolgozva, ebből ${done} sikeresen jelentve${where}.${why}`,
    environment,
    results: results as unknown as Json[],
    ...(left.length ? { notProcessed: left.map((r) => r.number ?? r.invoiceId) } : {}),
    ...extra,
  });
}

/**
 * The storno amount, what it negates – the original alone, or the original with its issued modifications – and
 * its fulfilment date: the invoice's current one, which after a date-correcting modification is not the original's.
 */
function stornoText(original: Invoice, p: StornoPreview): string {
  const gross = `bruttó ${money(p.storno, p.storno.totals.grossAmount)}`;
  const date = p.storno.fulfillmentDate;
  const fulfilment = `teljesítés: ${date}${date === original.fulfillmentDate ? '' : ` (javított; az eredeti számláé: ${original.fulfillmentDate})`}`;
  if (!p.negates.length) return `${gross} – az eredeti számla ellentéte, ${fulfilment}`;
  const mods = p.negates.map((m) => `${m.number}: bruttó ${money(m, m.totals.grossAmount)}`).join(', ');
  return `${gross} – az eredeti számla (bruttó ${money(original, original.totals.grossAmount)}) és ${p.negates.length} módosító számlája (${mods}) együttes ellentéte, ${fulfilment}`;
}

function supportsFormElicitation(server: McpServer, envelope: unknown): boolean {
  const modern = (envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META_KEY] as Record<string, unknown> | undefined;
  const caps = (modern ?? server.server.getClientCapabilities()) as Record<string, unknown> | undefined;
  const e = caps?.elicitation as Record<string, unknown> | undefined;
  return !!e && (Object.keys(e).length === 0 || 'form' in e);
}

const ELICIT_SCHEMA = z.object({ confirm: z.boolean().describe('Igen, jóváhagyom (a művelet nem vonható vissza)') });

/**
 * Optional human dialog (confirmMode "elicit"). Returns null when the operation may proceed,
 * otherwise the result to return (an input request, or a "cancelled" result).
 */
function elicitGate(server: McpServer, ctx: ToolContext, rctx: { mcpReq: { envelope?: unknown; inputResponses?: unknown } }, message: string): ToolResult | null {
  if (ctx.confirmMode !== 'elicit') return null;
  // Without a session the 2025-era HTTP request has no client capabilities and no way back to the client:
  // the dialog cannot be shown – say so precisely instead of blaming the client (and never proceed).
  if (ctx.statelessLegacyHttp === true) {
    return errorResult(new AppError('ELICITATION_UNAVAILABLE_LEGACY_HTTP', 'A 2025-ös protokollú HTTP-kapcsolaton az elicit mód nem érhető el – használd a stdio módot, egy 2026-07-28-as protokollú klienst vagy a code módot.', {
      hint: 'Az openszamla serve a 2025-ös protokollú kéréseket munkamenet nélkül szolgálja ki, így nem nyithat jóváhagyó párbeszédet a kliensben. Stdio: openszamla mcp; code mód: OPENSZAMLA_CONFIRM_MODE=code (a megerősítő kód HTTP-n is működik).',
    }));
  }
  if (!supportsFormElicitation(server, rctx.mcpReq.envelope)) {
    return errorResult(new AppError('ELICITATION_UNSUPPORTED', 'Ez az MCP kliens nem támogatja a felhasználói megerősítő párbeszédet (elicitation).', {
      hint: 'Állítsd az OPENSZAMLA_CONFIRM_MODE változót "code" értékre (megerősítő kódos jóváhagyás).',
    }));
  }
  const responses = rctx.mcpReq.inputResponses as Record<string, unknown> | undefined;
  if (inputResponse(responses, 'confirm').kind === 'missing') {
    return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema: ELICIT_SCHEMA }) } });
  }
  const answer = acceptedContent(responses, 'confirm', ELICIT_SCHEMA);
  if (answer?.confirm === true) return null;
  return ok({ status: 'cancelled_by_user', summary: 'A felhasználó nem hagyta jóvá a műveletet; semmi nem változott.' });
}

/** At most one progress notification per this many ms (besides the first and the last). */
const PROGRESS_INTERVAL_MS = 1000;

/**
 * notifications/progress of a long tool call whose request carries a progressToken – a client can reset its request
 * timeout on each (the TypeScript SDK's resetTimeoutOnProgress): the first and the last step, and at most one per
 * PROGRESS_INTERVAL_MS between them. After each one the event loop gets a turn, so it is written out while the work
 * goes on. A notification that cannot be sent is dropped.
 */
function progressNotifier(rctx: ServerContext, progressToken: string | number, message: (done: number, total: number) => string): (done: number, total: number) => Promise<void> {
  let last = Number.NEGATIVE_INFINITY;
  return async (done, total) => {
    const now = Date.now();
    if (done !== 0 && done !== total && now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    await rctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: done, total, message: message(done, total) } }).catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
}

function issuedWithCode(app: OpenSzamla, invoiceId: string, code: string): boolean {
  const fp = codeFingerprint(code);
  return app.auditLog({ entityId: invoiceId, limit: 100 }).items.some((e) => e.details.confirmFingerprint === fp);
}

/** `view.invoice` is the service's preview of the draft: the dates, seller data and amounts issuing it today gives. */
/** What a modification draft does to its invoice, in one sentence (with a leading space); '' for other drafts. */
function chainSentence(inv: Invoice, chain: CorrectionChainTotals | undefined): string {
  if (!chain) return '';
  return ` A(z) ${chain.originalNumber} számla a módosításaival együtt: eddig bruttó ${money(inv, chain.before.grossAmount)}, ezzel a módosítással bruttó ${money(inv, chain.after.grossAmount)}.`;
}

function draftResult(ctx: ToolContext, view: InvoiceView, verb: string): CallToolResult {
  const { app } = ctx;
  const inv = view.invoice;
  const errors = view.issues.filter((i) => i.severity === 'error').length;
  const code = view.readyToIssue && ctx.confirmMode !== 'none' ? mintConfirmCode(app, 'issue', inv.id, app.issueFingerprint(inv.id)) : null;
  return ok({
    summary: `${verb}: ${inv.id}, bruttó ${money(inv, inv.totals.grossAmount)}.${grossBasisNote(inv)}${chainSentence(inv, view.chain)} Vevő: ${quoted(inv.customer.name)}.`,
    readyToIssue: view.readyToIssue,
    nextStep: view.readyToIssue
      ? view.chain
        ? 'Mutasd meg a felhasználónak ezt az előnézetet (a különbözeti tételeket, az ÁFÁ-t, a dátumokat), és azt is, mennyiről mennyire változik a számla a módosításaival együtt (chain: before → after) – a tételek különbözetek, nem a javított értékek. Csak kifejezett jóváhagyás után hívd: invoice_issue { draftId, confirmationCode }.'
        : 'Mutasd meg a felhasználónak ezt az előnézetet (vevő, tételek, ÁFA, végösszeg, dátumok). Csak kifejezett jóváhagyás után hívd: invoice_issue { draftId, confirmationCode }.'
      : `${errors} hiba javítandó: invoice_draft { draftId, … } – a piszkozat addig nem állítható ki.`,
    ...(code ? { confirmationCode: code, confirmationValidMinutes: 10 } : {}),
    issues: issuesView(view.issues),
    ...(view.chain ? { chain: view.chain } : {}),
    invoice: invoiceDetail(inv),
  });
}

function toLineInputs(lines: Array<z.infer<typeof lineInput>> | undefined): LineInput[] | undefined {
  return lines?.map((l) => clean({ ...l, advanceDeduction: l.advanceDeduction ? clean(l.advanceDeduction) : undefined }) as LineInput);
}

function toCustomerInput(c: z.infer<typeof customerInput> | z.infer<typeof customerSaveInput> | undefined): CustomerInput | undefined {
  if (!c) return undefined;
  return clean({ ...c, address: c.address ? clean(c.address) : undefined }) as CustomerInput;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE_LOCAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/**
 * Every tool registered on `server` from now on rejects unknown arguments. z.object() silently drops
 * keys it does not know, so a misspelt parameter ("dueDays", "start") gave a successful but wrong
 * answer; a strict input object fails with 'Unrecognized key: "dueDays"' and is advertised with
 * additionalProperties: false. Nested objects are strict where they are defined (schemas.ts, below).
 */
function rejectUnknownArguments(server: McpServer): void {
  const register = server.registerTool.bind(server) as (name: string, config: { inputSchema?: unknown }, cb: unknown) => unknown;
  server.registerTool = ((name: string, config: { inputSchema?: unknown }, cb: unknown) =>
    register(name, config.inputSchema instanceof z.ZodObject ? { ...config, inputSchema: config.inputSchema.strict() } : config, cb)) as McpServer['registerTool'];
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { app } = ctx;
  rejectUnknownArguments(server);

  // ------------------------------------------------------------------------------------------
  server.registerTool(
    'setup_status',
    {
      title: 'Beállítások és állapot',
      description:
        'START HERE. Seller profile (eladó), invoice number series, NAV Online Számla connection (never secrets), counts (drafts, unpaid, NAV problems), VAT codes, common units, today\'s date, the next setup steps and notes to keep in mind (e.g. cash accounting).',
      inputSchema: z.object({}),
      annotations: READ,
    },
    () =>
      run(() =>
        ok({
          ...(app.status() as unknown as Json),
          vatCodes: listVatCodes().map((v) => ({ code: v.code, name: v.nameHu })),
          commonUnits: COMMON_UNITS,
          today: app.today(),
          confirmMode: ctx.confirmMode,
        }),
      ),
  );

  server.registerTool(
    'seller_update',
    {
      title: 'Eladó adatai',
      description:
        'Create or update the seller (own company, eladó) printed on every invoice, and the invoice defaults. Only given fields change; null or "" clears an optional field. vatStatus "aam" = alanyi adómentes (every line must use VAT code AAM).',
      inputSchema: z.object({
        name: z.string().optional().describe('Legal name'),
        taxNumber: z.string().optional().describe('Adószám, e.g. 12345676-1-23'),
        groupMemberTaxNumber: z.string().nullable().optional(),
        euVatNumber: z.string().nullable().optional().describe('Közösségi adószám, e.g. HU12345676'),
        address: z
          .object({ countryCode: z.string().length(2).default('HU'), postalCode: z.string(), city: z.string(), addressLine: z.string(), region: z.string().optional() })
          .strict()
          .optional(),
        bankAccount: z.string().nullable().optional().describe('Bankszámlaszám (GIRO 2×8/3×8 digits) or IBAN'),
        bankName: z.string().nullable().optional(),
        swift: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        website: z.string().nullable().optional(),
        registrationNumber: z.string().nullable().optional().describe('Cégjegyzékszám / EV nyilvántartási szám'),
        vatStatus: z.enum(['normal', 'aam']).optional().describe('normal = általános ÁFA-alany; aam = alanyi adómentes'),
        cashAccounting: z.boolean().optional().describe('Pénzforgalmi elszámolás'),
        smallBusiness: z.boolean().optional().describe('KATA kisadózó'),
        invoiceFooter: z.string().nullable().optional().describe('Text printed in the invoice footer'),
        defaults: z
          .object({
            paymentMethod: paymentMethod.optional(),
            paymentDays: z.number().int().min(0).max(365).optional().describe('Default payment term in days'),
            language: language.optional(),
            appearance: z.enum(['ELECTRONIC', 'PAPER']).optional(),
            currency: z.string().length(3).optional(),
            exchangeRateSource: z
              .enum(['MNB', 'manual'])
              .optional()
              .describe('Foreign-currency rate: MNB = automatic official rate (the business must have notified NAV of this choice); manual = give the rate (e.g. own bank selling rate) on each invoice'),
          })
          .strict()
          .optional()
          .describe('Invoice defaults'),
      }),
      annotations: { ...WRITE_LOCAL, idempotentHint: true },
    },
    (args) =>
      run(() => {
        const { defaults, address, ...rest } = args;
        const input = clean({ ...rest, address: address ? clean(address) : undefined }) as SellerInput;
        const hasSeller = Object.keys(input).length > 0;
        const result: Json = {};
        if (hasSeller) {
          const r = app.updateSeller(input);
          result.seller = r.seller;
          result.issues = issuesView(r.issues);
        }
        if (defaults) result.defaults = app.updateDefaults(clean(defaults));
        if (!hasSeller && !defaults) result.seller = app.getSeller();
        result.summary = hasSeller ? 'Eladói adatok mentve.' : defaults ? 'Alapértelmezések mentve.' : 'Nem változott semmi.';
        return ok(result);
      }),
  );

  server.registerTool(
    'series_manage',
    {
      title: 'Sorszámtartományok',
      description:
        'List, create or update invoice number series (sorszámtartomány / számlatömb). Pattern tokens: {YYYY}, {YY}, {SEQ}, {SEQ:n} (zero padded), e.g. "SZ-{YYYY}-{SEQ:5}". kind "proforma" is for díjbekérő. Already issued numbers never change. ' +
        'Numbers are unique across all series: a pattern that could produce a number of another active series is refused. The default series cannot be switched off or archived – make another one the default instead.',
      inputSchema: z.object({
        action: z.enum(['list', 'create', 'update']),
        id: z.string().optional().describe('Series id (update)'),
        kind: z.enum(['invoice', 'proforma']).optional().describe('create: invoice (számla) or proforma (díjbekérő)'),
        name: z.string().optional(),
        pattern: z.string().optional(),
        yearlyReset: z.boolean().optional().describe('Restart numbering every year (the pattern must contain the year)'),
        startSeq: z.number().int().min(1).optional().describe('create: first sequence number (e.g. when migrating from another program)'),
        isDefault: z.boolean().optional(),
        archived: z.boolean().optional(),
      }),
      annotations: WRITE_LOCAL,
    },
    (args) =>
      run(() => {
        if (args.action === 'list') return ok({ series: app.listSeries().map(seriesView) });
        if (args.action === 'create') {
          if (!args.kind || !args.name || !args.pattern) throw new AppError('INVALID_INPUT', 'Létrehozáshoz kind, name és pattern kötelező.');
          const s = app.createSeries(clean({ kind: args.kind, name: args.name, pattern: args.pattern, yearlyReset: args.yearlyReset, startSeq: args.startSeq, isDefault: args.isDefault }));
          return ok({ summary: `Sorszámtartomány létrehozva: ${s.name}`, series: seriesView(s) });
        }
        if (!args.id) throw new AppError('INVALID_INPUT', 'Módosításhoz az id kötelező.', { hint: 'Az azonosítót a series_manage { action: "list" } adja.' });
        const s = app.updateSeries(args.id, clean({ name: args.name, pattern: args.pattern, yearlyReset: args.yearlyReset, isDefault: args.isDefault, archived: args.archived }));
        return ok({ summary: `Sorszámtartomány módosítva: ${s.name}`, series: seriesView(s) });
      }),
  );

  // ------------------------------------------------------------------------------------------
  server.registerTool(
    'taxpayer_lookup',
    {
      title: 'Adószám-lekérdezés (NAV)',
      description:
        'Look up a Hungarian company by tax number (adószám / 8-digit törzsszám) in the NAV database: official name, address, validity. Optionally save it as a DOMESTIC customer. Requires the NAV connection.',
      inputSchema: z.object({
        taxNumber: z.string().describe('8-digit törzsszám or full adószám, e.g. 12345676 or 12345676-2-42'),
        saveAsCustomer: z.boolean().optional().describe('Also create a customer from the result'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(async () => {
        const r = await app.lookupTaxpayer(args.taxNumber, clean({ saveAsCustomer: args.saveAsCustomer }));
        if (!r.taxpayer) return ok({ found: false, summary: 'A NAV nem talált adózót ezzel a törzsszámmal.' });
        if (r.customer) resourcesChanged(server, ctx);
        return ok({
          found: true,
          summary: `${r.taxpayer.formattedTaxNumber}${r.taxpayer.valid ? '' : ' – FIGYELEM: az adószám nem érvényes!'} – név: ${quoted(r.taxpayer.name)}`,
          taxpayer: r.taxpayer as unknown as Json,
          customer: r.customer ? customerView(r.customer) : null,
        });
      }),
  );

  server.registerTool(
    'customer_save',
    {
      title: 'Vevő mentése',
      description:
        'Create a customer (vevő, partner): vatStatus, name and address are required. Hungarian company: vatStatus DOMESTIC + taxNumber (taxpayer_lookup gives exact data). EU company: OTHER + euVatNumber. Private individual: PRIVATE_PERSON (name + address only). Duplicates by tax number are rejected. ' +
        'Update (give id): only the given fields change, null or "" clears an optional field; an address is always given whole. archived: true hides the customer, false restores it.',
      inputSchema: customerSaveInput,
      annotations: WRITE_LOCAL,
    },
    (args) =>
      run(() => {
        const r = app.saveCustomer(toCustomerInput(args) as CustomerInput);
        resourcesChanged(server, ctx);
        return ok({ summary: `Vevő mentve (${r.customer.id}): ${quoted(r.customer.name)}`, customer: customerView(r.customer), issues: issuesView(r.issues) });
      }),
  );

  server.registerTool(
    'customer_find',
    {
      title: 'Vevők keresése',
      description: 'Search customers by name, tax number (also EU VAT number, group member or third-country tax id), e-mail or city (accent-insensitive: "kovacs" finds "Kovács"), or get one by id.',
      inputSchema: z.object({
        id: z.string().optional().describe('Customer id (cus_…)'),
        query: z.string().optional().describe('Free text'),
        taxNumber: z.string().optional().describe('Tax number / törzsszám'),
        includeArchived: z.boolean().optional(),
        ...pagination,
      }),
      annotations: READ,
    },
    (args) =>
      run(() => {
        if (args.id) return ok({ customer: customerView(app.getCustomer(args.id)) });
        const page = app.findCustomers(clean({ text: args.query, taxNumber: args.taxNumber, includeArchived: args.includeArchived, limit: args.limit, offset: args.offset }));
        return ok({ total: page.total, offset: page.offset, customers: page.items.map(customerView) });
      }),
  );

  server.registerTool(
    'product_save',
    {
      title: 'Termék / szolgáltatás mentése',
      description:
        'Create or update (give id) a product or service (termék, szolgáltatás) with unit, unit price (net or gross), currency and VAT code; invoice lines can then reference it by productId. ' +
        'An update gives name, unit, unitPrice and vatCode again; optional fields left out keep their stored value.',
      inputSchema: z.object({
        id: z.string().optional(),
        name: z.string().min(1),
        unit: z.string().describe('db, óra, nap, hó, kg, …'),
        unitPrice: decimal,
        priceBasis: z.enum(['net', 'gross']).optional().describe('Default net'),
        currency: z.string().length(3).optional().describe('Default HUF'),
        vatCode,
        nature: z.enum(['PRODUCT', 'SERVICE', 'OTHER']).optional(),
        sku: z.string().optional().describe('Cikkszám'),
        description: z.string().optional(),
        archived: z.boolean().optional(),
      }),
      annotations: WRITE_LOCAL,
    },
    (args) =>
      run(() => {
        const p = app.saveProduct(clean(args) as ProductInput);
        return ok({ summary: `Termék mentve: ${p.name} (${p.id})`, product: productView(p) });
      }),
  );

  server.registerTool(
    'product_find',
    {
      title: 'Termékek keresése',
      description: 'Search products/services by name, SKU or description (accent-insensitive), or get one by id.',
      inputSchema: z.object({
        id: z.string().optional(),
        query: z.string().optional(),
        includeArchived: z.boolean().optional(),
        ...pagination,
      }),
      annotations: READ,
    },
    (args) =>
      run(() => {
        if (args.id) return ok({ product: productView(app.getProduct(args.id)) });
        const page = app.findProducts(clean({ text: args.query, includeArchived: args.includeArchived, limit: args.limit, offset: args.offset }));
        return ok({ total: page.total, offset: page.offset, products: page.items.map(productView) });
      }),
  );

  // ------------------------------------------------------------------------------------------
  server.registerTool(
    'invoice_draft',
    {
      title: 'Számla piszkozat',
      description:
        'Create a NEW invoice draft, or update an existing draft (give draftId; given fields replace old ones, "lines" replaces all lines). documentType: invoice (számla, default), advance (előlegszámla), final (végszámla), proforma (díjbekérő – not an invoice). ' +
        'Buyer: customerId, or an inline customer (saveCustomer: true also stores it). Defaults: issue date today, fulfillment date = issue date, due date from the payment term; currency, payment method, language and appearance are the seller\'s defaults (setup_status → defaults; the currency is not necessarily HUF) – give currency whenever the prices are in another currency (foreign currency: MNB rate of the fulfillment date unless exchangeRate is given). ' +
        'A buyer from a customer record (customerId, saveCustomer, or the record of a copied invoice) is previewed and issued with the record\'s CURRENT data: a later customer_save reaches the draft and changes the preview and its confirmationCode. An inline customer without saveCustomer is used as given. customerId and customer together are rejected. ' +
        'copyFromId duplicates an earlier invoice or converts a díjbekérő (the copy never inherits the exchange rate: new MNB rate, or give exchangeRate). ' +
        'Returns the full preview exactly as invoice_issue would issue it today (issue date, due date, totals, VAT, mandatory notations, validation issues) and, when it can be issued, the confirmationCode for invoice_issue. Nothing is numbered or reported yet.',
      inputSchema: z.object({
        draftId: z.string().optional().describe('Existing draft id (inv_…) to update'),
        documentType: z.enum(['invoice', 'advance', 'final', 'proforma']).optional(),
        copyFromId: z
          .string()
          .optional()
          .describe('New draft only: copy buyer and lines from this invoice/díjbekérő (id or number). A converted díjbekérő passes its recorded payment to the invoice at issue; its fulfilment date is today unless given – ask for it'),
        seriesId: z.string().optional().describe('Number series (default series if omitted)'),
        customerId: z.string().optional(),
        customer: customerInput.optional().describe('Inline buyer data (instead of customerId)'),
        saveCustomer: z.boolean().optional(),
        issueDate: isoDate.optional().describe('Kelt (becomes the actual issue day when issued)'),
        fulfillmentDate: isoDate.optional().describe('Teljesítés dátuma'),
        dueDate: isoDate.optional().describe('Fizetési határidő (kept as given even if issued on a later day; a due date from paymentDays moves with the issue date)'),
        paymentDays: z.number().int().min(0).max(365).optional().describe('Payment term in days (alternative to dueDate)'),
        paymentMethod: paymentMethod.optional(),
        currency: z.string().length(3).optional().describe("ISO currency of the invoice and of its unit prices. Default: the seller's default currency (setup_status → defaults.currency), not necessarily HUF"),
        exchangeRate: decimal
          .optional()
          .describe(
            'HUF per 1 unit of currency, valid on the fulfillment date. Default (MNB policy): the official MNB rate, looked up again only when fulfillmentDate or currency changes. ' +
              "Manual policy: required, give it again after changing fulfillmentDate or currency. Never on a correction (módosító számla) draft: it always uses the original invoice's rate (another value → CORRECTION_EXCHANGE_RATE_FIXED)",
          ),
        language: language.optional().describe("Invoice language: hu, en or bilingual hu-en. Default: the seller's default (setup_status → defaults.language)"),
        appearance: z.enum(['ELECTRONIC', 'PAPER']).optional().describe("ELECTRONIC = PDF sent electronically, PAPER = printed. Default: the seller's default (setup_status → defaults.appearance)"),
        comment: z.string().nullable().optional().describe('Printed comment (megjegyzés)'),
        internalNote: z.string().nullable().optional().describe('Internal note, never printed'),
        orderNumber: z.string().nullable().optional().describe('Buyer order / PO number'),
        lines: z.array(lineInput).optional().describe('Invoice lines (tételek)'),
      }),
      annotations: WRITE_LOCAL,
    },
    (args) =>
      run(async () => {
        const { draftId, copyFromId, customer, lines, ...rest } = args;
        const base = clean({ ...rest, customer: toCustomerInput(customer), lines: toLineInputs(lines) });
        if (draftId) {
          if (copyFromId) throw new AppError('INVALID_INPUT', 'copyFromId csak új piszkozatnál használható.');
          const updated = await app.updateDraft(draftId, base as DraftPatch);
          if (args.saveCustomer && customer) resourcesChanged(server, ctx);
          return draftResult(ctx, updated, 'Piszkozat módosítva');
        }
        const input = clean({ ...base, copyFromId: copyFromId ? app.getInvoice(copyFromId).id : undefined }) as DraftInput;
        const created = await app.createDraft(input);
        if (args.saveCustomer && customer) resourcesChanged(server, ctx);
        return draftResult(ctx, created, 'Piszkozat létrehozva');
      }),
  );

  server.registerTool(
    'invoice_get',
    {
      title: 'Számla részletei',
      description:
        'Full details of one invoice or draft by id (inv_…) or number (e.g. SZ-2026-00012): buyer, lines, VAT summary, notations, payment and NAV status (with NAV messages), related corrections, and for an issued document pdf { uri (resource), path (the file invoice_pdf serves, null until it is written – invoice_pdf writes it), kind ("original" or, for a document issued before originals were kept, "regenerated"), sha256 (of the original), problem (when the PDF cannot be served) }. For a draft that can be issued it also returns a fresh confirmationCode.',
      inputSchema: z.object({ invoice: z.string().describe('Invoice id or number') }),
      annotations: READ,
    },
    (args) =>
      run(() => {
        const view = app.viewInvoice(args.invoice);
        if (view.invoice.status === 'draft') return draftResult(ctx, view, 'Piszkozat');
        const related = app.findInvoices({ originalInvoiceId: view.invoice.id, limit: 50 }).items.map((i) => invoiceSummary(i, app.navEnvironmentNote(i)));
        // The PDF reference is in structuredContent too (Codex shows the model only that): what invoice_pdf serves – the
        // resource, its kind and fingerprint, the file if it is there with those bytes – or why it cannot be served.
        return ok({ invoice: invoiceDetail(view.invoice, app.navEnvironmentNote(view.invoice)), corrections: related, pdf: pdfReference(ctx, app, view.invoice) }, pdfLink(ctx, view.invoice));
      }),
  );

  server.registerTool(
    'invoice_list',
    {
      title: 'Számlák listája',
      description:
        'List/search invoices, newest first. Filters: status (draft/issued/cancelled), documentType, customerId, free-text query (number, buyer, comment, order number), issue date range, paymentStatus, navStatus, overdue (unpaid after the due date). ' +
        'paymentStatus without status and documentType lists receivables only ("which invoices are unpaid?"): issued invoices with a positive total – no drafts, díjbekérők, stornos, crediting modifications, cancelled invoices or corrections of cancelled ones, as in setup_status counts.unpaid. ' +
        'The payment status of an invoice with issued modifications is settled together with them (see invoice_record_payment): an invoice paid at its corrected total is paid, not overdue. A from later than to is an error. ' +
        'Returns compact rows, the total count and the filters applied.',
      inputSchema: z.object({
        status: z.array(z.enum(['draft', 'issued', 'cancelled'])).optional(),
        documentType: z.array(z.enum(['invoice', 'advance', 'final', 'modification', 'storno', 'proforma'])).optional(),
        customerId: z.string().optional(),
        query: z.string().optional(),
        from: isoDate.optional().describe('Issue date from (inclusive)'),
        to: isoDate.optional().describe('Issue date to (inclusive)'),
        paymentStatus: z.array(z.enum(['unpaid', 'partial', 'paid'])).optional().describe('Payment status; without status and documentType only receivables (see the description)'),
        navStatus: z.array(z.enum(['not_applicable', 'not_configured', 'pending', 'processing', 'done', 'done_with_warnings', 'aborted', 'error'])).optional(),
        overdue: z.boolean().optional().describe('Only receivables (issued invoices with a positive total, no díjbekérő) unpaid after their due date'),
        ...pagination,
      }),
      annotations: READ,
    },
    (args) =>
      run(() => {
        // paymentStatus alone asks about money owed: what setup_status / report_summary count as unpaid.
        const receivablesOnly = !!args.paymentStatus?.length && !args.status?.length && !args.documentType?.length;
        const filters = clean({
          status: args.status, documentType: args.documentType, customerId: args.customerId, query: args.query, from: args.from, to: args.to,
          paymentStatus: args.paymentStatus, receivablesOnly: receivablesOnly || undefined, navStatus: args.navStatus, overdueOn: args.overdue ? app.today() : undefined,
        });
        const page = app.findInvoices(clean({
          status: args.status, documentType: args.documentType, customerId: args.customerId, text: args.query,
          issueDateFrom: args.from, issueDateTo: args.to, paymentStatus: args.paymentStatus, receivable: receivablesOnly || undefined, navStatus: args.navStatus,
          overdueOn: filters.overdueOn, limit: args.limit, offset: args.offset,
        }));
        const shown = page.offset + page.items.length;
        return ok({
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          ...(shown < page.total ? { more: `${page.total - shown} további találat – lapozz offset: ${shown} értékkel, vagy szűkíts.` } : {}),
          filters,
          invoices: page.items.map((i) => invoiceSummary(i, app.navEnvironmentNote(i))),
        });
      }),
  );

  server.registerTool(
    'invoice_issue',
    {
      title: 'Számla kiállítása',
      description:
        'IRREVERSIBLE. Issues a draft: assigns the next sequential number, sets the issue date to today (a due date derived from the payment term moves with it, an explicitly given one stays – the preview already shows these dates), freezes the invoice, renders the PDF and reports it to NAV Online Számla (a díjbekérő is not reported). ' +
        'Requires the confirmationCode returned with the draft preview (invoice_draft / invoice_get) – call only after the user explicitly approved that preview. ' +
        'Payment: for a cash or card sale ask whether the buyer has already paid and pass markPaid: true if so; an invoice converted from a díjbekérő takes over the payment recorded on it (see notes).',
      inputSchema: z.object({
        draftId: z.string().describe('Draft id (inv_…)'),
        confirmationCode: z.string().optional().describe('Code from the approved preview, e.g. ABCD-EFGH-JKMN-PQRS'),
        submitToNav: z.boolean().optional().describe('Report to NAV right away (default: server setting, normally true)'),
        markPaid: z
          .boolean()
          .optional()
          .describe('The buyer has already paid (e.g. cash or card at the sale): records the full amount still open on the new document as paid – on a crediting document as refunded to the buyer; nothing when nothing is open –, dated on the issue date (default false). Not part of the confirmation code'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: REQUIRES_USER,
    },
    (args, rctx) =>
      run(async () => {
        const inv = app.getInvoice(args.draftId);
        if (inv.status !== 'draft') {
          if (args.confirmationCode && issuedWithCode(app, inv.id, args.confirmationCode)) {
            return ok({ repeated: true, summary: `Ez a számla már ki van állítva ezzel a kóddal: ${inv.number}.`, invoice: invoiceSummary(inv) }, pdfLink(ctx, inv));
          }
          throw new AppError('NOT_A_DRAFT', `A(z) ${inv.number ?? inv.id} már ki van állítva.`, { hint: 'Részletek: invoice_get.' });
        }
        const view = app.viewInvoice(inv.id);
        if (!view.readyToIssue) {
          throw new AppError('VALIDATION_FAILED', 'A piszkozat hibás, nem állítható ki.', { hint: 'Javítsd a hibákat (invoice_draft draftId-vel).', details: { issues: view.issues } });
        }
        if (ctx.confirmMode !== 'none') {
          if (!args.confirmationCode) {
            throw new AppError('CONFIRMATION_REQUIRED', 'Hiányzik a megerősítő kód.', {
              hint: 'A kódot az invoice_draft / invoice_get adja az előnézettel. Mutasd meg az előnézetet a felhasználónak, és csak jóváhagyás után add át confirmationCode-ként.',
            });
          }
          if (!verifyConfirmCode(app, 'issue', inv.id, app.issueFingerprint(inv.id), args.confirmationCode)) {
            throw new AppError('CONFIRMATION_INVALID', 'A megerősítő kód érvénytelen vagy lejárt, vagy az előnézet óta megváltozott a piszkozat, az eladó adatai vagy a dátum.', {
              hint: 'Kérj friss előnézetet és kódot (invoice_get { invoice: draftId }), mutasd meg újra a felhasználónak.',
            });
          }
        }
        // The dialog shows what will be issued (the preview: today's issue date, the due date issuing gives):
        // the document type, amount and dates first, the buyer's name (third-party text) last, quoted.
        const p = view.invoice;
        const dates = [`kelte: ${p.issueDate}`, `teljesítés: ${p.fulfillmentDate}`, ...(p.dueDate ? [`fizetési határidő: ${p.dueDate}`] : [])].join('; ');
        const permanence = p.documentType === 'proforma' ? 'A kiállított díjbekérő nem módosítható, csak visszavonható.' : 'A kiállított számla nem módosítható.';
        const paidNow = args.markPaid ? markPaidSentence(app.markPaidAmount(inv.id)) : '';
        const gate = elicitGate(
          server,
          ctx,
          rctx,
          `Kiállítod ${DOCUMENT_ACCUSATIVE[p.documentType]}? Bruttó: ${money(p, p.totals.grossAmount)}; ${dates}.${chainSentence(p, view.chain)} ${permanence} ${navSentence(app, p.documentType, args.submitToNav, p.reference ? app.store.getInvoice(p.reference.originalInvoiceId) : null)}${paidNow} Vevő: ${quoted(p.customer.name)}.`,
        );
        if (gate) return gate;
        const r = await app.issue(inv.id, clean({
          submitToNav: args.submitToNav,
          auditDetails: args.confirmationCode ? { confirmFingerprint: codeFingerprint(args.confirmationCode) } : undefined,
          markPaid: args.markPaid,
        }));
        resourcesChanged(server, ctx);
        // A cash or card sale is usually paid on the spot: without a payment it stays a receivable (overdue the next day).
        const unpaidOnTheSpot = !args.markPaid && app.markPaidHint(r.invoice) === 'suggested' && r.invoice.paymentStatus !== 'paid';
        return ok(
          {
            summary: `Kiállítva: ${r.invoice.number}, bruttó ${money(r.invoice, r.invoice.totals.grossAmount)}. ${navStatusText(app, r.invoice)} Vevő: ${quoted(r.invoice.customer.name)}.`,
            invoice: invoiceSummary(r.invoice),
            pdfPath: r.pdfPath,
            pdfError: r.pdfError,
            nav: r.nav as unknown as Json,
            notes: r.notes,
            ...(unpaidOnTheSpot
              ? { nextStep: 'Készpénzes/kártyás számla: ha a vevő már fizetett, rögzítsd a befizetést (invoice_record_payment), vagy add meg a markPaid: true-t a kiállításkor.' }
              : {}),
          },
          pdfLink(ctx, r.invoice),
        );
      }),
  );

  const cancellable = (idOrNumber: string): Invoice => {
    const inv = app.getInvoice(idOrNumber);
    if (inv.status === 'draft') throw new AppError('NOT_ISSUED', 'Piszkozatot nem kell sztornózni – töröld (invoice_delete_draft).');
    if (inv.status === 'cancelled') throw new AppError('ALREADY_CANCELLED', `A(z) ${inv.number} már sztornózva / visszavonva van.`);
    if (inv.documentType === 'storno' || inv.documentType === 'modification') {
      const original = inv.reference?.originalInvoiceNumber ?? '?';
      throw new AppError(
        'INVALID_INPUT',
        inv.documentType === 'storno' ? 'Sztornó számlát nem lehet sztornózni.' : 'Módosító számlát önmagában nem lehet sztornózni.',
        {
          hint:
            inv.documentType === 'storno'
              ? `A sztornó végleges: ha a(z) ${original} számlára mégis szükség van, állíts ki újat (invoice_draft copyFromId: "${original}").`
              : `Csak ezt a módosítást visszavonni egy ellentétes előjelű módosító számlával lehet az eredetin (invoice_correct { invoice: "${original}", … }); az egész számlát az eredeti sztornója érvényteleníti, a módosításaival együtt (invoice_cancel_preview { invoice: "${original}" }).`,
        },
      );
    }
    return inv;
  };

  server.registerTool(
    'invoice_cancel_preview',
    {
      title: 'Sztornó előnézet',
      description:
        'Shows what cancelling an issued invoice would do (a sztornó számla negating it and its issued corrections – its amounts, its fulfilment date and the corrections it negates are in "storno" –, reported to NAV; a díjbekérő is simply withdrawn) and returns the confirmationCode for invoice_cancel. Changes nothing.',
      inputSchema: z.object({
        invoice: z.string().describe('Id or number of the invoice to cancel'),
        reason: z.string().min(3).max(200).describe('Reason, printed on the storno invoice'),
      }),
      annotations: READ,
    },
    (args) =>
      run(() => {
        const inv = cancellable(args.invoice);
        // As the storno will carry it (normalised by the service; too short: INVALID_INPUT, no code).
        const reason = app.cancelReason(inv.id, args.reason);
        if (inv.documentType === 'proforma') {
          const code = ctx.confirmMode === 'none' ? null : mintConfirmCode(app, 'cancel', inv.id, app.cancelFingerprint(inv.id, reason));
          return ok({
            summary: `A(z) ${inv.number} díjbekérő visszavonásra kerül (nem számla, nincs sztornó bizonylat).`,
            invoice: invoiceSummary(inv),
            reason,
            nextStep: 'Mutasd meg a felhasználónak; csak kifejezett jóváhagyás után hívd: invoice_cancel { invoice, reason, confirmationCode }.',
            ...(code ? { confirmationCode: code, confirmationValidMinutes: 10 } : {}),
          });
        }
        // The storno negates the original AND every issued modification of it: show that amount.
        const p = app.stornoPreview(inv.id, reason);
        const errors = p.issues.filter((i) => i.severity === 'error');
        const code = ctx.confirmMode === 'none' || errors.length ? null : mintConfirmCode(app, 'cancel', inv.id, app.cancelFingerprint(inv.id, reason));
        return ok({
          summary: `Sztornó számla készül a(z) ${inv.number} számlához: ${stornoText(inv, p)}, új sorszámmal. ${navSentence(app, 'storno', undefined, inv)} Vevő: ${quoted(inv.customer.name)}; ok: ${quoted(reason, 200)}.`,
          invoice: invoiceSummary(inv),
          storno: {
            currency: p.storno.currency,
            net: p.storno.totals.netAmount,
            vat: p.storno.totals.vatAmount,
            gross: p.storno.totals.grossAmount,
            fulfillmentDate: p.storno.fulfillmentDate,
            negates: p.negates.map((m) => ({ id: m.id, number: m.number, gross: m.totals.grossAmount })),
          },
          reason,
          ...(p.issues.length ? { issues: issuesView(p.issues) } : {}),
          nextStep: errors.length
            ? `A sztornó most nem állítható ki (${errors.length} hiba, lásd issues); előbb javítsd a hibát.`
            : 'Mutasd meg a felhasználónak; csak kifejezett jóváhagyás után hívd: invoice_cancel { invoice, reason, confirmationCode }.',
          ...(code ? { confirmationCode: code, confirmationValidMinutes: 10 } : {}),
        });
      }),
  );

  server.registerTool(
    'invoice_cancel',
    {
      title: 'Sztornó (érvénytelenítés)',
      description:
        'IRREVERSIBLE. Cancels an issued invoice by issuing an érvénytelenítő (sztornó) számla (reported to NAV), or withdraws a díjbekérő. Requires the confirmationCode from invoice_cancel_preview with the same reason, after the user explicitly approved it.',
      inputSchema: z.object({
        invoice: z.string().describe('Id or number of the invoice to cancel'),
        reason: z.string().min(3).max(200).describe('Exactly the reason used in the preview'),
        confirmationCode: z.string().optional().describe('Code from invoice_cancel_preview (same invoice and reason), after the user approved it'),
        submitToNav: z.boolean().optional().describe('Report the storno to NAV right away (default: server setting, normally true)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: REQUIRES_USER,
    },
    (args, rctx) =>
      run(async () => {
        const target = app.getInvoice(args.invoice);
        if (target.status === 'cancelled' && args.confirmationCode) {
          const stornos = app.findInvoices({ originalInvoiceId: target.id, documentType: ['storno'], limit: 10 }).items;
          const prior = stornos.find((s) => issuedWithCode(app, s.id, args.confirmationCode as string));
          if (prior || (target.documentType === 'proforma' && issuedWithCode(app, target.id, args.confirmationCode))) {
            const shown = prior ?? target;
            return ok({ repeated: true, summary: `Már végrehajtva ezzel a kóddal: ${shown.number}.`, invoice: invoiceSummary(shown) });
          }
        }
        const inv = cancellable(args.invoice);
        const reason = app.cancelReason(inv.id, args.reason);
        // What its preview already refuses is refused here, before the code check and the dialog (as
        // invoice_issue checks readyToIssue first): nobody is asked to approve a storno that cannot be issued.
        const planned = inv.documentType === 'proforma' ? null : app.stornoPreview(inv.id, reason);
        const refusal = planned ? app.stornoRefusal(planned) : null;
        if (refusal) throw refusal;
        // What the code binds; the service checks it again inside the storno's transaction (STORNO_CHAIN_CHANGED).
        const fingerprint = app.cancelFingerprint(inv.id, reason);
        if (ctx.confirmMode !== 'none') {
          if (!args.confirmationCode) {
            throw new AppError('CONFIRMATION_REQUIRED', 'Hiányzik a megerősítő kód.', { hint: 'Kérj előnézetet és kódot: invoice_cancel_preview { invoice, reason }.' });
          }
          if (!verifyConfirmCode(app, 'cancel', inv.id, fingerprint, args.confirmationCode)) {
            throw new AppError('CONFIRMATION_INVALID', 'A megerősítő kód érvénytelen vagy lejárt, az ok eltér az előnézetben megadottól, vagy az előnézet óta módosító számla készült, illetve megváltoztak az eladó adatai.', {
              hint: 'Kérj új kódot: invoice_cancel_preview { invoice, reason } – ugyanazzal az okkal.',
            });
          }
        }
        const gate = elicitGate(server, ctx, rctx, !planned
          ? `Visszavonod a(z) ${inv.number} díjbekérőt?`
          : `Sztornózod a(z) ${inv.number} számlát? A sztornó számla: ${stornoText(inv, planned)}. ${navSentence(app, 'storno', args.submitToNav, inv)} Vevő: ${quoted(inv.customer.name)}; ok: ${quoted(reason, 200)}.`);
        if (gate) return gate;
        const r = await app.cancel(inv.id, clean({
          reason,
          submitToNav: args.submitToNav,
          auditDetails: args.confirmationCode ? { confirmFingerprint: codeFingerprint(args.confirmationCode) } : undefined,
          confirmedFingerprint: ctx.confirmMode === 'none' ? undefined : fingerprint,
        }));
        resourcesChanged(server, ctx);
        return ok(
          {
            summary: r.invoice.documentType === 'proforma' ? `Díjbekérő visszavonva: ${r.invoice.number}` : `Sztornó számla kiállítva: ${r.invoice.number} (eredeti: ${inv.number}). ${navStatusText(app, r.invoice)}`,
            invoice: invoiceSummary(r.invoice),
            pdfPath: r.pdfPath,
            nav: r.nav as unknown as Json,
            notes: r.notes,
          },
          r.invoice.documentType === 'proforma' ? [] : pdfLink(ctx, r.invoice),
        );
      }),
  );

  server.registerTool(
    'invoice_correct',
    {
      title: 'Módosító (helyesbítő) számla',
      description:
        'Creates a DRAFT módosító számla for an issued invoice. Lines are DIFFERENCES (new lines), never the corrected values: e.g. to lower a price by 5 000 Ft add quantity 1, unitPrice -5000 (same VAT code); to take back 2 pieces add the item with quantity -2; to change 10 hours to 12 add 2 hours. modifiesLineNo (optional) names the original line a difference refers to. ' +
        'The result has chain: the totals of the invoice with its issued modifications before and with this one (before → after) – check that "after" is what the user wants the invoice to come to; a line that repeats a line of the original is flagged (CORRECTION_LINE_REPEATS_ORIGINAL). ' +
        'At least one line is needed (NAV): to correct header data only (e.g. fulfillmentDate) add one zero-amount line (quantity 1, unitPrice 0, the VAT code of the original, the corrected data in the description). ' +
        'Review it with the user, then issue it with invoice_issue. To cancel the whole invoice use invoice_cancel_preview instead.',
      inputSchema: z.object({
        invoice: z.string().describe('Id or number of the ORIGINAL invoice'),
        lines: z.array(lineInput).min(1).describe('Difference lines'),
        comment: z.string().optional().describe('Reason of the correction (printed)'),
        fulfillmentDate: isoDate.optional().describe("Teljesítés dátuma. Default: the invoice's current one (its latest modification's, otherwise the original's); give it only to correct the date"),
      }),
      annotations: WRITE_LOCAL,
    },
    (args) =>
      run(async () => {
        const view = await app.createCorrectionDraft(args.invoice, clean({ lines: toLineInputs(args.lines), comment: args.comment, fulfillmentDate: args.fulfillmentDate }));
        return draftResult(ctx, view, 'Módosító számla piszkozat létrehozva');
      }),
  );

  server.registerTool(
    'invoice_delete_draft',
    {
      title: 'Piszkozat törlése',
      description: 'Deletes a DRAFT (never an issued invoice – those can only be cancelled).',
      inputSchema: z.object({ draftId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(() => {
        app.deleteDraft(args.draftId);
        return ok({ summary: `Piszkozat törölve: ${args.draftId}` });
      }),
  );

  server.registerTool(
    'invoice_record_payment',
    {
      title: 'Befizetés rögzítése',
      description:
        'Records a payment received for an issued invoice (default: the full remaining amount, today). Updates paymentStatus to partial/paid. ' +
        'More than the invoice (with its modifications) still owes is an overpayment: refused (OVERPAYMENT_NOT_CONFIRMED) unless allowOverpayment is true – check the amount with the user first (a slipped digit is the usual cause), and set it only when they confirm the buyer really paid that much. ' +
        'A negative amount reverses earlier payments (e.g. one recorded by mistake), at most down to 0 paid – the invoice is then unpaid again. ' +
        'Crediting documents (negative total): the refund to the buyer is negative and a positive amount reverses it. A 0 Ft invoice is only marked as paid (no amount). ' +
        'An invoice with issued modifications (módosító számla) is settled together with them: a credit note is set off against what is still owed on the original (beszámítás), and an overpayment covers the other documents of the chain – ' +
        'so a payment of the corrected total on the original settles both, and a credit note needs a refund only for what the buyer paid beyond the corrected total. The remaining amount, the status and the overdue flag follow from that. ' +
        'Without an amount, a document with a positive total (the original or a modification) gets what the whole chain still owes – e.g. the difference of an upward modification of a paid invoice, also on the original –, a credit note its open refund. ' +
        'Nothing can be recorded on a cancelled invoice or a modification of a cancelled invoice (the storno negated it too); on its storno only the refund to the buyer of what that invoice received – a negative amount, at most what is still to refund (default: all of it) – and a positive amount reversing such a refund. ' +
        'An invoice converted from a díjbekérő already holds the payment recorded on the díjbekérő: do not record it again (on any document of its chain an amount larger than what the chain still owes is refused). ' +
        'Every payment keeps its date: paidAmount is what was allocated to the document (a payment of the corrected total on the original also pays the modification), paidDate the payment date on which it became fully paid (null while not). ' +
        'Returns the amount still open ("open").',
      inputSchema: z.object({
        invoice: z.string().describe('Id or number'),
        amount: decimal.optional().describe('Amount in the invoice currency (default: the remaining amount, with the modifications of the invoice); the opposite sign reverses earlier payments'),
        date: isoDate.optional().describe('Payment date (default today; not after today, and not more than a year before the invoice date)'),
        allowOverpayment: z.boolean().optional().describe('true: record an amount larger than what is still owed (an overpayment the user confirmed); default false – such an amount is refused'),
      }),
      annotations: WRITE_LOCAL,
    },
    (args) =>
      run(() => {
        const inv = app.recordPayment(args.invoice, clean({ amount: args.amount, date: args.date, allowOverpayment: args.allowOverpayment }));
        const open = app.openAmount(inv) ?? '0';
        const positive = (v: string): string => v.replace(/^-/, '');
        return ok({
          summary:
            inv.documentType === 'storno'
              ? `Visszafizetés rögzítve: ${inv.number} (sztornó) → ${inv.paymentStatus} (visszafizetve: ${money(inv, positive(inv.paidAmount))}; még visszafizetendő: ${money(inv, positive(open))})`
              : `Befizetés rögzítve: ${inv.number} → ${inv.paymentStatus} (${money(inv, inv.paidAmount)} / ${money(inv, inv.totals.payableAmount)}; hátralék: ${money(inv, open)})`,
          invoice: invoiceSummary(inv),
          open,
        });
      }),
  );

  server.registerTool(
    'invoice_pdf',
    {
      title: 'Számla PDF',
      description:
        'Returns the PDF of an invoice: its local file path, kind, bytes and a resource link (readable with resources/read). ' +
        'For an issued document it is the original (kind "original", with its sha256): the PDF made when it was issued, kept byte for byte – the one to give the buyer; it is never rendered again. A kept original that no longer matches its fingerprints is refused (DOCUMENT_INTEGRITY_FAILED) – tell the user, never hand out a copy as the original. ' +
        'A document issued before originals were kept gets a PDF regenerated with the running program (kind "regenerated", <number>_UJRAELOALLITOTT.pdf): tell the user it is not byte for byte the PDF the buyer received. ' +
        'Drafts are rendered with a "TERVEZET" watermark (kind "draft"). ' +
        'copyToDir copies it into an existing local folder (e.g. to attach it to an e-mail): network (UNC) and device paths are refused, an existing file of the same name is never overwritten; the HTTP server (openszamla serve) does not copy unless OPENSZAMLA_ALLOW_FILE_COPY=1 is set on its machine. ' +
        'copy prints "MÁSOLAT" and is saved as <number>_MASOLAT.pdf, next to the invoice PDF (kind "copy", rendered now – not the original).',
      inputSchema: z.object({
        invoice: z.string().describe('Id or number'),
        copyToDir: z.string().optional().describe('Absolute path of an existing local folder (not a network share)'),
        copy: z.boolean().optional().describe('Print "MÁSOLAT" (copy) on it'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const inv = app.getInvoice(args.invoice);
        const r = await app.pdf(inv.id, clean({ copyToDir: args.copyToDir, copy: args.copy }));
        const summary = `${r.note} Fájl: ${r.copiedTo ?? r.path}${r.sha256 ? ` (SHA-256: ${r.sha256})` : ''}`;
        // previousFile: this request kept the original and found another file at its path, kept under that name (note says so).
        return ok({ summary, kind: r.kind, sha256: r.sha256, note: r.note, path: r.path, bytes: r.bytes, copiedTo: r.copiedTo, ...(r.previousFile ? { previousFile: r.previousFile } : {}) }, pdfLink(ctx, inv));
      }),
  );

  // ------------------------------------------------------------------------------------------
  server.registerTool(
    'nav_sync',
    {
      title: 'NAV szinkronizálás',
      description:
        'Reports pending invoices to NAV Online Számla and refreshes the processing status of submitted ones (originals before their corrections). Give invoice to handle just one; resubmitFailed retries rejected/failed ones after the cause was fixed. ' +
        'It never sends an invoice whose NAV status belongs to the other NAV system (e.g. reported only to the test one): nav_sync { invoice, resubmitFailed: true } on such an invoice sends nothing and returns the preview of sending it here (confirmationRequired, crossEnvironment: which NAV system it belongs to, where it would go – to production that is a real report) with the confirmationCode for nav_send_to_configured_environment. ' +
        'One call takes at most about 45 s: what it did not get to is listed in notProcessed – run nav_sync again. A run stops contacting NAV at the first outage, and sends nothing before a pause NAV asked for (Retry-After) ends – the notes say until when. ' +
        'Safe to repeat: an invoice is never sent twice, and a submission with an unknown outcome (timeout, lost answer) is first looked up at NAV, 5 minutes after it was sent. ' +
        'environment says which NAV system was used – in "test" nothing is reported for real.',
      inputSchema: z.object({
        invoice: z.string().optional().describe('Id or number: only this invoice – it is sent again even if NAV rejected it before (default: all pending)'),
        waitSeconds: z.number().int().min(0).max(45).optional().describe('How long to wait for NAV processing (default 15, within the time limit of the call)'),
        resubmitFailed: z
          .boolean()
          .optional()
          .describe('Also send again the rejected (aborted) and failed (error) reports – only after their cause was fixed. With invoice, for an invoice of the other NAV system: the preview and confirmationCode of nav_send_to_configured_environment (nothing is sent)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(async () => {
        const invoiceId = args.invoice ? app.getInvoice(args.invoice).id : undefined;
        // An invoice of the other NAV system is never sent from here: the preview of sending it, for the tool that does.
        const foreign = invoiceId && args.resubmitFailed ? app.navForeignResend(invoiceId) : null;
        if (foreign) {
          const code = ctx.confirmMode === 'none' ? null : mintConfirmCode(app, 'nav-report', foreign.invoiceId, foreign.fingerprint);
          const dialog = ctx.confirmMode === 'elicit' ? ' (a kliens párbeszédablaka is rákérdez)' : '';
          return ok({
            summary: `${foreign.summary} Nem küldtük be: a nav_sync a másik NAV-rendszerhez tartozó számlát nem küldi be – ezt a nav_send_to_configured_environment végzi${code ? ', a felhasználó megerősítésével' : ''}.`,
            confirmationRequired: code !== null,
            crossEnvironment: { invoiceId: foreign.invoiceId, number: foreign.number, reportedTo: foreign.reportedTo, navStatus: foreign.navStatus, sendTo: foreign.sendTo, realReport: foreign.realReport },
            nextStep: code
              ? `Mutasd meg ezt a felhasználónak. Csak ha kifejezetten megerősíti, hogy ez valódi számla, és ebbe a NAV-rendszerbe is be kell küldeni, hívd: nav_send_to_configured_environment { invoice, confirmationCode }${dialog}.`
              : 'Csak ha a felhasználó kifejezetten kéri, hogy ezt a számlát ebbe a NAV-rendszerbe is beküldd, hívd: nav_send_to_configured_environment { invoice }.',
            ...(code ? { confirmationCode: code, confirmationValidMinutes: 10 } : {}),
            environment: foreign.sendTo,
          });
        }
        const results = await app.navSync(clean({ invoiceId, waitSeconds: args.waitSeconds, resubmitFailed: args.resubmitFailed, budgetMs: NAV_CALL_BUDGET_MS }));
        return navSyncResult(app, results);
      }),
  );

  server.registerTool(
    'nav_send_to_configured_environment',
    {
      title: 'Beküldés a beállított NAV-rendszerbe',
      description:
        'IRREVERSIBLE – to production this is a real report to the tax authority. Sends ONE invoice whose NAV status belongs to the other NAV system (e.g. reported only to the TEST one: its navNote says so) to the configured NAV system, as a new submission. ' +
        'Requires the confirmationCode of the preview nav_sync { invoice, resubmitFailed: true } returns (it shows which NAV system the invoice belongs to and where it goes) – call only after the user explicitly confirmed that this is a real invoice to be reported here. Never in bulk. ' +
        'Takes at most about 45 s; the result is the nav_sync result for this invoice.',
      inputSchema: z.object({
        invoice: z.string().describe('Id or number of the invoice'),
        confirmationCode: z.string().optional().describe('Code from the preview of nav_sync { invoice, resubmitFailed: true }, after the user confirmed it'),
        waitSeconds: z.number().int().min(0).max(45).optional().describe('How long to wait for NAV processing (default 15, within the time limit of the call)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: REQUIRES_USER,
    },
    (args, rctx) =>
      run(async () => {
        // The rule is the service's: the invoice belongs to the other NAV system, and only the fingerprint of what the
        // preview showed (navForeignResend) sends it.
        const foreign = app.requireNavForeignResend(args.invoice);
        if (ctx.confirmMode !== 'none') {
          if (!args.confirmationCode) {
            throw new AppError('CONFIRMATION_REQUIRED', 'Hiányzik a megerősítő kód.', {
              hint: 'A kódot a nav_sync { invoice, resubmitFailed: true } adja az előnézettel. Mutasd meg az előnézetet a felhasználónak, és csak jóváhagyás után add át confirmationCode-ként.',
            });
          }
          if (!verifyConfirmCode(app, 'nav-report', foreign.invoiceId, foreign.fingerprint, args.confirmationCode)) {
            throw new AppError(
              'CONFIRMATION_INVALID',
              'A megerősítő kód érvénytelen vagy lejárt, vagy az előnézet óta megváltozott a számla NAV-állapota (az állapota, vagy hogy melyik NAV-rendszerhez tartozik), illetve a beállított NAV-környezet.',
              { hint: 'Kérj friss előnézetet és kódot: nav_sync { invoice, resubmitFailed: true }, és mutasd meg újra a felhasználónak.' },
            );
          }
        }
        const gate = elicitGate(server, ctx, rctx, `Beküldöd a(z) ${foreign.number ?? foreign.invoiceId} számlát ${foreign.sendTo === 'production' ? 'az ÉLES' : 'a TESZT'} NAV-rendszerbe? ${foreign.summary}`);
        if (gate) return gate;
        const results = await app.navSync(clean({ invoiceId: foreign.invoiceId, resubmitFailed: true, confirmedForeign: foreign.fingerprint, waitSeconds: args.waitSeconds, budgetMs: NAV_CALL_BUDGET_MS }));
        return navSyncResult(app, results, {
          crossEnvironment: { invoiceId: foreign.invoiceId, number: foreign.number, reportedTo: foreign.reportedTo, navStatus: foreign.navStatus, sendTo: foreign.sendTo, realReport: foreign.realReport },
        });
      }),
  );

  server.registerTool(
    'exchange_rate',
    {
      title: 'MNB árfolyam',
      description: 'Official MNB (Hungarian National Bank) exchange rate: HUF per 1 unit of the currency valid on the given date (the last rate published on or before it).',
      inputSchema: z.object({ currency: z.string().length(3).describe('e.g. EUR, USD'), date: isoDate.optional().describe('Default today') }),
      annotations: { ...READ, openWorldHint: true },
    },
    (args) => run(async () => ok((await app.exchangeRate(args.currency, args.date)) as unknown as Json)),
  );

  server.registerTool(
    'report_summary',
    {
      title: 'Időszaki összesítő',
      description:
        'Revenue and VAT summary of the invoices of a period (default: the current month so far): totals in HUF, by VAT code, by month, top customers; plus the unpaid and overdue receivables as of today (independent of the period). ' +
        'The period is matched against the issue date (kelte) unless dateBasis is "fulfillment" (teljesítés dátuma) – use "fulfillment" for VAT figures (general rule) – or "payment" (befizetés dátuma). A from later than to is an error. ' +
        'For a cash-accounting seller (pénzforgalmi elszámolás) the VAT is due when the payment is received (Áfa tv. 196/B. §): dateBasis "payment" sums the payments and refunds dated in the period on the documents issued under cash accounting, each with its proportional VAT (paymentCount: the payments counted). ' +
        'The result echoes from, to and dateBasis; notes holds warnings to pass on (how the payment basis is computed, documents it leaves out; that the issue and fulfilment bases are not the VAT to declare for a cash-accounting seller) – the accountant decides what to declare.',
      inputSchema: z.object({
        from: periodFrom.optional().describe('First day of the period, inclusive (YYYY-MM-DD; default: first day of the current month); compared with the date chosen by dateBasis'),
        to: periodTo.optional().describe('Last day of the period, inclusive (YYYY-MM-DD; default: today); compared with the date chosen by dateBasis'),
        dateBasis: dateBasis.optional(),
      }),
      annotations: READ,
    },
    (args) =>
      run(() => {
        const today = app.today();
        const r = app.report(clean({ from: args.from ?? `${today.slice(0, 7)}-01`, to: args.to ?? today, dateBasis: args.dateBasis }));
        // Buyer names on one line, as in the invoice rows (views.ts).
        return ok({ ...r, topCustomers: r.topCustomers.map((c) => ({ ...c, name: singleLine(c.name) })) } as unknown as Json);
      }),
  );

  server.registerTool(
    'export_invoices',
    {
      title: 'Export könyvelőnek',
      description:
        'Exports the issued invoices of a period (díjbekérők excluded) into the data folder: csv (Excel, Hungarian headers, both the issue and the fulfilment date), json (full data) or xml (NAV invoiceData files). ' +
        'The period is matched against the issue date (kelte) unless dateBasis is "fulfillment" (teljesítés dátuma) or "payment" (the documents issued under cash accounting that received a payment dated in the period); a from later than to is an error. ' +
        'ledger: true exports the payment ledger (befizetési napló) of the period instead, csv or json: every payment, refund and reversal dated in the period, with the part each document received and its proportional HUF net, VAT and gross. ' +
        'Returns the path, the count (ledger: the payments), from, to, dateBasis, ledger, warnings (xml: invoices left out, files named with the invoice id) and notes (warnings about the export as a whole, e.g. that for a cash-accounting seller the VAT to declare follows the payments).',
      inputSchema: z.object({
        from: periodFrom,
        to: periodTo,
        format: z.enum(['csv', 'json', 'xml']).optional().describe('Default csv; the ledger: csv or json'),
        dateBasis: dateBasis.optional(),
        ledger: z.boolean().optional().describe('true: the payment ledger of the period (by payment date) instead of the invoices; dateBasis then must be omitted or "payment"'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => ok(app.exportInvoices(clean({ from: args.from, to: args.to, format: args.format ?? 'csv', dateBasis: args.dateBasis, ledger: args.ledger })) as unknown as Json)),
  );

  server.registerTool(
    'tax_audit_export',
    {
      title: 'Adóhatósági ellenőrzési adatszolgáltatás',
      description:
        'The legally required tax-audit export ("adóhatósági ellenőrzési adatszolgáltatás", 23/2014. NGM rendelet 11/A. §) – use it when the tax authority (NAV) asks for the invoice data. ' +
        "Exports the invoices issued in a date range (from, to; from not later than to) OR an invoice-number range of one series (fromNumber, toNumber; fromNumber not after toNumber) into a new folder: szamlak.xml (the decree's annex-3 XML), NAV Online Számla XML per invoice and the PDFs. " +
        'Returns the folder path, the count and warnings (shortened texts, documents left out, renamed files – also listed in OLVASSEL.txt). ' +
        'Large ranges take long – about 1 ms per document whose PDF is kept (5 000 in about 3 s), 20–25 ms per PDF that has to be rendered (documents issued before PDFs were kept: 5 000 take about 2 minutes): it sends notifications/progress when the request has a progressToken, but a client that does not wait for them gives up after about 60 s. ' +
        'For thousands of documents split the range by month (one call per month), or ask the user to run `openszamla adohatosagi-export --from … --to …` on the command line. A call that timed out keeps running and still writes its folder: do not start it again.',
      inputSchema: z.object({
        from: isoDate.optional().describe('Issue date from (with to)'),
        to: isoDate.optional().describe('Issue date to (with from)'),
        fromNumber: z.string().optional().describe('First invoice number, or its id (with toNumber)'),
        toNumber: z.string().optional().describe('Last invoice number, or its id (with fromNumber)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args, rctx) =>
      run(async () => {
        const token = rctx.mcpReq._meta?.progressToken;
        const r = await app.taxAuditExport(
          clean({ from: args.from, to: args.to, fromNumber: args.fromNumber, toNumber: args.toNumber }),
          undefined,
          token === undefined ? {} : { onProgress: progressNotifier(rctx, token, (done, total) => `Adóhatósági export: ${done} / ${total} bizonylat kész.`) },
        );
        // A document that cannot be represented is left out and named in the warnings (and in OLVASSEL.txt).
        const notes = r.warnings.length ? ` – ${r.warnings.length} megjegyzés (lásd warnings és OLVASSEL.txt)` : '';
        return ok({ summary: `${r.count} számla exportálva: ${r.path}${notes}`, ...(r as unknown as Json) });
      }),
  );

  server.registerTool(
    'audit_log',
    {
      title: 'Auditnapló',
      description: 'Append-only, hash-chained log of every change (who/what/when), newest first; optionally only for one entity id.',
      inputSchema: z.object({
        entityId: z.string().optional().describe('Only the entries of this invoice, customer, product or series id'),
        ...pagination,
        limit: pagination.limit.describe('Max items (default 50)'),
      }),
      annotations: READ,
    },
    (args) =>
      run(() => {
        const page = app.auditLog(clean({ entityId: args.entityId, limit: args.limit, offset: args.offset }));
        return ok({ total: page.total, entries: page.items as unknown as Json[] });
      }),
  );

  server.registerTool(
    'backup_create',
    {
      title: 'Adatbázis mentése',
      description:
        'Makes a backup: a consistent copy of the database (every invoice with its kept original PDF, customers, products, settings, the audit log) in the backups folder of the data directory, named by date and time. Returns its path and size. ' +
        'Tell the user where it is and to copy it off this machine (a backup on the same disk does not survive a disk failure), and that a backup is restored with the openszamla restore command, not by copying the file over the database. Changes no data.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    () =>
      run(() => {
        const b = app.createBackup();
        return ok({
          summary: `Mentés elkészült: ${b.path} (${(b.bytes / (1024 * 1024)).toFixed(1)} MB). Másold a gépen kívülre is (pendrive, felhő); visszaállítani az „openszamla restore <mentésfájl>” paranccsal kell.`,
          path: b.path,
          bytes: b.bytes,
          auditHead: b.auditHead,
        });
      }),
  );

  server.registerTool(
    'verify_integrity',
    {
      title: 'Adatbázis ellenőrzése',
      description:
        'Checks that nothing was changed outside the program (as openszamla verify): the content hash of every issued document, the audit hash chain, each issuance against the log, gaps in the numbering, the protective database triggers, the paid amounts against the payment ledger and the kept original PDFs against their fingerprints. ' +
        'ok: true – nothing found; otherwise the lists name what differs: tell the user plainly, and suggest restoring a sound backup and asking their accountant – never try to "repair" issued documents. warnings and notes are not failures. Read-only.',
      inputSchema: z.object({}),
      annotations: READ,
    },
    () =>
      run(() => {
        const r = app.verifyIntegrity();
        const problems = [r.invoiceMismatches, r.auditMismatches, r.unauditedInvoices, r.numberingGaps, r.alteredTriggers, r.paymentMismatches, r.documentMismatches].reduce((n, l) => n + l.length, 0) + (r.audit.ok ? 0 : 1);
        return ok({
          summary: r.ok
            ? `Ellenőrzés: rendben – ${r.invoicesChecked} bizonylat, ${r.audit.entries} naplóbejegyzés, ${r.documentsChecked} megőrzött eredeti PDF.`
            : `Ellenőrzés: ELTÉRÉST TALÁLT (${problems}) – az adatbázist a programon kívül módosíthatták. Mondd el a felhasználónak, mit talált az ellenőrzés; javítás: egy ép mentés visszaállítása (openszamla restore) és könyvelői segítség.`,
          ok: r.ok,
          invoicesChecked: r.invoicesChecked,
          invoiceMismatches: r.invoiceMismatches,
          auditMismatches: r.auditMismatches,
          unauditedInvoices: r.unauditedInvoices,
          numberingGaps: r.numberingGaps,
          alteredTriggers: r.alteredTriggers,
          paymentMismatches: r.paymentMismatches,
          documentsChecked: r.documentsChecked,
          documentMismatches: r.documentMismatches,
          warnings: [...r.documentWarnings, ...r.restoreWarnings],
          notes: r.documentNotes,
          legacyDocuments: r.legacyDocuments,
          audit: r.audit,
        });
      }),
  );
}
