import { strToU8, zipSync } from 'fflate';
import type { Contact, Entry, MoneyPart, Settings, Source, TrackerDoc, YearMonth } from '../model/types';
import { DEFAULT_SETTINGS, STATUS_LABELS } from '../model/types';
import { entryMonth, formatEUR, monthLabel, monthTotals, moneyTotal, turnoverByType } from '../model/entry';
import { typeColor, typeHasMoney, UNKNOWN_TYPE_COLOR } from '../model/taskTypes';
import type { MonthTotals } from '../model/entry';

export interface ExportOdsOptions {
  from?: YearMonth;
  to?: YearMonth;
  filter?: (e: Entry) => boolean;
}

export const ODS_MIMETYPE = 'application/vnd.oasis.opendocument.spreadsheet';
export const NO_DATE_SHEET = 'Без даты';
export const SUMMARY_SHEET = 'Итоги';

/** Колонки листа месяца. Сумма обязана быть в колонке F — на неё ссылаются формулы итогов. */
export const MONTH_COLUMNS: { title: string; width: string }[] = [
  { title: 'Дата', width: '2.2cm' },
  { title: 'Время', width: '2.4cm' },
  { title: 'Название', width: '6cm' },
  { title: 'Место', width: '4.5cm' },
  { title: 'Категория', width: '3.5cm' },
  { title: 'Сумма', width: '2.4cm' },
  { title: 'Где деньги', width: '4.5cm' },
  { title: 'Способ', width: '2.6cm' },
  { title: '№ инвойса', width: '2cm' },
  { title: 'Контакт', width: '5cm' },
  { title: 'Источник', width: '3cm' },
  { title: 'Статус', width: '3cm' },
  { title: 'Заметки', width: '7cm' },
];
const SUM_COL = 'F';

/** Колонки сводного листа; между «Оборот» и «Чистыми ≈» вставляется по колонке на каждый тип с деньгами. */
const SUMMARY_HEAD: { title: string; width: string }[] = [
  { title: 'Месяц', width: '3.6cm' },
  { title: 'Оборот', width: '2.6cm' },
];
const SUMMARY_TAIL: { title: string; width: string }[] = [
  { title: 'Чистыми ≈', width: '2.6cm' },
  { title: 'Получено', width: '2.6cm' },
  { title: 'У посредников', width: '2.8cm' },
  { title: 'У клиентов', width: '2.6cm' },
  { title: 'Задач', width: '2cm' },
];
const TYPE_COL_WIDTH = '2.6cm';
const SUMMARY_COLUMNS = [...SUMMARY_HEAD, ...SUMMARY_TAIL];

const METHOD_LABELS: Record<string, string> = { cash: 'нал', revolut: 'револют', bank: 'счёт' };

// ---------- XML-помощники ----------

// Символы, недопустимые в XML 1.0, выбрасываем.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function xmlEscape(s: string): string {
  return s
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Одна строка текста → содержимое text:p с сохранением повторных пробелов и табов. */
function paragraphContent(line: string): string {
  let out = '';
  const re = /( {2,}|\t)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    out += xmlEscape(line.slice(last, m.index));
    if (m[0] === '\t') out += '<text:tab/>';
    else out += ' <text:s text:c="' + (m[0].length - 1) + '"/>';
    last = m.index + m[0].length;
  }
  out += xmlEscape(line.slice(last));
  return out;
}

/** Текст ячейки: каждая строка — отдельный text:p. */
function paragraphs(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => '<text:p>' + paragraphContent(l) + '</text:p>')
    .join('');
}

function styleAttr(style?: string): string {
  return style ? ` table:style-name="${style}"` : '';
}

