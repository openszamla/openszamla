/**
 * openszamla restore <mentésfájl> [--confirm]: puts a backup in the place of the database (service/restore.ts has the
 * rules). Without --confirm it only says what the restore would do – which documents the backup does not have, where the
 * numbering continues – and changes nothing; with --confirm it restores, keeps the replaced database beside the new
 * one, and runs the integrity check on the result.
 */
import { DOCUMENT_TYPE_NAME } from '../core/names.ts';
import { OpenSzamla } from '../service/app.ts';
import { dataDirOption } from '../service/config.ts';
import { restoreDatabase, type DatabaseSummary, type LostDocument, type RestorePlan } from '../service/restore.ts';

/** At most this many lost documents are listed one by one. */
const LISTED = 20;

function summaryLine(s: DatabaseSummary): string {
  const seller = s.seller ? `${s.seller.name} (${s.seller.taxNumber})` : 'nincs beállítva';
  const last = s.lastIssued ? `, az utolsó: ${s.lastIssued.number} (${s.lastIssued.issueDate})` : '';
  return `  eladó: ${seller}; ${s.issued} kiállított bizonylat${last}; ${s.drafts} piszkozat, ${s.customers} vevő, ${s.products} termék`;
}

function lostLines(lost: readonly LostDocument[]): string[] {
  const lines = lost.slice(0, LISTED).map((l) => `  ${l.number} (${DOCUMENT_TYPE_NAME[l.documentType] ?? l.documentType}, kelte ${l.issueDate})`);
  if (lost.length > LISTED) lines.push(`  … és még ${lost.length - LISTED} bizonylat (${lost.at(-1)?.number ?? ''}-ig)`);
  return lines;
}

/** What the restore does, or did (`done`), to the documents and the numbering. */
function consequences(plan: RestorePlan, done: boolean): string[] {
  const out: string[] = [];
  const cur = plan.current;
  if (plan.currentProblem) {
    out.push(`A jelenlegi adatbázis nem olvasható (${plan.currentProblem}) – összehasonlítás nélkül ${done ? 'tettem' : 'teszem'} félre.`);
  } else if (!cur) {
    out.push(`Itt még ${done ? 'nem volt' : 'nincs'} adatbázis: a mentés ${done ? 'került' : 'kerül'} a helyére.`);
  } else {
    if (cur.seller && plan.backup.seller && cur.seller.taxNumber !== plan.backup.seller.taxNumber) {
      out.push(`FIGYELEM: a mentés másik eladóé (${plan.backup.seller.name}, ${plan.backup.seller.taxNumber}), mint a jelenlegi adatbázis (${cur.seller.name}, ${cur.seller.taxNumber}).`);
    }
    // The same last audit entry: nothing was logged since the backup was made.
    const sameState = plan.earlierState === true && cur.auditHead !== null && cur.auditHead.id === plan.backup.auditHead?.id;
    if (sameState) out.push('A mentés az adatbázis mostani állapotával egyezik (az auditnapló utolsó bejegyzése azonos): a mentés óta nem történt naplózott változás.');
    else if (plan.earlierState === true) out.push('A mentés ennek az adatbázisnak egy korábbi állapota.');
    else if (cur.issued > 0 || cur.auditHead !== null) {
      out.push('FIGYELEM: a mentés NEM ennek az adatbázisnak egy korábbi állapota (másik adatbázis mentése, vagy a mentés készítése óta külön folytatódott).');
    }
    if (plan.lost.length > 0) {
      out.push(
        `A jelenlegi adatbázis ${plan.lost.length} kiállított bizonylata NINCS a mentésben – a visszaállítás után az adatbázisból ${done ? 'hiányzik' : 'hiányozni fog'}:`,
        ...lostLines(plan.lost),
        '  Ezeket a vevők megkaphatták, és a NAV-nál is szerepelhetnek: a félretett adatbázisban megmaradnak (onnan a PDF-jük is kiadható).',
      );
    }
    if (plan.conflicting.length > 0) {
      out.push(`FIGYELEM: ${plan.conflicting.length} sorszám mindkét adatbázisban szerepel, de más tartalommal (két különböző bizonylat egy sorszámon): ${plan.conflicting.slice(0, LISTED).join(', ')}${plan.conflicting.length > LISTED ? ', …' : ''}.`);
    }
    if (plan.continued.length > 0) {
      out.push(
        `A sorszámozás a már kiadott sorszámok után ${done ? 'folytatódik' : 'folytatódik majd'} (ugyanaz a sorszám nem adható ki kétszer):`,
        ...plan.continued.map((c) => `  ${c.name}: a következő sorszám ${c.to} (a mentés szerint ${c.from} lenne)`),
      );
    } else if (plan.lost.length > 0) {
      out.push('A sorszámozás a mentés szerint folytatódik: ha a hiányzó bizonylatok sorszámai a vevőknél vagy a NAV-nál már szerepelnek, ne add ki őket újra – hozz létre új sorszámtartományt eltérő előtaggal.');
    }
    for (const m of plan.missingSeries) {
      out.push(`A(z) „${m.name}” sorszámtartomány (${m.pattern}) a mentésben nincs meg: ha újra létrehozod, a kezdő sorszáma legyen a következő kiadandó sorszám (${m.next}), ne 1.`);
    }
    out.push('A mentés óta rögzített minden más adat (piszkozatok, vevők, termékek, befizetések, NAV-állapotok) is a mentéskori állapotra áll vissza.');
  }
  return out;
}

