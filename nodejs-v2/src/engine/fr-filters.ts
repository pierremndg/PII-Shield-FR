/**
 * French post-detection filters and corrections.
 * Ported from the FR patch (src/patch/fonctions.mjs and patch-pii-shield.mjs).
 * Each function takes entities and returns entities; pii-engine.ts calls them in the same
 * order as the patch did. Tested in tests/fr-filters-test.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DetectedEntity } from "./pattern-recognizers.js";
import { SOUS_TYPE_REGLES } from "./fr-subtypes.js";

type Ents = DetectedEntity[];

// ── Institutions ────────────────────────────────────────────────────────────

// Institutions named without their own name or place ("la mairie", "le tribunal", "France Travail" alone) identify nobody.
export const INSTITUTIONS_NUES = String.raw`^(?:[Mm]airie|[Pp]réfecture|[Mm]inistère|[Tt]résor [Pp]ublic|[Tt]ribunal|[Cc]our|[Cc]onseil (?:départemental|régional)|C\.?H\.?U\.?|CPAM|URSSAF|CAF|CROUS|France Travail|Pôle emploi)$`;

// Same institution cited by its acronym or its full form: [acronym, full form] pairs.
export const FORMES_INSTITUTION: Array<[string, string]> = [
  [String.raw`C\.?H\.?U\.?`, String.raw`Centre hospitalier universitaire`],
  [String.raw`CPAM`, String.raw`Caisse primaire d['’]assurance maladie`],
];

const INSTITUTIONS_NUES_RE = new RegExp(INSTITUTIONS_NUES, "u");

/** A bare institution ("France Travail", "la Mairie", "le CHU") identifies nobody: not masked. "Mairie de Caen" stays. */
export function dropBareInstitution(entities: Ents): Ents {
  return entities.filter((e) => !(e.type === "ORGANIZATION" && INSTITUTIONS_NUES_RE.test(e.text.trim())));
}

// ── Model output corrections (before the merge with patterns) ───────────────

const CIVILITY_RE = /^(?:M|Mme|Mlle|Mr)\.?\s+/i;

/** The civility (M., Mme, Mlle, Mr) is removed from a PERSON: it only helps to find the name, only the name is masked. */
export function stripCivility(entities: Ents): Ents {
  return entities.map((e) => {
    if (e.type !== "PERSON") return e;
    const m = e.text.match(CIVILITY_RE);
    return m ? { ...e, start: e.start + m[0].length, text: e.text.replace(CIVILITY_RE, "") } : e;
  });
}

export const LONE_WORDS_RE = /^(?:M|Mme|Mlle|Mr|Monsieur|Madame)\.?$|^(?:(?:le|la|les|un|une)\s+)?(?:client|cliente|témoin|demandeur|demanderesse|défendeur|défenderesse|patient|patiente)$/i;

/** A civility alone ("Mme") or a role alone ("le client", "témoin") is not a name, though the model takes it for one. */
export function dropLoneWords(entities: Ents): Ents {
  return entities.filter((e) => e.type !== "PERSON" || !LONE_WORDS_RE.test(e.text.trim()));
}

/**
 * PERSON without any capital ("a", "signé"): a proper noun has one. Filter applied only if the document is normally
 * cased (at least 1 % capitals); "article + lowercase word" ("Le contrat") is always removed; an all-lowercase text keeps the
 * model's detections.
 */