function textCell(text: string | undefined, style?: string): string {
  if (!text) return `<table:table-cell${styleAttr(style)}/>`;
  return `<table:table-cell${styleAttr(style)} office:value-type="string">${paragraphs(text)}</table:table-cell>`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function currencyCell(value: number, style: string, formula?: string): string {
  const f = formula ? ` table:formula="${xmlEscape(formula)}"` : '';
  const v = round2(value);
  return (
    `<table:table-cell${styleAttr(style)}${f} office:value-type="currency" office:currency="EUR" office:value="${v}">` +
    `<text:p>${xmlEscape(formatEUR(v))}</text:p></table:table-cell>`
  );
}

function floatCell(value: number, style?: string, formula?: string): string {
  const f = formula ? ` table:formula="${xmlEscape(formula)}"` : '';
  return `<table:table-cell${styleAttr(style)}${f} office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`;
}

function row(cells: string[], style = 'ro1'): string {
  return `<table:table-row table:style-name="${style}">${cells.join('')}</table:table-row>`;
}

// ---------- Форматирование полей записи ----------

function ddmm(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

export function formatDate(e: Pick<Entry, 'date' | 'dateEnd' | 'dateTentative'>): string {
  if (!e.date) return e.dateTentative ? '?' : '';
  let s = ddmm(e.date);
  if (e.dateEnd && e.dateEnd !== e.date) s += '–' + ddmm(e.dateEnd);
  if (e.dateTentative) s += '?';
  return s;
}

export function formatTime(e: Pick<Entry, 'timeStart' | 'timeEnd' | 'timeNote'>): string {
  let s = '';
  if (e.timeStart) s = e.timeEnd ? `${e.timeStart}–${e.timeEnd}` : e.timeStart;
  if (e.timeNote) s = s ? `${s} (${e.timeNote})` : e.timeNote;
  return s;
}

function num(n: number): string {
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

/** Человекочитаемо: «получено», «у посредника: Петя 200», «у клиента», «получено 150; у клиента 150». */
export function formatMoneyWhere(e: Entry, sources: Map<string, Source>, settings: Settings = DEFAULT_SETTINGS): string {
  if (!typeHasMoney(settings, e.type) || !e.amount) return '';
  const owner = moneyTotal(e.money, 'owner');
  const byHolder = new Map<string, number>();
  for (const p of e.money) {
    if (p.where !== 'intermediary') continue;
    const name = (p.holderId && sources.get(p.holderId)?.name) || 'посредник';
    byHolder.set(name, (byHolder.get(name) ?? 0) + p.amount);
  }
  const inter = moneyTotal(e.money, 'intermediary');
  const client = Math.max(0, e.amount - owner - inter);
  const parts: string[] = [];
  const single = [owner > 0, inter > 0, client > 0].filter(Boolean).length === 1;
  if (owner > 0) parts.push(single ? 'получено' : `получено ${num(owner)}`);
  for (const [name, a] of byHolder) parts.push(`у посредника: ${name} ${num(a)}`);
  if (client > 0) parts.push(single ? 'у клиента' : `у клиента ${num(client)}`);
  return parts.join('; ');
}

function formatMethods(parts: MoneyPart[]): string {
  const seen: string[] = [];
  for (const p of parts) {
    if (!p.method) continue;
    const label = METHOD_LABELS[p.method] ?? p.method;
    if (!seen.includes(label)) seen.push(label);
  }
  return seen.join(', ');
}

function formatContact(c: Contact | undefined): string {
  if (!c) return '';
  const lines = [c.name, ...c.phones, ...c.channels.map((ch) => `${ch.kind}: ${ch.value}`)];
  return lines.filter(Boolean).join('\n');
}

function formatNotes(e: Entry): string {
  const lines: string[] = [];
  if (e.notes) lines.push(e.notes);
  for (const it of e.checklist) lines.push((it.done ? '☑ ' : '☐ ') + it.text);
  return lines.join('\n');
}

/** Сумма записи идёт в формулу итога, только если её считает monthTotals. */
function amountCounted(e: Entry, settings: Settings): boolean {
  return e.amount !== undefined && e.status !== 'cancelled' && typeHasMoney(settings, e.type);
}

// ---------- Отбор и группировка ----------

function compareEntries(a: Entry, b: Entry): number {
  const ka = (a.date ?? '9999-99-99') + (a.timeStart ?? '99:99');
  const kb = (b.date ?? '9999-99-99') + (b.timeStart ?? '99:99');
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.title.localeCompare(b.title, 'ru');
}

interface SheetGroup {
  month?: YearMonth;
  name: string;
  entries: Entry[];
  totals: MonthTotals;
}

const NO_DATE_KEY = '0000-00';

function totalsFor(entries: Entry[], month: YearMonth | undefined, doc: TrackerDoc): MonthTotals {
  if (month) return monthTotals(entries, month, doc.settings);
  // monthTotals умеет только месяц — для «Без даты» подставляем служебный ключ.
  const t = monthTotals(
    entries.map((e) => ({ ...e, accountingMonth: NO_DATE_KEY })),
    NO_DATE_KEY,
    doc.settings,
  );
  return t;
}

function groupEntries(doc: TrackerDoc, opts: ExportOdsOptions): SheetGroup[] {
  const byMonth = new Map<string, Entry[]>();
  const noDate: Entry[] = [];
  for (const e of doc.entries) {
    if (e.deleted) continue;
    if (opts.filter && !opts.filter(e)) continue;
    const m = entryMonth(e);
    if (!m) {
      // Без месяца в период не попадают; выгружаются, только если период не задан.
      if (!opts.from && !opts.to) noDate.push(e);
      continue;
    }
    if (opts.from && m < opts.from) continue;
    if (opts.to && m > opts.to) continue;
    const list = byMonth.get(m) ?? [];
    list.push(e);
    byMonth.set(m, list);
  }
  const groups: SheetGroup[] = [...byMonth.keys()].sort().map((m) => {
    const entries = byMonth.get(m)!.sort(compareEntries);
    return { month: m, name: monthLabel(m), entries, totals: totalsFor(entries, m, doc) };
  });
  if (noDate.length) {
    noDate.sort(compareEntries);
    groups.push({ name: NO_DATE_SHEET, entries: noDate, totals: totalsFor(noDate, undefined, doc) });
  }
  return groups;
}

// ---------- Стили ----------

function normColor(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  const s = c.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return ('#' + [...s.slice(1)].map((ch) => ch + ch).join('')).toLowerCase();
  return fallback;
}

/** Цвет фона строки записи (#rrggbb) — цвет её типа. */
function entryColor(e: Entry, settings: Settings): string {
  return normColor(typeColor(settings, e.type), UNKNOWN_TYPE_COLOR);
}

/** Имя автостиля ячейки по цвету фона (один стиль на каждый используемый цвет). */
export function colorCellStyle(color: string, currency = false): string {
  return `ce_bg_${color.replace('#', '')}${currency ? '_cur' : ''}`;
}

function automaticStyles(doc: TrackerDoc, groups: SheetGroup[]): string {
  const colors = new Set<string>();
  for (const g of groups) for (const e of g.entries) colors.add(entryColor(e, doc.settings));
  const cols = [...MONTH_COLUMNS, ...SUMMARY_COLUMNS]
    .map((c) => c.width)
    .filter((w, i, a) => a.indexOf(w) === i);
  let s = '<office:automatic-styles>';
  s +=
    '<number:currency-style style:name="N_EUR">' +
    '<number:currency-symbol number:language="en" number:country="IE">€</number:currency-symbol>' +
    '<number:number number:decimal-places="2" number:min-decimal-places="0" number:min-integer-digits="1" number:grouping="true"/>' +
    '</number:currency-style>';
  cols.forEach((w, i) => {
    s += `<style:style style:name="co${i + 1}" style:family="table-column"><style:table-column-properties fo:break-before="auto" style:column-width="${w}"/></style:style>`;
  });
  s +=
    '<style:style style:name="ro1" style:family="table-row"><style:table-row-properties fo:break-before="auto" style:use-optimal-row-height="true"/></style:style>';
  s +=
    '<style:style style:name="ta1" style:family="table" style:master-page-name="Default"><style:table-properties table:display="true" style:writing-mode="lr-tb"/></style:style>';
  const cell = (name: string, bg: string | undefined, bold: boolean, currency: boolean) =>
    `<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="Default"${currency ? ' style:data-style-name="N_EUR"' : ''}>` +
    `<style:table-cell-properties${bg ? ` fo:background-color="${bg}"` : ''} fo:wrap-option="wrap" style:vertical-align="top"/>` +
    (bold ? '<style:text-properties fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"/>' : '') +
    '</style:style>';
  s += cell('ce_head', '#e0e0e0', true, false);
  s += cell('ce_total', undefined, true, false);
  s += cell('ce_total_cur', undefined, true, true);
  s += cell('ce_plain', undefined, false, false);
  s += cell('ce_plain_cur', undefined, false, true);
  for (const bg of colors) {
    s += cell(colorCellStyle(bg), bg, false, false);
    s += cell(colorCellStyle(bg, true), bg, false, true);
  }
  s += '</office:automatic-styles>';
  return s;
}

function columnStyleName(width: string): string {
  const cols = [...MONTH_COLUMNS, ...SUMMARY_COLUMNS]
    .map((c) => c.width)
    .filter((w, i, a) => a.indexOf(w) === i);
  return 'co' + (cols.indexOf(width) + 1);
}

function columns(defs: { width: string }[]): string {
  return defs
    .map((c) => `<table:table-column table:style-name="${columnStyleName(c.width)}" table:default-cell-style-name="Default"/>`)
    .join('');
}

// ---------- Листы ----------

interface SheetCtx {
  contacts: Map<string, Contact>;
  sources: Map<string, Source>;
  settings: Settings;
}

function entryRow(e: Entry, ctx: SheetCtx): string {
  const color = entryColor(e, ctx.settings);
  const st = colorCellStyle(color);
  const amountCell =
    e.amount === undefined
      ? textCell('', st)
      : amountCounted(e, ctx.settings)
        ? currencyCell(e.amount, colorCellStyle(color, true))
        : textCell(formatEUR(e.amount) + (e.status === 'cancelled' ? ' (отменено)' : ''), st);
  const place = [e.location, e.mapUrl].filter(Boolean).join('\n');
  return row([
    textCell(formatDate(e), st),
    textCell(formatTime(e), st),
    textCell(e.title, st),
    textCell(place, st),
    textCell(e.category, st),
    amountCell,
    textCell(formatMoneyWhere(e, ctx.sources, ctx.settings), st),
    textCell(formatMethods(e.money), st),
    textCell(e.invoiceNo, st),
    textCell(formatContact(e.contactId ? ctx.contacts.get(e.contactId) : undefined), st),
    textCell(e.sourceId ? ctx.sources.get(e.sourceId)?.name : undefined, st),
    textCell(STATUS_LABELS[e.status] ?? e.status, st),
    textCell(formatNotes(e), st),
  ]);
}

function labelledRow(label: string, value: string): string {
  // Подпись в колонке E, значение — в колонке суммы F.
  return row([
    `<table:table-cell table:number-columns-repeated="4"/>`,
    textCell(label, 'ce_total'),
    value,
  ]);
}

function headerRow(defs: { title: string }[]): string {
  return row(defs.map((c) => textCell(c.title, 'ce_head')));
}

function monthSheet(g: SheetGroup, doc: TrackerDoc, ctx: SheetCtx): string {
  const rows: string[] = [headerRow(MONTH_COLUMNS)];
  for (const e of g.entries) rows.push(entryRow(e, ctx));
  const n = g.entries.length + 1; // последняя строка с записями
  const sumRow = n + 1;
  const counted = g.entries.filter((e) => amountCounted(e, ctx.settings)).reduce((s, e) => s + (e.amount ?? 0), 0);
  const nf = doc.settings.netFactor;
  rows.push(labelledRow('Итого', currencyCell(counted, 'ce_total_cur', `of:=SUM([.${SUM_COL}2:.${SUM_COL}${n}])`)));
  rows.push(labelledRow('чистыми ≈', currencyCell(counted * nf, 'ce_total_cur', `of:=[.${SUM_COL}${sumRow}]*${nf}`)));
  rows.push(labelledRow('получено', currencyCell(g.totals.received, 'ce_total_cur')));
  rows.push(labelledRow('у посредников', currencyCell(g.totals.atIntermediary, 'ce_total_cur')));
  rows.push(labelledRow('у клиентов', currencyCell(g.totals.atClient, 'ce_total_cur')));
  return (
    `<table:table table:name="${xmlEscape(g.name)}" table:style-name="ta1">` +
    columns(MONTH_COLUMNS) +
    rows.join('') +
    '</table:table>'
  );
}

/** Буква колонки по индексу (0 → A, 26 → AA). */
function colLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function summarySheet(groups: SheetGroup[], doc: TrackerDoc): string {
  // Колонка на каждый тип с деньгами + неизвестные id, по которым есть суммы.
  const all: Record<string, number> = {};
  for (const g of groups) for (const [id, a] of Object.entries(g.totals.byType)) all[id] = (all[id] ?? 0) + a;
  const types = turnoverByType(doc.settings, all, { allTypes: true });
  const defs = [...SUMMARY_HEAD, ...types.map((t) => ({ title: t.name, width: TYPE_COL_WIDTH })), ...SUMMARY_TAIL];
  const rows: string[] = [headerRow(defs)];
  for (const g of groups) {
    const t = g.totals;
    rows.push(
      row([
        textCell(g.name, 'ce_plain'),
        currencyCell(t.turnover, 'ce_plain_cur'),
        ...types.map((x) => currencyCell(t.byType[x.id] ?? 0, 'ce_plain_cur')),
        currencyCell(t.net, 'ce_plain_cur'),
        currencyCell(t.received, 'ce_plain_cur'),
        currencyCell(t.atIntermediary, 'ce_plain_cur'),
        currencyCell(t.atClient, 'ce_plain_cur'),
        floatCell(t.jobs, 'ce_plain'),
      ]),
    );
  }
  if (groups.length) {
    const last = groups.length + 1;
    type NumKey = 'turnover' | 'net' | 'received' | 'atIntermediary' | 'atClient' | 'jobs';
    const sum = (k: NumKey) => groups.reduce((s, g) => s + g.totals[k], 0);
    const values = [
      sum('turnover'),
      ...types.map((x) => groups.reduce((s, g) => s + (g.totals.byType[x.id] ?? 0), 0)),
      sum('net'),
      sum('received'),
      sum('atIntermediary'),
      sum('atClient'),
    ];
    const formula = (i: number) => `of:=SUM([.${colLetter(i)}2:.${colLetter(i)}${last}])`;
    rows.push(
      row([
        textCell('Всего', 'ce_total'),
        ...values.map((v, i) => currencyCell(v, 'ce_total_cur', formula(i + 1))),
        floatCell(sum('jobs'), 'ce_total', formula(values.length + 1)),
      ]),
    );
  }
  return (
    `<table:table table:name="${SUMMARY_SHEET}" table:style-name="ta1">` +
    columns(defs) +
    rows.join('') +
    '</table:table>'
  );
}

// ---------- Файлы пакета ----------

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" ' +
  'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" ' +
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/"';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

function contentXml(doc: TrackerDoc, groups: SheetGroup[]): string {
  const ctx: SheetCtx = {
    contacts: new Map(doc.contacts.filter((c) => !c.deleted).map((c) => [c.id, c])),
    sources: new Map(doc.sources.map((s) => [s.id, s])),
    settings: doc.settings,
  };
  return (
    XML_HEAD +
    `<office:document-content ${NS} office:version="1.3">` +
    automaticStyles(doc, groups) +
    '<office:body><office:spreadsheet>' +
    summarySheet(groups, doc) +
    groups.map((g) => monthSheet(g, doc, ctx)).join('') +
    '</office:spreadsheet></office:body></office:document-content>'
  );
}

function stylesXml(): string {
  return (
    XML_HEAD +
    `<office:document-styles ${NS} office:version="1.3">` +
    '<office:styles>' +
    '<style:default-style style:family="table-cell"><style:paragraph-properties style:tab-stop-distance="1.25cm"/>' +
    '<style:text-properties fo:font-size="10pt" style:font-name="Liberation Sans" fo:language="ru" fo:country="RU"/></style:default-style>' +
    '<style:style style:name="Default" style:family="table-cell"/>' +
    '</office:styles>' +
    '<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties style:print-orientation="landscape"/></style:page-layout></office:automatic-styles>' +
    '<office:master-styles><style:master-page style:name="Default" style:page-layout-name="pm1"/></office:master-styles>' +
    '</office:document-styles>'
  );
}

function metaXml(): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, '');
  return (
    XML_HEAD +
    `<office:document-meta ${NS} office:version="1.3"><office:meta>` +
    '<meta:generator>work-life-tracker</meta:generator>' +
    '<dc:title>Трекер работы</dc:title>' +
    `<meta:creation-date>${now}</meta:creation-date><dc:date>${now}</dc:date>` +
    '</office:meta></office:document-meta>'
  );
}

function manifestXml(): string {
  return (
    XML_HEAD +
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${ODS_MIMETYPE}"/>` +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
    '</manifest:manifest>'
  );
}

/** Собрать .ods: лист на месяц + сводный лист, фон строки — цвет типа, формулы итогов (SPEC §8). */
export function exportOds(doc: TrackerDoc, opts: ExportOdsOptions = {}): Uint8Array {
  const groups = groupEntries(doc, opts);
  // Порядок ключей важен: mimetype обязан быть первым и несжатым.
  return zipSync({
    mimetype: [strToU8(ODS_MIMETYPE), { level: 0 }],
    'META-INF/manifest.xml': [strToU8(manifestXml()), { level: 6 }],
    'content.xml': [strToU8(contentXml(doc, groups)), { level: 6 }],
    'styles.xml': [strToU8(stylesXml()), { level: 6 }],
    'meta.xml': [strToU8(metaXml()), { level: 6 }],
  });
}
