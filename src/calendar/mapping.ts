// Чистые функции: запись трекера ↔ событие Google Календаря (SPEC §10).
import type { Entry, TrackerDoc } from '../model/types';
import { formatEUR } from '../model/entry';
import { typeColor, typeHasMoney } from '../model/taskTypes';
import type { DesiredEvent, ForeignEvent, MovedEvent } from '../sync/scriptApi';

/** Часовой пояс устройства: в нём выгружаются события со временем и создаётся календарь. */
export const CALENDAR_TIME_ZONE: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

export interface GCalDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GCalEvent {
  id?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  start?: GCalDateTime;
  end?: GCalDateTime;
  reminders?: { useDefault: boolean; overrides?: { method: 'popup' | 'email'; minutes: number }[] };
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  updated?: string;
}

/** Палитра цветов событий Google Calendar (colors.get → event). */
export const GOOGLE_EVENT_COLORS: Record<string, string> = {
  '1': '#a4bdfc', // лавандовый
  '2': '#7ae7bf', // шалфей
  '3': '#dbadff', // виноград
  '4': '#ff887c', // фламинго
  '5': '#fbd75b', // банан
  '6': '#ffb878', // мандарин
  '7': '#46d6db', // павлин
  '8': '#e1e1e1', // графит
  '9': '#5484ed', // черника
  '10': '#51b749', // базилик
  '11': '#dc2127', // томат
};

const ICON_PHOTO = '📷';
const ICON_VIDEO = '🎥';
export const BUSY_TITLE = 'Занято';
export const CANCELLED_PREFIX = 'Отменено: ';
export const TENTATIVE_PREFIX = '? ';

// ---------- цвет ----------

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Ближайший colorId палитры событий Google к цвету '#rrggbb'. */
export function nearestColorId(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const c = parseHex(hex);
  if (!c) return undefined;
  let best: string | undefined;
  let bestD = Infinity;
  for (const [id, h] of Object.entries(GOOGLE_EVENT_COLORS)) {
    const p = parseHex(h)!;
    const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

// ---------- даты ----------

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

function fromMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function normTime(t: string): string {
  return fromMinutes(toMinutes(t));
}

/** Дата + 'HH:mm' + минуты → [дата, 'HH:mm'] с переходом через полночь. */
function shift(date: string, time: string, minutes: number): [string, string] {
  const total = toMinutes(time) + minutes;
  const days = Math.floor(total / 1440);
  return [addDays(date, days), fromMinutes(((total % 1440) + 1440) % 1440)];
}

function localDateTime(date: string, time: string): string {
  return `${date}T${normTime(time)}:00`;
}

interface When {
  start: GCalDateTime;
  end: GCalDateTime;
}

function entryWhen(e: Entry): When | null {
  if (!e.date) return null;
  const lastDay = e.dateEnd && e.dateEnd > e.date ? e.dateEnd : e.date;
  if (!e.timeStart) {
    return { start: { date: e.date }, end: { date: addDays(lastDay, 1) } };
  }
  const start = normTime(e.timeStart);
  let endDate: string;
  let endTime: string;
  if (e.timeEnd) {
    endTime = normTime(e.timeEnd);
    endDate = lastDay;
    // «22:00–02:00» без диапазона дат — через полночь.
    if (endDate === e.date && toMinutes(endTime) <= toMinutes(start)) endDate = addDays(e.date, 1);
  } else {
    [endDate, endTime] = shift(lastDay, start, 60);
  }
  return {
    start: { dateTime: localDateTime(e.date, start), timeZone: CALENDAR_TIME_ZONE },
    end: { dateTime: localDateTime(endDate, endTime), timeZone: CALENDAR_TIME_ZONE },
  };
}

/** Местное время события в поясе CALENDAR_TIME_ZONE: { date, time? }. */
function eventLocal(dt: GCalDateTime | undefined): { date: string; time?: string } | null {
  if (!dt) return null;
  if (dt.date) return { date: dt.date };
  if (!dt.dateTime) return null;
  const s = dt.dateTime;
  const hasOffset = /([zZ]|[+-]\d\d:?\d\d)$/.test(s);
  if (!hasOffset && (!dt.timeZone || dt.timeZone === CALENDAR_TIME_ZONE)) {
    return { date: s.slice(0, 10), time: s.slice(11, 16) };
  }
  let instant: Date;
  if (hasOffset) instant = new Date(s);
  else instant = zonedToInstant(s, dt.timeZone!);
  if (isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CALENDAR_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
}

/** Местное время без смещения в поясе tz → момент времени. */
function zonedToInstant(local: string, tz: string): Date {
  const guess = new Date(local + 'Z');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(guess);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const asUtc = Date.parse(`${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}Z`);
  return new Date(guess.getTime() - (asUtc - guess.getTime()));
}

/** Отпечаток времени события в местном поясе — для распознавания переноса в календаре. */
export function whenKey(start: GCalDateTime | undefined, end: GCalDateTime | undefined): string {
  const s = eventLocal(start);
  const e = eventLocal(end);
  const f = (x: { date: string; time?: string } | null) => (x ? x.date + (x.time ? 'T' + x.time : '') : '-');
  return f(s) + '/' + f(e);
}

// ---------- хэш ----------

function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(o[k]))
      .join(',') +
    '}'
  );
}

