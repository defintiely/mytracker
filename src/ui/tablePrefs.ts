// Настройки таблицы, которые живут на устройстве (localStorage), а не в документе: «Показывать пустые дни».
// Подписка — чтобы переключатель в «Настройках» и флажок в панели фильтров таблицы менялись синхронно.
import { useSyncExternalStore } from 'react';

export const SHOW_EMPTY_DAYS_KEY = 'wlt.table.showEmptyDays';

const listeners = new Set<() => void>();
/** Хранилище отказало при записи — дальше значение живёт только в памяти этой вкладки. */
let storageBroken = false;
let memory = false;

export function getShowEmptyDays(): boolean {
  if (storageBroken) return memory;
  try {
    const raw = localStorage.getItem(SHOW_EMPTY_DAYS_KEY);
    return raw === null ? false : JSON.parse(raw) === true;
  } catch {
    return memory;
  }
}

export function setShowEmptyDays(on: boolean): void {
  memory = on;
  try {
    localStorage.setItem(SHOW_EMPTY_DAYS_KEY, JSON.stringify(on));
    storageBroken = false;
  } catch {
    storageBroken = true;
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // Та же настройка, изменённая в другой вкладке.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === SHOW_EMPTY_DAYS_KEY) cb();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function useShowEmptyDays(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, getShowEmptyDays, () => false);
  return [on, setShowEmptyDays];
}
