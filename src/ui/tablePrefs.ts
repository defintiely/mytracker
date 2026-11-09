// Настройки таблицы, которые живут на устройстве (localStorage), а не в документе: «Показывать пустые дни»,
// порядок по дате и вид таблицы («Таблица» или «Год»).
// Подписка — чтобы переключатель в «Настройках» и флажок в панели фильтров таблицы менялись синхронно.
import { useSyncExternalStore } from 'react';

export const SHOW_EMPTY_DAYS_KEY = 'wlt.table.showEmptyDays';
export const TABLE_SORT_KEY = 'wlt.table.sort';
export const TABLE_MODE_KEY = 'wlt.table.mode';

/** Порядок по дате: 'desc' — сначала новые, 'asc' — сначала старые. */
export type SortDir = 'desc' | 'asc';
/** Вид экрана таблицы: обычная таблица или календарь года (из него открывается один месяц). */
export type TableMode = 'table' | 'year';

interface DevicePref<T> {
  get: () => T;
  set: (v: T) => void;
  use: () => [T, (v: T) => void];
}

/** Значение на устройстве с подпиской. parse — проверка сохранённого; undefined — взять значение по умолчанию. */
function devicePref<T extends string | boolean>(key: string, fallback: T, parse: (raw: unknown) => T | undefined): DevicePref<T> {
  const listeners = new Set<() => void>();
  /** Хранилище отказало при записи — дальше значение живёт только в памяти этой вкладки. */
  let storageBroken = false;
  let memory = fallback;

  const get = (): T => {
    if (storageBroken) return memory;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return parse(JSON.parse(raw)) ?? fallback;
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
