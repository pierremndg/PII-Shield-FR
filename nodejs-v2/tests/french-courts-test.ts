/**
 * Tests for the French court-name rule in false-positive-filter.ts:
 * a court name is not masked, the city that follows it is.
 * Run: npx tsx tests/french-courts-test.ts
 */

import { filterJurisdictionEntities, isFrenchCourtName } from "../src/engine/false-positive-filter.js";
import type { DetectedEntity } from "../src/engine/pattern-recognizers.js";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ok  ${msg}`); passed++; }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

function ent(text: string, type: string, doc: string): DetectedEntity {
  const start = doc.indexOf(text);
  if (start < 0) throw new Error(`"${text}" not in "${doc}"`);
  return { text, type, start, end: start + text.length, score: 0.9, verified: false, reason: "test" };
}

// ── Court names are recognised (whole word, ORGANIZATION only) ──────────────
for (const name of [
  "Tribunal Judiciaire de Lyon", "Tribunal de commerce de Rennes", "Cour d'appel de Rennes",
  "Cour de cassation", "Conseil d'État", "Conseil d’Etat", "Conseil constitutionnel",
  "Conseil des prud'hommes de Rennes", "Conseil de prud’hommes de Lyon",
]) {
  check(isFrenchCourtName(ent(name, "ORGANIZATION", name)), `court name recognised: ${name}`);
}
for (const name of ["Maison Exemple Conseil", "Courtage Dupont", "Tribunaux", "Syndicat CGT"]) {
  check(!isFrenchCourtName(ent(name, "ORGANIZATION", name)), `not a court name: ${name}`);
}
check(!isFrenchCourtName(ent("Lyon", "LOCATION", "Lyon")), "a city is not a court name");
check(!isFrenchCourtName(ent("Tribunal de commerce", "PERSON", "Tribunal de commerce")), "only ORGANIZATION counts");

// ── The filter drops the court name and keeps the city ──────────────────────
{
  const doc = "Le Tribunal de commerce de Rennes a statué.";
  const court = ent("Tribunal de commerce de Rennes", "ORGANIZATION", doc);
  const city = ent("Rennes", "LOCATION", doc);
  // The city is detected inside the court-name span too (as the NER does).
  const kept = filterJurisdictionEntities([court, city], doc);
  check(kept.length === 1 && kept[0].type === "LOCATION" && kept[0].text === "Rennes", "court name dropped, city kept");
}
{
  const doc = "Le Tribunal a statué à Lyon.";
  const kept = filterJurisdictionEntities([ent("Lyon", "LOCATION", doc)], doc);
  check(kept.length === 1, "a city without a court name before it is kept");
}
{
  const doc = "La société Maison Exemple Conseil est cliente.";
  const kept = filterJurisdictionEntities([ent("Maison Exemple Conseil", "ORGANIZATION", doc)], doc);
  check(kept.length === 1, "an organisation containing 'Conseil' is kept");
}

// ── French rules type the court as ORG_* and cover the city: the city is given back ──
{
  const doc = "Le Tribunal de commerce de Rennes a statué.";
  const court = { ...ent("Tribunal de commerce de Rennes", "ORG_TRIBUNAL_COMMERCE", doc) };
  check(isFrenchCourtName(court), "an ORG_* sub-type court is recognised");
  const kept = filterJurisdictionEntities([court], doc);
  check(kept.length === 1 && kept[0].type === "VILLE" && kept[0].text === "Rennes" && kept[0].start === doc.indexOf("Rennes"),
    "court typed ORG_*, no city entity: the court is dropped and the city comes back at the right place");
}
{
  const doc = "Saisine du Conseil d'État et de la Cour de cassation.";
  const kept = filterJurisdictionEntities([ent("Conseil d'État", "ORG_TRIBUNAL", doc), ent("Cour de cassation", "ORG_COUR", doc)], doc);
  check(kept.length === 0, "courts without a city give no city back (Conseil d'État, Cour de cassation)");
}
{
  const doc = "La Cour d'appel d'Aix-en-Provence a jugé.";
  const kept = filterJurisdictionEntities([ent("Cour d'appel d'Aix-en-Provence", "ORG_COUR_APPEL", doc)], doc);
  check(kept.length === 1 && kept[0].text === "Aix-en-Provence", "compound city name after d' is given back");
}

// ── Original behaviour is unchanged ─────────────────────────────────────────
{
  const doc = "Disputes go to the German courts.";
  const kept = filterJurisdictionEntities([ent("German courts", "ORGANIZATION", doc)], doc);
  check(kept.length === 0, "original rule still drops 'German courts'");
}

// ── The user can choose to mask court names (PII_MASK_COURTS=true) ──────────
{
  const doc = "Le Tribunal de commerce de Rennes a statué.";
  const court = ent("Tribunal de commerce de Rennes", "ORGANIZATION", doc);
  const city = ent("Rennes", "LOCATION", doc);
  process.env.PII_MASK_COURTS = "true";
  const kept = filterJurisdictionEntities([court, city], doc);
  check(kept.length === 2 && kept.some((e) => e.type === "ORGANIZATION"), "PII_MASK_COURTS=true: court name kept (masked), city kept");
  const english = filterJurisdictionEntities([ent("German courts", "ORGANIZATION", "Disputes go to the German courts.")], "Disputes go to the German courts.");
  check(english.length === 0, "PII_MASK_COURTS=true: original rule still drops 'German courts'");
  process.env.PII_MASK_COURTS = "false";
  check(filterJurisdictionEntities([court, city], doc).length === 1, "PII_MASK_COURTS=false: court name dropped");
  delete process.env.PII_MASK_COURTS;
  check(filterJurisdictionEntities([court, city], doc).length === 1, "setting absent: court name dropped (default)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
