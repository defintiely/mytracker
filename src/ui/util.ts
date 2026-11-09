// Помощники интерфейса: даты, просрочка, пересечения, справочники, localStorage, скачивание.
import type {
  Contact,
  Entry,
  EntryStatus,
  HistoryItem,
  ISODate,
  MoneyPart,
  Settings,
  Source,
  TrackerDoc,
} from '../model/types';
import { STATUS_LABELS, WHERE_LABELS } from '../model/types';
import { formatEUR, moneyTotal, newId, nowIso, payState } from '../model/entry';
import { typeHasMoney } from '../model/taskTypes';
import { store } from '../store/store';

// ---------- даты ----------

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function toISODate(d: Date): ISODate {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayISO(): ISODate {
  return toISODate(new Date());
}

export function parseISODate(s: ISODate): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = parseISODate(s);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / 86400000);
}

const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const WEEKDAYS_MON_FIRST = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/** «12.12» или «12.12.2025», если год не текущий. */
export function formatDate(s?: ISODate, withWeekday = false): string {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  const sameYear = Number(y) === new Date().getFullYear();
  let out = `${d}.${m}` + (sameYear ? '' : `.${y}`);
  if (withWeekday) out = WEEKDAYS_SHORT[parseISODate(s).getDay()] + ' ' + out;
  return out;
}

export function formatDateRange(e: Pick<Entry, 'date' | 'dateEnd' | 'dateTentative'>, withWeekday = false): string {
  if (!e.date) return '';
  let s = formatDate(e.date, withWeekday);
  if (e.dateEnd && e.dateEnd !== e.date) s += '–' + formatDate(e.dateEnd);
  if (e.dateTentative) s += '?';
  return s;
}

export function formatTime(e: Pick<Entry, 'timeStart' | 'timeEnd' | 'timeNote' | 'allDay'>): string {
  if (e.timeStart) return e.timeStart + (e.timeEnd ? '–' + e.timeEnd : '');
  return e.timeNote ?? '';
}

/** Разбор ручного ввода времени: «11-12», «11.30 - 13», «19:30» → поля; иначе — timeNote. */
export function parseTimeInput(text: string): Pick<Entry, 'timeStart' | 'timeEnd' | 'timeNote' | 'allDay'> {
  const t = text.trim();
  if (!t) return { timeStart: undefined, timeEnd: undefined, timeNote: undefined, allDay: true };
  const m = t.match(/^(\d{1,2})(?:[.:](\d{1,2}))?\s*(?:[-–—]\s*(\d{1,2})(?:[.:](\d{1,2}))?)?$/);
  const hm = (h?: string, mm?: string) => {
    if (h === undefined) return undefined;
    const hh = Number(h);
    let mi = mm === undefined ? 0 : Number(mm.length === 1 ? mm + '0' : mm);
    if (hh > 23 || mi > 59) return null;
    return `${pad2(hh)}:${pad2(mi)}`;
  };
  if (m) {
    const s = hm(m[1], m[2]);
    const e = hm(m[3], m[4]);
    if (s && e !== null) return { timeStart: s, timeEnd: e ?? undefined, timeNote: undefined, allDay: false };
  }
  return { timeStart: undefined, timeEnd: undefined, timeNote: t, allDay: true };
}

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Охватывает ли запись день d (с учётом dateEnd). */
export function coversDay(e: Pick<Entry, 'date' | 'dateEnd'>, d: ISODate): boolean {
  if (!e.date) return false;
  if (e.date === d) return true;
  return Boolean(e.dateEnd && e.date <= d && d <= e.dateEnd);
}

/** Id записей дня, пересекающихся по времени (без времени — не пересекаются; без конца — считаем 1 час). */
export function overlappingIds(dayEntries: Entry[]): Set<string> {
  const timed = dayEntries
    .filter((e) => e.timeStart && e.status !== 'cancelled')
    .map((e) => {
      const s = timeToMinutes(e.timeStart!);
      let end = e.timeEnd ? timeToMinutes(e.timeEnd) : s + 60;
      if (end <= s) end = s + 60;
      return { id: e.id, s, end };
    });
  const out = new Set<string>();
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length; j++)
      if (timed[i].s < timed[j].end && timed[j].s < timed[i].end) {
        out.add(timed[i].id);
        out.add(timed[j].id);
      }
  return out;
}

