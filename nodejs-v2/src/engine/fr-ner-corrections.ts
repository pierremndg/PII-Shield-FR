/**
 * Corrections for the gliner_multi_pii-v1 model, applied to the NER results
 * right after the NER step (see pii-engine.ts, step 2.6). Ported from the
 * French patch. They fix two habits of this model; they are not detection rules.
 */

import type { DetectedEntity } from "./pattern-recognizers.js";

const GENERIC_SYNDIC_RE = /^(?:(?:le|la|les)\s+)?[Ss]yndicat des copropriétaires (?:de\s+|du\s+|d['’])\p{Ll}/u;

/**
 * The model takes the complement of a generic condominium union for a name
 * ("syndicat des copropriétaires de l'immeuble"). Drop it unless a proper noun
 * follows "de" / "du" ("Syndicat des copropriétaires du Parc Lilas" is kept).
 */
export function removeGenericSyndic(entities: DetectedEntity[]): DetectedEntity[] {
  return entities.filter((e) => e.type === "PERSON" || !GENERIC_SYNDIC_RE.test(e.text));
}

const LOWERCASE_NAME_TAIL_RE = /^(.*\p{Lu}[\p{L}'’-]*) \p{Ll}+$/u;

/**
 * The model keeps a trailing lowercase word in a person name ("Le Goff a" when
 * the text reads "Mme Le Goff a répondu"). Cut it: the name ends at the last
 * capitalised word.
 */
export function trimLowercaseNameTail(entities: DetectedEntity[]): DetectedEntity[] {
  return entities.map((e) => {
    const m = e.type === "PERSON" ? e.text.match(LOWERCASE_NAME_TAIL_RE) : null;
    return m ? { ...e, text: m[1], end: e.start + m[1].length } : e;
  });
}
