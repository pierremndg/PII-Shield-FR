/**
 * French identifier recognizers and control-key checks.
 * Ported from the FR patch (patch-pii-shield.mjs: IDENTIFIANTS, verifierCleFR).
 *
 * - buildFrenchRecognizers(): regex rules for SIRET, SIREN, FINESS, RPPS,
 *   phone, IBAN, licence plate and RIB. Same shape as the other recognizers
 *   (name, regex, score, context words that add +0.35).
 * - verifyFrenchKey(): checks the control key (NIR, IBAN FR, RIB, bank card
 *   Luhn, FR VAT, SIRET/SIREN Luhn).
 * - flagWrongFrenchKeys(): a candidate with a wrong key is kept but retyped
 *   to *_A_VERIFIER, never silently dropped.
 *
 * Types only are imported from pattern-recognizers (no runtime cycle).
 */

import type { DetectedEntity } from "./pattern-recognizers.js";
import { buildFrenchNameRules } from "./fr-rules.js";
import { buildFrenchTerritoryRules, buildFrenchTableRules } from "./fr-rules-data.js";

interface FrPattern { name: string; regex: RegExp; score: number }
export interface FrRecognizer { entityType: string; patterns: FrPattern[]; context: string[] }

/** All French rules: identifiers, names/organizations/addresses, territories, one rule per organization sub-type. */
export function buildFrenchRecognizers(): FrRecognizer[] {
  return [
    ...buildFrenchIdentifierRules(),
    ...buildFrenchNameRules(),
    ...buildFrenchTerritoryRules(),
    ...buildFrenchTableRules(),
  ];
}

function buildFrenchIdentifierRules(): FrRecognizer[] {
  return [
    {
      entityType: "SIRET",
      patterns: [{ name: "fr_siret", regex: /\b\d{3}\s?\d{3}\s?\d{3}\s?\d{5}\b/g, score: 0.5 }],
      context: ["SIRET", "siret", "numéro d'identification", "établissement"],
    },
    {
      // A number preceded by "FINESS" is not a SIREN: same 9-digit shape, the FINESS rule takes it.
      entityType: "SIREN",
      patterns: [{ name: "fr_siren", regex: /(?<!\b(?:FINESS|finess)\s*(?:n°|:)?\s*)\b\d{3}\s?\d{3}\s?\d{3}\b/g, score: 0.35 }],
      context: ["SIREN", "siren", "RCS", "registre du commerce"],
    },
    {
      entityType: "MEDICAL_LICENSE",
      patterns: [{ name: "fr_finess", regex: /\b\d{9}\b/g, score: 0.35 }],
      context: ["FINESS", "finess", "établissement de santé"],
    },
    {
      entityType: "MEDICAL_LICENSE",
      patterns: [{ name: "fr_rpps", regex: /\b10\s?\d{9}\b/g, score: 0.5 }],
      context: ["RPPS", "rpps", "identifiant national", "praticien"],
    },
    {
      entityType: "PHONE_NUMBER",
      patterns: [{ name: "fr_telephone", regex: /(?:(?:\+|00\s?)33\s?\(?0?\)?|\b0)[1-9](?:[\s.\-]?\d{2}){4}\b/g, score: 0.6 }],
      context: ["téléphone", "telephone", "tél", "tel", "portable", "mobile", "fax", "contact"],
    },
    {
      entityType: "IBAN_CODE",
      patterns: [{ name: "fr_iban", regex: /\bFR\d{2}(?:\s?[0-9A-Z]{4}){5}\s?[0-9A-Z]{3}\b/g, score: 0.9 }],
      context: ["IBAN", "iban", "RIB", "virement"],
    },
    {
      entityType: "VEHICLE_PLATE",
      patterns: [{ name: "fr_plaque", regex: /\b[A-Z]{2}[\s-]?\d{3}[\s-]?[A-Z]{2}\b/g, score: 0.6 }],
      context: ["immatriculation", "plaque", "véhicule", "carte grise"],
    },
    {
      // RIB: 5 digits bank, 5 branch, 11 account, 2 key. Only near a word that names it.
      entityType: "BANK_ACCOUNT",
      patterns: [{ name: "fr_rib", regex: /\b\d{5}[ \t]?\d{5}[ \t]?[0-9A-Z]{11}[ \t]?\d{2}\b/g, score: 0.6 }],
      context: ["RIB", "rib", "relevé d'identité", "compte", "guichet"],
    },
  ];
}

