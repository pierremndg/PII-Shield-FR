/**
 * @file PII Shield review iframe — main module.
 *
 * Runs inside the sandboxed iframe the MCP host renders for
 * `ui://pii-shield/review.html`.  Uses the `App` class from
 * `@modelcontextprotocol/ext-apps` to:
 *
 *   - Receive the initial session payload via `ontoolresult` (comes from the
 *     `start_review` tool response, field `structuredContent`).
 *   - Send the user's approve payload back via `app.callServerTool({ name:
 *     "apply_review_overrides", arguments: { session_id, overrides } })`.
 *
 * Replaces the v1.x fetch-based client that talked to a localhost HTTP
 * server — that server doesn't exist in v2.0.0.  All data travels through
 * MCP over stdio, so no network access or browser tab is needed.
 *
 * The render/selection/approve logic is ported verbatim from
 * `nodejs/assets/review_ui.html` (~1400 lines of inline script).  Only the
 * bulk-mode tabbed navigation was dropped — the v2.0.0 flow opens one panel
 * per `start_review` call, which is how every known host renders MCP Apps
 * today.  Bulk can be reintroduced later by either (a) opening multiple
 * panels or (b) letting `ontoolresult` deliver an array of sessions and
 * keeping them in-memory.
 */

import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./review.css";
import { REFERENTIEL_ETIQUETTES, REFERENTIEL_ALIAS } from "../../src/engine/fr-referentiel.js";
import { normalizePhoneOrDate } from "../../src/engine/fr-normalize.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface Entity {
  text: string;
  type: string;
  start: number;
  end: number;
  score: number;
  placeholder?: string;
  /** Assigned by the UI when entities arrive (stable index into `entities[]`). */
  idx: number;
  /** All entities from the server are considered verified. */
  verified: boolean;
}

interface AddedEntity {
  text: string;
  type: string;
  start: number;
  end: number;
  /** French fork: display marker (set by merges), never sent to the server. */
  placeholder?: string;
  /** French fork: token of a category change; additions with the same token form one label. */
  fam?: string;
}