/** cyrb53 — быстрый некриптографический 53-битный хэш строки. */
export function hashString(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// ---------- запись → событие ----------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function telLink(phone: string): string {
  const num = phone.replace(/[^\d+]/g, '');
  return `<a href="tel:${num}">${escapeHtml(phone)}</a>`;
}

function buildTitle(e: Entry, busy: boolean, withMoney: boolean): string {
  let title: string;
  if (busy) {
    title = BUSY_TITLE;
  } else {
    const base = e.title.trim() || e.category || (e.kind === 'event' ? 'Дело' : 'Съёмка');
    let icons = '';
    if (withMoney) {
      if (e.media.includes('photo')) icons += ICON_PHOTO;
      if (e.media.includes('video')) icons += ICON_VIDEO;
    }
    title = icons ? icons + ' ' + base : base;
  }
  if (e.dateTentative) title = TENTATIVE_PREFIX + title;
  if (e.status === 'cancelled') title = CANCELLED_PREFIX + title;
  return title;
}

function buildDescription(e: Entry, doc: TrackerDoc): string | undefined {
  const lines: string[] = [];
  const includeMoney = doc.settings.calendar.includeMoney && typeHasMoney(doc.settings, e.type);
  if (e.category) lines.push('Категория: ' + escapeHtml(e.category));
  const contact = e.contactId ? doc.contacts.find((c) => c.id === e.contactId && !c.deleted) : undefined;
  if (contact) {
    lines.push('Контакт: ' + escapeHtml(contact.name));
    for (const p of contact.phones) lines.push('Тел.: ' + telLink(p));
  }
  if (e.mapUrl) lines.push('Карта: ' + escapeHtml(e.mapUrl));
  if (e.timeNote) lines.push('Время: ' + escapeHtml(e.timeNote));
  if (includeMoney) {
    if (e.amount !== undefined) lines.push('Сумма: ' + escapeHtml(formatEUR(e.amount)));
    const src = e.sourceId ? doc.sources.find((s) => s.id === e.sourceId) : undefined;
    if (src) lines.push('Источник: ' + escapeHtml(src.name));
  }
  if (e.notes?.trim()) {
    if (lines.length) lines.push('');
    lines.push(escapeHtml(e.notes.trim()));
  }
  return lines.length ? lines.join('\n') : undefined;
}

/** Выгружается ли запись в календарь — без учёта отмены. */
function isExportable(e: Entry, doc: TrackerDoc): boolean {
  if (e.deleted || !e.date) return false;
  if (e.kind !== 'shoot' && e.kind !== 'event') return false;
  // Режим «личного» применяется ко всем типам без денег.
  if (!typeHasMoney(doc.settings, e.type) && doc.settings.calendar.personalMode === 'skip') return false;
  return true;
}

/**
 * Событие для записи или null — «события быть не должно» (удалить, если есть).
 * В extendedProperties.private: entryId, wltHash (хэш содержимого), wltWhen (отпечаток времени).
 */