// ---------- деньги ----------

/** Запись без денег: тип без денег (settings не передан — только встроенный personal). */
export function noMoney(e: Pick<Entry, 'type'>, settings?: Settings): boolean {
  return settings ? !typeHasMoney(settings, e.type) : e.type === 'personal';
}

export function atClient(e: Entry, settings?: Settings): number {
  if (noMoney(e, settings) || !e.amount) return 0;
  return Math.max(0, e.amount - moneyTotal(e.money, 'owner') - moneyTotal(e.money, 'intermediary'));
}

export const PAY_ICONS: Record<ReturnType<typeof payState>, { icon: string; label: string }> = {
  none: { icon: '', label: 'Без денег' },
  unpaid: { icon: '○', label: 'Не оплачено' },
  partial: { icon: '◐', label: 'Оплачено частично' },
  intermediary: { icon: '⇄', label: 'Деньги у посредника' },
  paid: { icon: '●', label: 'Получено' },
};

export const STATUS_ICONS: Record<EntryStatus, string> = {
  lead: '✉',
  booked: '📌',
  shot: '📷',
  editing: '✎',
  delivered: '📦',
  done: '✔',
  cancelled: '✕',
};

export const METHOD_LABELS: Record<string, string> = { cash: 'нал', revolut: 'револют', bank: 'счёт' };

export function methodLabel(m?: string): string {
  if (!m) return '';
  return METHOD_LABELS[m] ?? m;
}

export function whereText(p: MoneyPart, sources: Source[]): string {
  if (p.where === 'intermediary') {
    const s = sources.find((x) => x.id === p.holderId);
    return 'у ' + (s?.name ?? 'посредника');
  }
  return WHERE_LABELS[p.where].toLowerCase();
}

/** Короткая строка «где деньги» для таблицы. */
export function moneySummary(e: Entry, sources: Source[], settings?: Settings): string {
  if (noMoney(e, settings) || e.amount === undefined) return '';
  const parts = e.money.map((p) => `${formatEUR(p.amount)} ${whereText(p, sources)}`);
  const rest = (e.amount ?? 0) - moneyTotal(e.money);
  if (rest > 0 && e.money.length) parts.push(`${formatEUR(rest)} у клиента`);
  if (!parts.length) return e.amount ? 'у клиента' : '';
  return parts.join(', ');
}

/** Записи журнала о перемещении денег (смена «где» у частей, добавление/удаление частей). */
export function describeMoneyChange(before: MoneyPart[], after: MoneyPart[], sources: Source[]): string[] {
  const out: string[] = [];
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const a = before[i];
    const b = after[i];
    if (a && b) {
      if (a.where !== b.where || (b.where === 'intermediary' && a.holderId !== b.holderId))
        out.push(`${formatEUR(b.amount)}: ${whereText(a, sources)} → ${whereText(b, sources)}`);
    } else if (b && !a) {
      out.push(`Добавлена часть ${formatEUR(b.amount)} (${whereText(b, sources)})`);
    } else if (a && !b) {
      out.push(`Удалена часть ${formatEUR(a.amount)} (${whereText(a, sources)})`);
    }
  }
  return out;
}

/** Дополнить patch записями журнала: смена статуса, перемещение денег. */
export function withHistory(e: Entry, patch: Partial<Entry>, sources: Source[]): Partial<Entry> {
  const items: HistoryItem[] = [];
  const at = nowIso();
  if (patch.status && patch.status !== e.status)
    items.push({ at, text: `Статус: ${STATUS_LABELS[e.status]} → ${STATUS_LABELS[patch.status]}` });
  if (patch.money) for (const text of describeMoneyChange(e.money, patch.money, sources)) items.push({ at, text });
  if (!items.length) return patch;
  return { ...patch, history: [...(patch.history ?? e.history ?? []), ...items] };
}