interface FormatRun {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

interface BlockMapEntry {
  start: number;
  end: number;
  tag: string;
}

interface SessionPayload {
  session_id: string;
  /** v2.1.3: doc_id scopes the payload to a single PerDocReview within a
   *  multi-file session. For legacy single-doc sessions this is omitted
   *  and the server applies overrides to documents[0]. */
  doc_id?: string;
  original_text?: string;
  /** v2.0.0 server field name. */
  html_text?: string;
  /** Legacy field alias (v1.x). */
  original_html?: string;
  anonymized_text?: string;
  entities?: Array<Omit<Entity, "idx" | "verified">>;
  overrides?: { remove?: number[]; add?: AddedEntity[]; merge?: Merge[] };
  approved?: boolean;
  source_filename?: string;
}

/**
 * v2.0.3 (issue #2): start_review now returns metadata-only entries here.
 * Raw PII (original_text, entities, html_text) is pulled separately by the
 * iframe via the model-invisible `get_review_payload` tool.
 */
interface SessionMetadata {
  session_id: string;
  doc_id?: string;
  source_filename?: string;
  entity_count?: number;
  approved?: boolean;
  has_overrides?: boolean;
}

interface StartReviewStructuredContent {
  status?: string;
  sessions?: SessionMetadata[];
  count?: number;
  is_bulk?: boolean;
}

interface Family {
  type: string;
  rootText: string;
  rootNorm: string;
  members: Array<{
    text: string;
    norm: string;
    /** Index in entities[] (number) or "a<k>" for the k-th manual addition. */
    indices: Array<number | string>;
    score: number;
  }>;
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`element #${id} not found in review.html shell`);
  return el;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── State ───────────────────────────────────────────────────────────────────

let SESSION_ID = "";
/** v2.1.3: doc_id for the currently loaded single-session review (empty when
 *  the server didn't emit one — legacy single-doc flow). */
let DOC_ID = "";
let originalText = "";
let originalHtml = "";
let anonymizedText = "";
let entities: Entity[] = [];
let removedIndices = new Set<number>();
let addedEntities: AddedEntity[] = [];
let formatRuns: FormatRun[] = [];
let blockMap: BlockMapEntry[] = [];
let collapsedFamilies = new Set<string>();
let splitView = false;
let focusedFamilyIdx = -1;
let currentFamilies: Family[] = [];
/**
 * Sidebar text filter. Normalized (lowercased, trimmed) substring — if non-empty,
 * `renderSidebar()` hides any family/added-entity whose text doesn't contain it.
 * Updated by the `#filter-input` input handler (initSidebarFilter), and focused
 * on `/` keystroke (see keydown listener).
 */
let sidebarFilter = "";

// ── Bulk mode state (multi-document review) ─────────────────────────────────
// When start_review is called with 2+ session_ids, we switch to tabbed UI:
// one tab per document, independent per-doc state cached in memory, global
// approve-gating (all docs must be approved before the panel closes), and
// cross-document entity propagation (adding/removing in doc A auto-applies
// the same decision to matching text in docs B..N).

interface BulkSession {
  session_id: string;
  /** v2.1.3: per-doc id inside a multi-file session. Empty for legacy single-doc. */
  doc_id: string;
  source_filename: string;
  approved: boolean;
  /** Cached original payload from the server. */
  payload: SessionPayload;
  /** Per-session user decisions. */
  state: { removedIndices: Set<number>; addedEntities: AddedEntity[]; merges: Merge[] };
}

let bulkSessions: BulkSession[] = [];
let currentBulkIdx = 0;

function isBulkMode(): boolean {
  return bulkSessions.length > 1;
}

/**
 * Set both the top and bottom Approve buttons to the same disabled/text
 * state. The bottom button is added by review.html so users can approve
 * after reviewing a long doc without scrolling back up — we keep their
 * states in sync so the UI always shows one coherent "Valider" / "Saving…"
 * action everywhere.
 */
function setApproveBtnState(disabled: boolean, text: string): void {
  const top = $("approve-btn") as HTMLButtonElement;
  top.disabled = disabled;
  top.textContent = text;
  const bottom = document.getElementById("approve-btn-bottom") as HTMLButtonElement | null;
  if (bottom) {
    bottom.disabled = disabled;
    bottom.textContent = text;
  }
}

// ── Theme ───────────────────────────────────────────────────────────────────

function isDark(): boolean {
  if (document.documentElement.classList.contains("dark")) return true;
  if (document.documentElement.classList.contains("light")) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function updateThemeIcon(): void {
  const btn = document.getElementById("theme-btn");
  if (btn) btn.textContent = isDark() ? "\u2600\uFE0F" : "\uD83C\uDF19";
}

function initTheme(): void {
  const saved = localStorage.getItem("pii-theme");
  if (saved === "dark") {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
  } else if (saved === "light") {
    document.documentElement.classList.add("light");
    document.documentElement.classList.remove("dark");
  }
  updateThemeIcon();
}

function toggleTheme(): void {
  const goingDark = !isDark();
  document.documentElement.classList.toggle("dark", goingDark);
  document.documentElement.classList.toggle("light", !goingDark);
  localStorage.setItem("pii-theme", goingDark ? "dark" : "light");
  updateThemeIcon();
}

// ── Entity grouping ─────────────────────────────────────────────────────────

const ENTITY_GROUP: Record<string, string> = {
  PERSON: "PERSON", NRP: "PERSON",
  ORGANIZATION: "ORG", ORG: "ORG",
  LOCATION: "LOCATION",
  EMAIL_ADDRESS: "COMM", PHONE_NUMBER: "COMM", URL: "COMM", IP_ADDRESS: "COMM",
  CREDIT_CARD: "FINANCIAL", IBAN_CODE: "FINANCIAL", CRYPTO: "FINANCIAL",
  US_SSN: "ID_DOC", US_PASSPORT: "ID_DOC", US_DRIVER_LICENSE: "ID_DOC",
  UK_NHS: "ID_DOC", UK_NIN: "ID_DOC", UK_PASSPORT: "ID_DOC", UK_CRN: "ID_DOC",
  UK_DRIVING_LICENCE: "ID_DOC",
  EU_VAT: "ID_DOC", EU_PASSPORT: "ID_DOC",
  DE_TAX_ID: "ID_DOC", DE_SOCIAL_SECURITY: "ID_DOC",
  FR_NIR: "ID_DOC", FR_CNI: "ID_DOC",
  IT_FISCAL_CODE: "ID_DOC", IT_VAT: "ID_DOC",
  ES_DNI: "ID_DOC", ES_NIE: "ID_DOC",
  CY_TIC: "ID_DOC", CY_ID_CARD: "ID_DOC",
  MEDICAL_LICENSE: "MEDICAL",
};
// French types and short names (placeholder labels): category from the single reference (src/engine/fr-referentiel.ts).
for (const [, rows] of REFERENTIEL_ETIQUETTES) {
  for (const [type, , , category] of rows) ENTITY_GROUP[type] = category;
}
for (const [tag, category] of REFERENTIEL_ALIAS) ENTITY_GROUP[tag] = category;
for (const [, rows] of REFERENTIEL_ETIQUETTES) {
  for (const [, , , category, tag] of rows) ENTITY_GROUP[tag] = category;
}

function getEntityClass(type: string): string {
  return "entity-" + (ENTITY_GROUP[type] || "OTHER");
}

function getTypeClass(type: string): string {
  return "type-" + (ENTITY_GROUP[type] || "OTHER");
}

function makeGroupKey(type: string, text: string): string {
  const norm = (text || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "_");
  return `${type}__${norm}`;
}

// ── French fork: labels (one row per marker), merges, category changes ──────
// A "label" is one marker (« Personne 1 ») and all the texts written under it. A reference to a detection is
// either its index in entities[] (number) or "a<k>" for the k-th manual addition.

type Ref = number | string;
interface Merge { type: string; from: string; to: string }
interface Entry { text: string; type: string; start: number; end: number; placeholder?: string; fam?: string; score?: number }

/** Merges chosen by the reviewer: text `from` takes the label of `to` (same type). Sent with Approve. */
let merges: Merge[] = [];
/** Labels whose occurrences are unfolded in the sidebar (folded by default). */
const openLabels = new Set<string>();
/** Hover key of every detection (label key), and the detections of each label. Recomputed at each render. */
let labelKeyByDoc: Record<string, string> = {};
let labelIds: Record<string, Ref[]> = {};

const TYPE_LABELS = new Map<string, string>();
for (const [, rows] of REFERENTIEL_ETIQUETTES) for (const [type, label] of rows) TYPE_LABELS.set(type, label);
function typeLabel(t: string): string { return TYPE_LABELS.get(t) || t; }

const nums = (a: Ref[]): number[] => a.filter((x): x is number => typeof x === "number");
const docKey = (j: Ref): string => (typeof j === "number" ? String(j) : "added_" + String(j).slice(1));

/** Marker without brackets and without the document prefix, e.g. "<D1_PERSONNE_1a>" → "PERSONNE_1a". */
function bareMarker(p?: string): string { return String(p || "").replace(/^<|>$/g, "").replace(/^D\d+_/, ""); }
/** Number of a marker ("PERSONNE_4a" → "4"), "" for a merge key (F_…) or no marker. */
function markerNumber(p?: string): string {
  const s = bareMarker(p);
  return s && !s.startsWith("F_") ? (s.split("_").pop() || "").replace(/[^0-9]/g, "") : "";
}
/** « Personne 1 »: label of the type and number of the marker. */
function entityLabel(e: { type: string; placeholder?: string }): string {
  const n = markerNumber(e.placeholder);
  return n ? `${typeLabel(e.type)} ${n}` : typeLabel(e.type);
}
/** Hover/group key: type + marker when there is one, else type + text. */
function groupKey(type: string, text: string, placeholder?: string): string {
  return placeholder ? `${type}__${bareMarker(placeholder).replace(/[^a-zA-Z0-9]/g, "_")}` : makeGroupKey(type, text);
}
function entryOf(j: Ref): Entry | undefined {
  return typeof j === "number" ? entities.find((x) => x.idx === j) : addedEntities[+String(j).slice(1)];
}

/** Merged texts share the marker of their target (display; the server numbers them the same way). */
function applyMergesDisplay(): void {
  const norm = (t: string) => String(t).trim().toLowerCase();
  for (const f of merges) {
    const all: Entry[] = [...entities.filter((a) => a.verified), ...addedEntities];
    const target = all.find((x) => x.type === f.type && x.text === f.to);
    const key = target && target.placeholder ? target.placeholder : "F_" + norm(f.to).replace(/[^a-z0-9]/g, "_");
    for (const x of all) {
      if (x.type === f.type && (norm(x.text) === norm(f.from) || norm(x.text) === norm(f.to))) x.placeholder = key;
    }
  }
}

/** An original that was re-typed: it is removed and an addition covers the same span; it must not hide the addition. */
function originalReplaced(a: Entity): boolean {
  return removedIndices.has(a.idx) && addedEntities.some((m) => m.start === a.start && m.end === a.end);
}

/** Marker used in the pseudonymized view for an entry (existing marker, or the next number of its tag for an addition). */
function viewMarker(s: Entry): string {
  if (s.placeholder && !bareMarker(s.placeholder).startsWith("F_")) return bareMarker(s.placeholder);
  const all: Entry[] = [...entities, ...addedEntities];
  const real = (x: Entry) => x.placeholder && !bareMarker(x.placeholder).startsWith("F_");
  // Same key as the server (entity-dedup.ts normalize): phone numbers and dates written differently share one marker.
  const key = (t: string): string =>
    normalizePhoneOrDate(t) ?? t.toLowerCase().trim().replace(/[.,;:]+$/, "").replace(/\s+/g, " ");
  const same = all.find((x) => real(x) && x.type === s.type && key(x.text) === key(s.text));
  if (same) { s.placeholder = same.placeholder; return bareMarker(same.placeholder); }
  const ofType = all.find((x) => real(x) && x.type === s.type);
  const tag = ofType ? bareMarker(ofType.placeholder).split("_").slice(0, -1).join("_") : (TAG_NAMES_UI[s.type] || s.type);
  let max = 0;
  for (const x of all) {
    const b = bareMarker(x.placeholder);
    if (b.startsWith(tag + "_")) { const n = parseInt(b.split("_").pop() || "", 10); if (n > max) max = n; }
  }
  s.placeholder = `${tag}_${max + 1}`;
  return s.placeholder;
}
const TAG_NAMES_UI: Record<string, string> = {};
for (const [, rows] of REFERENTIEL_ETIQUETTES) for (const [type, , , , tag] of rows) TAG_NAMES_UI[type] = tag;

interface LabelEntry extends Entry { idx: Ref }

/** Group detections into labels: by marker when there is one, else by text similarity; re-typed ones form their own label. */
function labelFamilies(): Family[] {
  const originals: LabelEntry[] = entities.filter((e) => e.verified && !originalReplaced(e))
    .map((e) => ({ text: e.text, type: e.type, start: e.start, end: e.end, placeholder: e.placeholder, score: e.score, idx: e.idx }));
  const added: LabelEntry[] = addedEntities.map((x, k) => ({ ...x, score: 1, idx: "a" + k }));
  const all = [...originals, ...added];
  const families: Family[] = [];
  const addTo = (fam: Family, x: LabelEntry) => {
    const norm = x.text.trim().toLowerCase();
    let m = fam.members.find((v) => v.norm === norm);
    if (!m) { m = { text: x.text, norm, indices: [], score: x.score ?? 1 }; fam.members.push(m); }
    m.indices.push(x.idx);
  };
  const newFam = (x: LabelEntry): Family => ({ type: x.type, rootText: x.text, rootNorm: x.text.trim().toLowerCase(), members: [] });
  // 1. Re-typed (fam) entries: one label per change, grouped by exact text.
  const byChange = new Map<string, Family>();
  for (const x of all.filter((y) => y.fam)) {
    let fam = byChange.get(x.fam as string);
    if (!fam) { fam = newFam(x); byChange.set(x.fam as string, fam); families.push(fam); }
    addTo(fam, x);
  }
  // 2. Entries with a marker: one label per marker (the variant letter is ignored).
  const byMarker = new Map<string, Family>();
  const free: LabelEntry[] = [];
  for (const x of all.filter((y) => !y.fam)) {
    if (!x.placeholder) { free.push(x); continue; }
    const id = x.type + "|" + bareMarker(x.placeholder).replace(/(\d+)[a-z]$/, "$1");
    let fam = byMarker.get(id);
    if (!fam) { fam = newFam(x); byMarker.set(id, fam); families.push(fam); }
    addTo(fam, x);
  }
  // 3. Entries without marker (manual additions): grouped by text similarity, like the original list.
  for (const fam of buildFamilies(free as unknown as Entity[])) families.push(fam);

  const pos = (j: Ref): number => { const e = entryOf(j); return e && typeof e.start === "number" ? e.start : 1e15; };
  for (const f of families) {
    for (const v of f.members) v.indices.sort((a, b) => pos(a) - pos(b));
    f.members.sort((a, b) => pos(a.indices[0]) - pos(b.indices[0]));
    f.rootText = f.members[0].text;
    f.rootNorm = f.members[0].norm;
  }
  return families.sort((a, b) => pos(a.members[0].indices[0]) - pos(b.members[0].indices[0]));
}

/** The marker of a label: the smallest of its members, whatever their order (PERSONNE_4 before PERSONNE_4a). */
function labelMarker(f: Family): string | undefined {
  const ps: string[] = [];
  for (const v of f.members) for (const j of v.indices) { const e = entryOf(j); if (e && e.placeholder) ps.push(String(e.placeholder)); }
  ps.sort();
  return ps.length ? ps[0] : undefined;
}
function labelKeyOf(f: Family): string { return groupKey(f.type, f.rootText, labelMarker(f)); }

function computeLabelKeys(): void {
  labelKeyByDoc = {};
  labelIds = {};
  for (const f of labelFamilies()) {
    const k = labelKeyOf(f);
    labelIds[k] = f.members.flatMap((v) => v.indices);
    for (const v of f.members) for (const j of v.indices) labelKeyByDoc[docKey(j)] = k;
  }
}

/** Change the category of detections. Originals are removed and re-added with the new type at the same place;
 *  additions change type in place; already removed ones do not move. Returns the number of changes. */
function changeCategory(ids: Ref[], type: string): number {
  let n = 0;
  const token = "c" + ids.map(String).join("_");
  for (const x of ids) {
    if (typeof x === "number") {
      if (removedIndices.has(x)) continue;
      const e = entities.find((y) => y.idx === x);
      if (!e || e.type === type) continue;
      removedIndices.add(x);
      addedEntities.push({ text: e.text, type, start: e.start, end: e.end, fam: token });
      n++;
    } else {
      const e = addedEntities[+String(x).slice(1)];
      if (e && e.type !== type) { e.type = type; if (!e.fam) e.fam = token; n++; }
    }
  }
  return n;
}

// ── Format parsing from docx HTML ───────────────────────────────────────────

function parseHtmlFormatting(html: string): void {
  const temp = document.createElement("div");
  temp.innerHTML = html;
  formatRuns = [];
  blockMap = [];
  let charPos = 0;

  for (const block of Array.from(temp.children)) {
    const tag = block.tagName.toLowerCase();
    const blockStart = charPos;

    function walkNode(node: Node, inherited: { bold: boolean; italic: boolean; underline: boolean }) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || "";
        if (text.length > 0) {
          if (inherited.bold || inherited.italic || inherited.underline) {
            formatRuns.push({
              start: charPos, end: charPos + text.length,
              bold: inherited.bold, italic: inherited.italic, underline: inherited.underline,
            });
          }
          charPos += text.length;
        }
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const t = (node as Element).tagName.toLowerCase();
        if (t === "br") { charPos++; return; }
        const next = { ...inherited };
        // Bold intentionally NOT tracked: DOCX runs are often split mid-word
        // with inconsistent bold flags, producing ugly "ha**lf wor**d" renders.
        // Italic/underline are much less frequently mis-split so stay.
        // if (t === "b" || t === "strong") next.bold = true;
        if (t === "i" || t === "em") next.italic = true;
        if (t === "u") next.underline = true;
        for (const child of Array.from(node.childNodes)) walkNode(child, next);
      }
    }

    walkNode(block, { bold: false, italic: false, underline: false });
    blockMap.push({ start: blockStart, end: charPos, tag });
    charPos++; // \n between paragraphs
  }
}

