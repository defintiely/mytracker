// Общие помощники над моделью: создание записей, производные статусы, итоги месяца.
import type {
  Entry,
  EntryKind,
  EntryType,
  MoneyPart,
  Settings,
  TrackerDoc,
  YearMonth,
} from './types';
import { DEFAULT_SETTINGS } from './types';

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newEntry(partial: Partial<Entry> = {}): Entry {
  const t = nowIso();
  const type: EntryType = partial.type ?? 'main';
  const kind: EntryKind = partial.kind ?? (type === 'personal' ? 'event' : 'shoot');
  return {
    id: newId(),
    type,
    kind,
    title: '',
    dateTentative: false,
    allDay: !partial.timeStart,
    media: [],
    currency: 'EUR',
    money: [],
    status: 'booked',
    checklist: [],
    createdAt: t,
    updatedAt: t,
    ...partial,
  };
}

export function emptyDoc(): TrackerDoc {
  return {
    schemaVersion: 1,
    entries: [],
    contacts: [],
    sources: [],
    settings: structuredClone(DEFAULT_SETTINGS),
  };
}

/** Производный статус оплаты (для фильтров и значков). */
export type PayState = 'none' | 'unpaid' | 'partial' | 'intermediary' | 'paid';

export function moneyTotal(parts: MoneyPart[], where?: MoneyPart['where']): number {
  return parts.filter((p) => !where || p.where === where).reduce((s, p) => s + p.amount, 0);
}

export function payState(e: Pick<Entry, 'amount' | 'money' | 'type'>): PayState {
  if (e.type === 'personal' || !e.amount) return 'none';
  const owner = moneyTotal(e.money, 'owner');
  const inter = moneyTotal(e.money, 'intermediary');
  const client = e.amount - owner - inter;
  if (owner >= e.amount) return 'paid';
  if (inter > 0 && client <= 0) return 'intermediary';
  if (owner > 0 || inter > 0) return 'partial';
  return 'unpaid';
}

/** Месяц, к которому относится запись в таблице и итогах. */
export function entryMonth(e: Pick<Entry, 'date' | 'accountingMonth'>): YearMonth | undefined {
  return e.accountingMonth ?? e.date?.slice(0, 7);
}

export interface MonthTotals {
  month: YearMonth;
  turnover: number;
  net: number;
  main: number;
  joint: number;
  received: number;
  atIntermediary: number;
  atClient: number;
  shoots: number;
}

export function monthTotals(entries: Entry[], month: YearMonth, settings: Settings): MonthTotals {
  const list = entries.filter((e) => !e.deleted && e.status !== 'cancelled' && entryMonth(e) === month);
  const t: MonthTotals = {
    month,
    turnover: 0,
    net: 0,
    main: 0,
    joint: 0,
    received: 0,
    atIntermediary: 0,
    atClient: 0,
    shoots: 0,
  };
  for (const e of list) {
    if (e.type === 'personal') continue;
    const a = e.amount ?? 0;
    t.turnover += a;
    if (e.type === 'main') t.main += a;
    if (e.type === 'joint') t.joint += a;
    const owner = moneyTotal(e.money, 'owner');
    const inter = moneyTotal(e.money, 'intermediary');
    t.received += owner;
    t.atIntermediary += inter;
    t.atClient += Math.max(0, a - owner - inter);
    if (e.kind === 'shoot') t.shoots++;
  }
  t.net = Math.round(t.turnover * settings.netFactor * 100) / 100;
  return t;
}

/** Обновить запись с проставлением updatedAt и fieldUpdatedAt по изменённым полям. */
export function patchEntry(e: Entry, patch: Partial<Entry>): Entry {
  // Монотонная метка: правка всегда новее предыдущей, даже если часы устройства отстают
  // от устройства, сделавшего прошлую правку (слияние при синхронизации сравнивает метки).
  const prev = Date.parse(e.updatedAt);
  const t = new Date(Math.max(Date.now(), Number.isNaN(prev) ? 0 : prev + 1)).toISOString();
  const fieldUpdatedAt = { ...(e.fieldUpdatedAt ?? {}) };
  for (const k of Object.keys(patch) as (keyof Entry)[]) {
    if (k === 'updatedAt' || k === 'fieldUpdatedAt') continue;
    fieldUpdatedAt[k] = t;
  }
  return { ...e, ...patch, updatedAt: t, fieldUpdatedAt };
}

export function formatEUR(n: number | undefined): string {
  if (n === undefined || n === null) return '';
  return '€' + n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const MONTHS_RU = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];
export const MONTH_NAMES_RU = MONTHS_RU;

export function monthLabel(m: YearMonth): string {
  const [y, mm] = m.split('-').map(Number);
  const name = MONTHS_RU[mm - 1];
  return name[0].toUpperCase() + name.slice(1) + ' ' + y;
}