export function entryToEvent(entry: Entry, doc: TrackerDoc): GCalEvent | null {
  if (!isExportable(entry, doc)) return null;
  const cal = doc.settings.calendar;
  if (entry.status === 'cancelled' && cal.onCancel === 'delete') return null;
  const when = entryWhen(entry);
  if (!when) return null;
  const withMoney = typeHasMoney(doc.settings, entry.type);
  const busy = !withMoney && cal.personalMode === 'busy';

  const minutes = [...new Set(cal.reminderMinutes.filter((m) => Number.isFinite(m) && m >= 0 && m <= 40320))]
    .sort((a, b) => b - a)
    .slice(0, 5);

  const body: GCalEvent = {
    summary: buildTitle(entry, busy, withMoney),
    start: when.start,
    end: when.end,
    reminders: { useDefault: false, overrides: minutes.map((m) => ({ method: 'popup', minutes: m })) },
  };
  if (!busy) {
    if (entry.location?.trim()) body.location = entry.location.trim();
    const description = buildDescription(entry, doc);
    if (description) body.description = description;
  }
  const colorId = nearestColorId(typeColor(doc.settings, entry.type));
  if (colorId) body.colorId = colorId;

  body.extendedProperties = {
    private: {
      entryId: entry.id,
      wltHash: hashString(stableStringify(body)),
      wltWhen: whenKey(when.start, when.end),
    },
  };
  return body;
}

export function eventHash(ev: GCalEvent | null | undefined): string | undefined {
  return ev?.extendedProperties?.private?.wltHash;
}

// ---------- событие → патч записи ----------

type TimePatch = Pick<Entry, 'date' | 'dateEnd' | 'timeStart' | 'timeEnd' | 'allDay'>;

function eventToTime(event: GCalEvent, entry: Entry): TimePatch | null {
  const s = eventLocal(event.start);
  const en = eventLocal(event.end);
  if (!s) return null;
  if (!s.time) {
    // весь день: end.date — исключительная граница
    const last = en ? addDays(en.date, -1) : s.date;
    return {
      date: s.date,
      dateEnd: last > s.date ? last : undefined,
      timeStart: undefined,
      timeEnd: undefined,
      allDay: true,
    };
  }
  const endDate = en?.date ?? s.date;
  const endTime = en?.time ?? shift(s.date, s.time, 60)[1];
  const diff = daysBetween(s.date, endDate);
  const overnight = diff === 1 && toMinutes(endTime) <= toMinutes(s.time);
  const dateEnd = diff >= 1 && !overnight ? endDate : undefined;
  // У записи не было конца, а длительность осталась часовой — конец не проставляем.
  const [defDate, defTime] = shift(dateEnd ?? s.date, s.time, 60);
  const keepNoEnd = !entry.timeEnd && defTime === endTime && (defDate === endDate || overnight);
  return {
    date: s.date,
    dateEnd,
    timeStart: s.time,
    timeEnd: keepNoEnd ? undefined : endTime,
    allDay: false,
  };
}

/**
 * Если у события приложения в календаре перенесли дату/время — патч записи
 * (date/dateEnd/timeStart/timeEnd/allDay). Остальные поля из календаря не тянем.
 * Перенос распознаётся по отпечатку wltWhen, записанному при выгрузке: если время события
 * совпадает с выгруженным, а запись отличается — значит, запись правили в приложении и
 * её выгрузит исходящая синхронизация, а не наоборот.
 */
export function eventToEntryPatch(event: GCalEvent, entry: Entry): Partial<Entry> | null {
  if (event.status === 'cancelled') return null;
  const pushed = event.extendedProperties?.private?.wltWhen;
  if (pushed && pushed === whenKey(event.start, event.end)) return null;
  const t = eventToTime(event, entry);
  if (!t) return null;
  const patch: Partial<Entry> = {};
  const cur: TimePatch = {
    date: entry.date,
    dateEnd: entry.dateEnd && entry.date && entry.dateEnd > entry.date ? entry.dateEnd : undefined,
    timeStart: entry.timeStart ? normTime(entry.timeStart) : undefined,
    timeEnd: entry.timeEnd ? normTime(entry.timeEnd) : undefined,
    allDay: !entry.timeStart,
  };
  for (const k of ['date', 'dateEnd', 'timeStart', 'timeEnd', 'allDay'] as const) {
    if (t[k] !== cur[k]) (patch as Record<string, unknown>)[k] = t[k];
  }
  if (Object.keys(patch).length === 0) return null;
  // allDay держим согласованным, даже если поменялось только время
  if (patch.allDay === undefined && entry.allDay !== t.allDay) patch.allDay = t.allDay;
  return patch;
}

