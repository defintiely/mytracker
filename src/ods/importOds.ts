// Импорт трекера из .ods (SPEC §9): лист = месяц, строка = запись, итог SUM — для сверки.
import type { Contact, Entry, EntryOrigin, EntryType, ISODate, Settings, Source, YearMonth } from '../model/types';
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../model/types';
import { newEntry, newId, nowIso } from '../model/entry';
import { defaultNoMoneyTypeId, defaultTypeId, typeHasMoney } from '../model/taskTypes';
import { readOds } from './readOds';
import type {
  ColorStat,
  ImportedRow,
  ImportOptions,
  ImportResult,
  MonthCheck,
  OdsCell,
  OdsRow,
  OdsSheet,
  SkippedRow,
} from './types';
import {
  BUILTIN_SOURCES,
  buildMoney,
  paymentKindDefaults,
  classify,
  cleanText,
  contactNameFrom,
  findCategory,
  findContactInfo,
  findInvoice,
  findPayment,
  findSource,
  findTimes,
  isTimeCellText,
  isoDate,
  monthFromWord,
  nameForms,
  pastNearestYear,
  normalizeTimeText,
  parseDatePrefix,
  parseTimeCell,
  phoneKey,
  statusFor,
  todayIso,
  yearMonth,
  type ContactInfo,
  type TimeInfo,
} from './parseLine';

// ───────────────────────── публичные помощники ─────────────────────────

/** Ключ повторного импорта: `${sheet}|${row}|${raw}` (SPEC §9 п.6). */
export function originKey(o: EntryOrigin): string {
  return `${o.sheet}|${o.row}|${o.raw}`;
}

/** Сырой текст строки: ячейки через « | », хвост пустых отрезан. */
export function rowRaw(cells: OdsCell[]): string {
  return cells
    .map((c) => c.text.replace(/\n/g, ' / '))
    .join(' | ')
    .replace(/(\s*\|\s*)+$/, '')
    .trim();
}

/** «Июнь  2024» → { month: 6, year: 2024 }; «июнь» → { month: 6 }; «Sheet3» → undefined. */
export function parseSheetName(name: string): { month: number; year?: number } | undefined {
  const n = name.replace(/[\s ]+/g, ' ').trim().toLowerCase();
  const m = /^(\p{L}+)(?:\s+(\d{4}))?$/u.exec(n);
  if (!m) return undefined;
  const month = monthFromWord(m[1]);
  if (!month) return undefined;
  // Только полные названия месяцев, а не случайные слова на «ма…».
  if (m[1].length < 3) return undefined;
  return m[2] ? { month, year: Number(m[2]) } : { month };
}

/**
 * Год и месяц каждого листа. Листы без года считаются по порядку назад от ближайшего
 * следующего листа с годом («июнь»…«январь» перед «февраль 2023» → июнь 2022…январь 2023).
 */
export function resolveSheetMonths(names: string[], fallbackYear: number): (YearMonth | undefined)[] {
  const parsed = names.map(parseSheetName);
  const out: (YearMonth | undefined)[] = parsed.map((p) => (p?.year ? yearMonth(p.year, p.month) : undefined));
  // назад от листов с годом
  let cursor: { y: number; m: number } | undefined;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const p = parsed[i];
    if (!p) continue;
    if (p.year) {
      cursor = { y: p.year, m: p.month };
      continue;
    }
    if (cursor) {
      const y = p.month < cursor.m ? cursor.y : cursor.y - 1;
      out[i] = yearMonth(y, p.month);
      cursor = { y, m: p.month };
    }
  }
  // вперёд — если листов с годом после нет совсем
  let prev: { y: number; m: number } | undefined;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (!p) continue;
    if (out[i]) {
      const [y, m] = out[i]!.split('-').map(Number);
      prev = { y, m };
      continue;
    }
    const y = prev ? (p.month > prev.m ? prev.y : prev.y + 1) : fallbackYear;
    out[i] = yearMonth(y, p.month);
    prev = { y, m: p.month };
  }
  return out;
}

// ───────────────────────── итог листа ─────────────────────────

