/**
 * Tests for the gliner_multi_pii-v1 corrections in fr-ner-corrections.ts.
 * Run: npx tsx tests/fr-ner-corrections-test.ts
 */

import { removeGenericSyndic, trimLowercaseNameTail } from "../src/engine/fr-ner-corrections.js";
import type { DetectedEntity } from "../src/engine/pattern-recognizers.js";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ok  ${msg}`); passed++; }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

function ent(text: string, type: string, start: number): DetectedEntity {
  return { text, type, start, end: start + text.length, score: 0.9, verified: false, reason: "test" };
}

// ── Generic condominium union ───────────────────────────────────────────────
check(removeGenericSyndic([ent("le syndicat des copropriétaires de l'immeuble", "ORGANIZATION", 0)]).length === 0,
  "generic syndic 'le syndicat des copropriétaires de l'immeuble' dropped");
check(removeGenericSyndic([ent("syndicat des copropriétaires d’un immeuble", "ORGANIZATION", 0)]).length === 0,
  "generic syndic with typographic apostrophe dropped");
check(removeGenericSyndic([ent("Syndicat des copropriétaires du Parc Lilas", "ORGANIZATION", 3)]).length === 1,
  "syndic with a proper noun kept");
check(removeGenericSyndic([ent("CGT", "ORGANIZATION", 3)]).length === 1, "a trade union acronym is kept");
check(removeGenericSyndic([ent("syndicat des copropriétaires de l'immeuble", "PERSON", 0)]).length === 1, "a PERSON is never dropped");

// ── Trailing lowercase word in a name ───────────────────────────────────────
{
  const out = trimLowercaseNameTail([ent("Le Goff a", "PERSON", 4)]);
  check(out[0].text === "Le Goff" && out[0].end === 11, "'Le Goff a' becomes 'Le Goff' (end 11)");
}
{
  const out = trimLowercaseNameTail([ent("Jean-Pierre Martin répond", "PERSON", 0)]);
  check(out[0].text === "Jean-Pierre Martin" && out[0].end === 18, "hyphenated first name kept, lowercase verb cut");
}
{
  const out = trimLowercaseNameTail([ent("Laure Le Goff", "PERSON", 0)]);
  check(out[0].text === "Laure Le Goff", "a name that ends with a capital is unchanged");
}
{
  const out = trimLowercaseNameTail([ent("Cabinet Dupont et", "ORGANIZATION", 0)]);
  check(out[0].text === "Cabinet Dupont et", "only PERSON entities are trimmed");
}
{
  const out = trimLowercaseNameTail([ent("de Gaulle", "PERSON", 0)]);
  check(out[0].text === "de Gaulle", "no capital before a lowercase word: unchanged");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