export function dropLowercasePersons(text: string, entities: Ents): Ents {
  let out = entities;
  if ((text.match(/[A-ZÀ-ÖØ-Þ]/g) || []).length >= text.length * 0.01) {
    out = out.filter((e) => e.type !== "PERSON" || /[A-ZÀ-ÖØ-Þ]/.test(e.text));
  }
  return out.filter((e) => e.type !== "PERSON" || !/^(?:Les?|La|Une?|Des|L['’])\s?[a-zà-ÿ]/.test(e.text));
}

// ── After the merge ─────────────────────────────────────────────────────────

/** A year-number case reference after "dossier", "affaire", "réf.", "n°" is not personal data. */
export function dropCaseReference(text: string, entities: Ents): Ents {
  return entities.filter((e) => {
    if (e.reason !== "pattern:reg_number" || !/^(?:19|20)\d{2}-\d{1,6}$/.test(String(e.text || ""))) return true;
    const before = text.slice(Math.max(0, e.start - 30), e.start);
    return !/(?:dossier|affaire|réf(?:érence)?\.?|n°)\s*(?:n°|no\.?)?\s*:?\s*$/i.test(before);
  });
}

/** Name split after a particle ("Laure Le" + "Goff") or after a hyphen ("Anne-" + "Laure Roussel"): joined again. */
export function fixSplitName(text: string, entities: Ents): Ents {
  return entities.map((e) => {
    if (e.type !== "PERSON") return e;
    if (/(?:^|\s)(?:le|la|les|de|du|des|d['’]|van|von)$/i.test(e.text)) {
      const next = text.slice(e.end).match(/^ (\p{Lu}[\p{L}'’-]*)/u);
      return next ? { ...e, text: `${e.text} ${next[1]}`, end: e.end + 1 + next[1].length } : e;
    }
    if (/-$/.test(e.text)) {
      const next = text.slice(e.end).match(/^(\p{Lu}[\p{Ll}']+(?:\s+\p{Lu}[\p{Ll}']+)?)/u);
      return next ? { ...e, text: `${e.text}${next[1]}`, end: e.end + next[1].length } : e;
    }
    return e;
  });
}

/** Organization starting with an article followed by a lowercase word ("Le dossier est") is not a name ("La Poste" stays). */
export function dropArticleOrg(entities: Ents): Ents {
  return entities.filter((e) => !(e.type === "ORGANIZATION" && /^(?:Le|La|Les|Un|Une)\s+\p{Ll}|^L['’]\p{Ll}/u.test(e.text)));
}

/** Words that name nothing (a common word detected as a place) and "France Travail" (not masked). */
export function dropNonIdentifiers(entities: Ents): Ents {
  const commonWords = /^(?:adresse|domicile|siège|siege|ville|lieu|commune|pays|région|département)$/i;
  return entities.filter((e) => {
    if (["LOCATION", "VILLE", "ADRESSE", "REGION", "DEPARTEMENT"].includes(e.type) && commonWords.test(e.text.trim())) return false;
    if (e.type === "ORGANIZATION" && /^(?:France Travail|Pôle emploi)(?!\p{L})/u.test(e.text.trim())) return false;
    return true;
  });
}

/** A department, region or city inside an organization name is part of the name ("SARL Atelier Fictif Nord"). */
export function dropTerritoryInOrg(entities: Ents): Ents {
  const orgs = entities.filter((e) => e.type === "ORGANIZATION");
  return entities.filter((e) => !(["DEPARTEMENT", "REGION", "VILLE"].includes(e.type) && orgs.some((o) => o !== e && e.start >= o.start && e.end <= o.end)));
}

/**
 * Priority to the French rules (pattern:fr_*): a model detection that overlaps one is dropped.
 * A trade-type organization (table rule, "Office notarial X") that contains another organization wins over the legal form.
 * Switch: PII_FR_PRIORITE=0 gives back the original behaviour.
 */
export function applyFrenchPriority(text: string, results: Ents): Ents {
  if (process.env.PII_FR_PRIORITE === "0") return results;
  const isFr = (e: DetectedEntity) => String(e.reason || "").startsWith("pattern:fr_");
  const fr = results.filter(isFr);
  if (!fr.length) return results;
  const trade = fr.filter((f) => String(f.reason).startsWith("pattern:fr_tbl_"));
  // No link word between the two ("et la", "&"): else two organizations would be merged.
  // Two table rules on the same span ("CHU de Rennes": CHU and hospital) do not contain each other: else both would be dropped.
  const contained = (e: DetectedEntity) => e.type === "ORGANIZATION" && trade.some((m) => m !== e && !(m.start === e.start && m.end === e.end) && m.start <= e.start && e.end === m.end && !/\s(?:et|la|le|les|&)\s/i.test(text.slice(m.start, e.start)));
  return results.filter((e) => !contained(e) && (isFr(e) || !fr.some((f) => e.start < f.end && f.start < e.end)));
}

/**
 * Diagnostic journal: create the file ~/.pii_shield/fr-debug.on and the detections before and after the
 * French priority are appended to ~/.pii_shield/fr-debug.jsonl (one JSON line per step). Nothing happens otherwise.
 */
export function debugFR(step: string, results: Ents): void {
  try {
    const dir = path.join(os.homedir(), ".pii_shield");
    if (!fs.existsSync(path.join(dir, "fr-debug.on"))) return;
    const line = JSON.stringify({ etape: step, entites: results.map((e) => [e.type, e.text, e.start, e.end, e.score, e.reason]) });
    fs.appendFileSync(path.join(dir, "fr-debug.jsonl"), line + "\n");
  } catch { /* diagnostic only, never blocks detection */ }
}

// ── Sub-types ───────────────────────────────────────────────────────────────

/** Organization sub-type from the ordered table (bank, clinic, notary office…). The first match wins; "company" is the fallback. */
export function assignOrgSubtype(text: string, entities: Ents): Ents {
  return entities.map((e) => {
    if (e.type !== "ORGANIZATION") return e;
    let type = "ORGANIZATION";
    let generic: string | null = null;
    for (const [name, src] of SOUS_TYPE_REGLES) {
      if (!new RegExp(src, "u").test(e.text)) continue;
      if (name === "ORG_SOCIETE") { generic = generic || name; continue; }
      type = name; break;
    }
    if (type === "ORGANIZATION" && generic) type = generic;
    if (type === "ORG_SA") {
      const next = text.slice(e.end).match(/^\s+(à conseil d['’]administration|à directoire)/u);
      if (next) type = /directoire/.test(next[1]) ? "ORG_SA_DIRECTOIRE" : "ORG_SA_CA";
    }
    return type === e.type ? e : { ...e, type };
  });
}

/**
 * Role of a person from the title or profession before the name ("Maître", "notaire"…). Procedure roles (client, witness…)
 * are not used. The role belongs to the person, not to one occurrence: every occurrence of the same name gets it.
 */
export function assignPersonRole(text: string, entities: Ents): Ents {
  const roles: Array<[string, RegExp]> = [
    ["PERSON_AVOCAT", /(?:^|[^\p{L}])(?:Maître|Maitre|Me|Mes)\s+$/u],
    ["PERSON_NOTAIRE", /(?:^|[^\p{L}])notaire\s+$/iu],
    ["PERSON_HUISSIER", /(?:^|[^\p{L}])huissier(?:\s+de justice)?\s+$/iu],
    ["PERSON_MAGISTRAT", /(?:^|[^\p{L}])(?:juge|procureur|procureure|greffier|greffière|magistrat)\s+$/iu],
    ["PERSON_MEDECIN", /(?:^|[^\p{L}])(?:Dr|Docteur|Pr|Professeur)\.?\s+$/u],
    ["PERSON_INFIRMIER", /(?:^|[^\p{L}])infirmi(?:er|ère)\s+$/iu],
  ];
  const key = (t: string) => String(t).toLowerCase().replace(/\s+/g, " ").trim();
  const roleOfName = new Map<string, string>();
  for (const e of entities) {
    if (e.type !== "PERSON") continue;
    // A civility between the role and the name ("Demandeur : Madame X") does not count.
    const before = text.slice(Math.max(0, e.start - 40), e.start).replace(/(?:Madame|Monsieur|Mme|Mlle|M\.)\s*$/u, "");
    const role = roles.find(([, re]) => re.test(before));
    if (role && !roleOfName.has(key(e.text))) roleOfName.set(key(e.text), role[0]);
  }
  return entities.map((e) => {
    if (e.type !== "PERSON") return e;
    const role = roleOfName.get(key(e.text));
    return role ? { ...e, type: role } : e;
  });
}

// ── Final steps ─────────────────────────────────────────────────────────────

/** Two addresses separated only by a line break (street, then postal code and city) form one address. */
export function mergeContiguousAddresses(text: string, entities: Ents): Ents {
  const sorted = [...entities].sort((a, b) => a.start - b.start);
  const out: Ents = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && last.type === "ADRESSE" && e.type === "ADRESSE" && /^[ \t]*\n[ \t]*$/.test(text.slice(last.end, e.start))) {
      out[out.length - 1] = { ...last, text: text.slice(last.start, e.end), end: e.end };
    } else {
      out.push(e);
    }
  }
  return out;
}

/**
 * Persons already marked in another document of the session are searched, as written, in this one, with their placeholder.
 * The engine only propagated inside one document, so "Paul Dupont" went unnoticed when the model missed him.
 * Text detected by the model keeps priority (no overlap).
 */
export function propagateSessionPersons(
  text: string,
  entities: Ents,
  state?: { seenExact: Map<string, string>; mapping: Record<string, string> },
): Ents {
  if (!state || !state.seenExact || !state.mapping) return entities;
  const added: Ents = [];
  for (const [key, ph] of state.seenExact) {
    if (key.indexOf("PERSON::") !== 0) continue;
    const raw = String(state.mapping[ph] || "").trim();
    if (raw.length < 4) continue;
    const re = new RegExp("(?<![\\p{L}\\p{N}])" + raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\p{L}\\p{N}])", "gu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const overlaps = (x: DetectedEntity) => x.start < end && x.end > start;
      if (entities.some(overlaps) || added.some(overlaps)) continue;
      added.push({ text: m[0], type: "PERSON", start, end, score: 0.9, verified: true, reason: "session" });
    }
  }
  return added.length ? entities.concat(added) : entities;
}

// ── Placeholder families (used by entity-dedup.ts) ──────────────────────────

/**
 * Same person written with an initial or the family name alone ("J. Exemplaire", "Exemplaire", "Jean Exemplaire"):
 * same family name; if both have a first name, it must be the same or one must be a compatible initial.
 */
export function samePersonFamily(etype: string, a: string, b: string): boolean {
  if (etype !== "PERSON" || a === b) return false;
  const ta = a.split(" "), tb = b.split(" ");
  const last = (t: string[]) => t[t.length - 1].replace(/\.$/, "");
  if (last(ta) !== last(tb) || last(ta).length < 3) return false;
  if (ta.length === 1 || tb.length === 1) return true;
  const pa = ta[0].replace(/\.$/, ""), pb = tb[0].replace(/\.$/, "");
  if (pa.length === 1 || pb.length === 1) return pa[0] === pb[0];
  return pa === pb;
}

/** Same institution cited by its acronym and by its full form, at the same place ("CHU de Tours", "Centre hospitalier universitaire de Tours"). */
export function sameInstitutionFamily(etype: string, a: string, b: string): boolean {
  if (!etype.startsWith("ORG_") || a === b) return false;
  const rest = (t: string): [number, string] | null => {
    for (let i = 0; i < FORMES_INSTITUTION.length; i++) {
      const [acronym, full] = FORMES_INSTITUTION[i];
      const m = t.match(new RegExp("^(?:" + acronym + "|" + full + ")(?!\\p{L})", "iu"));
      if (m) return [i, t.slice(m[0].length).toLowerCase().replace(/’/g, "'")];
    }
    return null;
  };
  const ra = rest(a), rb = rest(b);
  return ra !== null && rb !== null && ra[0] === rb[0] && ra[1].trim() !== "" && ra[1] === rb[1];
}

// Moved to fr-normalize.ts (no Node imports) so the review panel can use the same rule.
export { normalizePhoneOrDate } from "./fr-normalize.js";
