/**
 * French detection rules: organizations, people, addresses, birth dates.
 * Generated once from the FR patch (patch-pii-shield.mjs, REGLES) so that no regex is retyped by hand.
 * From now on this file is edited by hand. Ville / region / department rules and the table rules
 * (one per organization sub-type) are built in fr-rules-data.ts.
 */

import type { FrRecognizer } from "./fr-recognizers.js";

export function buildFrenchNameRules(): FrRecognizer[] {
  return [
    {
      entityType: "ORGANIZATION",
      patterns: [{ name: "fr_forme_prefixe", regex: new RegExp("(?<!\\p{L})(?:SARL|EURL|SAS|SASU|SCI|SELARL|SELAS|SELAFA|SELCA|SPFPL|SCP|SNC|SCS|SCA|SLP|SCCV|SCM|SCEA|EARL|GAEC|GIE|GEIE|GFA|CUMA|SICA|SCOP|SCIC|SCPI|SICAV|FCP|FCPR|FPCI|OPCI|ASL|AFU)[ \\t]+(?:[\\p{Lu}][\\p{L}'’&-]*(?:[ \\t]+(?:(?:de|du|des|la|le|les|et)[ \\t]+|d['’])?[\\p{Lu}][\\p{L}'’&-]*)+|[\\p{Lu}][\\p{L}'’&-]*(?=[ \\t]*(?:[,.;:)\\n]|$)))", "gu"), score: 0.7 }],
      context: ["société","SIREN","capital","gérant"],
    },
    {
      entityType: "ADRESSE",
      patterns: [{ name: "fr_adresse", regex: new RegExp("\\b\\d{1,4}(?:\\s?(?:bis|ter))?,?\\s+(?:rue|avenue|av\\.|boulevard|bd|place|chemin|allée|impasse|route|quai|cours)\\s+[^\\n,]+(?:[,\\n][ \\t]*\\d{5}[ \\t]+[^\\n,.]+)?", "gi"), score: 0.9 }],
      context: ["adresse","domicile","demeurant","siège","cabinet"],
    },
    {
      entityType: "PERSON",
      patterns: [{ name: "fr_nom_civilite", regex: new RegExp("(?<=\\b(?:M\\.|Mme|Mlle|Monsieur|Madame)\\s+)(?!(?:Tribunal|Cabinet|Cour|Société|Juge|Maison|Ministère|SAS|SARL|Le|La|Les|Maire|Président|Présidente|Directeur|Directrice|Ministre|Préfet|Bâtonnier|Procureur)(?!\\p{L}))[\\p{Lu}][\\p{L}'-]+(?:\\s+[\\p{Lu}][\\p{L}'-]+)?", "gu"), score: 0.6 }],
      context: ["M.","Mme","Monsieur","Madame","client","concernant"],
    },
    {
      entityType: "PERSON",
      patterns: [{ name: "fr_nom_indice", regex: new RegExp("(?<=\\b(?:client|cliente|demandeur|demanderesse|défendeur|défenderesse|témoin)\\s*,?\\s+)(?!(?:Fictif|Exemple|Société|SAS|SARL|Métropole|Nantes)(?!\\p{L}))[\\p{Lu}][\\p{L}'-]+(?:\\s+[\\p{Lu}][\\p{L}'-]+)?", "gu"), score: 0.6 }],
      context: ["client","demandeur","défendeur","témoin"],
    },
    {
      entityType: "LOCATION",
      patterns: [{ name: "fr_lieu_naissance", regex: new RegExp("(?<=\\b(?:[Nn]ée?\\s+le|naissance)[^\\n\\d]{0,30}?(?:\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{4}|\\d{1,2}(?:er)?\\s+(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\\s+\\d{4}),?\\s+à\\s+)[\\p{Lu}][\\p{L}'-]+(?:\\s[\\p{Lu}][\\p{L}'-]+)*", "gu"), score: 0.6 }],
      context: ["né","née","naissance"],
    },
    {
      entityType: "PERSON",
      patterns: [{ name: "fr_nom_magistrat", regex: new RegExp("(?<=\\b(?:M\\.|Mme|Monsieur|Madame)\\s+(?:le|la)\\s+(?:juge|procureur|présidente?|greffière?)\\s+)[\\p{Lu}][\\p{L}'-]+(?:\\s+[\\p{Lu}][\\p{L}'-]+)?", "gu"), score: 0.6 }],
      context: ["juge","procureur","tribunal"],
    },
    {
      entityType: "PERSON",
      patterns: [{ name: "fr_initiale_nom", regex: new RegExp("(?<!\\p{L})(?!M\\.)\\p{Lu}\\.\\s+(?!(?:Tribunal|Cabinet|Cour|Société|Paris)(?!\\p{L}))[\\p{Lu}][\\p{L}'-]+", "gu"), score: 0.6 }],
      context: ["M.","Mme","Monsieur","Madame","procuration"],
    },
    {
      entityType: "DATE_NAISSANCE",
      patterns: [{ name: "fr_naissance_date", regex: new RegExp("(?<=\\b(?:[Nn]ée?\\s+le|naissance)[^\\n\\d]{0,30}?)(?:\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{4}|\\d{1,2}(?:er)?\\s+(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\\s+\\d{4})", "g"), score: 0.6 }],
      context: ["né","née","naissance"],
    },
    {
      entityType: "PERSON",
      patterns: [{ name: "fr_praticien", regex: new RegExp("(?<=(?<![\\p{L}])(?:Dr|Pr|Me|Docteur|Professeur|Maître|dr|pr|docteur|professeur|maître)\\.?\\s+)(?:[A-ZÉÈÀÂÊÎÔÛÇ]\\.\\s?)?(?:[\\p{Lu}][\\p{Ll}'-]+\\s+[\\p{Lu}][\\p{Lu}'-]+|[\\p{Lu}][\\p{Lu}'-]+|[\\p{Lu}][\\p{Ll}'-]+(?:\\s+[\\p{Lu}][\\p{Ll}'-]+)?)\\b", "gu"), score: 0.7 }],
      context: ["docteur","médecin","praticien","avocat","maître"],
    },
    {
      entityType: "ORGANIZATION",
      patterns: [{ name: "fr_organisation", regex: new RegExp("(?<!\\p{L})(?:(?:(?:Cabinet|CABINET|Office|OFFICE|[ÉE]tude|[ÉE]TUDE)[ \\t]+)?(?:[\\p{Lu}][\\p{L}'-]*[ \\t]+){1,3}(?:&|ET|Et|et)[ \\t]+(?:ASSOCI[ÉE]S|Associ[ée]s)|(?!(?:La|Le|Les|Un|Une)[ \\t]+(?:SARL|SAS|SASU|SCI|SELARL|SELAS|SCP|EURL|SNC))(?:[\\p{Lu}][\\p{L}'-]*[ \\t]+){1,4}(?:SARL|SAS|SASU|SCI|SELARL|SELAS|SCP|EURL|SNC))(?!\\p{L})", "gu"), score: 0.85 }],
      context: ["société","cabinet","SIREN","SIRET","RCS","gérante","gérant","associés"],
    },
    {
      entityType: "ORGANIZATION",
      patterns: [{ name: "fr_declencheur", regex: new RegExp("(?<=(?:[Dd][ée]nomm[ée]e?|[Ss]ous la d[ée]nomination(?: sociale)?|[Ss]ous la raison sociale|[Ss]ous l['’]enseigne|[Ee]xer[çc]ant sous l['’]enseigne|[Nn]om commercial)[ \\t]*(?::|[«\"])?[ \\t]*)(?!(?:M\\.|Mme|Mlle|Monsieur|Madame|Maître|Me|Dr|Pr)[ \\t])(?!(?:la|le|les)[ \\t]+(?:Soci[ée]t[ée]|Prestataire|Client|Bailleur|Preneur|Vendeur|Acheteur|Fournisseur|Employeur|Salari[ée]|Association|B[ée]n[ée]ficiaire|Locataire)(?!\\p{L}))(?:(?:la|le|les|pour|de|du|des|et|&)[ \\t]+|(?:l|d)['’])*[\\p{Lu}][\\p{L}'’&-]*(?:[ \\t]+(?:(?:la|le|les|pour|de|du|des|et|&)[ \\t]+|(?:l|d)['’])*[\\p{Lu}][\\p{L}'’&-]*){0,6}", "gu"), score: 0.8 }],
      context: ["dénommée","dénomination","enseigne","nom commercial","société"],
    },
    {
      entityType: "ORGANIZATION",
      patterns: [{ name: "fr_indice_societe", regex: new RegExp("(?<=\\b(?:[Ss]oci[ée]t[ée]|[Ee]ntreprise|[Ee]nseigne|[Ff]iliale)[ \\t]+)(?!(?:M\\.|Mme|Mlle|Monsieur|Madame|Maître|Me|Dr|Pr|Docteur|Professeur|G[ée]n[ée]rale|Civile|Anonyme|Commerciale|Immobili[èe]re|Mutuelle|Coop[ée]rative|Nationale|Tribunal|Cour|Minist[èe]re|Pr[ée]fecture|Mairie|[ÉE]tat|R[ée]publique|Commune|Partie|Parties|Demanderesse|Cocontractant|Cessionnaire|Cédante|Mère)(?!\\p{L}))(?!(?:Client|Prestataire|Bailleur|Preneur|Vendeur|Acheteur|Fournisseur|Employeur|Locataire|B[ée]n[ée]ficiaire)(?!\\p{L})(?![ \\t]+[\\p{Lu}]))[\\p{Lu}][\\p{L}'’&-]*(?:[ \\t]+(?:(?:de|du|des|et|&)[ \\t]+)?[\\p{Lu}][\\p{L}'’&-]*){0,4}", "gu"), score: 0.6 }],
      context: ["société","entreprise","SIRET","SIREN","siège"],
    },
    {
      entityType: "ORGANIZATION",
      patterns: [{ name: "fr_indice_contrat", regex: new RegExp("(?<=\\b(?:notifi[ée]e?s?[ \\t]+à|contrat[ \\t]+avec|convention[ \\t]+avec|conclu[e]?[ \\t]+avec|aupr[èe]s[ \\t]+de)[ \\t]+)(?!(?:M\\.|Mme|Mlle|Monsieur|Madame|Maître|Me|Dr|Pr|Docteur|Professeur|Tribunal|Cour|Minist[èe]re|Pr[ée]fecture|Mairie|[ÉE]tat|R[ée]publique|Commune|D[ée]partement|R[ée]gion|Universit[ée]|Conseil|Procureur|Juge)(?!\\p{L}))[\\p{Lu}][\\p{L}'’&-]*(?:[ \\t]+(?:(?:de|du|des|et|&)[ \\t]+)?[\\p{Lu}][\\p{L}'’&-]*){1,4}", "gu"), score: 0.6 }],
      context: ["notifiée","contrat","convention","société"],
    },
    {
      entityType: "ORGANIZATION",
      patterns: [{ name: "fr_marque_bancaire", regex: new RegExp("(?<!\\p{L})(?:Banque Populaire|Caisse d['’][ÉEée]pargne|Cr[ée]dit (?:Agricole|Mutuel|Lyonnais|du Nord|Foncier|Coop[ée]ratif)|BNP Paribas|Soci[ée]t[ée] G[ée]n[ée]rale|La Banque Postale|Groupama|AXA|MAIF|MACIF|MAAF|MGEN|Malakoff Humanis|Harmonie Mutuelle|Allianz|Generali|Boursorama)(?:[ \\t]+(?:(?:de la|de|du|des|d['’])[ \\t]*)?[\\p{Lu}][\\p{L}'’-]*)*(?!\\p{L})", "gu"), score: 0.85 }],
      context: ["banque","assurance","mutuelle","compte","virement"],
    },
    {
      entityType: "ORGANIZATION",
      patterns: [{ name: "fr_sigle_suffixe", regex: new RegExp("(?<!\\p{L})[\\p{Lu}][\\p{L}'’&-]*(?:[ \\t]+[\\p{Lu}][\\p{L}'’&-]*){1,4}[ \\t]+(?:SA|SCS|SCA|SE|SLP|S\\.A\\.|S\\.C\\.S\\.|S\\.C\\.A\\.|S\\.E\\.)(?!\\p{L})", "gu"), score: 0.7 }],
      context: ["capital","RCS","siège","société"],
    },
    {
      entityType: "ORGANIZATION",
      patterns: [{ name: "fr_droits", regex: new RegExp("(?<=(?:venant aux droits de|ès qualités(?: de)?|en qualité d['’]assureur de|prise en la personne de)[ \\t]+)(?!(?:M\\.|Mme|Monsieur|Madame|Maître)[ \\t])(?:(?:la|le|les|pour|de|du|des|et|&)[ \\t]+|(?:l|d)['’])*[\\p{Lu}][\\p{L}'’&-]*(?:[ \\t]+(?:(?:la|le|les|pour|de|du|des|et|&)[ \\t]+|(?:l|d)['’])*[\\p{Lu}][\\p{L}'’&-]*){0,6}", "gu"), score: 0.7 }],
      context: ["droits","qualités","assureur","représentant"],
    },
  ];
}