/** Runs the command; returns the exit code. */
export function runRestore(o: { dbPath: string; backupPath: string; confirm: boolean; dataDir: string }, out: (line: string) => void): number {
  const r = restoreDatabase({ dbPath: o.dbPath, backupPath: o.backupPath, confirm: o.confirm, actor: 'cli' });
  const plan = r.plan;
  if (!r.restored) {
    out('Visszaállítás – előnézet (semmi nem változott)');
    out(`Mentés: ${plan.backupPath}`);
    out(summaryLine(plan.backup));
    out(`Adatbázis: ${plan.dbPath}`);
    if (plan.current) out(summaryLine(plan.current));
    for (const line of consequences(plan, false)) out(line);
    if (plan.current || plan.currentProblem) out('A jelenlegi adatbázist a program nem törli: félreteszi az adatbázis mellé („…visszaallitas-elott-<dátum>” nevű fájl).');
    out('A visszaállításhoz állíts le minden programot, amely az adatbázist használja (a webes felületet és az AI-klienseket), majd futtasd:');
    out(`  openszamla restore "${plan.backupPath}" --confirm${dataDirOption(o.dataDir)}`);
    return 0;
  }
  out(`Visszaállítva: ${plan.backupPath} → ${plan.dbPath}`);
  if (r.asidePath) out(`A korábbi adatbázis megvan, félretéve: ${r.asidePath}`);
  for (const line of consequences(plan, true)) out(line);
  // The restored database as the program sees it: the same check as `openszamla verify`.
  const app = OpenSzamla.open({ dataDir: o.dataDir, actor: 'cli' });
  try {
    const v = app.verifyIntegrity();
    out(v.ok ? `Ellenőrzés: rendben (${v.invoicesChecked} bizonylat, ${v.audit.entries} naplóbejegyzés).` : 'Ellenőrzés: ELTÉRÉST TALÁLT – a részletekhez futtasd: openszamla verify');
    if (v.ok === false) return 2;
  } finally {
    app.close();
  }
  out('Most indítsd újra a webes felületet és az AI-klienseket. A NAV-állapotok a mentéskoriak: ha van NAV-beállítás, futtass egy szinkront (nav_sync, vagy a webes „NAV-szinkron” gomb).');
  return 0;
}