// ── Control keys ────────────────────────────────────────────────────────────

export function nirValid(raw: string): boolean {
  const d = raw.toUpperCase();
  if (!/^[12]\d{2}(0[1-9]|1[0-2]|[2-4]\d)(\d{2}|2A|2B)\d{3}\d{3}\d{2}$/.test(d)) return false;
  const base = d.slice(0, 13).replace("2A", "19").replace("2B", "18");
  return 97 - (Number(base) % 97) === Number(d.slice(13));
}

export function ribValid(raw: string): boolean {
  const r = String(raw).toUpperCase();
  if (!/^\d{10}[0-9A-Z]{11}\d{2}$/.test(r)) return false;
  const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let rest = 0;
  for (let k = 0; k < 21; k++) {
    const c = r[k];
    const i = L.indexOf(c);
    const v = /\d/.test(c) ? +c : i < 18 ? (i % 9) + 1 : i - 16;
    rest = (rest * 10 + v) % 97;
  }
  return 97 - ((rest * 100) % 97) === +r.slice(21, 23);
}

export function frVatValid(raw: string): boolean {
  const key = +raw.slice(2, 4);
  const siren = +raw.slice(4);
  return (12 + 3 * (siren % 97)) % 97 === key;
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  const n = digits.length;
  for (let i = 0; i < n; i++) {
    let d = Number(digits[n - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export function siretValid(raw: string): boolean {
  // La Poste (SIREN 356000000): the SIRET does not follow Luhn, the sum of the 14 digits is a multiple of 5.
  if (raw.length === 14 && raw.startsWith("356000000")) {
    return [...raw].reduce((s, c) => s + Number(c), 0) % 5 === 0;
  }
  return luhnValid(raw);
}

export function ibanFrValid(raw: string): boolean {
  const r = raw.toUpperCase();
  if (!/^FR\d{2}[0-9A-Z]{23}$/.test(r)) return false;
  const num = (r.slice(4) + r.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const c of num) rest = (rest * 10 + Number(c)) % 97;
  return rest === 1;
}

/** True when the entity has no key to check, or its key is correct. */
export function verifyFrenchKey(e: DetectedEntity): boolean {
  const raw = String(e.text || "").replace(/\s/g, "");
  if (e.type === "FR_NIR") return nirValid(raw);
  if (e.type === "IBAN_CODE" && /^FR/i.test(raw)) return ibanFrValid(raw);
  if (e.type === "BANK_ACCOUNT") return ribValid(raw);
  if (e.type === "CREDIT_CARD" && /^\d{13,19}$/.test(raw)) return luhnValid(raw);
  if (e.type === "EU_VAT" && /^FR\d{11}$/.test(raw)) return frVatValid(raw);
  // Only our own SIRET/SIREN rules: another ID_DOC of 9 or 14 digits is not subject to Luhn.
  if ((e.type === "ID_DOC" || e.type === "SIRET" || e.type === "SIREN")
      && /^pattern:fr_si(?:ret|ren)$/.test(String(e.reason || ""))
      && /^\d+$/.test(raw) && (raw.length === 9 || raw.length === 14)) return siretValid(raw);
  return true;
}

/** Type given to a candidate whose key is wrong: kept (and masked) but flagged, never silently dropped. */
const WRONG_KEY_TYPE: Record<string, string> = {
  CREDIT_CARD: "CREDIT_CARD_A_VERIFIER",
  EU_VAT: "EU_VAT_A_VERIFIER",
  BANK_ACCOUNT: "BANK_ACCOUNT_A_VERIFIER",
  IBAN_CODE: "IBAN_A_VERIFIER",
  FR_NIR: "FR_NIR_A_VERIFIER",
  SIRET: "SIRET_A_VERIFIER",
  SIREN: "SIREN_A_VERIFIER",
};

export function flagWrongFrenchKeys(entities: DetectedEntity[]): DetectedEntity[] {
  return entities.map((e) => (verifyFrenchKey(e) ? e : { ...e, type: WRONG_KEY_TYPE[e.type] || "ID_A_VERIFIER" }));
}