// ── Render ──────────────────────────────────────────────────────────────────

interface DisplayEntity extends Entity {
  source: "original" | "added";
  _tooltipHtml?: string;
}

function render(): void {
  applyMergesDisplay();
  computeLabelKeys();
  renderDocument();
  renderSidebar();
  updateStats();
  updateViews();
}

function renderDocument(): void {
  const container = $("doc-content");
  const hasHtml = formatRuns.length > 0 || blockMap.length > 0;
  container.classList.toggle("html-mode", hasHtml);

  const allEntities: DisplayEntity[] = [
    ...entities.filter(e => e.verified && !originalReplaced(e)).map<DisplayEntity>(e => ({ ...e, source: "original" })),
    ...addedEntities.map<DisplayEntity>((e, i) => ({
      text: e.text, type: e.type, start: e.start, end: e.end, score: 1.0,
      idx: (`added_${i}` as unknown) as number, verified: false, source: "added",
    })),
  ].sort((a, b) => a.start - b.start);

  const segments = buildSegments(allEntities);

  const paragraphs = originalText.split("\n");
  let html = "";
  let offset = 0;
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi];
    const start = offset;
    const end = offset + para.length;
    const tag = (hasHtml && blockMap[pi] && blockMap[pi].tag) || "p";
    html += `<${tag}>`;
    html += renderSegmentsRange(segments, start, end);
    html += `</${tag}>`;
    offset = end + 1;
  }
  container.innerHTML = html;
  wireDocumentEntityHandlers();
}

interface Segment {
  start: number; end: number; entity?: DisplayEntity;
  bold: boolean; italic: boolean; underline: boolean;
}

function buildSegments(allEntities: DisplayEntity[]): Segment[] {
  const points = new Set<number>([0, originalText.length]);
  for (const e of allEntities) {
    if (e.start >= 0) { points.add(e.start); points.add(e.end); }
  }
  for (const f of formatRuns) { points.add(f.start); points.add(f.end); }
  const sorted = Array.from(points).sort((a, b) => a - b);

  const segments: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i], end = sorted[i + 1];
    if (start >= end) continue;
    const entity = allEntities.find(e => e.start <= start && end <= e.end);
    const fmt = formatRuns.find(f => f.start <= start && end <= f.end) || {} as FormatRun;
    segments.push({
      start, end, entity,
      bold: !!fmt.bold, italic: !!fmt.italic, underline: !!fmt.underline,
    });
  }
  return segments;
}

function buildTooltipHtml(e: DisplayEntity): string {
  // « Personne 1 »: label of the reference and number of the marker, same as the sidebar and the menu.
  return `<span class="entity-tooltip">${escapeHtml(entityLabel(e))}</span>`;
}

function renderSegmentsRange(segments: Segment[], rangeStart: number, rangeEnd: number): string {
  let html = "";
  let currentEntity: DisplayEntity | undefined = undefined;

  for (const seg of segments) {
    if (seg.end <= rangeStart || seg.start >= rangeEnd) continue;
    const s = Math.max(seg.start, rangeStart);
    const e = Math.min(seg.end, rangeEnd);
    const text = escapeHtml(originalText.slice(s, e));

    let formatted = text;
    // Bold intentionally not rendered — see parseHtmlFormatting for rationale
    // (DOCX run splits produce half-word bolds that look bad).
    // if (seg.bold) formatted = `<b>${formatted}</b>`;
    if (seg.italic) formatted = `<i>${formatted}</i>`;
    if (seg.underline) formatted = `<u>${formatted}</u>`;

    if (seg.entity) {
      if (currentEntity !== seg.entity) {
        if (currentEntity) html += currentEntity._tooltipHtml + `</span>`;
        const ent = seg.entity;
        const isRemoved = ent.source === "original" && removedIndices.has(ent.idx as unknown as number);
        const isAdded = ent.source === "added";
        const cls = `entity ${getEntityClass(ent.type)} ${isRemoved ? "removed" : ""} ${isAdded ? "entity-added" : ""}`;
        const dataIdx = String(ent.idx);
        // Hover key = the label of the detection (same key in the text, the sidebar and the tooltip).
        const hoverKey = labelKeyByDoc[dataIdx] || groupKey(ent.type, ent.text, ent.placeholder);
        html +=
          `<span class="${cls}" data-idx="${dataIdx}" data-source="${ent.source}" data-group-key="${hoverKey}">`;
        currentEntity = seg.entity;
        currentEntity._tooltipHtml = buildTooltipHtml(ent);
      }
      html += formatted;
    } else {
      if (currentEntity) {
        html += currentEntity._tooltipHtml + `</span>`;
        currentEntity = undefined;
      }
      html += formatted;
    }
  }
  if (currentEntity) html += currentEntity._tooltipHtml + `</span>`;
  return html;
}

function wireDocumentEntityHandlers(): void {
  const container = $("doc-content");
  for (const el of Array.from(container.querySelectorAll(".entity"))) {
    const span = el as HTMLElement;
    span.addEventListener("click", () => toggleEntity(span));
    const groupKey = span.dataset.groupKey || "";
    span.addEventListener("mouseenter", () => highlightGroup(groupKey));
    span.addEventListener("mouseleave", () => unhighlightGroup(groupKey));
  }
}

// ── Family building for sidebar ─────────────────────────────────────────────

function buildFamilies(confirmed: Entity[]): Family[] {
  const families: Family[] = [];

  for (const e of confirmed) {
    const norm = e.text.trim().toLowerCase();
    const type = e.type;
    let found: Family | null = null;
    if (norm.length >= 4) {
      for (const fam of families) {
        if (fam.type !== type) continue;
        if (fam.rootNorm.length >= 4 && (norm.includes(fam.rootNorm) || fam.rootNorm.includes(norm))) {
          const shorter = Math.min(norm.length, fam.rootNorm.length);
          const longer = Math.max(norm.length, fam.rootNorm.length);
          if (shorter / longer >= 0.5) { found = fam; break; }
        }
        const w1 = norm.split(/\s+/)[0], w2 = fam.rootNorm.split(/\s+/)[0];
        if (w1.length >= 4 && w1 === w2) {
          const shorter = Math.min(norm.length, fam.rootNorm.length);
          const longer = Math.max(norm.length, fam.rootNorm.length);
          if (shorter / longer >= 0.5) { found = fam; break; }
        }
      }
    }

    if (found) {
      const existing = found.members.find(m => m.norm === norm);
      if (existing) {
        existing.indices.push(e.idx);
      } else {
        found.members.push({ text: e.text, norm, indices: [e.idx], score: e.score });
        if (norm.length < found.rootNorm.length) {
          found.rootText = e.text;
          found.rootNorm = norm;
        }
      }
    } else {
      families.push({
        type, rootText: e.text, rootNorm: norm,
        members: [{ text: e.text, norm, indices: [e.idx], score: e.score }],
      });
    }
  }

  for (const fam of families) {
    fam.members.sort((a, b) => {
      if (a.norm === fam.rootNorm) return -1;
      if (b.norm === fam.rootNorm) return 1;
      return a.text.localeCompare(b.text);
    });
  }
  return families;
}

function renderSidebar(): void {
  const list = $("entity-list");
  const fams = labelFamilies();
  currentFamilies = fams;

  // Filter: substring (case-insensitive) on every text of a label. See #filter-input + initSidebarFilter().
  const filter = sidebarFilter;
  const visible = filter === "" ? fams : fams.filter((f) => f.members.some((v) => v.text.toLowerCase().includes(filter)));
  const matchCountEl = document.getElementById("filter-match-count");
  if (matchCountEl) matchCountEl.textContent = filter === "" ? "" : `${visible.length} sur ${fams.length}`;

  if (fams.length === 0) {
    list.innerHTML =
      '<div style="padding:24px 16px;text-align:center;color:var(--text-secondary);font-size:13px;">Aucune entité PII détectée dans ce document.</div>';
    return;
  }
  if (visible.length === 0) {
    list.innerHTML =
      '<div style="padding:24px 16px;text-align:center;color:var(--text-secondary);font-size:13px;">Aucune entité ne correspond au filtre.</div>';
    return;
  }

  const isNumber = (j: Ref) => typeof j === "number";
  let html = "";
  for (const f of visible) {
    const ids = f.members.flatMap((v) => v.indices);
    const total = ids.length;
    const allRemoved = ids.every((j) => isNumber(j) && removedIndices.has(j as number));
    const key = labelKeyOf(f);
    const open = openLabels.has(key);
    const first = f.members[0];
    const marker = labelMarker(f);
    const number = markerNumber(marker);
    const title = number ? entityLabel({ type: f.type, placeholder: marker }) : first.text;
    const idList = ids.map(String).join(",");

    html += `<div class="entity-item ${getTypeClass(f.type)} ${allRemoved ? "removed" : ""}" data-group-key="${key}" title="Survol : toutes les occurrences. Sur une occurrence dépliée : celle-ci seulement">`;
    html += `<span class="family-toggle ${open ? "" : "collapsed"}" data-action="occ-toggle" data-family="${key}">&#x25BC;</span>`;
    if (!number) html += `<span class="type-badge">${escapeHtml(typeLabel(f.type))}</span>`;
    if (!isNumber(first.indices[0])) html += `<span class="idx">+</span>`;
    html += number
      ? `<span class="text" title="${escapeHtml(first.text)}"><span class="type-badge">${escapeHtml(title)}</span></span>`
      : `<span class="text" title="${escapeHtml(first.text)}">${escapeHtml(title)}</span>`;
    html += `<span class="group-count">&times;${total}</span>`;
    html += `<button class="action-btn add-btn" title="Ajouter un texte à cette étiquette" data-action="add-pending" data-type="${f.type}" data-text="${escapeHtml(first.text)}">+</button>`;
    html += `<button class="action-btn merge-btn" title="Fusionner avec une étiquette existante" data-action="merge-group" data-key="${key}">&#x21C4;</button>`;
    html += `<button class="action-btn cat-btn" title="Changer la catégorie de l’étiquette" data-action="cat-change" data-indices="${idList}">&#x270E;</button>`;
    html += allRemoved
      ? `<button class="action-btn restore-btn" title="Rétablir tout" data-action="grp-restore" data-indices="${idList}">&#x21A9;</button>`
      : `<button class="action-btn remove-btn" title="Retirer tout" data-action="grp-remove" data-indices="${idList}">&#x2715;</button>`;
    html += `</div>`;

    if (open) {
      for (const v of f.members) {
        for (const j of v.indices) {
          const removedOcc = isNumber(j) && removedIndices.has(j as number);
          const target = isNumber(j) ? ` data-action="scrollto" data-idx="${j}"` : "";
          html += `<div class="entity-item variant ${getTypeClass(f.type)} ${removedOcc ? "removed" : ""}" data-occ="${docKey(j)}"${target}>`;
          if (!isNumber(j)) html += `<span class="idx">+</span>`;
          html += `<span class="text" title="${escapeHtml(v.text)}">${escapeHtml(v.text)}</span>`;
          if (isNumber(j)) html += `<span class="score">${(v.score * 100).toFixed(0)}%</span>`;
          html += removedOcc
            ? `<button class="action-btn restore-btn" title="Rétablir" data-action="grp-restore" data-indices="${j}">&#x21A9;</button>`
            : `<button class="action-btn remove-btn" title="Retirer" data-action="grp-remove" data-indices="${j}">&#x2715;</button>`;
          html += `<button class="action-btn cat-btn" title="Changer la catégorie de cette occurrence" data-action="cat-change" data-indices="${j}">&#x270E;</button>`;
          html += `</div>`;
        }
      }
    }
  }

  list.innerHTML = html;
  wireSidebarHandlers();
}