interface SumInfo {
  pos: number; // позиция строки в sheet.rows
  col: number; // колонка суммы (из формулы)
  value?: number;
  fromRow: number;
  toRow: number;
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function findSum(sheet: OdsSheet): SumInfo | undefined {
  for (let pos = 0; pos < sheet.rows.length; pos++) {
    for (const c of sheet.rows[pos].cells) {
      if (!c.formula || !/SUM\s*\(/i.test(c.formula)) continue;
      const m = /\[?\$?'?[^.\]]*'?\.?\$?([A-Z]+)\$?(\d+)\s*:\s*\.?\$?([A-Z]+)\$?(\d+)\]?/i.exec(c.formula.replace(/^of:=?/i, ''));
      if (!m) continue;
      return { pos, col: colIndex(m[1]), value: c.value, fromRow: Number(m[2]), toRow: Number(m[4]) };
    }
  }
  return undefined;
}

function isFormulaRow(row: OdsRow): boolean {
  return row.cells.some((c) => !!c.formula);
}

// ───────────────────────── справочники ─────────────────────────

/** Имя-заглушка из ссылки/ника: «https://www.facebook.com/anna.k» → «anna.k». */
function handleName(v: string): string {
  const m = /(?:facebook\.com|instagram\.com|fb\.com)\/(?:profile\.php\?id=)?([^/?#\s]+)/i.exec(v);
  return m ? m[1] : v;
}

class Registry {
  readonly newSources: Source[] = [];
  readonly newContacts: Contact[] = [];
  private sources: Source[];
  private contacts: Contact[];
  constructor(existingSources: Source[], existingContacts: Contact[]) {
    this.sources = existingSources.filter((s) => !s.deleted);
    this.contacts = existingContacts.filter((c) => !c.deleted);
  }

  allSources(): Source[] {
    return [...this.sources, ...this.newSources];
  }

  /** Источник по имени (или алиасу); если нет — создать. */
  source(name: string): Source {
    const low = name.toLowerCase();
    const found = this.allSources().find(
      (s) => s.name.toLowerCase() === low || s.aliases.some((a) => a.toLowerCase() === low),
    );
    if (found) return found;
    const builtin = BUILTIN_SOURCES.find((b) => b.name.toLowerCase() === low);
    const t = nowIso();
    const s: Source = {
      id: newId(),
      name,
      aliases: builtin ? [...builtin.aliases] : nameForms(name),
      createdAt: t,
      updatedAt: t,
    };
    this.newSources.push(s);
    return s;
  }

  /** Контакт: слить по телефону (последние 8 цифр), без телефона — по точному имени. */
  contact(name: string | undefined, phones: string[], channels: Contact['channels']): Contact | undefined {
    const linked = channels.filter((c) => c.value && !/^\+?\d+$/.test(c.value)); // ссылки и ники
    if (!phones.length && !name && !linked.length) return undefined;
    const keys = phones.map(phoneKey);
    const all = [...this.contacts, ...this.newContacts];
    let found = keys.length ? all.find((c) => c.phones.some((p) => keys.includes(phoneKey(p)))) : undefined;
    if (!found && linked.length) {
      const vals = linked.map((c) => c.value.toLowerCase());
      found = all.find((c) => c.channels.some((ch) => vals.includes(ch.value.toLowerCase())));
    }
    if (!found && !phones.length && name) {
      const low = name.toLowerCase();
      found = all.find((c) => c.phones.length === 0 && c.name.toLowerCase() === low);
    }
    if (found) {
      if (this.newContacts.includes(found)) {
        for (const p of phones) {
          const i = found.phones.findIndex((q) => phoneKey(q) === phoneKey(p));
          if (i < 0) found.phones.push(p);
          else if (p.replace(/\D/g, '').length > found.phones[i].replace(/\D/g, '').length) found.phones[i] = p;
        }
        for (const ch of channels) {
          if (!found.channels.some((c) => c.kind === ch.kind && (c.value === ch.value || !ch.value))) found.channels.push(ch);
        }
        if ((!found.name || /^\+?\d+$/.test(found.name)) && name) found.name = name;
      }
      return found;
    }
    const t = nowIso();
    const c: Contact = {
      id: newId(),
      name: name ?? phones[0] ?? handleName(linked[0].value),
      phones: [...phones],
      channels: [...channels],
      createdAt: t,
      updatedAt: t,
    };
    this.newContacts.push(c);
    return c;
  }
}

// ───────────────────────── разбор строки листа ─────────────────────────

interface SheetCtx {
  name: string;
  ym: YearMonth;
  year: number;
  month: number;
  amountCol: number;
  today: ISODate;
  opts: ImportOptions;
  reg: Registry;
  colorVotes: Map<string, ColorAcc>;
  types: ImportTypes;
}

/** Типы для импорта: флаг «с деньгами» и типы для строк без цвета. */
interface ImportTypes {
  /** Настройки-обёртка над типами (для typeHasMoney). */
  settings: Settings;
  moneyTypeId: EntryType;
  noMoneyTypeId: EntryType;
  categories: string[];
}

function importTypes(opts: ImportOptions): ImportTypes {
  const settings: Settings = { ...DEFAULT_SETTINGS, taskTypes: opts.taskTypes ?? DEFAULT_SETTINGS.taskTypes };
  return {
    settings,
    moneyTypeId: opts.moneyTypeId ?? defaultTypeId(settings),
    noMoneyTypeId: opts.noMoneyTypeId ?? defaultNoMoneyTypeId(settings),
    categories: opts.categories ?? DEFAULT_CATEGORIES,
  };
}

interface ColorAcc {
  count: number;
  samples: string[];
  withMoney: number;
}

interface RowOutput {
  imported: ImportedRow;
  /** Сумма, которая идёт в сверку с SUM. */
  amountForCheck: number;
}

function isNumeric(c: OdsCell): boolean {
  return (c.valueType === 'float' || c.valueType === 'currency' || c.valueType === 'percentage') && c.value !== undefined;
}

/** Похоже ли число в ячейке на дату дд.мм этого месяца (боковой календарь, как в сентябре 2025). */
function sideDate(c: OdsCell, ctx: SheetCtx): number | undefined {
  if (c.valueType !== 'float' || c.value === undefined || Number.isInteger(c.value)) return undefined;
  const v = Math.round(c.value * 100);
  if (Math.abs(c.value * 100 - v) > 1e-6) return undefined;
  const d = Math.floor(v / 100);
  const m = v % 100;
  if (m !== ctx.month || d < 1 || d > 31) return undefined;
  return d;
}

/** Ячейка состоит только из служебных слов (оплачено, нал, инв, «/», done…). */
function isTokenOnly(text: string, extraSpans: [number, number][] = []): boolean {
  const pay = findPayment(text);
  const inv = findInvoice(text);
  const spans = [...pay.spans, ...extraSpans];
  if (inv.span) spans.push(inv.span);
  let rest = text;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) rest = rest.slice(0, a) + ' ' + rest.slice(b);
  rest = rest.replace(/(?<![\p{L}])(done|пришло|не\s+пришло|оплачено|над|за\s+оба\s+дня)(?![\p{L}])/giu, ' ');
  return /^[\s/*?.,!+\-—–:;]*$/u.test(rest);
}

function cutText(s: string, spans: [number, number][]): string {
  let out = s;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + ' ' + out.slice(b);
  return out;
}

interface RowParseInput {
  cells: OdsCell[]; // ячейки (сумма — в ctx.amountCol)
  rowIndex: number;
  raw: string;
  afterTotal: boolean;
}

function parseRow(input: RowParseInput, ctx: SheetCtx): RowOutput | { skip: string } {
  const { cells, afterTotal } = input;
  const issues: string[] = [];

  // 1. Сумма.
  let amount: number | undefined;
  const amountCell = cells[ctx.amountCol];
  if (!afterTotal && amountCell && isNumeric(amountCell)) amount = Math.round(amountCell.value! * 100) / 100;

  // 2. Разложить остальные ячейки.
  const texts: { idx: number; text: string; bg?: string }[] = [];
  const invoiceNums: string[] = [];
  const phoneCells: { idx: number; phone: string }[] = [];
  for (let idx = 0; idx < cells.length; idx++) {
    const c = cells[idx];
    if (!afterTotal && idx === ctx.amountCol && amount !== undefined) continue;
    const text = c.text.replace(/[\s ]+/g, ' ').trim();
    if (!text && !isNumeric(c)) continue;
    if (isNumeric(c) && c.valueType !== 'percentage') {
      const v = c.value!;
      if (c.valueType === 'currency') {
        issues.push(`Вторая сумма вне колонки суммы: ${text}`);
        texts.push({ idx, text, bg: c.bg });
      } else if ((idx === 1 || idx === 2) && v > 0 && v < 24.6 && !afterTotal) {
        texts.push({ idx, text: text || String(v), bg: c.bg }); // «19.3» — время
      } else if (Number.isInteger(v) && v >= 1e7) {
        phoneCells.push({ idx, phone: String(v) });
      } else if (Number.isInteger(v) && v > 0 && v < 100000) {
        invoiceNums.push(String(v));
      } else {
        texts.push({ idx, text, bg: c.bg });
      }
      continue;
    }
    texts.push({ idx, text, bg: c.bg });
  }

  if (!texts.length && amount === undefined) {
    if (invoiceNums.length || phoneCells.length) return { skip: 'Строка без текста — только число' };
    return { skip: 'Пустая строка' };
  }

  // 3. Заголовок — первая текстовая ячейка (обычно колонка A).
  let titleIdx = texts.findIndex((t) => t.idx === 0);
  if (titleIdx < 0) titleIdx = texts.findIndex((t) => !isTimeCellText(t.text) && !isTokenOnly(t.text));
  if (titleIdx < 0) titleIdx = 0;
  const titleCell = texts[titleIdx];
  const rowColor = cells[0]?.text.trim() ? cells[0].bg : titleCell?.bg;

  // 4. Дата.
  const titleText = titleCell ? titleCell.text : '';
  // Под итогом «2-4 коротких текста» — пункт чек-листа, а не дни 2–4: там дата только с месяцем.
  const dp = parseDatePrefix(titleText, ctx.year, ctx.month, { allowBareRange: !afterTotal });
  let titleRest = normalizeTimeText(dp.rest);

  // 5. Время: отдельная ячейка-время, иначе — в заголовке.
  let time: TimeInfo = { spans: [] };
  const timeCellIdx = new Set<number>();
  if (!afterTotal) {
    for (let i = 0; i < texts.length; i++) {
      if (i === titleIdx) continue;
      if (isTimeCellText(texts[i].text)) {
        const t = parseTimeCell(texts[i].text);
        if (!time.timeStart && !time.timeEnd && !time.timeNote) time = t;
        else if (!time.timeStart && t.timeStart) time = t;
        timeCellIdx.add(i);
      }
    }
  }
  if (!time.timeStart && !time.timeEnd) {
    const t = findTimes(titleRest, { bareHours: false, strictSingle: true });
    if (t.timeStart || t.timeEnd) {
      titleRest = cutText(titleRest, t.spans);
      time = { ...t, timeNote: t.timeNote ?? time.timeNote };
    }
  }

  // 6. Признаки по всему тексту строки.
  const allText = texts.map((t) => t.text).join(' · ');
  const sourceMatch = findSource(allText, ctx.reg.allSources());
  const pay = findPayment(allText);

  // Инвойс.
  let invoiceNo: string | undefined;
  for (const t of texts) {
    const inv = findInvoice(t.text);
    if (inv.invoiceNo) {
      invoiceNo = inv.invoiceNo;
      break;
    }
  }
  if (!invoiceNo) {
    for (let i = 0; i < texts.length; i++) {
      if (i === titleIdx) continue;
      const m = /^(\d{1,4})\s+(?:в\s+)?(\p{L}+)$/u.exec(texts[i].text);
      if (m && monthFromWord(m[2])) {
        invoiceNo = m[1];
        break;
      }
    }
  }
  if (invoiceNums.length) {
    const uniq = [...new Set(invoiceNums)];
    if (!invoiceNo) invoiceNo = uniq[0];
    const others = uniq.filter((n) => n !== invoiceNo);
    if (others.length) issues.push(`Несколько номеров инвойса: ${[invoiceNo, ...others].join(', ')}`);
  }

  // Контакт.
  const phones: string[] = [];
  const channels: Contact['channels'] = [];
  let contactName: string | undefined;
  let mapUrl: string | undefined;
  const contactCellIdx = new Set<number>();
  const cellInfos: ContactInfo[] = texts.map((t) => findContactInfo(t.text));
  texts.forEach((t, i) => {
    const ci = cellInfos[i];
    if (ci.mapUrl && !mapUrl) mapUrl = ci.mapUrl;
    for (const p of ci.phones) if (!phones.includes(p)) phones.push(p);
    for (const ch of ci.channels) if (!channels.some((c) => c.kind === ch.kind && c.value === ch.value)) channels.push(ch);
    if ((ci.phones.length || ci.channels.length) && i !== titleIdx) {
      const srcSpans = sourceMatch ? findSource(t.text, ctx.reg.allSources())?.spans ?? [] : [];
      const name = contactNameFrom(cutText(t.text, srcSpans), findContactInfo(cutText(t.text, srcSpans)));
      if (name && !contactName && !findCategory(name, ctx.types.categories)) contactName = name;
      const leftover = cleanText(cutText(t.text, [...ci.spans, ...srcSpans]).replace(name ?? '\u0000', ' '));
      if (!leftover || isTokenOnly(leftover)) contactCellIdx.add(i);
    }
  });
  for (const pc of phoneCells) {
    const p = pc.phone;
    if (!phones.includes(p)) phones.push(p);
    if (!contactName) {
      // имя — в соседней слева текстовой ячейке: «мама Анны Марии | 99000004»
      const left = texts.find((t, i) => t.idx === pc.idx - 1 && i !== titleIdx);
      if (left && left.text.split(' ').length <= 4 && !/\d/.test(left.text) && !findCategory(left.text, ctx.types.categories)) {
        contactName = left.text;
        contactCellIdx.add(texts.indexOf(left));
      }
    }
  }
  for (const ch of channels) if (!ch.value && phones[0] && ch.kind !== 'email') ch.value = phones[0];

  // 7. Вид и тип.
  const cls = classify({
    text: allText,
    hasDate: !!dp.date,
    amount,
    hasSource: !!sourceMatch,
    hasInvoice: !!invoiceNo,
    hasPhone: phones.length > 0,
    afterTotal,
    categories: ctx.types.categories,
  });
  let { kind } = cls;
  // Без цвета (или цвет «по тексту»): тип — по признаку денег.
  let type: EntryType = cls.money ? ctx.types.moneyTypeId : ctx.types.noMoneyTypeId;
  if (cls.guessed) issues.push('Тип угадан: нет суммы и явных признаков работы');
  const colorRole = rowColor ? ctx.opts.colorMap?.[rowColor] : undefined;
  const important = colorRole === 'important';
  const isNoMoney = (t: EntryType) => !typeHasMoney(ctx.types.settings, t);
  if (colorRole && colorRole !== 'important') {
    type = colorRole;
    if (!afterTotal) {
      if (!isNoMoney(type) && kind === 'event') kind = 'job';
      if (!isNoMoney(type) && kind === 'note') kind = 'work';
      if (isNoMoney(type) && kind === 'job' && amount === undefined) kind = 'event';
    }
  }
  const noMoney = isNoMoney(type);
  if (noMoney && amount !== undefined && amount !== 0) issues.push('Дело без денег с суммой');

  // 8. Источник и деньги.
  let sourceId: string | undefined;
  let holderId: string | undefined;
  if (sourceMatch && !noMoney) {
    const s = sourceMatch.source ?? ctx.reg.source(sourceMatch.name);
    sourceId = s.id;
    if (sourceMatch.holder) holderId = s.id;
  } else if (sourceMatch?.holder && amount) {
    holderId = (sourceMatch.source ?? ctx.reg.source(sourceMatch.name)).id;
  }
  const money = buildMoney(amount, paymentKindDefaults(kind, pay), holderId);

  // 9. Месяц учёта.
  let accountingMonth: YearMonth | undefined;
  if (!dp.date) accountingMonth = ctx.ym;
  else if (dp.otherMonth) {
    if (amount !== undefined) {
      accountingMonth = ctx.ym;
      issues.push(`Дата из другого месяца — засчитано в лист «${ctx.name}»`);
    } else issues.push(`Дата из другого месяца (лист «${ctx.name}»)`);
  }
  if (pay.paidInMonth) {
    const y = pastNearestYear(pay.paidInMonth, ctx.year, ctx.month);
    const pm = yearMonth(y, pay.paidInMonth);
    if (amount === undefined) accountingMonth = pm;
    else if (pm !== (accountingMonth ?? dp.date?.slice(0, 7))) {
      issues.push(`В тексте «оплачено в …» (${pm}), но сумма стоит в листе «${ctx.name}» — засчитано по листу`);
    }
  }

  // 10. Заголовок и заметки.
  let title = cleanText(titleRest.replace(/^\s*[.?]+/, ''));
  const noteParts: string[] = [];
  texts.forEach((t, i) => {
    if (i === titleIdx || timeCellIdx.has(i) || contactCellIdx.has(i)) return;
    if (isTokenOnly(t.text, sourceMatch?.holder ? findSource(t.text, ctx.reg.allSources())?.spans ?? [] : [])) return;
    noteParts.push(t.text);
  });
  if (!title) {
    title = noteParts.shift() ?? (titleCell && !timeCellIdx.has(titleIdx) ? cleanText(titleCell.text) : '');
  }
  if (afterTotal) {
    title = cleanText(texts.map((t) => t.text).join(' · '));
    noteParts.length = 0;
  }
  if (!title) title = cleanText(input.raw);

  // 11. Прочие пометки.
  if (!dp.date && /^\s*\d{1,2}(?![\d.:])\s+\p{L}/u.test(titleText) && !afterTotal) issues.push('Дата не распознана');
  if (kind === 'job' && amount === undefined && !noMoney) issues.push('Нет суммы');
  // Строка без даты с суммой — обычная «работа без даты» месяца листа; пометка — только когда суммы нет.
  if (!dp.date && kind === 'work' && amount === undefined && !afterTotal) issues.push('Без даты: засчитано как работа месяца');
  if (time.timeNote === 'уточнить' || /\?/.test(titleText.slice(0, 8))) {
    // это поле, не ошибка
  }

  const tentative =
    dp.tentative || /(?<![\p{L}])(под\s+вопросом|уточнить)(?![\p{L}])/iu.test(allText) || /\?\s*$/.test(titleText);
  const category = noMoney ? undefined : findCategory(allText, ctx.types.categories);

  const contact = noMoney && !phones.length ? undefined : ctx.reg.contact(contactName, phones, channels);

  const partial: Partial<Entry> = {
    type,
    kind,
    title,
    dateTentative: tentative,
    allDay: !time.timeStart,
    currency: 'EUR',
    money,
    checklist: [],
    origin: { sheet: ctx.name, row: input.rowIndex, raw: input.raw },
  };
  if (dp.date) partial.date = dp.date;
  if (dp.dateEnd) partial.dateEnd = dp.dateEnd;
  if (time.timeStart) partial.timeStart = time.timeStart;
  if (time.timeEnd) partial.timeEnd = time.timeEnd;
  if (time.timeNote) partial.timeNote = time.timeNote;
  if (mapUrl) partial.mapUrl = mapUrl;
  if (category) partial.category = category;
  if (amount !== undefined) partial.amount = amount;
  if (invoiceNo) partial.invoiceNo = invoiceNo;
  if (accountingMonth) partial.accountingMonth = accountingMonth;
  if (contact) partial.contactId = contact.id;
  if (sourceId) partial.sourceId = sourceId;
  if (important) noteParts.unshift('❗ важно');
  if (noteParts.length) partial.notes = noteParts.join(' · ');
  partial.status = statusFor({
    kind,
    hasMoney: !noMoney,
    date: dp.date,
    dateEnd: dp.dateEnd,
    accountingMonth,
    amount,
    money,
    cancelled: pay.cancelled,
    today: ctx.today,
  });
  const entry = newEntry(partial, ctx.types.settings);

  // Статистика цветов (только цвет строки — ячейки названия).
  if (rowColor) {
    let acc = ctx.colorVotes.get(rowColor);
    if (!acc) {
      acc = { count: 0, samples: [], withMoney: 0 };
      ctx.colorVotes.set(rowColor, acc);
    }
    acc.count++;
    if (acc.samples.length < 5) acc.samples.push(input.raw);
    if (cls.money) acc.withMoney++;
  }

  return {
    imported: { entry, confidence: issues.length ? 'low' : 'high', issues },
    amountForCheck: amount ?? 0,
  };
}

// ───────────────────────── заготовки ─────────────────────────

function dataRowsOf(sheet: OdsSheet, sum: SumInfo | undefined): OdsRow[] {
  return sum ? sheet.rows.slice(0, sum.pos) : sheet.rows.filter((r) => !isFormulaRow(r));
}

// ───────────────────────── главный вход ─────────────────────────

/** Разобрать трекер .ods в записи трекера (SPEC §9). Ничего не сохраняет — результат показывает мастер. */
export function importOds(data: Uint8Array, opts: ImportOptions = {}): ImportResult {
  const wb = readOds(data);
  const today = opts.today ?? todayIso();
  const reg = new Registry(opts.existingSources ?? [], opts.existingContacts ?? []);
  const months = resolveSheetMonths(
    wb.sheets.map((s) => s.name),
    Number(today.slice(0, 4)),
  );
  const rows: ImportedRow[] = [];
  const skipped: SkippedRow[] = [];
  const monthChecks: MonthCheck[] = [];
  const colorVotes = new Map<string, ColorAcc>();
  const types = importTypes(opts);
  const seenRaw = new Map<string, string>(); // сырой текст строки данных → первый лист

  wb.sheets.forEach((sheet, si) => {
    const ym = months[si];
    if (!ym) {
      for (const r of sheet.rows) {
        skipped.push({ sheet: sheet.name, row: r.index, raw: rowRaw(r.cells), reason: 'Лист не похож на месяц' });
      }
      return;
    }
    const [year, month] = ym.split('-').map(Number);
    const sum = findSum(sheet);
    const ctx: SheetCtx = {
      name: sheet.name,
      ym,
      year,
      month,
      amountCol: sum?.col ?? 3,
      today,
      opts,
      reg,
      colorVotes,
      types,
    };
    const data = dataRowsOf(sheet, sum);

    // Лист-заготовка: все строки данных скопированы из более ранних листов, и даты в них не этого месяца.
    const raws = data.map((r) => rowRaw(r.cells));
    const copiedFrom = raws.map((r) => seenRaw.get(r));
    const isTemplate =
      data.length > 0 &&
      copiedFrom.every((s) => s !== undefined) &&
      data.every((r) => {
        const dp = parseDatePrefix(r.cells[0]?.text ?? '', year, month);
        return !dp.date || dp.otherMonth;
      });
    raws.forEach((r) => {
      if (!seenRaw.has(r)) seenRaw.set(r, sheet.name);
    });
    if (isTemplate && !opts.includeTemplateSheets) {
      for (let i = 0; i < data.length; i++) {
        skipped.push({
          sheet: sheet.name,
          row: data[i].index,
          raw: raws[i],
          reason: `Лист-заготовка: строка скопирована из листа «${copiedFrom[i]}»`,
        });
      }
      return;
    }

    let importedSum = 0;
    const push = (out: RowOutput | { skip: string }, r: OdsRow, raw: string, counts: boolean) => {
      if ('skip' in out) {
        skipped.push({ sheet: sheet.name, row: r.index, raw, reason: out.skip });
        return;
      }
      if (counts) importedSum += out.amountForCheck;
      if (opts.existingOriginKeys?.has(originKey(out.imported.entry.origin!))) {
        skipped.push({ sheet: sheet.name, row: r.index, raw, reason: 'Уже импортировано' });
        return;
      }
      rows.push(out.imported);
    };

    // Строки данных.
    for (const r of data) {
      const raw = rowRaw(r.cells);
      // Боковой календарь (сентябрь 2025): дата дд.мм числом в правых колонках.
      let cells = r.cells;
      let side: { day: number; cells: OdsCell[] } | undefined;
      for (let idx = 6; idx < cells.length; idx++) {
        const d = sideDate(cells[idx], ctx);
        if (d !== undefined) {
          side = { day: d, cells: cells.slice(idx + 1) };
          cells = cells.slice(0, idx).map((c) => c);
          // целые числа справа — инвойс основной строки
          for (const c of side.cells) if (isNumeric(c) && Number.isInteger(c.value)) cells.push(c);
          side.cells = side.cells.filter((c) => !(isNumeric(c) && Number.isInteger(c.value)));
          break;
        }
      }
      const mainHasContent = cells.some((c, i) => (c.text.trim() !== '' && !(isNumeric(c) && i !== ctx.amountCol)) || (i === ctx.amountCol && isNumeric(c)));
      if (mainHasContent) push(parseRow({ cells, rowIndex: r.index, raw, afterTotal: false }, ctx), r, raw, true);
      if (side) {
        const sideText = side.cells.map((c) => c.text.trim()).filter(Boolean);
        const sideRaw = `${pad(side.day)}.${pad(month)} | ${sideText.join(' | ')}`;
        const sideCells: OdsCell[] = [{ text: `${pad(side.day)}.${pad(month)} ${sideText.filter((t) => !isTimeCellText(t)).join(' · ')}` }];
        const timeText = sideText.find((t) => isTimeCellText(t));
        if (timeText) sideCells.push({ text: timeText });
        const out = parseRow({ cells: sideCellsWithAmountGap(sideCells, ctx.amountCol), rowIndex: r.index, raw: sideRaw, afterTotal: false }, ctx);
        if (!('skip' in out)) out.imported.issues.push('Запись из бокового списка дат (правые колонки листа)');
        if (!('skip' in out)) out.imported.confidence = 'low';
        push(out, r, sideRaw, false);
      }
    }

    // Итоговые строки: текст рядом с формулами — заметки.
    if (sum) {
      for (let pos = sum.pos; pos < sheet.rows.length; pos++) {
        const r = sheet.rows[pos];
        const raw = rowRaw(r.cells);
        if (isFormulaRow(r)) {
          const extra = r.cells.map((c) => (c.formula || isNumeric(c) ? { text: '' } : c));
          if (extra.some((c) => c.text.trim())) {
            push(parseRow({ cells: extra, rowIndex: r.index, raw, afterTotal: true }, ctx), r, raw, false);
          }
          continue;
        }
        // Строки после итога — заметки/чек-лист.
        if (!r.cells.some((c) => c.text.trim() && !isNumeric(c))) {
          skipped.push({ sheet: sheet.name, row: r.index, raw, reason: 'Число под итогом листа, без текста' });
          continue;
        }
        push(parseRow({ cells: r.cells, rowIndex: r.index, raw, afterTotal: true }, ctx), r, raw, false);
      }
      const sheetSum = sum.value;
      importedSum = Math.round(importedSum * 100) / 100;
      monthChecks.push({
        sheet: sheet.name,
        month: ym,
        sheetSum,
        importedSum,
        ok: sheetSum !== undefined && Math.abs(sheetSum - importedSum) < 0.005,
      });
    } else if (data.length) {
      importedSum = Math.round(importedSum * 100) / 100;
      monthChecks.push({ sheet: sheet.name, month: ym, importedSum, ok: importedSum === 0 });
    }
  });

  linkPrepayments(rows);

  const colors: ColorStat[] = [...colorVotes.entries()]
    .map(([color, acc]) => ({ color, count: acc.count, samples: acc.samples, withMoney: acc.withMoney }))
    .sort((a, b) => b.count - a.count);

  return { rows, contacts: reg.newContacts, sources: reg.newSources, colors, monthChecks, skipped };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Боковая запись без суммы: колонка суммы пустая. */
function sideCellsWithAmountGap(cells: OdsCell[], amountCol: number): OdsCell[] {
  const out = [...cells];
  while (out.length <= amountCol) out.push({ text: '' });
  return out;
}

/** «Предоплата за 1.09» → relatedEntryId на задачу этой даты (ближайшую не раньше месяца предоплаты). */
function linkPrepayments(rows: ImportedRow[]): void {
  const byDate = new Map<string, Entry[]>();
  for (const r of rows) {
    const e = r.entry;
    if (e.date && (e.kind === 'job' || e.kind === 'work')) {
      const list = byDate.get(e.date) ?? [];
      list.push(e);
      byDate.set(e.date, list);
    }
  }
  for (const r of rows) {
    const e = r.entry;
    if (e.kind !== 'payment' || !e.origin) continue;
    const m = /за\s+(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/iu.exec(e.origin.raw);
    if (!m) continue;
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const base = e.date ?? (e.accountingMonth ? e.accountingMonth + '-01' : undefined);
    if (!base) continue;
    const [by, bm] = base.split('-').map(Number);
    const y = m[3] ? Number(m[3]) : mo >= bm ? by : by + 1;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const target = byDate.get(isoDate(y, mo, d))?.find((x) => x.id !== e.id);
    if (target) e.relatedEntryId = target.id;
  }
}
