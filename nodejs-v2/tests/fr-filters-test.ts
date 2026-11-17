/**
 * Tests for the French filters in fr-filters.ts.
 * Run: npx tsx tests/fr-filters-test.ts
 */

import {
  stripCivility, dropLoneWords, dropLowercasePersons, dropCaseReference, fixSplitName, dropArticleOrg,
  dropNonIdentifiers, dropTerritoryInOrg, dropBareInstitution, applyFrenchPriority, assignOrgSubtype, assignPersonRole,
  mergeContiguousAddresses, samePersonFamily, sameInstitutionFamily, normalizePhoneOrDate, propagateSessionPersons,
} from "../src/engine/fr-filters.js";
import { assignPlaceholders, withMerges, createPlaceholderState } from "../src/engine/entity-dedup.js";
import type { DetectedEntity } from "../src/engine/pattern-recognizers.js";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ok  ${msg}`); passed++; }
  else      { console.log(`  FAIL ${msg}`); failed++; }
}

/** Entity for `text` found in `doc`. */
function ent(text: string, type: string, doc: string, reason = "test"): DetectedEntity {
  const start = doc.indexOf(text);
  if (start < 0) throw new Error(`"${text}" not in "${doc}"`);
  return { text, type, start, end: start + text.length, score: 0.9, verified: false, reason };
}

// ── Civility, lone words, lowercase persons ─────────────────────────────────
{
  const doc = "Mme Claire Durand a signé.";
  const out = stripCivility([ent("Mme Claire Durand", "PERSON", doc)]);
  check(out[0].text === "Claire Durand" && out[0].start === 4, "civility stripped, start moved");
}
check(dropLoneWords([ent("Mme", "PERSON", "Mme"), ent("le client", "PERSON", "le client"), ent("Mme Durand", "PERSON", "Mme Durand")]).length === 1, "lone civility and role dropped, a real name kept");
{
  const doc = "Le contrat est signé par Jean Exemplaire. Signé ensuite.";
  const out = dropLowercasePersons(doc, [ent("signé", "PERSON", doc), ent("Jean Exemplaire", "PERSON", doc)]);
  check(out.length === 1 && out[0].text === "Jean Exemplaire", "person without a capital dropped in a normally cased text");
}

// ── References, split names, articles ───────────────────────────────────────
{
  const doc = "Dossier n° 2026-0042 ouvert.";
  check(dropCaseReference(doc, [ent("2026-0042", "ID_DOC", doc, "pattern:reg_number")]).length === 0, "year-number case reference dropped");
  const doc2 = "Contrat 2026-0042 ouvert.";
  check(dropCaseReference(doc2, [ent("2026-0042", "ID_DOC", doc2, "pattern:reg_number")]).length === 1, "same number without 'dossier' kept");
}
{
  const doc = "Laure Le Goff est cliente.";
  const out = fixSplitName(doc, [ent("Laure Le", "PERSON", doc)]);
  check(out[0].text === "Laure Le Goff", "name split after a particle is joined");
  const doc2 = "Anne-Laure Roussel.";
  const out2 = fixSplitName(doc2, [ent("Anne-", "PERSON", doc2)]);
  check(out2[0].text === "Anne-Laure Roussel", "hyphenated first name is joined");
}
check(dropArticleOrg([ent("Le dossier est", "ORGANIZATION", "Le dossier est"), ent("La Poste", "ORGANIZATION", "La Poste")]).length === 1, "article + lowercase org dropped, La Poste kept");

// ── Non-identifiers, territory in an organization, bare institutions ────────
check(dropNonIdentifiers([ent("adresse", "LOCATION", "votre adresse"), ent("France Travail", "ORGANIZATION", "France Travail"), ent("Lille", "VILLE", "Lille")]).length === 1, "common word and France Travail dropped, a city kept");
{
  const doc = "SARL Atelier Fictif Nord";
  const out = dropTerritoryInOrg([ent("SARL Atelier Fictif Nord", "ORGANIZATION", doc), ent("Nord", "DEPARTEMENT", doc)]);
  check(out.length === 1 && out[0].type === "ORGANIZATION", "department inside an organization name dropped");
}
check(dropBareInstitution([ent("la Mairie", "ORGANIZATION", "la Mairie")]).length === 1, "'la Mairie' (article) is not bare per the original regex: kept");
check(dropBareInstitution([ent("Mairie", "ORGANIZATION", "Mairie"), ent("Mairie de Caen", "ORGANIZATION", "Mairie de Caen")]).length === 1, "bare 'Mairie' dropped, 'Mairie de Caen' kept");

// ── Priority of the French rules ────────────────────────────────────────────
{
  const doc = "Mme Claire Durand";
  const fr = ent("Claire Durand", "PERSON", doc, "pattern:fr_nom_civilite");
  const model = ent("Mme Claire Durand", "PERSON", doc, "ner:gliner:person");
  const out = applyFrenchPriority(doc, [fr, model]);
  check(out.length === 1 && out[0].reason === "pattern:fr_nom_civilite", "a model detection overlapping a French rule is dropped");
  process.env.PII_FR_PRIORITE = "0";
  check(applyFrenchPriority(doc, [fr, model]).length === 2, "PII_FR_PRIORITE=0: original behaviour");
  delete process.env.PII_FR_PRIORITE;
}
{
  const doc = "Office notarial Lenoir";
  const trade = ent("Office notarial Lenoir", "ORGANIZATION", doc, "pattern:fr_tbl_org_etude_notariale");
  const inner = { ...ent("Lenoir", "ORGANIZATION", doc, "ner:gliner:company") };
  check(applyFrenchPriority(doc, [trade, inner]).length === 1, "an organization contained in a trade-type organization is dropped");
}

// ── Sub-types ───────────────────────────────────────────────────────────────
{
  const doc = "Cabinet d'avocats Exemple et Crédit Agricole Nord-Est et Atelier Fictif SARL";
  const out = assignOrgSubtype(doc, [
    ent("Cabinet d'avocats Exemple", "ORGANIZATION", doc), ent("Crédit Agricole Nord-Est", "ORGANIZATION", doc), ent("Atelier Fictif SARL", "ORGANIZATION", doc),
  ]);
  check(out[0].type === "ORG_CABINET_AVOCATS", "lawyers' office sub-type");
  check(out[1].type === "ORG_BANQUE", "bank sub-type");
  check(out[2].type === "ORG_SARL", "SARL sub-type");
}
{
  const doc = "Maître Paul Dubois a plaidé. Paul Dubois a conclu. Le notaire Jean Durand.";
  const out = assignPersonRole(doc, [
    { ...ent("Paul Dubois", "PERSON", doc) }, { ...ent("Paul Dubois", "PERSON", doc.replace("Maître ", "")) , start: doc.lastIndexOf("Paul Dubois"), end: doc.lastIndexOf("Paul Dubois") + 11 },
    ent("Jean Durand", "PERSON", doc),
  ]);
  check(out[0].type === "PERSON_AVOCAT" && out[1].type === "PERSON_AVOCAT", "the role belongs to the person: every occurrence of the name");
  check(out[2].type === "PERSON_NOTAIRE", "notary role");
}

// ── Contiguous addresses ────────────────────────────────────────────────────
{
  const doc = "14 impasse des Acacias\n69003 Lyon";
  const a = ent("14 impasse des Acacias", "ADRESSE", doc), b = ent("69003 Lyon", "ADRESSE", doc);
  const out = mergeContiguousAddresses(doc, [a, b]);
  check(out.length === 1 && out[0].text === doc, "two addresses separated by a line break are merged");
  const out2 = mergeContiguousAddresses("14 impasse des Acacias, puis 69003 Lyon", [ent("14 impasse des Acacias", "ADRESSE", "14 impasse des Acacias, puis 69003 Lyon"), ent("69003 Lyon", "ADRESSE", "14 impasse des Acacias, puis 69003 Lyon")]);
  check(out2.length === 2, "addresses separated by text stay apart");
}

// ── Families and normalization ──────────────────────────────────────────────
check(samePersonFamily("PERSON", "j. exemplaire", "jean exemplaire"), "initial and first name: same person");
check(samePersonFamily("PERSON", "exemplaire", "jean exemplaire"), "family name alone: same person");
check(!samePersonFamily("PERSON", "pierre exemplaire", "jean exemplaire"), "two different first names: not the same person");
check(sameInstitutionFamily("ORG_HOPITAL_CHU", "chu de tours", "centre hospitalier universitaire de tours"), "CHU acronym and full form: same institution");
check(!sameInstitutionFamily("ORG_HOPITAL_CHU", "chu de tours", "chu de lille"), "same acronym, different city: not the same");
check(normalizePhoneOrDate("+33 6 12 34 56 78") === "0612345678" && normalizePhoneOrDate("06 12 34 56 78") === "0612345678", "phone numbers share one key");
check(normalizePhoneOrDate("15/01/1985") === normalizePhoneOrDate("15 janvier 1985"), "dates share one key");
check(normalizePhoneOrDate("3 mars 2026") === normalizePhoneOrDate("03/03/2026") && normalizePhoneOrDate("03.03.2026") === normalizePhoneOrDate("3 mars 2026"), "dates: month name, slashes and dots share one key");
check(normalizePhoneOrDate("12 février 2026") === normalizePhoneOrDate("12/02/2026") && normalizePhoneOrDate("1er août 2026") === normalizePhoneOrDate("01/08/2026") && normalizePhoneOrDate("5 décembre 2026") === normalizePhoneOrDate("5/12/2026"), "dates: accented month names and 1er");
check(normalizePhoneOrDate("3 mars 2026") !== normalizePhoneOrDate("4 mars 2026") && normalizePhoneOrDate("13/13/2026") === null, "dates: different days stay apart, invalid month is not a date");
check(normalizePhoneOrDate("Atelier Fictif") === null, "other text is left to the normal normalization");

// ── Merges chosen in the review panel: the merged text takes the marker of its target ──
{
  const doc = "Jean Martin a signé. Plus tard, J. Martin et Pierre Durand.";
  const ents = [ent("Jean Martin", "PERSON", doc), ent("Pierre Durand", "PERSON", doc)];
  const plain = assignPlaceholders(ents, "");
  const merged = withMerges([{ type: "PERSON", from: "Pierre Durand", to: "Jean Martin" }], () => assignPlaceholders(ents, ""));
  check(plain.entities[0].placeholder !== plain.entities[1].placeholder, "without a merge, two persons get two markers");
  check(merged.entities[0].placeholder === merged.entities[1].placeholder, "with a merge, both texts share one marker");
}

// ── Persons already marked in the session are found in another document ──
{
  const first = assignPlaceholders([ent("Paul Dupont", "PERSON", "Paul Dupont signe.")], "");
  const state = createPlaceholderState();
  assignPlaceholders([ent("Paul Dupont", "PERSON", "Paul Dupont signe.")], "", state);
  const next = "Contrat. Paul Dupont est présent, Pauline aussi.";
  const out = propagateSessionPersons(next, [], state);
  check(first.entities.length === 1 && out.length === 1 && out[0].text === "Paul Dupont", "known person found in a second document");
  check(propagateSessionPersons(next, [ent("Paul Dupont", "PERSON", next)], state).length === 1, "no duplicate when the model already found it");
  check(propagateSessionPersons(next, [], undefined).length === 0, "no session state: nothing added");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