/** "12,a3" → [12, "a3"] */
function parseIds(s: string): Ref[] {
  return s.split(",").filter(Boolean).map((v) => (v.charAt(0) === "a" ? v : Number(v)));
}

function wireSidebarHandlers(): void {
  const list = $("entity-list");

  for (const el of Array.from(list.querySelectorAll<HTMLElement>(".entity-item"))) {
    const key = el.dataset.groupKey || "";
    if (key) {
      el.addEventListener("mouseenter", () => highlightGroup(key));
      el.addEventListener("mouseleave", () => unhighlightGroup(key));
    }
    const occ = el.dataset.occ;
    if (occ) {
      el.addEventListener("mouseenter", () => highlightOccurrence(occ));
      el.addEventListener("mouseleave", () => highlightOccurrence(null));
    }
    if (el.dataset.action === "scrollto" && el.dataset.idx) {
      const idx = Number(el.dataset.idx);
      el.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest("button")) return;
        scrollToEntity(idx);
      });
    }
  }

  for (const btn of Array.from(list.querySelectorAll<HTMLElement>("[data-action=occ-toggle]"))) {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const key = btn.dataset.family || "";
      if (openLabels.has(key)) openLabels.delete(key); else openLabels.add(key);
      renderSidebar();
    });
  }
  for (const btn of Array.from(list.querySelectorAll<HTMLElement>("[data-action=grp-remove],[data-action=grp-restore]"))) {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const restore = btn.dataset.action === "grp-restore";
      const dropAdded = new Set<number>();
      for (const j of parseIds(btn.dataset.indices || "")) {
        if (typeof j === "string") { if (!restore) dropAdded.add(+j.slice(1)); }
        else if (restore) removedIndices.delete(j);
        else removedIndices.add(j);
      }
      if (dropAdded.size > 0) addedEntities = addedEntities.filter((_, k) => !dropAdded.has(k));
      showToast(restore ? "Rétabli" : "Retiré", "restore");
      render();
    });
  }
  for (const btn of Array.from(list.querySelectorAll<HTMLElement>("[data-action=add-pending]"))) {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      pendingAddTarget = { type: btn.dataset.type || "PERSON", text: btn.dataset.text || "" };
      document.body.classList.add("mode-ajout");
      showToast(`Sélectionnez le texte à ajouter à « ${pendingAddTarget.text} » (Échap pour annuler)`, "restore");
    });
  }
  for (const btn of Array.from(list.querySelectorAll<HTMLElement>("[data-action=merge-group]"))) {
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); openMergeList(btn, btn.dataset.key || ""); });
  }
  for (const btn of Array.from(list.querySelectorAll<HTMLElement>("[data-action=cat-change]"))) {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const r = btn.getBoundingClientRect();
      openCategoryMenu(parseIds(btn.dataset.indices || ""), r.left - 160, r.bottom + 4);
    });
  }
}

// ── French fork: add to a label, merge, change category ─────────────────────

/** "+" on a label: the next selection is added under that label. */
let pendingAddTarget: { type: string; text: string } | null = null;

/** Highlight one occurrence only (sidebar row and text span). */
let highlightedOccurrence: string | null = null;
function highlightOccurrence(k: string | null): void {
  if (highlightedOccurrence !== null) {
    document.querySelectorAll(`[data-occ="${highlightedOccurrence}"],.entity[data-idx="${highlightedOccurrence}"]`).forEach((x) => x.classList.remove("group-hover"));
  }
  highlightedOccurrence = k;
  if (k !== null) document.querySelectorAll(`[data-occ="${k}"],.entity[data-idx="${k}"]`).forEach((x) => x.classList.add("group-hover"));
}

/** Side box shown at a fixed position (merge list, category menu). */
function sideBox(id: string): HTMLElement {
  let box = document.getElementById(id);
  if (!box) {
    box = document.createElement("div");
    box.id = id;
    box.className = "type-dropdown";
    document.body.appendChild(box);
  }
  return box;
}
function placeBox(box: HTMLElement, x: number, y: number): void {
  box.style.position = "fixed";
  box.style.bottom = "auto";
  box.style.right = "auto";
  box.style.zIndex = "300";
  box.style.maxHeight = "60vh";
  box.style.overflowY = "auto";
  box.style.left = Math.max(8, Math.min(x, window.innerWidth - 280)) + "px";
  box.style.top = Math.max(8, Math.min(y, window.innerHeight - 200)) + "px";
  box.classList.add("visible");
}

/** "⇄": list the other labels of the same type; choosing one merges this label's texts into it. */
function openMergeList(btn: HTMLElement, key: string): void {
  const source = labelFamilies().find((f) => labelKeyOf(f) === key);
  if (!source) return;
  const targets = labelFamilies().filter((f) => f.type === source.type && labelKeyOf(f) !== key);
  const box = sideBox("fusion-side");
  box.innerHTML = targets.length === 0
    ? `<div class="type-dropdown-item">Aucune autre étiquette de ce type</div>`
    : targets.map((t, i) => `<div class="type-dropdown-item" data-idx="${i}">${escapeHtml(typeLabel(t.type) + " : " + t.rootText)}</div>`).join("");
  box.onclick = (ev) => {
    const it = (ev.target as HTMLElement).closest<HTMLElement>(".type-dropdown-item[data-idx]");
    if (!it) return;
    box.classList.remove("visible");
    const target = targets[+(it.dataset.idx || "0")];
    if (!target) return;
    for (const m of source.members) {
      if (m.text.trim().toLowerCase() !== target.rootText.trim().toLowerCase()) merges.push({ type: source.type, from: m.text, to: target.rootText });
    }
    showToast(`Fusion : ${source.rootText} → ${target.rootText}`, "restore");
    render();
  };
  const r = btn.getBoundingClientRect();
  placeBox(box, r.left, r.bottom + 4);
}

/** Menu of all categories (folded by default) to change the category of detections. */
function openCategoryMenu(ids: Ref[], x: number, y: number): void {
  const box = sideBox("cat-side");
  box.innerHTML = "";
  for (const [groupName, rows] of REFERENTIEL_ETIQUETTES) {
    const header = document.createElement("div");
    header.className = "type-dropdown-group collapsed";
    header.textContent = groupName;
    header.style.color = `var(${rows[0][2]})`;
    box.appendChild(header);
    for (const [type, label, cssVar] of rows) {
      const item = document.createElement("div");
      item.className = "type-dropdown-item";
      item.dataset.type = type;
      item.style.display = "none";
      item.appendChild(typeBadge(label, cssVar));
      box.appendChild(item);
    }
  }
  box.onclick = (ev) => {
    const target = ev.target as HTMLElement;
    const h = target.closest<HTMLElement>(".type-dropdown-group");
    if (h) { ev.stopPropagation(); foldGroup(h); return; }
    const it = target.closest<HTMLElement>(".type-dropdown-item[data-type]");
    if (!it) return;
    ev.stopPropagation();
    box.classList.remove("visible");
    const type = it.dataset.type || "";
    if (changeCategory(ids, type) > 0) showToast("Catégorie changée : " + typeLabel(type), "restore");
    render();
  };
  placeBox(box, x, y);
}

/** Colored pill for a type (same colours as the category). */
function typeBadge(label: string, cssVar: string): HTMLElement {
  const b = document.createElement("span");
  b.className = "type-badge";
  b.style.background = `var(${cssVar}-bg)`;
  b.style.color = `var(${cssVar})`;
  b.textContent = label;
  return b;
}

/** Fold or unfold a group header and its items in a menu. */
function foldGroup(h: HTMLElement): void {
  const folded = !h.classList.contains("collapsed");
  h.classList.toggle("collapsed", folded);
  let n = h.nextElementSibling as HTMLElement | null;
  while (n && !n.classList.contains("type-dropdown-group")) {
    n.style.display = folded ? "none" : "";
    n = n.nextElementSibling as HTMLElement | null;
  }
}

