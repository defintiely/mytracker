// Настройки таблицы, которые живут на устройстве (localStorage), а не в документе: «Показывать пустые дни»,
// порядок по дате, вид таблицы («Таблица» или «Год») и поля саммари в карточках года.
// Подписка — чтобы переключатель в «Настройках» и флажок в панели фильтров таблицы менялись синхронно.
import { useSyncExternalStore } from 'react';

export const SHOW_EMPTY_DAYS_KEY = 'wlt.table.showEmptyDays';
export const TABLE_SORT_KEY = 'wlt.table.sort';
export const TABLE_MODE_KEY = 'wlt.table.mode';

/** Порядок по дате: 'desc' — сначала новые, 'asc' — сначала старые. */
export type SortDir = 'desc' | 'asc';
/** Вид экрана таблицы: обычная таблица или календарь года (из него открывается один месяц). */
export type TableMode = 'table' | 'year';

export interface DevicePref<T> {
  get: () => T;
  set: (v: T) => void;
  use: () => [T, (v: T) => void];
}

/**
 * Значение на устройстве с подпиской. parse — проверка сохранённого; undefined — взять значение по умолчанию.
 * Значение-объект кэшируется по сохранённой строке: useSyncExternalStore требует один и тот же снимок, пока
 * ничего не менялось.
 */
export function devicePref<T>(key: string, fallback: T, parse: (raw: unknown) => T | undefined): DevicePref<T> {
  const listeners = new Set<() => void>();
  /** Хранилище отказало при записи — дальше значение живёт только в памяти этой вкладки. */
  let storageBroken = false;
  let memory = fallback;
  let cachedRaw: string | null = null;
  let cachedValue = fallback;

  const get = (): T => {
    if (storageBroken) return memory;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      if (raw !== cachedRaw) {
        cachedValue = parse(JSON.parse(raw)) ?? fallback;
        cachedRaw = raw;
      }
      return cachedValue;
    } catch {
      return memory;
    }
  };

  const set = (v: T): void => {
    memory = v;
    try {
      localStorage.setItem(key, JSON.stringify(v));
      storageBroken = false;
    } catch {
      storageBroken = true;
    }
    listeners.forEach((l) => l());
  };

  const subscribe = (cb: () => void): (() => void) => {
    listeners.add(cb);
    // Та же настройка, изменённая в другой вкладке.
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === key) cb();
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(cb);
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
  };

  const use = (): [T, (v: T) => void] => [useSyncExternalStore(subscribe, get, () => fallback), set];
  return { get, set, use };
}

const showEmptyDays = devicePref<boolean>(SHOW_EMPTY_DAYS_KEY, false, (v) => v === true);
const tableSort = devicePref<SortDir>(TABLE_SORT_KEY, 'desc', (v) => (v === 'asc' || v === 'desc' ? v : undefined));
const tableMode = devicePref<TableMode>(TABLE_MODE_KEY, 'table', (v) => (v === 'table' || v === 'year' ? v : undefined));

export const getShowEmptyDays = showEmptyDays.get;
export const setShowEmptyDays = showEmptyDays.set;
export const useShowEmptyDays = showEmptyDays.use;

export const getTableSort = tableSort.get;
export const setTableSort = tableSort.set;
export const useTableSort = tableSort.use;

export const getTableMode = tableMode.get;
export const setTableMode = tableMode.set;
export const useTableMode = tableMode.use;

// ---------- что показывать в саммари карточек вида «Год» ----------

export const YEAR_SUMMARY_KEY = 'wlt.year.summary';

/** Поля саммари карточки месяца; true — показывать. */
export interface YearSummaryPrefs {
  count: boolean;
  turnover: boolean;
  net: boolean;
  received: boolean;
  waiting: boolean;
}
export type YearSummaryField = keyof YearSummaryPrefs;

/** Порядок полей и подписи галок в «Настройках». */
export const YEAR_SUMMARY_FIELDS: { id: YearSummaryField; label: string }[] = [
  { id: 'count', label: 'Число задач' },
  { id: 'turnover', label: 'Оборот' },
  { id: 'net', label: 'Чистыми ≈' },
  { id: 'received', label: 'Получено' },
  { id: 'waiting', label: 'Ждём' },
];

export const DEFAULT_YEAR_SUMMARY: YearSummaryPrefs = Object.freeze({
  count: true,
  turnover: true,
  net: true,
  received: true,
  waiting: true,
});

/** Сохранённое — объект; неизвестные ключи отбрасываются, недостающие и не-булевы берутся по умолчанию. */
function parseYearSummary(v: unknown): YearSummaryPrefs | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const src = v as Record<string, unknown>;
  const out = { ...DEFAULT_YEAR_SUMMARY };
  for (const { id } of YEAR_SUMMARY_FIELDS) if (typeof src[id] === 'boolean') out[id] = src[id] as boolean;
  return out;
}

const yearSummary = devicePref<YearSummaryPrefs>(YEAR_SUMMARY_KEY, DEFAULT_YEAR_SUMMARY, parseYearSummary);

export const getYearSummary = yearSummary.get;
export const setYearSummary = yearSummary.set;
export const useYearSummary = yearSummary.use;

// ---------- панель разделов (боковая навигация на ПК/планшете) ----------

export const NAV_SIDE_KEY = 'wlt.nav.side';
export const NAV_MODE_KEY = 'wlt.nav.mode';

/** С какой стороны экрана панель разделов. */
export type NavSide = 'left' | 'right';
/** 'pinned' — всегда открыта; 'drawer' — открывается кнопкой ☰ в шапке и выезжает поверх содержимого. */
export type NavMode = 'pinned' | 'drawer';

const navSide = devicePref<NavSide>(NAV_SIDE_KEY, 'left', (v) => (v === 'left' || v === 'right' ? v : undefined));
const navMode = devicePref<NavMode>(NAV_MODE_KEY, 'pinned', (v) => (v === 'pinned' || v === 'drawer' ? v : undefined));

export const getNavSide = navSide.get;
export const setNavSide = navSide.set;
export const useNavSide = navSide.use;

export const getNavMode = navMode.get;
export const setNavMode = navMode.set;
export const useNavMode = navMode.use;
