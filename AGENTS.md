# AGENTS.md – OpenSzámla

Instructions for coding agents (Codex, Claude Code, …) working **on this repository**.
(Agents that *use* OpenSzámla to issue invoices get their instructions from the MCP server and from
`skills/magyar-szamlazas/SKILL.md`.)

## What this is

Open-source Hungarian invoicing program (számlázó program) with an MCP server. TypeScript, ESM,
developed on Node.js 24. The published package (`dist/`) runs on Node.js ≥ 22.13.0 (the first version
with `node:sqlite` unflagged and `StatementSync#iterate`); development and tests run `src/*.ts` directly
through Node's type stripping, which needs Node.js ≥ 22.18 (on by default from 22.18.0) – no build step.
Storage: built-in `node:sqlite`. PDF: pdfmake. NAV Online Számla v3.0 client: hand-written XML +
`node:crypto`. MCP: `@modelcontextprotocol/server` v2 (serves the 2025 and 2026-07-28 protocol eras).

## Commands

```bash
npm install
npm test                 # vitest (all suites)
npx vitest run test/core # one suite
npm run typecheck        # tsc (TypeScript 7) – must be clean
npm run build            # emits dist/ (imports rewritten .ts → .js)
node scripts/smoke.mjs   # after the build: CLI + service + stdio MCP against dist/ (CI also runs it on 22.13.0)
node scripts/sync-skills.mjs          # after editing skills/ (CI runs it with --check)
npm run build:mcpb       # Claude Desktop extension (.mcpb); mcpb/manifest.json must list the server's tools and prompts verbatim
node src/cli/main.ts --help
node src/cli/main.ts mcp # stdio MCP server against ~/.openszamla (set OPENSZAMLA_HOME for a scratch dir!)
```

Use a throw-away data directory when trying things: `OPENSZAMLA_HOME=$(mktemp -d) node src/cli/main.ts status`.

## Layout

| Path | Contents |
|---|---|
| `src/core/` | domain types, decimals, VAT catalog, calculation, validation, numbering, formatting |
| `src/db/` | SQLite schema + `Store` (immutability and audit-chain triggers) |
| `src/nav/` | NAV Online Számla crypto, invoiceData XML builder, API client |
| `src/pdf/` | invoice PDF |
| `src/mnb/` | MNB exchange rates |
| `src/service/` | `OpenSzamla` – every business operation (the only place for rules) |
| `src/mcp/` | MCP tools/resources/prompts, confirmation codes, stdio + HTTP transports |
| `src/web/`, `src/cli/` | web UI, command line |
| `vendor/nav-online-invoice/` | official NAV XSDs and sample XMLs (MIT) – tests validate against them |
| `scripts/`, `mcpb/`, `plugins/` | release tooling (`.mcpb` build, smoke test, skill sync), Claude Desktop extension manifest, Claude Code plugin |
| `docs/research/` | research the implementation is based on (law, NAV API, MCP clients, data formats) |

## Rules

- **Money is never a JS number.** Use `src/core/decimal.ts` (decimal strings in, decimal strings out).
- **Issued invoices are immutable.** Never add code paths that update or delete them; corrections are
  new documents (storno / modification). The SQLite triggers in `src/db/schema.ts` must keep enforcing this.
- **Business rules live in `src/service/`** (and `src/core/`); MCP tools, CLI and web stay thin adapters.
- **Every user-visible function must be documented** in `docs/felhasznaloi-dokumentacio.md` – this is a
  legal requirement for invoicing programs (23/2014. NGM rendelet 10. §: the program may only perform
  documented functions). Adding/changing an MCP tool, CLI command or web action without updating that
  document is a bug.
- **NAV XML** must validate against the vendored XSDs (`test/helpers/nav-xsd.ts`) – add a test for every
  new scenario. Element order matters.
- **Secrets** (NAV password, signing/exchange keys, HTTP token) never go to logs, tool results, errors or the database.
- **stdio mode:** nothing but JSON-RPC on stdout. Log to stderr.
- **Minimum runtime:** use only Node.js APIs that exist in 22.13.0 (check the "Added in" of the Node docs;
  e.g. `DatabaseSync#isTransaction` / `#isOpen` are newer – the store tracks transaction state itself).
  The same goes for SQL: Node.js 22.13 bundles SQLite 3.47.2, which e.g. does not resolve a column of the
  updated table in the ORDER BY of a correlated subquery ("no such column") – no test on a newer Node.js
  shows that, so run `node scripts/smoke.mjs` with a 22.13.0 binary after touching `src/db/` (the tests
  themselves need ≥ 22.18; run in-process suites with `<node 22.13> node_modules/vitest/vitest.mjs run test/service`).
  Raising the minimum means changing `engines`, the `MIN` gate in `src/cli/main.ts`, `mcpb/manifest.json`,
  the CI matrix and the docs together (`test/release/packaging.test.ts` checks that they agree).
- **Paths from configuration** (`OPENSZAMLA_HOME`, `OPENSZAMLA_DB`, `--data-dir`) go through
  `resolveConfiguredPath` (`src/service/config.ts`): MCP clients start the server without a shell.
- MCP tool names: ASCII `snake_case` ≤ 64 chars, root input schema `z.object`, annotations on every tool,
  `structuredContent` must be complete (Codex shows the model only that), irreversible tools need the
  confirmation code (`src/mcp/confirm.ts`).
- TypeScript: explicit `.ts` import extensions, `erasableSyntaxOnly` (no enums/namespaces/parameter
  properties), `verbatimModuleSyntax` (`import type`), strict + `noUncheckedIndexedAccess`.
- User-facing messages (errors, hints, PDF, docs) are Hungarian; code, identifiers and comments English.
- Tests must not touch the network except where explicitly marked live (`OPENSZAMLA_LIVE_TESTS=1`).
  Use the fake NAV server (`test/helpers/fake-nav.ts`) for NAV flows.