/** Open the type menu below the toolbar when the toolbar is high in the window (else it goes off screen). */
function placeMenu(id: string): void {
  const tb = document.getElementById("selection-toolbar");
  const dd = document.getElementById(id);
  if (tb && dd) dd.classList.toggle("down", tb.getBoundingClientRect().top < 330);
}

/** References of the label under the current selection when it is exactly a detection (the menu then changes its category). */
let changeTargetIds: Ref[] | null = null;
function selectionLabelIds(): Ref[] | null {
  if (!pendingSelection) return null;
  const sel = pendingSelection;
  const e = entities.find((x) => x.verified && !removedIndices.has(x.idx) && x.start === sel.start && x.end === sel.end);
  if (e) { const k = labelKeyByDoc[String(e.idx)]; return k ? labelIds[k] : [e.idx]; }
  const i = addedEntities.findIndex((x) => x.start === sel.start && x.end === sel.end);
  if (i >= 0) { const k = labelKeyByDoc["added_" + i]; return k ? labelIds[k] : ["a" + i]; }
  return null;
}

function toggleFamily(familyKey: string): void {
  if (collapsedFamilies.has(familyKey)) collapsedFamilies.delete(familyKey);
  else collapsedFamilies.add(familyKey);
  renderSidebar();
}

function updateStats(): void {
  const confirmed = entities.filter(e => e.verified).length;
  $("entity-count").textContent = String(confirmed - removedIndices.size + addedEntities.length);
  $("removed-count").textContent = String(removedIndices.size);
  $("added-count").textContent = String(addedEntities.length);
}

// ── Remove / restore ────────────────────────────────────────────────────────

function toggleEntity(el: HTMLElement): void {
  // A click on a mention in the text removes that one mention only (the sidebar removes a whole label).
  const sl = window.getSelection();
  if (sl && !sl.isCollapsed && sl.toString().trim()) return; // selecting text must not remove the mark under it
  const source = el.dataset.source;
  const idxStr = el.dataset.idx || "";
  if (source === "original") {
    const numIdx = parseInt(idxStr);
    if (removedIndices.has(numIdx)) removedIndices.delete(numIdx);
    else removedIndices.add(numIdx);
    render();
  } else if (source === "added") {
    removeAdded(parseInt(idxStr.replace("added_", "")));
  }
}

function removeEntity(idx: number): void {
  const entity = entities.find(e => e.idx === idx);
  if (entity) {
    const normText = entity.text.trim().toLowerCase();
    const type = entity.type;
    let count = 0;
    for (const e of entities) {
      if (e.verified && e.text.trim().toLowerCase() === normText && e.type === type) {
        removedIndices.add(e.idx);
        count++;
      }
    }
    showToast(`Removed${count > 1 ? ` ${count} occurrences of` : ""} "${entity.text}"`, "remove");
    // Removal is per-tab on purpose. Cross-tab "remove" propagation is a
    // less-redaction decision: a string that's a false positive in this
    // doc may be real PII in a sibling doc, and we don't want to silently
    // unmask it before the user reviews that tab. Only "add" propagates
    // (more-redaction direction is always safe). Matches USAGE.md.
    renderDocTabs();
  } else {
    removedIndices.add(idx);
  }
  render();
}

function restoreEntity(idx: number): void {
  const entity = entities.find(e => e.idx === idx);
  if (entity) {
    const normText = entity.text.trim().toLowerCase();
    const type = entity.type;
    let count = 0;
    for (const e of entities) {
      if (e.text.trim().toLowerCase() === normText && e.type === type) {
        removedIndices.delete(e.idx);
        count++;
      }
    }
    showToast(`Restored${count > 1 ? ` ${count} occurrences of` : ""} "${entity.text}"`, "restore");
    // Restore is per-tab; the symmetric counterpart of removal staying per-tab.
    renderDocTabs();
  } else {
    removedIndices.delete(idx);
  }
  render();
}

function removeAdded(idx: number): void {
  addedEntities.splice(idx, 1);
  render();
}

function removeAddedGroup(groupKey: string): void {
  addedEntities = addedEntities.filter(e => makeGroupKey(e.type, e.text) !== groupKey);
  render();
}

function removeFamilyAll(indices: number[]): void {
  for (const idx of indices) removedIndices.add(idx);
  showToast(`Removed ${indices.length} entities (all variants)`, "remove");
  render();
}

function restoreFamilyAll(indices: number[]): void {
  for (const idx of indices) removedIndices.delete(idx);
  showToast(`Restored ${indices.length} entities (all variants)`, "restore");
  render();
}

// Reset in two clicks: the browser confirm() dialog is silently blocked by the host window.
let resetAskedAt = 0;
function resetAll(): void {
  if (removedIndices.size === 0 && addedEntities.length === 0 && merges.length === 0) { showToast("Rien à réinitialiser", "restore"); return; }
  const btn = $("reset-btn");
  if (Date.now() - resetAskedAt > 4000) {
    resetAskedAt = Date.now();
    btn.textContent = "Cliquer à nouveau pour confirmer";
    btn.style.color = "var(--financial)";
    window.setTimeout(() => {
      if (Date.now() - resetAskedAt >= 4000) { btn.textContent = "Réinitialiser"; btn.style.color = ""; }
    }, 4100);
    return;
  }
  resetAskedAt = 0;
  btn.textContent = "Réinitialiser";
  btn.style.color = "";
  removedIndices.clear();
  addedEntities = [];
  merges = [];
  showToast("Modifications réinitialisées", "restore");
  render();
}

// ── Group highlighting ──────────────────────────────────────────────────────

function highlightGroup(groupKey: string): void {
  if (!groupKey) return;
  document.querySelectorAll(`[data-group-key="${CSS.escape(groupKey)}"]`).forEach(el => el.classList.add("group-hover"));
}
function unhighlightGroup(groupKey: string): void {
  if (!groupKey) return;
  document.querySelectorAll(`[data-group-key="${CSS.escape(groupKey)}"]`).forEach(el => el.classList.remove("group-hover"));
}

// ── Toast ───────────────────────────────────────────────────────────────────

let toastTimer: number | null = null;
function showToast(message: string, type: "remove" | "restore"): void {
  const toast = $("toast");
  const icon = toast.querySelector(".toast-icon") as HTMLElement;
  const textEl = toast.querySelector(".toast-text") as HTMLElement;
  icon.textContent = type === "remove" ? "\u2796" : "\u2795";
  textEl.textContent = message;
  toast.classList.add("visible");
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2500);
}

// ── Selection → add entity ──────────────────────────────────────────────────

let pendingSelection: { text: string; start: number; end: number } | null = null;
let toolbarShownAt = 0;

function showToolbarForSelection(e: MouseEvent): void {
  const toolbar = $("selection-toolbar");
  const sel = window.getSelection();
  const text = (sel ? sel.toString() : "").trim();

  const target = e.target as HTMLElement | null;
  if (!sel || !text || text.length < 2 || target?.closest(".selection-toolbar") || target?.closest(".sidebar")) {
    if (!target?.closest(".selection-toolbar")) toolbar.classList.remove("visible");
    return;
  }

  const range = sel.getRangeAt(0);
  const container = $("doc-content");
  if (!container.contains(range.commonAncestorContainer)) {
    toolbar.classList.remove("visible");
    return;
  }

  const start = findTextPositionFromRange(range, container, text);
  if (start === -1) { toolbar.classList.remove("visible"); return; }
  pendingSelection = { text, start, end: start + text.length };

  // "+" on a label was clicked: the selection joins that label (same type, merged) without opening the menu.
  if (pendingAddTarget) {
    const target = pendingAddTarget;
    pendingAddTarget = null;
    document.body.classList.remove("mode-ajout");
    toolbar.classList.remove("visible");
    if (text.trim().toLowerCase() !== target.text.trim().toLowerCase()) merges.push({ type: target.type, from: text, to: target.text });
    addEntity(target.type);
    showToast(`Ajouté à « ${target.text} »`, "restore");
    return;
  }

  const rect = range.getBoundingClientRect();
  const toolbarW = 260;
  let left = rect.left + rect.width / 2 - toolbarW / 2;
  let top = rect.top - 44;
  left = Math.max(8, Math.min(left, window.innerWidth - toolbarW - 8));
  if (top < 8) top = rect.bottom + 8;
  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
  toolbar.classList.add("visible");
  toolbarShownAt = Date.now();

  // The full menu opens at once. If the selection is exactly a detection, choosing a type changes its category.
  changeTargetIds = selectionLabelIds();
  const menu = $("type-dropdown");
  menu.classList.toggle("mode-change", changeTargetIds !== null);
  menu.dataset.titre = "Changer la catégorie de cette étiquette";
  menu.classList.add("visible");
  placeMenu("type-dropdown");
}

function findTextPositionFromRange(range: Range, container: HTMLElement, selectedText: string): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent && parent.closest(".entity-tooltip")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let charOffset = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === range.startContainer) {
      const approxPos = charOffset + range.startOffset;
      if (originalText.substr(approxPos, selectedText.length) === selectedText) return approxPos;
      const searchStart = Math.max(0, approxPos - 100);
      const region = originalText.substring(searchStart, Math.min(originalText.length, approxPos + 100));
      const localIdx = region.indexOf(selectedText);
      if (localIdx !== -1) return searchStart + localIdx;
      return originalText.indexOf(selectedText);
    }
    charOffset += (node.textContent || "").length;
  }
  return originalText.indexOf(selectedText);
}

