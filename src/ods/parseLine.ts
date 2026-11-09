// Парсер строки: быстрый ввод «12.12 встреча 11-12 200 от Пети» и общие куски разбора для импорта .ods.
// Тип записи парсер не выбирает: он отдаёт только признак денег, а тип подставляет вызывающий
// (тип по умолчанию / тип для дел без денег из настроек).
import type { Contact, EntryKind, EntryStatus, ISODate, MoneyPart, Source, YearMonth } from '../model/types';
import { DEFAULT_CATEGORIES, DEFAULT_SETTINGS } from '../model/types';
import { defaultNoMoneyTypeId, defaultTypeId } from '../model/taskTypes';
import type { ParseContext, ParsedLine } from './types';

// ───────────────────────── общие помощники ─────────────────────────

/** Начало/конец слова для кириллицы (\b в JS работает только с латиницей). */
const B = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';

function re(src: string, flags = 'iu'): RegExp {
  return new RegExp(src, flags);
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function isoDate(y: number, m: number, d: number): ISODate {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function yearMonth(y: number, m: number): YearMonth {
  return `${y}-${pad2(m)}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function validDate(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function todayIso(): ISODate {
  const d = new Date();
  return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Схлопнуть пробелы, убрать мусорную пунктуацию по краям. */
export function cleanText(s: string): string {
  return s
    .replace(/[\s ]+/g, ' ')
    .replace(/^[\s,.;:·|/\-–—]+|[\s,;:·|/\-–—]+$/g, '')
    .trim();
}

/** Вырезать из строки участки [from, to). */
function cutSpans(s: string, spans: [number, number][]): string {
  if (!spans.length) return s;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [a, b] of sorted) {
    if (a < pos) {
      pos = Math.max(pos, b);
      continue;
    }
    out += s.slice(pos, a) + ' ';
    pos = b;
  }
  return out + s.slice(pos);
}

// ───────────────────────── месяцы ─────────────────────────

const MONTH_RES: [RegExp, number][] = [
  [/^январ/i, 1],
  [/^феврал/i, 2],
  [/^март/i, 3],
  [/^апрел/i, 4],
  [/^ма[йяеюё]$/i, 5],
  [/^июн/i, 6],
  [/^июл/i, 7],
  [/^август/i, 8],
  [/^сентябр/i, 9],
  [/^октябр/i, 10],
  [/^ноябр/i, 11],
  [/^декабр/i, 12],
];

/** Номер месяца по русскому слову в любой форме: «июнь», «июне», «мая». */
export function monthFromWord(word: string): number | undefined {
  const w = word.trim().toLowerCase();
  for (const [r, n] of MONTH_RES) if (r.test(w)) return n;
  return undefined;
}

const MONTH_WORD = '(январ\\p{L}*|феврал\\p{L}*|март\\p{L}*|апрел\\p{L}*|ма[йяеюё]|июн\\p{L}*|июл\\p{L}*|август\\p{L}*|сентябр\\p{L}*|октябр\\p{L}*|ноябр\\p{L}*|декабр\\p{L}*)';

/** Год, при котором (год, месяц) ближе всего к опорному месяцу. */
export function nearestYear(month: number, refYear: number, refMonth: number): number {
  let best = refYear;
  let bestDiff = Infinity;
  for (const y of [refYear - 1, refYear, refYear + 1]) {
    const diff = Math.abs(y * 12 + month - (refYear * 12 + refMonth));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = y;
    }
  }
  return best;
}

/** Год для «оплачено в <месяце>»: месяц в прошлом (или следующий за опорным), не дальше. */
export function pastNearestYear(month: number, refYear: number, refMonth: number): number {
  if (refMonth === 12 && month === 1) return refYear + 1;
  return month <= refMonth + 1 ? refYear : refYear - 1;
}

// ───────────────────────── дата в начале ─────────────────────────

export interface DatePrefix {
  date?: ISODate;
  dateEnd?: ISODate;
  tentative: boolean;
  /** Текст после даты. */
  rest: string;
  /** Дата не в опорном месяце. */
  otherMonth: boolean;
}

const DATE_PREFIX_RE =
  /^\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?(?:\.(\d{1,2})(?:\.(\d{4}|\d{2})(?!\d))?)?(?:\s*[-–—]\s*(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2})(?!\d))?)?/;

/**
 * Дата в начале текста: д.мм, дд.мм, д-д.мм, дд.мм-дд.мм, «12-14» (дни текущего месяца),
 * хвост «?» → предварительно, «30.04.» и «27.12.корпоратив» тоже понимаются.
 */
export function parseDatePrefix(
  text: string,
  refYear: number,
  refMonth: number,
  opts: { allowBareRange?: boolean } = {},
): DatePrefix {
  const allowBareRange = opts.allowBareRange ?? true;
  const none: DatePrefix = { tentative: false, rest: text, otherMonth: false };
  const m = DATE_PREFIX_RE.exec(text);
  if (!m) return none;
  const [whole, d1s, d2s, m1s, y1s, d3s, m3s, y3s] = m;
  const after = text.slice(whole.length);
  // После даты не должно идти продолжение числа/времени.
  if (/^[\d:]/.test(after) || /^\.\d/.test(after) || /^,\d/.test(after)) return none;
  const d1 = Number(d1s);
  let date: ISODate | undefined;
  let dateEnd: ISODate | undefined;
  let y1: number;
  let mo1: number;
  if (m1s) {
    mo1 = Number(m1s);
    if (mo1 < 1 || mo1 > 12) return none;
    y1 = y1s ? (y1s.length === 2 ? 2000 + Number(y1s) : Number(y1s)) : nearestYear(mo1, refYear, refMonth);
    if (!validDate(y1, mo1, d1)) return none;
    date = isoDate(y1, mo1, d1);
    if (d2s) {
      const d2 = Number(d2s);
      if (!validDate(y1, mo1, d2) || d2 < d1) return none;
      dateEnd = isoDate(y1, mo1, d2);
    } else if (d3s && m3s) {
      const d3 = Number(d3s);
      const mo3 = Number(m3s);
      let y3 = y3s ? (y3s.length === 2 ? 2000 + Number(y3s) : Number(y3s)) : y1;
      if (!y3s && mo3 < mo1) y3 = y1 + 1;
      if (validDate(y3, mo3, d3)) dateEnd = isoDate(y3, mo3, d3);
    }
  } else if (d2s) {
    // «12-14» — дни опорного месяца; после — пробел/конец/«?».
    if (!allowBareRange || !/^(\s|\?|$)/.test(after)) return none;
    const d2 = Number(d2s);
    y1 = refYear;
    mo1 = refMonth;
    if (!validDate(y1, mo1, d1) || !validDate(y1, mo1, d2) || d2 <= d1) return none;
    date = isoDate(y1, mo1, d1);
    dateEnd = isoDate(y1, mo1, d2);
  } else {
    return none;
  }
  let rest = after;
  let tentative = false;
  const q = /^\s*\.?\s*(\?+)/.exec(rest);
  if (q) {
    tentative = true;
    rest = rest.slice(q[0].length);
  }
  rest = rest.replace(/^\s*\.\s*/, ' ');
  const inRef = (iso?: string) => !!iso && iso.slice(0, 7) === yearMonth(refYear, refMonth);
  return { date, dateEnd, tentative, rest, otherMonth: !inRef(date) && !inRef(dateEnd) };
}

// ───────────────────────── время ─────────────────────────

export interface TimeInfo {
  timeStart?: string;
  timeEnd?: string;
  timeNote?: string;
  /** Участки текста, занятые временем (для вырезания из названия). */
  spans: [number, number][];
}

function hm(h: number, m: number): string | undefined {
  if (h === 24 && m === 0) return '00:00';
  if (h < 0 || h > 23 || m < 0 || m > 59) return undefined;
  return `${pad2(h)}:${pad2(m)}`;
}

function minutes(s: string | undefined): number {
  if (s === undefined) return 0;
  return s.length === 1 ? Number(s) * 10 : Number(s); // «19.3» → 19:30
}

/** Нормализация перед поиском времени: «18. 00» → «18.00», тире → «-». */
export function normalizeTimeText(s: string): string {
  return s.replace(/(\d)\.\s+(\d\d)(?!\d)/g, '$1.$2').replace(/[–—]/g, '-');
}

const INTERVAL_RE = /(?<![\d.,:])(\d{1,2})(?:[.:](\d{1,2}))?\s*-\s*(\d{1,2})(?:[.:](\d{1,2}))?(?!\d|[.,:]\d)/g;
const OPEN_INTERVAL_RE = /(?<![\d.,:])(\d{1,2})[.:](\d{2})\s*-(?=\s*$|\s+[^\d\s])/g;
const SINGLE_RE = /(?<![\d.,:])(\d{1,2})[.:](\d{1,2})(?!\d|[.,:]\d)/g;

export interface FindTimesOptions {
  /** «11-12» без минут считать интервалом часов. */
  bareHours?: boolean;
  /** Одиночное время только с минутами, кратными 5 (отсекает даты вроде 16.12). */
  strictSingle?: boolean;
}

/** Найти время: интервалы «HH.mm - HH.mm», несколько через запятую, одиночное «HH.mm», «до 18.00». */
export function findTimes(text: string, opts: FindTimesOptions = {}): TimeInfo {
  const strict = opts.strictSingle ?? true;
  const spans: [number, number][] = [];
  const intervals: { s: string; e?: string }[] = [];
  const taken = (a: number, b: number) => spans.some(([x, y]) => a < y && b > x);

  for (const m of text.matchAll(INTERVAL_RE)) {
    const [whole, h1, m1, h2, m2] = m;
    const idx = m.index ?? 0;
    if (m1 === undefined && m2 === undefined && !opts.bareHours) continue;
    const s = hm(Number(h1), minutes(m1));
    const e = hm(Number(h2), minutes(m2));
    if (!s || !e) continue;
    if (m1 === undefined && m2 === undefined && (Number(h1) > 24 || Number(h2) > 24)) continue;
    intervals.push({ s, e });
    spans.push([idx, idx + whole.length]);
  }
  for (const m of text.matchAll(OPEN_INTERVAL_RE)) {
    const idx = m.index ?? 0;
    if (taken(idx, idx + m[0].length)) continue;
    const s = hm(Number(m[1]), minutes(m[2]));
    if (!s) continue;
    intervals.push({ s });
    spans.push([idx, idx + m[0].length]);
  }
  let timeStart: string | undefined;
  let timeEnd: string | undefined;
  let timeNote: string | undefined;
  if (intervals.length) {
    timeStart = intervals[0].s;
    timeEnd = intervals[intervals.length - 1].e;
    if (intervals.length > 1) timeNote = intervals.map((i) => (i.e ? `${i.s}–${i.e}` : i.s)).join(', ');
  } else {
    for (const m of text.matchAll(SINGLE_RE)) {
      const idx = m.index ?? 0;
      const mm = minutes(m[2]);
      if (strict && m[2].length === 2 && mm % 5 !== 0) continue;
      const t = hm(Number(m[1]), mm);
      if (!t) continue;
      const before = text.slice(Math.max(0, idx - 4), idx);
      if (/(^|\s)до\s*$/i.test(before)) {
        if (mm % 15 !== 0) continue; // «до 22.05» — скорее дата
        timeEnd = t;
        spans.push([idx - (before.length - before.search(/до\s*$/i)), idx + m[0].length]);
      } else {
        timeStart = t;
        spans.push([idx, idx + m[0].length]);
      }
      break;
    }
  }
  // Предлог перед временем уходит вместе с ним: «в 9.00», «к 11.30», «с 10.00».
  for (const sp of spans) {
    const m = /(?:^|\s)(в|к|с|около)\s+$/iu.exec(text.slice(0, sp[0]));
    if (m) sp[0] -= m[0].length - (m[0].startsWith(' ') ? 1 : 0);
  }
  return { timeStart, timeEnd, timeNote, spans };
}

const TIME_WORDS_RE = re(`${B}(утр[оау]?|утром|днём|днем|дня|день|вечер[ау]?|вечером|ночью|ночь|уточнить|около\\s+\\d{1,2}(?:[.:]\\d{2})?)${E}`, 'giu');

/** Нормализация ячейки времени: плюс случайная латинская буква перед словом («13.30 lдень»). */
function timeCellNormalize(text: string): string {
  return normalizeTimeText(text).replace(/(?<![\p{L}])[a-z](?=\p{Script=Cyrillic})/gu, '');
}

/** Ячейка/фрагмент целиком про время? «16.00 - 23.00», «9.00 утра», «вечер», «уточнить», «???». */
export function isTimeCellText(text: string): boolean {
  const t = timeCellNormalize(text);
  const info = findTimes(t, { bareHours: true, strictSingle: false });
  let rest = cutSpans(t, info.spans);
  rest = rest.replace(TIME_WORDS_RE, ' ').replace(/[?\s.,;:\-l]+/g, '');
  const hadSomething = info.spans.length > 0 || TIME_WORDS_RE.test(t) || /^\s*\?+\s*$/.test(t);
  TIME_WORDS_RE.lastIndex = 0;
  return hadSomething && rest === '';
}

/** Разобрать ячейку времени: числа + слово-пометка. */
export function parseTimeCell(text: string): TimeInfo {
  const t = timeCellNormalize(text);
  const info = findTimes(t, { bareHours: true, strictSingle: false });
  const words = [...t.matchAll(TIME_WORDS_RE)].map((m) => m[1].toLowerCase());
  const tentative = /\?/.test(t) || words.includes('уточнить');
  if (!info.timeStart && !info.timeEnd) {
    const note = words.length ? words.join(' ') : /\?/.test(t) ? 'уточнить' : cleanText(t);
    return { spans: info.spans, timeNote: note || undefined };
  }
  if (tentative && !info.timeNote) info.timeNote = 'уточнить';
  return info;
}

// ───────────────────────── источники ─────────────────────────

interface BuiltinSource {
  name: string;
  aliases: string[];
  /** Совпадение без предлога («агенство»). */
  bare?: boolean;
}

/** Падежные формы имени для алиасов: «Петя» → петя, пети, саше, сашу, петей… */
export function nameForms(name: string): string[] {
  const n = name.trim().toLowerCase();
  const out = new Set<string>([n]);
  if (!/^[\p{Script=Cyrillic}]+$/u.test(n) || n.length < 3) return [...out];
  const stem = n.slice(0, -1);
  const last = n.slice(-1);
  const hush = /[гкхжшчщ]$/.test(stem);
  const sib = /[жшчщц]$/.test(stem);
  if (last === 'а') {
    out.add(stem + (hush ? 'и' : 'ы'));
    out.add(stem + 'е');
    out.add(stem + 'у');
    out.add(stem + (sib ? 'ей' : 'ой'));
    out.add(stem + (sib ? 'ею' : 'ою'));
  } else if (last === 'я') {
    out.add(stem + 'и');
    out.add(stem + 'е');
    out.add(stem + 'ю');
    out.add(stem + 'ей');
    out.add(stem + 'ёй');
  } else if (/[бвгдзклмнпрстфхжшчщц]$/.test(n)) {
    out.add(n + 'а');
    out.add(n + 'у');
    out.add(n + 'ом');
    out.add(n + 'е');
  }
  return [...out];
}

/**
 * Встроенные источники — только общие слова. Имена конкретных посредников в код не зашиваются:
 * пользователь заводит их в справочнике «Источники» (имя + алиасы), а «от <Имя>», «у <Имя>»
 * распознаются по общему правилу в findSource.
 */
export const BUILTIN_SOURCES: BuiltinSource[] = [
  { name: 'Ребята', aliases: ['ребята', 'ребят', 'ребятам', 'ребятами'] },
  {
    name: 'Агентство',
    aliases: ['агентство', 'агенство', 'агентства', 'агенства', 'агентству', 'агенству', 'агентством', 'агенством'],
    bare: true,
  },
];

/** Именительный падеж из косвенного: «Коли» → «Коля», «Оли» → «Оля», «Техкода» → «Техкод». */
export function nominativeName(word: string, prep: string): string {
  const w = word.trim();
  const low = w.toLowerCase();
  const cap = (s: string) => (w[0] === w[0].toUpperCase() ? s[0].toUpperCase() + s.slice(1) : s);
  const stem = low.slice(0, -1);
  if (prep === 'через') {
    if (low.endsWith('у')) return cap(stem + 'а');
    if (low.endsWith('ю')) return cap(stem + 'я');
    return w;
  }
  // от / для / у — родительный
  if (low.endsWith('ы')) return cap(stem + 'а');
  if (low.endsWith('и')) return cap(stem + (/[гкхжшчщ]$/.test(stem) ? 'а' : 'я'));
  if (low.endsWith('а') && /[бвгдзклмнпрстфх]$/.test(stem) && stem.length >= 4) return cap(stem);
  return w;
}

export interface SourceMatch {
  name: string;
  /** Совпавший существующий источник (из ctx.sources), если есть. */
  source?: Source;
  /** Посредник держит деньги: «у Пети». */
  holder: boolean;
  spans: [number, number][];
}

const PREP = '(с|со|от|через|у|для|вместе\\s+с)';

/** Найти источник/посредника. Сначала справочник ctx.sources, потом встроенные, потом «от <Имя>». */
export function findSource(text: string, sources: Source[] = []): SourceMatch | undefined {
  const candidates: { name: string; source?: Source; aliases: string[]; bare: boolean }[] = [];
  for (const s of sources) {
    if (s.deleted) continue;
    const aliases = [...new Set([...nameForms(s.name), ...s.aliases.map((a) => a.toLowerCase())])];
    const builtin = BUILTIN_SOURCES.find((b) => b.name.toLowerCase() === s.name.toLowerCase());
    candidates.push({ name: s.name, source: s, aliases, bare: !!builtin?.bare });
  }
  for (const b of BUILTIN_SOURCES) {
    if (candidates.some((c) => c.name.toLowerCase() === b.name.toLowerCase())) continue;
    candidates.push({ name: b.name, aliases: b.aliases, bare: !!b.bare });
  }
  let best: (SourceMatch & { idx: number }) | undefined;
  for (const c of candidates) {
    const alt = c.aliases
      .filter((a) => a.length >= 2)
      .sort((a, b) => b.length - a.length)
      .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
      .join('|');
    if (!alt) continue;
    const withPrep = re(`${B}${PREP}\\s+(${alt})${E}`, 'giu');
    const spans: [number, number][] = [];
    let first = -1;
    let holder = false;
    for (const m of text.matchAll(withPrep)) {
      const idx = m.index ?? 0;
      spans.push([idx, idx + m[0].length]);
      if (first < 0) first = idx;
      if (m[1].toLowerCase() === 'у') holder = true;
    }
    if (c.bare) {
      for (const m of text.matchAll(re(`${B}(${alt})${E}`, 'giu'))) {
        const idx = m.index ?? 0;
        if (!spans.some(([a, b]) => idx >= a && idx < b)) spans.push([idx, idx + m[0].length]);
        if (first < 0 || idx < first) first = idx;
      }
    }
    if (spans.length && (!best || first < best.idx)) {
      best = { name: c.name, source: c.source, holder, spans, idx: first };
    }
  }
  if (best) return { name: best.name, source: best.source, holder: best.holder, spans: best.spans };
  // «от Коли», «через Таню», «для Коли», «у Коли» (держит деньги) — новое имя с заглавной буквы.
  const generic = re(`${B}(от|через|для|у)\\s+(\\p{Lu}[\\p{Ll}]{2,})${E}`, 'gu');
  for (const m of text.matchAll(generic)) {
    const word = m[2];
    if (monthFromWord(word)) continue;
    const idx = m.index ?? 0;
    const prep = m[1].toLowerCase();
    return { name: nominativeName(word, prep), holder: prep === 'у', spans: [[idx, idx + m[0].length]] };
  }
  return undefined;
}

// ───────────────────────── контакт ─────────────────────────

export interface ContactInfo {
  phones: string[];
  channels: Contact['channels'];
  mapUrl?: string;
  otherUrls: string[];
  spans: [number, number][];
}

const CHANNEL_WORDS: [RegExp, Contact['channels'][number]['kind']][] = [
  [re(`${B}(ватсап\\p{L}*|вотсап\\p{L}*|ватцап\\p{L}*|ватас|whats?app?|whatsup|whatsap|вацап)${E}`, 'giu'), 'whatsapp'],
  [re(`${B}(телеграм\\p{L}*|telegram|тг|tg)${E}`, 'giu'), 'telegram'],
  [re(`${B}(инст|инста|инстаграм\\p{L}*|instagram|insta)${E}`, 'giu'), 'instagram'],
  [re(`${B}(фейсбук\\p{L}*|facebook|fb)${E}`, 'giu'), 'facebook'],
  [re(`${B}(смс|sms)${E}`, 'giu'), 'sms'],
  [re(`${B}(gmail|email|e-mail|почта)${E}`, 'giu'), 'email'],
];

export function normalizePhone(raw: string): string {
  const plus = raw.trim().startsWith('+');
  const digits = raw.replace(/\D/g, '');
  return (plus ? '+' : '') + digits;
}

/** Ключ слияния телефонов: последние 8 цифр (кипрский номер с кодом и без). */
export function phoneKey(p: string): string {
  return p.replace(/\D/g, '').slice(-8);
}

/** Телефоны, ссылки, ники и слова-каналы. */
export function findContactInfo(text: string): ContactInfo {
  const spans: [number, number][] = [];
  const phones: string[] = [];
  const channels: Contact['channels'] = [];
  const otherUrls: string[] = [];
  let mapUrl: string | undefined;
  const taken = (a: number, b: number) => spans.some(([x, y]) => a < y && b > x);
  const add = (a: number, b: number) => spans.push([a, b]);

  for (const m of text.matchAll(/https?:\/\/\S+/giu)) {
    const url = m[0].replace(/[),.;]+$/, '');
    const idx = m.index ?? 0;
    add(idx, idx + m[0].length);
    if (/facebook\.com|fb\.com|fb\.me/i.test(url)) channels.push({ kind: 'facebook', value: url });
    else if (/instagram\.com|instagr\.am/i.test(url)) channels.push({ kind: 'instagram', value: url });
    else if (/maps\.app\.goo\.gl|goo\.gl\/maps|google\.[a-z.]+\/maps/i.test(url)) mapUrl = url;
    else otherUrls.push(url);
  }
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/gu)) {
    const idx = m.index ?? 0;
    if (taken(idx, idx + m[0].length)) continue;
    add(idx, idx + m[0].length);
    channels.push({ kind: 'email', value: m[0] });
  }
  const phoneRes = [
    /\+\s?\d[\d\s\-()]{6,18}\d/g,
    /(?<![\d.,+])\d{0,3}\(\d{2,4}\)[\d\s-]{5,12}\d/g,
    /(?<![\d.,])\d{8,13}(?![\d]|[.,]\d)/g,
  ];
  for (const r of phoneRes) {
    for (const m of text.matchAll(r)) {
      const idx = m.index ?? 0;
      let s = m[0];
      // «+7 985 421-11-38 250» — хвостовая группа через пробел (сумма) не часть номера.
      while (s.replace(/\D/g, '').length > 12 && /\s\d+$/.test(s)) s = s.replace(/\s+\d+$/, '');
      if (taken(idx, idx + s.length)) continue;
      const p = normalizePhone(s);
      const n = p.replace(/\D/g, '').length;
      if (n < 8 || n > 15) continue;
      add(idx, idx + s.length);
      if (!phones.includes(p)) phones.push(p);
    }
  }
  const kinds: Contact['channels'][number]['kind'][] = [];
  for (const [r, kind] of CHANNEL_WORDS) {
    r.lastIndex = 0;
    for (const m of text.matchAll(r)) {
      const idx = m.index ?? 0;
      if (taken(idx, idx + m[0].length)) continue;
      add(idx, idx + m[0].length);
      if (!kinds.includes(kind)) kinds.push(kind);
    }
  }
  const handles: { h: string; idx: number }[] = [];
  for (const m of text.matchAll(/(?<![\w@])@[A-Za-z0-9_.]{3,}/g)) {
    const idx = m.index ?? 0;
    if (taken(idx, idx + m[0].length)) continue;
    add(idx, idx + m[0].length);
    handles.push({ h: m[0].replace(/\.$/, ''), idx });
  }
  for (const { h } of handles) {
    const kind = kinds.includes('telegram') ? 'telegram' : 'instagram';
    channels.push({ kind, value: h });
  }
  for (const kind of kinds) {
    if (channels.some((c) => c.kind === kind)) continue;
    const phone = kind === 'whatsapp' || kind === 'telegram' || kind === 'sms' ? phones[0] : undefined;
    channels.push({ kind, value: phone ?? '' });
  }
  return { phones, channels, mapUrl, otherUrls, spans };
}

const NAME_STOP = re(
  `${B}(контакт|номер|тел|телефон|мама|папа|личные|клиент|через|от|и|and|в|на|с|по|для)${E}`,
  'giu',
);

/** Имя контакта из ячейки, где лежит телефон/канал: «Анна 99000001» → «Анна». */
export function contactNameFrom(text: string, info: ContactInfo): string | undefined {
  const pay = findPayment(text);
  const inv = findInvoice(text);
  let rest = cutSpans(text, [...info.spans, ...pay.spans, ...(inv.span ? [inv.span] : [])]);
  rest = rest.replace(
    re(`${B}(опл\\p{L}*|в\\s+${MONTH_WORD}|${MONTH_WORD}|контакт|номер|тел|телефон|сделать|забронировать|позвонить|уточнить|написать|on|in|january|february|march|april|may|june|july|august|september|october|november|december|prepaid|prepayed|invoice|full|amount)${E}`, 'giu'),
    ' ',
  );
  rest = cleanText(rest.replace(/[?!(),.;:]+/g, ' '));
  if (!rest || /\d/.test(rest)) return undefined;
  const words = rest.split(' ').filter(Boolean);
  if (words.length > 4) return undefined;
  const meaningful = rest.replace(NAME_STOP, ' ').trim();
  if (!meaningful || meaningful.length < 2) return undefined;
  if (!/\p{L}/u.test(meaningful)) return undefined;
  return rest;
}

// ───────────────────────── оплата ─────────────────────────

export interface PaymentInfo {
  paid: boolean;
  unpaid: boolean;
  half: boolean;
  /** Часть уже у владельца: «150 предоплата», «100 оплачено в июле». */
  partialOwner?: number;
  /** Частичная оплата пришла в другом месяце и в сумму строки не входит. */
  partialElsewhere: boolean;
  /** «оплачено в феврале» → номер месяца. */
  paidInMonth?: number;
  method?: string;
  /** Способ сам по себе означает, что деньги получены (нал, револют, на счету). */
  methodImpliesPaid: boolean;
  cancelled: boolean;
  spans: [number, number][];
}

const PAID_RE = re(`(?<!не\\s{1,3})${B}опл[аче]{1,4}н\\p{L}*`, 'giu');
const PAID_IN_MONTH_RE = re(`(?:опл[аче]{1,4}н\\p{L}*|посчитано)(?:\\s+и\\s+посчитано)?\\s+в\\s+${MONTH_WORD}${E}`, 'iu');
const PARTIAL_RE = re(
  `(?<![\\p{L}\\p{N}_.,:])(\\d{2,5})\\s*(?:€|евро|eur)?\\s+(?:предоплат\\p{L}*|предоплачен\\p{L}*|опл[аче]{1,4}н\\p{L}*|prepaid|prepayed|уже\\s+опл\\p{L}*)|${B}(?:предоплат\\p{L}*|prepaid|prepayed)\\s+(\\d{2,5})${E}`,
  'iu',
);
const METHODS: [RegExp, string, boolean][] = [
  [re(`${B}(на\\s+сч[её]ту|на\\s+сч[её]т)${E}`, 'giu'), 'bank', true],
  [re(`${B}(нал|наличн\\p{L}*|налом|кэш|cash)${E}`, 'giu'), 'cash', true],
  [re(`${B}(револют\\p{L}*|revolut)${E}`, 'giu'), 'revolut', true],
  [re(`${B}(сч[её]т|по\\s+инвойсу|bank)${E}\\??`, 'giu'), 'bank', false],
  [re(`${B}(бартер)${E}`, 'giu'), 'бартер', true],
];

export function findPayment(text: string): PaymentInfo {
  const spans: [number, number][] = [];
  // Частичная оплата («150 предоплата», «100 оплачено в июле») — отдельно, и из дальнейшего поиска убирается.
  let partialOwner: number | undefined;
  let partialElsewhere = false;
  let t = text;
  const pm = PARTIAL_RE.exec(text);
  if (pm) {
    const n = Number(pm[1] ?? pm[2]);
    // «предоплата 150 в августе», «150 prepaid … on april» — учтена в другом месяце, в сумме строки её нет.
    const near = text.slice(pm.index, pm.index + pm[0].length + 40);
    partialElsewhere = re(`${MONTH_WORD}|${B}(january|february|march|april|may|june|july|august|september|october|november|december)${E}`).test(near);
    if (n >= 10) {
      partialOwner = n;
      const tail = /^\s+в\s+\p{L}+/u.exec(text.slice(pm.index + pm[0].length));
      const end = pm.index + pm[0].length + (tail && monthFromWord(tail[0].trim().split(/\s+/)[1]) ? tail[0].length : 0);
      t = text.slice(0, pm.index) + ' '.repeat(end - pm.index) + text.slice(end);
      spans.push([pm.index, end]);
    }
  }
  let paid = false;
  for (const m of t.matchAll(PAID_RE)) {
    paid = true;
    const idx = m.index ?? 0;
    spans.push([idx, idx + m[0].length]);
  }
  const unpaid = re(`${B}не\\s+(опл\\p{L}*|пришл\\p{L}*)`).test(t);
  if (!unpaid && re(`(?<!не\\s{1,3})${B}пришло${E}`).test(t)) paid = true;
  const half = re(`${B}50\\s*(%|процент\\p{L}*)`).test(t);
  let paidInMonth: number | undefined;
  const mm = PAID_IN_MONTH_RE.exec(t);
  if (mm) paidInMonth = monthFromWord(mm[1]);
  let method: string | undefined;
  let methodImpliesPaid = false;
  for (const [r, name, implies] of METHODS) {
    r.lastIndex = 0;
    const m = r.exec(t);
    if (m) {
      if (!method) {
        method = name;
        methodImpliesPaid = implies;
      }
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  const cancelled = re(`${B}отмен(а|ено|ена|ён|ен|или)${E}`).test(t);
  return {
    paid: paid && !unpaid,
    unpaid,
    half,
    partialOwner,
    partialElsewhere,
    paidInMonth,
    method,
    methodImpliesPaid,
    cancelled,
    spans,
  };
}

/** Запись-предоплата/сертификат сама означает, что деньги получены, если не сказано обратное. */
export function paymentKindDefaults(kind: EntryKind, pay: PaymentInfo): PaymentInfo {
  if (kind !== 'payment' || pay.unpaid || pay.paid || pay.half || pay.partialOwner !== undefined) return pay;
  return { ...pay, paid: true };
}

/** Разложить сумму по местам (SPEC §9: оплата → owner, 50% → owner+client, у посредника → intermediary, иначе client). */
export function buildMoney(amount: number | undefined, pay: PaymentInfo, holderId?: string): MoneyPart[] {
  if (amount === undefined || amount === 0) return [];
  const method = pay.method;
  const part = (a: number, where: MoneyPart['where'], extra: Partial<MoneyPart> = {}): MoneyPart => {
    const p: MoneyPart = { amount: Math.round(a * 100) / 100, where, ...extra };
    if (method) p.method = method;
    return p;
  };
  if (amount < 0) return [part(amount, 'owner')];
  if (holderId) return [part(amount, 'intermediary', { holderId })];
  if (pay.unpaid) return [part(amount, 'client')];
  if (pay.half) {
    const owner = Math.round(amount * 50) / 100;
    return [part(owner, 'owner'), part(amount - owner, 'client')];
  }
  if (pay.partialOwner !== undefined && !pay.partialElsewhere && pay.partialOwner < amount && !pay.paid) {
    return [part(pay.partialOwner, 'owner'), part(amount - pay.partialOwner, 'client')];
  }
  if (pay.paid || pay.methodImpliesPaid) return [part(amount, 'owner')];
  return [part(amount, 'client')];
}

// ───────────────────────── категория ─────────────────────────

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const categoryReCache = new Map<string, RegExp>();

/**
 * Шаблон категории: каждое слово — по основе, чтобы ловились падежные формы
 * («консультация» → консультации, консультацию; «поддержка» → поддержку). Короткие слова — точно.
 */
function categoryRe(cat: string): RegExp {
  let r = categoryReCache.get(cat);
  if (!r) {
    const words = cat.trim().toLowerCase().split(/\s+/).map((w) => {
      const stem = w.replace(/[аеёиоуыэюяйь]+$/u, '');
      return stem.length >= 5 ? stem.replace(ESCAPE_RE, '\\$&') + '\\p{L}*' : w.replace(ESCAPE_RE, '\\$&');
    });
    r = re(`${B}${words.join('\\s+')}${E}`);
    categoryReCache.set(cat, r);
  }
  return r;
}

/** Категория — по совпадению с категориями из настроек (длинные названия проверяются первыми). */
export function findCategory(text: string, categories: string[] = DEFAULT_CATEGORIES): string | undefined {
  const list = categories.filter((c) => c.trim().length >= 3).sort((a, b) => b.length - a.length);
  for (const c of list) if (categoryRe(c).test(text)) return c;
  return undefined;
}

// ───────────────────────── вид, признак денег, статус ─────────────────────────

export const PAYMENT_WORDS_RE = re(
  `${B}(предо?п?оплат\\p{L}*|предпоплат\\p{L}*|сертификат\\p{L}*|комисси\\p{L}*|booking\\s+fee|оплата\\s+за|опалата\\s+за)`,
);
/** Общие слова работы: строка без суммы с ними — всё равно работа, а не личное дело. */
const WORK_SIGN_WORDS_RE = re(
  `${B}(заказ\\p{L}*|клиент\\p{L}*|проект\\p{L}*|договор\\p{L}*|контракт\\p{L}*|дедлайн\\p{L}*|order|client|project|deadline)`,
);
/** Явно личное: врачи, быт, отдых. */
const PERSONAL_WORDS_RE = re(
  `${B}(к\\s+рите|рит[аеуы]|психолог\\p{L}*|ветеринар\\p{L}*|ветерин\\p{L}*|эпиляци\\p{L}*|парикмах\\p{L}*|парикмех\\p{L}*|стрижк\\p{L}*|зуб\\p{L}*|стоматолог\\p{L}*|эндокрин\\p{L}*|вр[ао]ч\\p{L}*|доктор\\p{L}*|отпуск\\p{L}*|репетици\\p{L}*|экзамен\\p{L}*|тату|массаж|massage|гости|в\\s+гости|каникулы|паспорт\\p{L}*|купить|отвезти|ужин|операци\\p{L}*|анализ\\p{L}*|without\\s+food|настолки|горы|выходн\\p{L}*)`,
);

export interface ClassifyInput {
  text: string;
  hasDate: boolean;
  amount?: number;
  hasSource: boolean;
  hasInvoice?: boolean;
  hasPhone?: boolean;
  afterTotal?: boolean;
  /** Категории из настроек: совпадение с категорией — признак работы. */
  categories?: string[];
}

export interface ClassifyResult {
  kind: EntryKind;
  /**
   * Признак денег: запись с суммой или признаками работы. Тип выбирает вызывающий:
   * true → тип по умолчанию, false → тип для дел без денег.
   */
  money: boolean;
  /** Признак угадан без опоры (нет суммы и явных признаков). */
  guessed: boolean;
}

/** Вид записи и признак денег по эвристике SPEC §9 (без цвета). */
export function classify(i: ClassifyInput): ClassifyResult {
  const t = i.text;
  // «150 предоплата» внутри строки задачи — это частичная оплата, а не запись-предоплата.
  const tp = t.replace(new RegExp(PARTIAL_RE.source, 'giu'), ' ');
  const isPayment = PAYMENT_WORDS_RE.test(tp) || (i.amount !== undefined && i.amount < 0);
  const hasAmount = i.amount !== undefined;
  const personalWords = PERSONAL_WORDS_RE.test(t);
  const paidMention = re(`${B}опл[аче]{1,4}н`).test(t);
  const workSigns =
    isPayment || paidMention || !!i.hasInvoice || WORK_SIGN_WORDS_RE.test(t) || !!findCategory(t, i.categories ?? DEFAULT_CATEGORIES);

  if (i.afterTotal) return { kind: 'note', money: hasAmount || workSigns, guessed: false };

  if (!hasAmount && (personalWords || !workSigns)) {
    return { kind: i.hasDate ? 'event' : 'note', money: false, guessed: !personalWords };
  }
  let kind: EntryKind;
  if (isPayment) kind = 'payment';
  else if (i.hasDate) kind = 'job';
  else kind = 'work'; // без даты — работа, засчитывается в месяц учёта
  return { kind, money: true, guessed: false };
}

export function statusFor(p: {
  kind: EntryKind;
  /** Тип записи с деньгами. */
  hasMoney: boolean;
  date?: ISODate;
  dateEnd?: ISODate;
  accountingMonth?: YearMonth;
  amount?: number;
  money: MoneyPart[];
  cancelled?: boolean;
  today: ISODate;
}): EntryStatus {
  if (p.cancelled) return 'cancelled';
  const ref = p.dateEnd ?? p.date;
  let past: boolean;
  if (ref) past = ref < p.today;
  else if (p.accountingMonth) past = p.accountingMonth < p.today.slice(0, 7);
  else past = false;
  if (!past) {
    if (ref) return 'booked';
    return p.kind === 'work' ? 'editing' : 'booked';
  }
  if (!p.hasMoney || !p.amount) return 'done';
  const owner = p.money.filter((m) => m.where === 'owner').reduce((s, m) => s + m.amount, 0);
  return owner >= p.amount ? 'done' : 'delivered';
}

// ───────────────────────── сумма в тексте (быстрый ввод) ─────────────────────────

const AMOUNT_RE =
  /(?<![\d.,:\p{L}])([-−]?)(€\s?)?(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s?(€|eur\b|евро\b)?(?![\d.,:]?\d)(?!\s*(?:%|процент|час|мин|лет|год|челов|дн))/giu;

export function findAmount(text: string): { amount?: number; span?: [number, number] } {
  let best: { amount: number; span: [number, number]; marked: boolean } | undefined;
  for (const m of text.matchAll(AMOUNT_RE)) {
    const [whole, minus, eur1, int, frac, eur2] = m;
    const idx = m.index ?? 0;
    const n = Number(int.replace(/\s/g, '') + (frac ? '.' + frac : '')) * (minus ? -1 : 1);
    if (!Number.isFinite(n)) continue;
    const marked = !!(eur1 || eur2);
    if (!marked && Math.abs(n) < 10) continue;
    const cand = { amount: n, span: [idx, idx + whole.length] as [number, number], marked };
    if (!best || (marked && !best.marked)) best = cand;
    else if (marked === best.marked) best = cand; // последнее число — обычно сумма
  }
  return best ? { amount: best.amount, span: best.span } : {};
}

// ───────────────────────── инвойс ─────────────────────────

export function findInvoice(text: string): { invoiceNo?: string; mark: boolean; span?: [number, number] } {
  // «инв 28», «инвойс 1», «invoice 47»; «в инвойсе 1200» — это сумма, не номер.
  const m = re(`${B}(?:инв\\.?|инвойс|иновойс|invoice)\\s*№?\\s*(\\d{1,5})${E}`).exec(text);
  if (m) return { invoiceNo: m[1], mark: true, span: [m.index, m.index + m[0].length] };
  const mark = re(`${B}(инв|инвойс\\p{L}*|invoice)${E}`).exec(text);
  return mark ? { mark: true, span: [mark.index, mark.index + mark[0].length] } : { mark: false };
}

// ───────────────────────── быстрый ввод ─────────────────────────

/**
 * Разобрать строку быстрого ввода: «12.12 встреча 11-12 200 от Пети». Тип: запись с суммой или
 * признаками работы — тип по умолчанию, иначе — тип для дел без денег (из ctx.settings).
 */
export function parseQuickLine(text: string, ctx: ParseContext): ParsedLine {
  const issues: string[] = [];
  const today = ctx.today ?? todayIso();
  const raw = text.replace(/[\s ]+/g, ' ').trim();

  const dp = parseDatePrefix(raw, ctx.year, ctx.month);
  let rest = normalizeTimeText(dp.rest);

  // Контакт — раньше времени и суммы, чтобы телефон не стал суммой.
  const ci = findContactInfo(rest);
  let quickName: string | undefined;
  if (ci.phones.length || ci.channels.length) {
    // Имя — соседнее слово с заглавной буквы возле телефона/канала.
    for (const [a, b] of ci.spans) {
      const before = rest.slice(0, a).match(/(\p{Lu}[\p{Ll}]+)\s*$/u);
      const after = rest.slice(b).match(/^\s*(\p{Lu}[\p{Ll}]+)/u);
      const w = before?.[1] ?? after?.[1];
      if (w && !monthFromWord(w)) {
        quickName = w;
        const pos = before ? a - before[0].length : b;
        const len = before ? before[0].length : after![0].length;
        ci.spans.push([pos, pos + len]);
        break;
      }
    }
  }
  rest = cutSpans(rest, ci.spans);

  const src = findSource(rest, ctx.sources);
  if (src) rest = cutSpans(rest, src.spans);

  let pay = findPayment(rest);
  const inv = findInvoice(rest);
  const spans: [number, number][] = [...pay.spans];
  if (inv.span) spans.push(inv.span);
  rest = cutSpans(rest, spans);

  const times = findTimes(rest, { bareHours: true, strictSingle: true });
  rest = cutSpans(rest, times.spans);
  let timeNote = times.timeNote;
  if (!times.timeStart && !times.timeEnd) {
    const w = rest.match(re(`${B}(утром|утро|вечером|вечер|ночью|уточнить)${E}`));
    if (w) {
      timeNote = w[1].toLowerCase();
      rest = rest.replace(w[0], ' ');
    }
  } else {
    rest = rest.replace(re(`${B}(утра|утром|дня|днём|днем|вечера|вечером)${E}`), ' ');
  }

  const am = findAmount(rest);
  if (am.span) rest = cutSpans(rest, [am.span]);
  if (am.amount === undefined && pay.partialOwner !== undefined) {
    // «300 оплачено» в быстром вводе — это сама сумма, оплаченная целиком.
    am.amount = pay.partialOwner;
    pay = { ...pay, partialOwner: undefined, partialElsewhere: false, paid: !pay.unpaid };
  }

  const title = cleanText(rest.replace(/\s+[,;]+/g, ' '));

  const categories = ctx.categories ?? DEFAULT_CATEGORIES;
  const amount = am.amount;
  const cls = classify({
    text: raw,
    hasDate: !!dp.date,
    amount,
    hasSource: !!src,
    hasInvoice: !!inv.invoiceNo,
    hasPhone: ci.phones.length > 0,
    categories,
  });
  const typeSettings = ctx.settings ?? DEFAULT_SETTINGS;
  const type = cls.money ? defaultTypeId(typeSettings) : defaultNoMoneyTypeId(typeSettings);

  const holderId = src?.holder ? src.source?.id : undefined;
  if (src?.holder && !src.source) issues.push(`Посредник «${src.name}» ещё не в справочнике`);
  const money = buildMoney(amount, paymentKindDefaults(cls.kind, pay), holderId);
  if (src?.holder && !holderId && amount) {
    // посредник неизвестен по id — деньги всё равно у посредника
    money.splice(0, money.length, { amount, where: 'intermediary', ...(pay.method ? { method: pay.method } : {}) });
  }

  let accountingMonth: YearMonth | undefined;
  if (pay.paidInMonth) accountingMonth = yearMonth(pastNearestYear(pay.paidInMonth, ctx.year, ctx.month), pay.paidInMonth);
  else if (!dp.date && amount !== undefined) accountingMonth = yearMonth(ctx.year, ctx.month);

  const tentative = dp.tentative || re(`${B}(под\\s+вопросом|уточнить)${E}`).test(raw);
  const entry: ParsedLine['entry'] = {
    kind: cls.kind,
    type,
    title,
    dateTentative: tentative,
    allDay: !times.timeStart,
    currency: 'EUR',
    money: cls.money ? money : [],
    checklist: [],
  };
  if (dp.date) entry.date = dp.date;
  if (dp.dateEnd) entry.dateEnd = dp.dateEnd;
  if (times.timeStart) entry.timeStart = times.timeStart;
  if (times.timeEnd) entry.timeEnd = times.timeEnd;
  if (timeNote) entry.timeNote = timeNote;
  if (ci.mapUrl) entry.mapUrl = ci.mapUrl;
  const category = cls.money ? findCategory(raw, categories) : undefined;
  if (category) entry.category = category;
  if (amount !== undefined) entry.amount = amount;
  if (inv.invoiceNo) entry.invoiceNo = inv.invoiceNo;
  if (accountingMonth) entry.accountingMonth = accountingMonth;
  if (src?.source && cls.money) entry.sourceId = src.source.id;
  entry.status = statusFor({
    kind: cls.kind,
    hasMoney: cls.money,
    date: dp.date,
    dateEnd: dp.dateEnd,
    accountingMonth,
    amount,
    money: entry.money ?? [],
    cancelled: pay.cancelled,
    today,
  });

  if (!dp.date && /^\s*\d/.test(raw) && cls.kind !== 'work' && cls.kind !== 'note') issues.push('Дата не распознана');
  if (dp.otherMonth && dp.date) issues.push('Дата из другого месяца');

  const out: ParsedLine = { entry, money: cls.money, issues };
  if (src) out.sourceName = src.name;
  if (ci.phones.length || ci.channels.length) {
    out.contact = { phones: ci.phones, channels: ci.channels };
    if (quickName) out.contact.name = quickName;
  }
  return out;
}
