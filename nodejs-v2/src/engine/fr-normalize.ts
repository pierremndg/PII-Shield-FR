/**
 * French normalization shared by the server (entity-dedup.ts, via fr-filters.ts) and the review panel preview
 * (ui/src/review-app.ts). No imports: this file must stay usable in the browser bundle.
 */

/**
 * Same entity written several ways gets one key: phone numbers (06…, +33…, 0033…) and dates (15/01/1985, 15 janvier 1985).
 * Returns null when the text is neither a phone number nor a date: the caller uses its own normalization.
 */
export function normalizePhoneOrDate(text: string): string | null {
  const tel = String(text).replace(/[\s.\-()]/g, "");
  if (/^(\+33|0033)0?[1-9]\d{8}$/.test(tel)) return "0" + tel.replace(/^(\+33|0033)0?/, "");
  if (/^0[1-9]\d{8}$/.test(tel)) return tel;
  const dt = String(text).trim().toLowerCase().match(/^(\d{1,2})(?:er)?[\/.\-\s]+(\d{1,2}|janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)[\/.\-\s]+(\d{4})$/);
  if (dt) {
    const months = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];
    const m = /^\d+$/.test(dt[2]) ? Number(dt[2]) : months.indexOf(dt[2].normalize("NFD").replace(/[̀-ͯ]/g, "")) + 1;
    if (m >= 1 && m <= 12) return "date:" + dt[3] + "-" + m + "-" + Number(dt[1]);
  }
  return null;
}