function addEntity(type: string): void {
  ($("type-dropdown")).classList.remove("visible", "mode-change");
  // Selection is exactly an existing detection: change the category of its label instead of adding.
  if (changeTargetIds) {
    const ids = changeTargetIds;
    changeTargetIds = null;
    $("selection-toolbar").classList.remove("visible");
    pendingSelection = null;
    window.getSelection()?.removeAllRanges();
    if (changeCategory(ids, type) > 0) showToast("Catégorie changée : " + typeLabel(type), "restore");
    render();
    return;
  }
  if (!pendingSelection) return;
  const searchText = pendingSelection.text;
  const newLen = searchText.length;
  let pos = 0;
  let count = 0;
  while ((pos = originalText.indexOf(searchText, pos)) !== -1) {
    const newStart = pos, newEnd = pos + newLen;
    const overlappingOriginals = entities.filter(e =>
      e.verified && !removedIndices.has(e.idx) && e.start < newEnd && e.end > newStart);
    const overlappingAdded = addedEntities.filter(e => e.start < newEnd && e.end > newStart);

    const blockedByExisting =
      overlappingOriginals.some(e => (e.end - e.start) >= newLen) ||
      overlappingAdded.some(e => (e.end - e.start) >= newLen);
    if (blockedByExisting) { pos += newLen; continue; }

    for (const e of overlappingOriginals) removedIndices.add(e.idx);
    addedEntities = addedEntities.filter(e => !(e.start < newEnd && e.end > newStart));
    addedEntities.push({ text: searchText, type, start: newStart, end: newEnd });
    count++;
    pos += newLen;
  }
  if (count > 1) showToast(`Added ${count} occurrences of "${searchText}"`, "restore");

  // Bulk: propagate the add decision to sibling (non-approved) sessions.
  propagateAddToSiblings(searchText, type);
  renderDocTabs();

  pendingSelection = null;
  ($("selection-toolbar")).classList.remove("visible");
  window.getSelection()?.removeAllRanges();
  render();
}

// ── Approve ────────────────────────────────────────────────────────────────

async function approve(): Promise<void> {
  setApproveBtnState(true, "Saving\u2026");

  // Snapshot current doc's in-flight state into bulk cache before sending.
  saveCurrentBulkState();

  // Bulk mode: send ALL sessions' overrides on every Approve click. Server
  // stores per-session; the overlay only shows when every doc is approved.
  if (isBulkMode()) {
    try {
      // Mark current doc as approved locally, then flush all pending sessions.
      bulkSessions[currentBulkIdx].approved = true;
      for (const s of bulkSessions) {
        const overrides = {
          remove: Array.from(s.state.removedIndices),
          add: s.state.addedEntities.map((e) => ({
            text: e.text,
            type: e.type,
            start: e.start,
            end: e.end,
          })),
          merge: s.state.merges || [],
        };
        // v2.1.3: include doc_id so the server can route overrides to the
        // correct PerDocReview inside a multi-file session. For legacy
        // single-doc sessions the server falls back to documents[0].
        const args: Record<string, unknown> = {
          session_id: s.session_id,
          overrides,
        };
        if (s.doc_id) args.doc_id = s.doc_id;
        await app.callServerTool({
          name: "apply_review_overrides",
          arguments: args,
        });
      }
      renderDocTabs();
      const allApproved = bulkSessions.every((s) => s.approved);
      if (allApproved) {
        $("approved-overlay").classList.add("visible");
      } else {
        setApproveBtnState(false, "Valider");
        showToast(
          `Validé "${bulkSessions[currentBulkIdx].source_filename}" \u2014 passage au document suivant`,
          "restore",
        );
        setTimeout(() => bulkAdvanceToNext(), 400);
      }
    } catch (err) {
      setApproveBtnState(false, "Valider");
      bulkSessions[currentBulkIdx].approved = false;
      renderDocTabs();
      showToast("Échec de l'enregistrement : " + (err instanceof Error ? err.message : String(err)), "remove");
    }
    return;
  }

  // Single-session mode (original behavior)
  const overrides = {
    remove: Array.from(removedIndices),
    add: addedEntities.map(e => ({ text: e.text, type: e.type, start: e.start, end: e.end })),
    merge: merges,
  };

  try {
    const args: Record<string, unknown> = {
      session_id: SESSION_ID,
      overrides,
    };
    // v2.1.3: include doc_id when server emitted one (multi-doc or
    // single-doc session with explicit doc id).
    if (DOC_ID) args.doc_id = DOC_ID;
    await app.callServerTool({
      name: "apply_review_overrides",
      arguments: args,
    });
    $("approved-overlay").classList.add("visible");
  } catch (err) {
    setApproveBtnState(false, "Valider");
    showToast("Échec de l'enregistrement : " + (err instanceof Error ? err.message : String(err)), "remove");
  }
}

// ── Scroll / split view ─────────────────────────────────────────────────────

function scrollToEntity(idx: number): void {
  const el = document.querySelector<HTMLElement>(
    `.entity[data-idx="${CSS.escape(String(idx))}"][data-source="original"]`,
  );
  if (!el) return;
  // scrollIntoView works through MCP Apps iframes because the iframe is
  // loaded as same-origin (srcdoc / about:blank), so it can drive the host
  // chat's scroll — effectively jumping the user to the entity location.
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  // Flash a briefly-visible outline so the user can spot the entity in a
  // dense document after the jump. Re-trigger by toggling the class.
  el.classList.remove("flash-highlight");
  // Force reflow so that removing + re-adding the class restarts the
  // animation if the user clicks the same entity twice in a row.
  void el.offsetWidth;
  el.classList.add("flash-highlight");
  window.setTimeout(() => el.classList.remove("flash-highlight"), 1300);
}

// French fork: two buttons, « Original » and « Pseudonymisé ». Both on = side by side; one = that view alone.
let showOriginal = true;
let showPseudonymized = true;
let scrollLinked = false;

function toggleView(which: "o" | "a"): void {
  if (which === "o") showOriginal = !showOriginal; else showPseudonymized = !showPseudonymized;
  if (!showOriginal && !showPseudonymized) { if (which === "o") showOriginal = true; else showPseudonymized = true; }
  updateViews();
}

function updateViews(): void {
  const main = $("main-container");
  splitView = showOriginal && showPseudonymized;
  main.classList.toggle("split-view", splitView);
  main.classList.toggle("only-anon", showPseudonymized && !showOriginal);
  $("btn-vue-orig").classList.toggle("active", showOriginal);
  $("btn-vue-anon").classList.toggle("active", showPseudonymized);
  if (showPseudonymized) renderAnonymizedPanel();
  if (splitView && !scrollLinked) { scrollLinked = true; setupScrollSync(); }
}

const PH_GROUP = ENTITY_GROUP;

function renderAnonymizedPanel(): void {
  const container = $("doc-content-anon");
  if (!anonymizedText) { container.textContent = "Texte anonymisé indisponible."; return; }
  const hasHtml = formatRuns.length > 0 || blockMap.length > 0;
  container.classList.toggle("html-mode", hasHtml);

  // French fork: the pseudonymized column is rebuilt from the original text and the current state of the panel
  // (removed detections stay in clear, additions and merges are replaced by their marker), so it follows every edit.
  const views: Entry[] = [
    ...entities.filter((s) => s.verified && !removedIndices.has(s.idx)),
    ...addedEntities,
  ].filter((s) => s.start >= 0 && s.end > s.start).sort((a, b) => a.start - b.start);

  let html = "";
  let pos = 0;
  for (const s of views) {
    if (s.start < pos) continue;
    const label = viewMarker(s);
    const isAdded = (addedEntities as Entry[]).includes(s);
    html += escapeHtml(originalText.slice(pos, s.start))
      + `<span class="anon-placeholder ph-${PH_GROUP[s.type] || "OTHER"}${isAdded ? " ph-added" : ""}">&lt;${escapeHtml(label)}&gt;</span>`;
    pos = s.end;
  }
  html += escapeHtml(originalText.slice(pos));
  const lines = html.split("\n");
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const tag = (hasHtml && blockMap[i] && blockMap[i].tag) || "p";
    out += `<${tag}>${lines[i]}</${tag}>`;
  }
  container.innerHTML = out;
}

function setupScrollSync(): void {
  const origPane = document.querySelector(".doc-pane-orig") as HTMLElement | null;
  const anonPane = document.querySelector(".doc-pane-anon") as HTMLElement | null;
  if (!origPane || !anonPane) return;
  let syncing = false;
  function syncScroll(source: HTMLElement, target: HTMLElement): void {
    if (syncing) return;
    syncing = true;
    const pct = source.scrollTop / (source.scrollHeight - source.clientHeight || 1);
    target.scrollTop = pct * (target.scrollHeight - target.clientHeight || 1);
    syncing = false;
  }
  origPane.addEventListener("scroll", () => syncScroll(origPane, anonPane));
  anonPane.addEventListener("scroll", () => syncScroll(anonPane, origPane));
}

// ── Keyboard navigation ─────────────────────────────────────────────────────

