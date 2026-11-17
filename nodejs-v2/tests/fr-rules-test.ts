/**
 * Replays the examples of the FR patch on the French rules of the source (fr-rules.ts, fr-rules-data.ts):
 * "oui" = the rule fires, "non" = it does not, "exact" = the text the rule captures.
 * The table rules (one per organization sub-type) are compared with the patterns the patch generated.
 * Run: npx tsx tests/fr-rules-test.ts
 */

import { readFileSync } from "node:fs";
import { runPatternRecognizers } from "../src/engine/pattern-recognizers.js";
import { buildFrenchTableRules } from "../src/engine/fr-rules-data.js";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passed++; }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

const read = (f: string) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
const examples: Array<{ nom: string; type: string; oui: string[]; non: string[]; exact: Record<string, string> }> = read("./fr-rules-examples.json");
const tables: Array<{ nom: string; source: string; flags: string }> = read("./fr-rules-tables.json");

const hits = (text: string, rule: string) => runPatternRecognizers(text).filter((e) => e.reason === `pattern:${rule}`);

for (const ex of examples) {
  for (const t of ex.oui) check(hits(t, ex.nom).length > 0, `${ex.nom}: should fire on ${JSON.stringify(t)}`);
  for (const t of ex.non) check(hits(t, ex.nom).length === 0, `${ex.nom}: should NOT fire on ${JSON.stringify(t)}`);
  for (const [t, want] of Object.entries(ex.exact)) {
    const got = hits(t, ex.nom).map((e) => e.text);
    check(got.includes(want), `${ex.nom}: ${JSON.stringify(t)} should capture ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  const typed = hits(ex.oui[0] ?? "", ex.nom);
  if (typed.length) check(typed[0].type === ex.type, `${ex.nom}: type ${typed[0].type} should be ${ex.type}`);
}

// Table rules: same count, same names, same patterns as the patch
const built = buildFrenchTableRules();
check(built.length === tables.length, `table rules: ${built.length} built, ${tables.length} in the patch`);
// Several rules share a name (one per pattern of the same sub-type), so compare in order.
tables.forEach((t, i) => {
  const b = built[i];
  check(!!b && b.patterns[0].name === t.nom && b.patterns[0].regex.source === t.source && b.patterns[0].regex.flags === t.flags, `table rule #${i} ${t.nom} identical to the patch`);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
