/**
 * Tests for the French identifier recognizers and control keys (fr-recognizers.ts).
 * Run: npx tsx tests/fr-recognizers-test.ts
 */

import { runPatternRecognizers, type DetectedEntity } from "../src/engine/pattern-recognizers.js";
import { flagWrongFrenchKeys, verifyFrenchKey, nirValid, ibanFrValid, siretValid, luhnValid, ribValid } from "../src/engine/fr-recognizers.js";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ok  ${msg}`); passed++; }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

/** Entities found by rule `name` in `text`. */
function byRule(text: string, name: string): DetectedEntity[] {
  return runPatternRecognizers(text).filter((e) => e.reason === `pattern:${name}`);
}

// ── Regex rules: positive and negative examples ─────────────────────────────
check(byRule("SIRET 123 456 789 00012", "fr_siret").length === 1, "fr_siret matches a SIRET");
check(byRule("123 456 789", "fr_siret").length === 0, "fr_siret ignores 9 digits");
check(byRule("SIREN 123 456 789", "fr_siren").length === 1, "fr_siren matches a SIREN");
check(byRule("1234567", "fr_siren").length === 0, "fr_siren ignores 7 digits");
check(byRule("FINESS 750712184", "fr_siren").length === 0, "fr_siren ignores a number after FINESS");
{
  const r = byRule("FINESS 750712184", "fr_finess");
  check(r.length === 1 && r[0].type === "MEDICAL_LICENSE", "fr_finess matches a FINESS as MEDICAL_LICENSE");
}
check(byRule("RPPS 10003456789", "fr_rpps").length === 1, "fr_rpps matches an RPPS");
check(byRule("20003456789", "fr_rpps").length === 0, "fr_rpps needs the 10 prefix");
for (const t of ["06 12 34 56 78", "+33 6 12 34 56 78", "0033 6 12 34 56 78", "00 33 6 12 34 56 78"]) {
  check(byRule(`Tél : ${t}`, "fr_telephone").length === 1, `fr_telephone matches ${t}`);
}
check(byRule("1234567", "fr_telephone").length === 0, "fr_telephone ignores 7 digits");
check(byRule("IBAN FR76 3000 6000 0112 3456 7890 189", "fr_iban").length === 1, "fr_iban matches an IBAN");
check(byRule("FR76 3000", "fr_iban").length === 0, "fr_iban ignores a truncated IBAN");
for (const t of ["AB-123-CD", "AB 123 CD"]) {
  check(byRule(`immatriculation ${t}`, "fr_plaque").length === 1, `fr_plaque matches ${t}`);
}
check(byRule("ABC-DE", "fr_plaque").length === 0, "fr_plaque ignores ABC-DE");
check(byRule("RIB 30004 00850 00012345678 02", "fr_rib").length === 1, "fr_rib matches a RIB");
check(byRule("1234567890", "fr_rib").length === 0, "fr_rib ignores 10 digits");

// ── Control keys ────────────────────────────────────────────────────────────
check(nirValid("185017510812316"), "NIR with a good key");
check(!nirValid("185017510812300"), "NIR with a wrong key");
check(ibanFrValid("FR7630006000011234567890189"), "French IBAN with a good key");
check(!ibanFrValid("FR7630006000011234567890180"), "French IBAN with a wrong key");
check(siretValid("73282932000074") && !siretValid("73282932000075"), "SIRET Luhn");
check(siretValid("35600000000001") && !siretValid("35600000000002"), "La Poste SIRET: sum of digits multiple of 5 (15 ok, 16 not)");
check(luhnValid("732829320") && !luhnValid("732829321"), "SIREN Luhn");
check(!ribValid("12345678901234567890123"), "RIB with a wrong key");

function ent(text: string, type: string, reason = "test"): DetectedEntity {
  return { text, type, start: 0, end: text.length, score: 0.9, verified: true, reason };
}

// A wrong key: kept, but retyped *_A_VERIFIER (never dropped)
{
  const out = flagWrongFrenchKeys([
    ent("1 85 01 75 108 123 16", "FR_NIR"), ent("1 85 01 75 108 123 00", "FR_NIR"),
    ent("FR76 3000 6000 0112 3456 7890 180", "IBAN_CODE"),
    ent("732 829 320 00075", "SIRET", "pattern:fr_siret"),
    ent("732 829 321", "SIREN", "pattern:fr_siren"),
  ]);
  check(out.length === 5, "no entity is dropped");
  check(out[0].type === "FR_NIR", "good NIR keeps its type");
  check(out[1].type === "FR_NIR_A_VERIFIER", "wrong NIR becomes FR_NIR_A_VERIFIER");
  check(out[2].type === "IBAN_A_VERIFIER", "wrong IBAN becomes IBAN_A_VERIFIER");
  check(out[3].type === "SIRET_A_VERIFIER", "wrong SIRET becomes SIRET_A_VERIFIER");
  check(out[4].type === "SIREN_A_VERIFIER", "wrong SIREN becomes SIREN_A_VERIFIER");
}
// Only our own rules are held to the Luhn: another 9-digit ID_DOC is left alone
check(verifyFrenchKey(ent("123456789", "ID_DOC", "pattern:some_other_rule")), "foreign ID_DOC of 9 digits not checked");
check(!verifyFrenchKey(ent("123456789", "ID_DOC", "pattern:fr_siren")), "ID_DOC from fr_siren is checked");
check(verifyFrenchKey(ent("DE89 3704 0044 0532 0130 00", "IBAN_CODE")), "non-French IBAN not checked");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