/** Перевести части посредника holderId в «получено». */
export function intermediaryToOwner(e: Entry, holderId: string | undefined, sources: Source[]): Partial<Entry> {
  const at = nowIso();
  const money = e.money.map((p) =>
    p.where === 'intermediary' && (holderId === undefined || p.holderId === holderId)
      ? { ...p, where: 'owner' as const, holderId: undefined, at }
      : p,
  );
  return withHistory(e, { money }, sources);
}

// ---------- просрочка ----------

export interface OverdueInfo {
  reason: string;
}

export function overdueReason(e: Entry, settings: Settings, today: ISODate): string | undefined {
  if (e.deleted || e.status === 'cancelled') return undefined;
  const last = e.dateEnd ?? e.date;
  if (last && last < today && (e.status === 'booked' || e.status === 'lead') && e.kind === 'shoot')
    return 'Съёмка прошла, статус ещё «' + STATUS_LABELS[e.status] + '»';
  if (e.status === 'delivered' && atClient(e, settings) > 0)
    return `Отдано, но ${formatEUR(atClient(e, settings))} ещё у клиента`;
  for (const p of e.money) {
    if (p.where !== 'intermediary') continue;
    const since = p.at?.slice(0, 10) ?? e.date ?? e.updatedAt.slice(0, 10);
    const days = daysBetween(since, today);
    if (days > settings.intermediaryOverdueDays) return `${formatEUR(p.amount)} у посредника ${days} дн.`;
  }
  return undefined;
}

// ---------- справочники ----------

export function norm(s: string): string {
  return s.trim().toLowerCase().replace(/ё/g, 'е');
}

export function findSource(sources: Source[], name: string): Source | undefined {
  const n = norm(name);
  return sources.find((s) => !s.deleted && (norm(s.name) === n || s.aliases.some((a) => norm(a) === n)));
}

export function makeSource(name: string): Source {
  const t = nowIso();
  return { id: newId(), name: name.trim(), aliases: [norm(name)], createdAt: t, updatedAt: t };
}

export function makeContact(partial: Partial<Contact> = {}): Contact {
  const t = nowIso();
  return { id: newId(), name: '', phones: [], channels: [], createdAt: t, updatedAt: t, ...partial };
}

export function digits(s: string): string {
  return s.replace(/\D/g, '');
}

/** Номер для wa.me: только цифры; номер без кода (до 10 цифр, без «+») получает код страны из настроек. */
export function waNumber(phone: string, countryCode = store.getDoc().settings.phoneCountryCode): string {
  const d = digits(phone);
  const cc = digits(countryCode ?? '');
  if (!cc || phone.trim().startsWith('+') || d.length > 10 || d.startsWith(cc)) return d;
  return cc + d.replace(/^0+/, '');
}

export function findContactByPhone(contacts: Contact[], phones: string[]): Contact | undefined {
  const ds = phones.map((p) => digits(p).slice(-8)).filter(Boolean);
  if (!ds.length) return undefined;
  return contacts.find((c) => !c.deleted && c.phones.some((p) => ds.includes(digits(p).slice(-8))));
}

export function sourceName(doc: TrackerDoc, id?: string): string {
  if (!id) return '';
  return doc.sources.find((s) => s.id === id)?.name ?? '';
}

export function contactName(doc: TrackerDoc, id?: string): string {
  if (!id) return '';
  const c = doc.contacts.find((x) => x.id === id);
  return c ? c.name || c.phones[0] || '' : '';
}

export function uniqueSorted(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v && v.trim())).map((v) => v.trim()))].sort((a, b) =>
    a.localeCompare(b, 'ru'),
  );
}

export function liveEntries(doc: TrackerDoc): Entry[] {
  return doc.entries.filter((e) => !e.deleted);
}

// ---------- localStorage ----------

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* приватный режим или запрет хранилища — не критично */
  }
}

// ---------- файлы ----------

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function mapLink(e: Pick<Entry, 'mapUrl' | 'location'>): string | undefined {
  if (e.mapUrl) return e.mapUrl;
  if (e.location) return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(e.location);
  return undefined;
}