function focusFamily(idx: number): void {
  focusedFamilyIdx = idx;
  document.querySelectorAll(".entity.focused").forEach(el => el.classList.remove("focused"));
  document.querySelectorAll(".entity-item.focused").forEach(el => el.classList.remove("focused"));

  if (idx < 0 || idx >= currentFamilies.length) { focusedFamilyIdx = -1; return; }

  const fam = currentFamilies[idx];
  const groupKey = makeGroupKey(fam.type, fam.rootText);
  const sidebarItem = document.querySelector(`.entity-item[data-group-key="${CSS.escape(groupKey)}"]`);
  if (sidebarItem) {
    sidebarItem.classList.add("focused");
    sidebarItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  document.querySelectorAll(`.entity[data-group-key="${CSS.escape(groupKey)}"]`).forEach(el => el.classList.add("focused"));
  const firstIdx = fam.members[0].indices[0];
  if (typeof firstIdx === "number") scrollToEntity(firstIdx);
}

function getFocusedFamily(): Family | null {
  if (focusedFamilyIdx < 0 || focusedFamilyIdx >= currentFamilies.length) return null;
  return currentFamilies[focusedFamilyIdx];
}

document.addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement | null;
  const key = e.key;

  // `/` → focus the sidebar filter input. Works from anywhere in the iframe
  // EXCEPT when the filter input itself is already focused (so user can type
  // `/` into the search box). Must come BEFORE the INPUT/TEXTAREA early-return
  // below, otherwise it never fires when a sibling input has focus.
  if (key === "/" && tgt?.id !== "filter-input") {
    e.preventDefault();
    const input = document.getElementById("filter-input") as HTMLInputElement | null;
    input?.focus();
    input?.select();
    return;
  }

  if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0 && e.key !== "Escape" && e.key !== "Tab") return;

  if (key === "Tab") {
    e.preventDefault();
    if (currentFamilies.length === 0) return;
    if (e.shiftKey) {
      focusFamily(focusedFamilyIdx <= 0 ? currentFamilies.length - 1 : focusedFamilyIdx - 1);
    } else {
      focusFamily(focusedFamilyIdx >= currentFamilies.length - 1 ? 0 : focusedFamilyIdx + 1);
    }
    return;
  }
  if (key === "d" || key === "D") {
    const fam = getFocusedFamily();
    if (!fam) return;
    const allIndices = nums(fam.members.flatMap(m => m.indices));
    if (!allIndices.every(i => removedIndices.has(i))) {
      removeFamilyAll(allIndices);
      setTimeout(() => focusFamily(focusedFamilyIdx), 50);
    }
    return;
  }
  if (key === "r" || key === "R") {
    const fam = getFocusedFamily();
    if (!fam) return;
    const allIndices = nums(fam.members.flatMap(m => m.indices));
    if (allIndices.some(i => removedIndices.has(i))) {
      restoreFamilyAll(allIndices);
      setTimeout(() => focusFamily(focusedFamilyIdx), 50);
    }
    return;
  }
  if (key === "a" || key === "A") { approve(); return; }
  if (key === "Escape") {
    focusFamily(-1);
    $("selection-toolbar").classList.remove("visible");
    $("type-dropdown").classList.remove("visible");
    return;
  }
});

document.addEventListener("mousedown", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.closest(".type-dropdown") && !target?.closest(".type-btn-more")) {
    $("type-dropdown").classList.remove("visible");
  }
  if (!target?.closest(".selection-toolbar")) {
    setTimeout(() => {
      if (Date.now() - toolbarShownAt < 400) return;
      if (!target?.closest(".selection-toolbar")) {
        $("selection-toolbar").classList.remove("visible");
      }
    }, 300);
  }
});

document.addEventListener("mouseup", showToolbarForSelection);
document.addEventListener("dblclick", (e) => setTimeout(() => showToolbarForSelection(e), 10));

// ── Bulk helpers ────────────────────────────────────────────────────────────

/** Initialize bulk review from N sessions. Renders tabs, loads doc 0. */
function initBulk(sessions: SessionPayload[]): void {
  bulkSessions = sessions.map<BulkSession>((s) => ({
    session_id: s.session_id,
    doc_id: s.doc_id || "",
    source_filename: s.source_filename || s.session_id,
    approved: !!s.approved,
    payload: s,
    state: {
      merges: (s.overrides?.merge || []).slice(),
      removedIndices: new Set<number>((s.overrides?.remove as number[]) || []),
      addedEntities: ((s.overrides?.add || []) as AddedEntity[]).filter(
        (a) => a.start >= 0 && a.text,
      ),
    },
  }));
  currentBulkIdx = 0;
  ($("doc-tabs")).style.display = "flex";
  renderDocTabs();
  loadBulkDocument(0);
}

/** Render the tab strip with status icons + approved counter. */
function renderDocTabs(): void {
  const container = $("doc-tabs");
  if (bulkSessions.length === 0) {
    container.style.display = "none";
    return;
  }
  const approvedCount = bulkSessions.filter((s) => s.approved).length;
  let html = "";
  for (let i = 0; i < bulkSessions.length; i++) {
    const s = bulkSessions[i];
    const isActive = i === currentBulkIdx;
    const cls = `doc-tab ${isActive ? "active" : ""} ${s.approved ? "approved" : ""}`;
    const icon = s.approved ? "\u2705" : isActive ? "\u25CF" : "\u25CB";
    const name = s.source_filename;
    const short = name.length > 28 ? name.slice(0, 25) + "\u2026" : name;
    html +=
      `<div class="${cls}" data-idx="${i}" title="${escapeHtml(name)}">` +
      `<span class="status-icon">${icon}</span>` +
      `<span>${escapeHtml(short)}</span>` +
      `</div>`;
  }
  html +=
    `<div class="bulk-progress"><span class="count">${approvedCount}</span>/${bulkSessions.length} approved</div>`;
  container.innerHTML = html;
  for (const tab of Array.from(container.querySelectorAll<HTMLElement>(".doc-tab"))) {
    tab.addEventListener("click", () => {
      const idx = parseInt(tab.dataset.idx || "0", 10);
      switchDocument(idx);
    });
  }
}

/** Save the currently-loaded doc's in-flight user decisions back into bulkSessions. */
function saveCurrentBulkState(): void {
  if (!isBulkMode()) return;
  const s = bulkSessions[currentBulkIdx];
  if (!s) return;
  s.state = {
    removedIndices: new Set(removedIndices),
    addedEntities: addedEntities.slice(),
    merges: merges.slice(),
  };
}

/** Switch to doc at `idx` — saves current, loads target's cached payload + state. */
function switchDocument(idx: number): void {
  if (idx === currentBulkIdx || idx < 0 || idx >= bulkSessions.length) return;
  saveCurrentBulkState();
  currentBulkIdx = idx;
  loadBulkDocument(idx);
}

/** Load the bulk session at `idx` into the main panel. */
function loadBulkDocument(idx: number): void {
  const s = bulkSessions[idx];
  if (!s) return;
  // loadSession parses HTML + sets module state; then we overlay cached user decisions.
  loadSession(s.payload);
  removedIndices = new Set(s.state.removedIndices);
  addedEntities = s.state.addedEntities.slice();
  merges = s.state.merges ? s.state.merges.slice() : merges;
  render();
  renderDocTabs();
}

/** Advance to the next unapproved doc (wraps around). No-op if all approved. */
function bulkAdvanceToNext(): void {
  for (let i = 1; i <= bulkSessions.length; i++) {
    const nextIdx = (currentBulkIdx + i) % bulkSessions.length;
    if (!bulkSessions[nextIdx].approved) {
      switchDocument(nextIdx);
      return;
    }
  }
}

// ── Cross-document entity propagation ───────────────────────────────────────
// When the user adds an entity in doc A, scan the text of all OTHER unapproved
// docs in bulkSessions and automatically add the same text→type decision
// everywhere it appears (word-boundary). Symmetric for remove: if the user
// removes entity "Acme LLC" from doc A, mark matching text in other docs as
// removed too. This gives the user the "unified decisions across a batch"
// behavior they expect.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract plain text from a session payload (for regex scanning). */
function sessionText(s: BulkSession): string {
  return s.payload.original_text || "";
}

/** Add entity text+type to all sibling (non-approved, non-current) sessions. */
function propagateAddToSiblings(searchText: string, type: string): void {
  if (!isBulkMode() || searchText.trim().length < 3) return;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegex(searchText)}(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  for (let i = 0; i < bulkSessions.length; i++) {
    if (i === currentBulkIdx) continue;
    const s = bulkSessions[i];
    if (s.approved) continue;
    const text = sessionText(s);
    if (!text) continue;
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(text)) !== null) {
      const newStart = m.index;
      const newEnd = newStart + m[0].length;
      const exists = s.state.addedEntities.some(
        (a) => a.start === newStart && a.end === newEnd,
      );
      if (!exists) {
        s.state.addedEntities.push({
          text: m[0],
          type,
          start: newStart,
          end: newEnd,
        });
      }
    }
  }
}

/** Mark all entities in sibling sessions with matching text+type as removed. */
function propagateRemoveToSiblings(searchText: string, type: string): void {
  if (!isBulkMode() || searchText.trim().length < 3) return;
  const norm = searchText.trim().toLowerCase();
  for (let i = 0; i < bulkSessions.length; i++) {
    if (i === currentBulkIdx) continue;
    const s = bulkSessions[i];
    if (s.approved) continue;
    const siblingEntities = s.payload.entities || [];
    for (let j = 0; j < siblingEntities.length; j++) {
      const e = siblingEntities[j];
      if (e.type === type && (e.text || "").trim().toLowerCase() === norm) {
        s.state.removedIndices.add(j);
      }
    }
  }
}

/** Undo propagateRemove: un-mark entities with matching text+type in siblings. */
function propagateRestoreToSiblings(searchText: string, type: string): void {
  if (!isBulkMode() || searchText.trim().length < 3) return;
  const norm = searchText.trim().toLowerCase();
  for (let i = 0; i < bulkSessions.length; i++) {
    if (i === currentBulkIdx) continue;
    const s = bulkSessions[i];
    if (s.approved) continue;
    const siblingEntities = s.payload.entities || [];
    for (let j = 0; j < siblingEntities.length; j++) {
      const e = siblingEntities[j];
      if (e.type === type && (e.text || "").trim().toLowerCase() === norm) {
        s.state.removedIndices.delete(j);
      }
    }
  }
}

// ── Payload intake ──────────────────────────────────────────────────────────

function loadSession(payload: SessionPayload): void {
  SESSION_ID = payload.session_id || "";
  DOC_ID = payload.doc_id || "";
  originalText = payload.original_text || "";
  originalHtml = payload.html_text || payload.original_html || "";
  anonymizedText = payload.anonymized_text || "";
  entities = (payload.entities || []).map((e, i) => ({
    ...e, idx: i, verified: true,
  }));
  removedIndices = new Set((payload.overrides?.remove as number[]) || []);
  addedEntities = (payload.overrides?.add || []).filter(a => a.start >= 0 && a.text) as AddedEntity[];
  merges = (payload.overrides?.merge || []).slice();
  formatRuns = [];
  blockMap = [];
  if (originalHtml) parseHtmlFormatting(originalHtml);

  $("btn-vue-anon").style.display = anonymizedText ? "" : "none";
  $("btn-vue-orig").style.display = anonymizedText ? "" : "none";

  if (payload.approved) {
    $("approved-overlay").classList.add("visible");
  }

  render();
}

