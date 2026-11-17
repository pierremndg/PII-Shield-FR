/**
 * French detection rules built from data: cities, regions, departments, and one rule per organization
 * sub-type (generated from the sub-type table, so the table stays the single source).
 * Ported from the FR patch (patch-pii-shield.mjs: VILLES_CONNUES, TERRITOIRES, REGLES_TABLE).
 */

import type { FrRecognizer } from "./fr-recognizers.js";
import { SOUS_TYPE_REGLES, FORMES_AVANT_NOM } from "./fr-subtypes.js";
import villes from "./fr-villes.json";
import territoires from "./fr-territoires.json";

const esc = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Communes of more than 2,000 inhabitants (fr-villes.json), without the names that are also common words.
const VILLES_CONNUES: string[] = villes as string[];
const TERRITOIRES = territoires as { regions: string[]; departements: string[] };

export function buildFrenchTerritoryRules(): FrRecognizer[] {
  return [
    {
      // A known city: a large French commune, whole words, with a capital.
      // Not after "Tribunal judiciaire de": the court name is not a person's address.
      // Not after a postal code: in a full address, the address rule masks the city.
      // Not inside an organization name ("paroisse Saint-Martin", "Cabinet …"): the organization masks it.
      entityType: "VILLE",
      patterns: [{
        name: "fr_ville",
        regex: new RegExp(String.raw`(?<!(?:paroisse|église|école|lycée|collège|hôpital|clinique|centre|cabinet|association|syndicat|mairie|société|SARL|SAS|SA|Tribunal|Cour|Université|Institut|Préfecture|Chambre|Ordre|Commune|Maison|Paroisse|Église|École|Clinique|Centre|Cabinet|Association|Syndicat|Mairie|Société|Hôpital|Institut|Université|Chambre|Ordre|Collège|Lycée|Préfecture|Commune)(?:\s+[\p{L}'’-]+){0,3}\s+)(?<!(?:Tribunal|Cour)(?:\s+[\p{L}]+){0,4}\s+de\s+)(?<!\d{5}[ \t]+)(?<![\p{L}\p{N}-])(?:${VILLES_CONNUES.map(esc).join("|")})(?![\p{L}\p{N}-])(?!\s+(?:Conseil|Services|Groupe|Associés|Consulting|Expertise|Immobilier|Finance|Assurances|Solutions|Technologies|Holding|Industries|Transports|Construction|Architecture|Avocats|Notaires|SARL|SAS|SASU|SA|SCI|EURL|SELARL))`, "gu"),
        score: 0.85,
      }],
      context: ["adresse", "domicile", "né à", "née à", "demeurant", "siège", "fait à", "à"],
    },
    {
      // Region: official name (Bretagne, Auvergne-Rhône-Alpes…), whole words, with a capital.
      entityType: "REGION",
      patterns: [{
        name: "fr_region",
        regex: new RegExp(String.raw`(?<![\p{L}\p{N}-])(?:${TERRITOIRES.regions.map(esc).join("|")})(?![\p{L}\p{N}-])`, "gu"),
        score: 0.85,
      }],
      context: ["région", "dans la", "en", "située", "domicilié", "siège"],
    },
    {
      // Department: official name (Rhône, Haute-Savoie, Corse-du-Sud…). Not inside a region name ("Pays de la Loire").
      entityType: "DEPARTEMENT",
      patterns: [{
        name: "fr_departement",
        regex: new RegExp(String.raw`(?<!Pays de la |Val de )(?<![\p{L}\p{N}-])(?:${TERRITOIRES.departements.map(esc).join("|")})(?![\p{L}\p{N}-])`, "gu"),
        score: 0.85,
      }],
      context: ["département", "dans le", "dans la", "domicilié", "siège", "Préfecture"],
    },
  ];
}

// ── One rule per organization sub-type ──────────────────────────────────────

// Organization name: 1 to 7 capitalized words, with particles (de, du, la, d'…) between them. Capital required, no i flag.
export const NOM_SRC = String.raw`(?:(?:la|le|les|pour|de|du|des|et|&)[ \t]+|(?:l|d)['’])*[\p{Lu}][\p{L}'’&-]*(?:[ \t]+(?:(?:la|le|les|pour|de|du|des|et|&)[ \t]+|(?:l|d)['’])*[\p{Lu}][\p{L}'’&-]*){0,6}`;
const CONNECTEUR_SRC = String.raw`(?:(?:[ \t]+|(?<=['’]))(?:de|du|des|pour|la|le|les|d|l|entreprise|soci[ée]t[ée]|[ée]tablissement|groupe|site|copropri[ée]taires)(?!\p{L})|['’])*[ \t]*`;
const NEG_COMMERCE_SRC = String.raw`(?!\s*(?:de|du|des|la|le)\s+(?:Ville|Ventes|Dieu|Justice|France|Paix|Paris|Scolaire)(?!\p{L}))`;
const NEG_COMMERCE_NOMS = ["ORG_BANQUE", "ORG_HOTEL", "ORG_GARAGE", "ORG_RESTAURANT", "ORG_BRASSERIE", "ORG_PIZZERIA", "ORG_BOULANGERIE", "ORG_BOUCHERIE", "ORG_ETABLISSEMENTS", "ORG_MUTUELLE", "ORG_HOLDING"];
// Bank and insurance brands have their own rule (fr_marque_bancaire).
const MARQUE_SRC_RE = /Cr\[ée\]dit|BNP|Boursorama|MAIF|MACIF|Groupama|Banque Populaire|Caisse d|Soci\[ée\]t\[ée\] G|AXA|MAAF|MGEN|Allianz|Generali|Malakoff|Harmonie|LCL|La Banque Postale/;
// Legal-form lines before the name give the sub-type without generating a rule (see fr_forme_prefixe).
const FORMES_PREFIXE = FORMES_AVANT_NOM.map((f) => "^" + f + "[ \\t]");

export function buildFrenchTableRules(): FrRecognizer[] {
  return SOUS_TYPE_REGLES
    .filter(([, src]) => src.startsWith("^") && !MARQUE_SRC_RE.test(src) && !FORMES_PREFIXE.includes(src))
    .map(([nom, src]) => ({
      entityType: "ORGANIZATION",
      patterns: [{
        name: "fr_tbl_" + nom.toLowerCase(),
        regex: new RegExp("(?<!\\p{L})" + src.slice(1) + (NEG_COMMERCE_NOMS.includes(nom) ? NEG_COMMERCE_SRC : "") + CONNECTEUR_SRC + NOM_SRC, "gu"),
        score: 0.7,
      }],
      context: [],
    }));
}