// ---------- обмен с Apps Script (src/sync/scriptApi.ts) ----------

/** 'YYYY-MM-DD' или 'YYYY-MM-DDTHH:mm' из даты события Google. */
function gcalToScript(dt: GCalDateTime | undefined): string | undefined {
  if (!dt) return undefined;
  if (dt.date) return dt.date;
  return dt.dateTime?.slice(0, 16);
}

function scriptToGcal(s: string, allDay: boolean): GCalDateTime {
  return allDay ? { date: s.slice(0, 10) } : { dateTime: s.slice(0, 16) + ':00', timeZone: CALENDAR_TIME_ZONE };
}

/** Событие, которое должно быть в календаре, или null — «события быть не должно». */
export function entryToDesired(entry: Entry, doc: TrackerDoc): DesiredEvent | null {
  const ev = entryToEvent(entry, doc);
  if (!ev) return null;
  const start = gcalToScript(ev.start);
  const end = gcalToScript(ev.end);
  if (!start || !end) return null;
  const d: DesiredEvent = {
    entryId: entry.id,
    hash: eventHash(ev)!,
    title: ev.summary ?? '',
    allDay: !!ev.start?.date,
    start,
    end,
    reminders: (ev.reminders?.overrides ?? []).map((r) => r.minutes),
  };
  if (ev.description) d.description = ev.description;
  if (ev.location) d.location = ev.location;
  if (ev.colorId) d.colorId = ev.colorId;
  return d;
}

/** Перенос события в календаре → патч даты/времени записи (null — менять нечего). */
export function movedToPatch(m: MovedEvent, entry: Entry): Partial<Entry> | null {
  return eventToEntryPatch({ start: scriptToGcal(m.start, m.allDay), end: scriptToGcal(m.end, m.allDay) }, entry);
}

/** Поля предложения импорта из чужого события календаря. */
export function foreignToFields(f: ForeignEvent): {
  date: string;
  dateEnd?: string;
  timeStart?: string;
  timeEnd?: string;
} {
  const date = f.start.slice(0, 10);
  if (f.allDay) {
    const last = addDays(f.end.slice(0, 10), -1);
    return last > date ? { date, dateEnd: last } : { date };
  }
  const timeStart = f.start.slice(11, 16);
  const endDate = f.end.slice(0, 10);
  const timeEnd = f.end.slice(11, 16) || undefined;
  const diff = daysBetween(date, endDate);
  const overnight = diff === 1 && timeEnd !== undefined && toMinutes(timeEnd) <= toMinutes(timeStart);
  const out: { date: string; dateEnd?: string; timeStart?: string; timeEnd?: string } = { date, timeStart, timeEnd };
  if (diff >= 1 && !overnight) out.dateEnd = endDate;
  return out;
}

/** Сегодняшняя дата в поясе календаря. */
export function todayInCalendarZone(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CALENDAR_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** Окно поиска перенесённых и чужих событий: от сегодня −60 дней до +2 лет. */
export function calendarWindow(now: Date = new Date()): { windowStart: string; windowEnd: string } {
  const today = todayInCalendarZone(now);
  return { windowStart: addDays(today, -60), windowEnd: addDays(today, 730) };
}

/** Событие заканчивается не раньше начала окна (прошлое старше окна не выгружаем и не сверяем). */
export function desiredInWindow(d: DesiredEvent, windowStart: string): boolean {
  const endDay = d.end.slice(0, 10);
  return d.allDay ? endDay > windowStart : endDay >= windowStart;
}

/** Данные для предложения импорта из события, созданного не приложением. */
export function eventToProposalFields(event: GCalEvent): {
  date?: string;
  timeStart?: string;
  timeEnd?: string;
} {
  const s = eventLocal(event.start);
  const e = eventLocal(event.end);
  if (!s) return {};
  return { date: s.date, timeStart: s.time, timeEnd: s.time ? e?.time : undefined };
}