// ── Sidebar resize (drag-handle between .doc-panel and .sidebar) ─────────────
// The MCP Apps iframe auto-sizes HEIGHT only; width is fixed by the host chat
// column. Inside the iframe we're free to change .sidebar width via the
// `--sidebar-w` CSS variable on .main without triggering any ext-apps resize
// protocol side effects. Persist the preferred width in localStorage so it
// sticks across sessions (same idiom as `pii-theme`).
function initSidebarResize(): void {
  const handle = document.getElementById("resize-handle");
  const main = document.getElementById("main-container");
  if (!handle || !main) return;

  const SIDEBAR_W_MIN = 180;
  const SIDEBAR_W_MAX_ABS = 500;
  const STORAGE_KEY = "pii-sidebar-w";

  // Restore saved width from prior session, if any.
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const n = parseInt(saved, 10);
    if (Number.isFinite(n) && n >= SIDEBAR_W_MIN) {
      main.style.setProperty("--sidebar-w", `${n}px`);
    }
  }

  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");

    const startX = e.clientX;
    const currentW = getComputedStyle(main).getPropertyValue("--sidebar-w").trim();
    const startW = parseInt(currentW, 10) || 240;
    const mainW = main.clientWidth;
    // Max = min(500px, half the main-container width). Keeps the doc-panel
    // from collapsing below 50% on narrow chat columns.
    const sidebarMax = Math.max(SIDEBAR_W_MIN, Math.min(SIDEBAR_W_MAX_ABS, Math.floor(mainW * 0.5)));

    const onMove = (ev: PointerEvent) => {
      // Handle is LEFT of sidebar; dragging LEFT (clientX ↓) widens sidebar.
      const delta = ev.clientX - startX;
      const newW = Math.max(SIDEBAR_W_MIN, Math.min(sidebarMax, startW - delta));
      main.style.setProperty("--sidebar-w", `${newW}px`);
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      const finalW = getComputedStyle(main).getPropertyValue("--sidebar-w").trim();
      if (finalW) localStorage.setItem(STORAGE_KEY, finalW);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
}

// ── Sidebar filter input (search across entity text) ─────────────────────────
// Live-updating substring filter over families + added entities. Triggered by
// user typing into `#filter-input` (see review.html .sidebar-filter block) or
// by the `/` keyboard shortcut (see keydown listener). renderSidebar() reads
// the module-scoped `sidebarFilter` and shows a "N of M" counter.
function initSidebarFilter(): void {
  const input = document.getElementById("filter-input") as HTMLInputElement | null;
  if (!input) return;
  input.addEventListener("input", () => {
    sidebarFilter = input.value.trim().toLowerCase();
    renderSidebar();
  });
  // Pressing Escape inside the filter clears it + blurs — a quick way out
  // without reaching for the mouse. Other Escape usage (focus clear, close
  // dropdowns) is handled by the outer keydown listener after blur.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (input.value !== "") {
        input.value = "";
        sidebarFilter = "";
        renderSidebar();
      } else {
        input.blur();
      }
      e.stopPropagation();
    }
  });
}

// ── Wire top-bar buttons and selection toolbar ──────────────────────────────

function wireStaticHandlers(): void {
  $("theme-btn").addEventListener("click", toggleTheme);
  $("btn-vue-orig").addEventListener("click", () => toggleView("o"));
  $("btn-vue-anon").addEventListener("click", () => toggleView("a"));
  $("reset-btn").addEventListener("click", resetAll);
  $("approve-btn").addEventListener("click", () => { approve(); });
  // Bottom action bar — duplicates top Approve + offers "↑ To top" which
  // scrolls the host chat back to the panel header via scrollIntoView.
  const approveBottom = document.getElementById("approve-btn-bottom");
  if (approveBottom) approveBottom.addEventListener("click", () => { approve(); });
  const scrollTopBtn = document.getElementById("scroll-top-btn");
  if (scrollTopBtn) {
    scrollTopBtn.addEventListener("click", () => {
      const chromeEl = document.querySelector<HTMLElement>(".chrome");
      chromeEl?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  $("type-more-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    $("type-dropdown").classList.toggle("visible");
  });
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>(".selection-toolbar .type-btn[data-type]"))) {
    btn.addEventListener("click", () => addEntity(btn.dataset.type || "PERSON"));
  }
  // The "more types" menu is built from the single reference of types (French groups and labels).
  const dropdown = $("type-dropdown");
  dropdown.textContent = "";
  for (const [groupName, rows] of REFERENTIEL_ETIQUETTES) {
    const header = document.createElement("div");
    header.className = "type-dropdown-group";
    header.textContent = groupName;
    dropdown.appendChild(header);
    for (const [type, label, cssVar] of rows) {
      const item = document.createElement("div");
      item.className = "type-dropdown-item";
      item.dataset.type = type;
      item.appendChild(typeBadge(label, cssVar));
      dropdown.appendChild(item);
    }
    header.style.color = `var(${rows[0][2]})`;
  }
  // Groups fold and unfold on click; all folded at start.
  dropdown.addEventListener("click", (ev) => {
    const h = (ev.target as HTMLElement).closest<HTMLElement>(".type-dropdown-group");
    if (h) { ev.stopPropagation(); foldGroup(h); }
  }, true);
  for (const h of Array.from(dropdown.querySelectorAll<HTMLElement>(".type-dropdown-group"))) foldGroup(h);
  // Fusion and category boxes close on a click elsewhere.
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    for (const id of ["fusion-side", "cat-side"]) {
      const box = document.getElementById(id);
      if (box && box.classList.contains("visible") && !box.contains(t) && !t.closest("[data-action=merge-group],[data-action=cat-change]")) box.classList.remove("visible");
    }
  });
  // Right click on a mention: change the category of its label.
  document.addEventListener("contextmenu", (ev) => {
    const s = (ev.target as HTMLElement).closest<HTMLElement>(".entity[data-idx]");
    if (!s) return;
    ev.preventDefault();
    const idx = s.dataset.idx || "";
    const ids = labelIds[s.dataset.groupKey || ""] || [/^added_/.test(idx) ? "a" + idx.slice(6) : Number(idx)];
    openCategoryMenu(ids, ev.clientX, ev.clientY);
  }, true);
  // Escape cancels "add to a label".
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && pendingAddTarget) {
      pendingAddTarget = null;
      document.body.classList.remove("mode-ajout");
      showToast("Ajout annulé", "restore");
    }
  });
  for (const item of Array.from(document.querySelectorAll<HTMLElement>(".type-dropdown-item[data-type]"))) {
    item.addEventListener("click", () => addEntity(item.dataset.type || "PERSON"));
  }
}

// ── App class wiring ───────────────────────────────────────────────────────

const app = new App({ name: "pii-shield-review-ui", version: "2.0.0" });

app.ontoolresult = (result: CallToolResult) => {
  // v2.0.3 (issue #2): start_review returns metadata-only `sessions[]`. The
  // iframe pulls the unredacted payload for each session via the
  // model-invisible `get_review_payload` tool. This keeps raw PII out of the
  // host's tool-result channel and therefore out of Claude's context.
  //
  // Shape on the wire from start_review:
  //   structuredContent = { status: "review_ready", sessions: [
  //     { session_id, doc_id, source_filename, entity_count, approved, has_overrides },
  //     ...
  //   ], count, is_bulk }
  //
  // After pull, `payloads` holds the full SessionPayload objects the
  // initBulk / loadSession helpers already understand — no downstream
  // changes needed.
  const sc = (result as unknown as { structuredContent?: unknown }).structuredContent;
  if (!sc || typeof sc !== "object") return;
  const asContainer = sc as StartReviewStructuredContent;
  const metaList: SessionMetadata[] = Array.isArray(asContainer.sessions)
    ? asContainer.sessions
    : [];
  if (metaList.length === 0) {
    // Tolerate older servers that still inline the full payload on
    // structuredContent itself (single-session shape). After deploy this
    // branch is dead — kept until v2.0.3 ships to the field.
    const legacy = sc as SessionPayload;
    if (legacy && legacy.session_id) {
      bulkSessions = [];
      currentBulkIdx = 0;
      ($("doc-tabs")).style.display = "none";
      loadSession(legacy);
    }
    return;
  }

  // Fire-and-forget pull. ontoolresult itself stays sync (SDK signature) but
  // we kick off the async work below; the SDK does not require completion.
  void (async () => {
    const payloads: SessionPayload[] = [];
    for (const meta of metaList) {
      if (!meta || !meta.session_id) continue;
      try {
        const pull = await app.callServerTool({
          name: "get_review_payload",
          arguments: {
            session_id: meta.session_id,
            doc_id: meta.doc_id || "",
          },
        });
        const sc2 = (pull as unknown as { structuredContent?: unknown })
          .structuredContent;
        if (!sc2 || typeof sc2 !== "object") continue;
        const candidate = sc2 as SessionPayload & { error?: string };
        if (candidate.error || !candidate.session_id) continue;
        payloads.push(candidate);
      } catch (err) {
        console.error(
          "[panneau] échec de get_review_payload pour",
          meta.session_id,
          err,
        );
      }
    }
    if (payloads.length === 0) return;

    if (payloads.length >= 2) {
      initBulk(payloads);
      return;
    }
    const payload = payloads[0];
    bulkSessions = [];
    currentBulkIdx = 0;
    ($("doc-tabs")).style.display = "none";
    loadSession(payload);
  })();
};

app.onhostcontextchanged = (_ctx: McpUiHostContext) => {
  // Host-provided theme hints could be applied here via
  // applyHostStyleVariables — left as a future enhancement.
};

app.onerror = (err) => {
  console.error("[panneau] erreur de l'application :", err);
};

// ── Boot ───────────────────────────────────────────────────────────────────

initTheme();
wireStaticHandlers();
initSidebarResize();
initSidebarFilter();

app.connect().catch((err: unknown) => {
  console.error("[panneau] app.connect() rejeté :", err);
  $("doc-content").textContent =
    "Failed to connect to MCP host: " + (err instanceof Error ? err.message : String(err));
});
