// Локальное хранилище: весь TrackerDoc в памяти + IndexedDB (офлайн).
// Объём маленький (~1 МБ за 5 лет), поэтому документ хранится одной записью.
// Синхронизатор (src/sync) читает getDoc()/isDirty() и после слияния вызывает replaceDoc().
import { openDB, type IDBPDatabase } from 'idb';
import type { Contact, Entry, Settings, Source, TrackerDoc } from '../model/types';
import { emptyDoc, normalizeEntries, nowIso, patchEntry } from '../model/entry';
import { normalizeTaskTypes } from '../model/taskTypes';

const DB_NAME = 'work-life-tracker';
const DB_VERSION = 1;

type Listener = (doc: TrackerDoc) => void;

export class TrackerStore {
  private doc: TrackerDoc = emptyDoc();
  private db?: IDBPDatabase;
  private listeners = new Set<Listener>();
  private dirty = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private changeListeners = new Set<() => void>();

  async load(): Promise<void> {
    this.db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('kv');
      },
    });
    const saved = (await this.db.get('kv', 'doc')) as TrackerDoc | undefined;
    if (saved) this.doc = migrate(saved);
    this.dirty = Boolean(await this.db.get('kv', 'dirty'));
    this.emit();
  }

  getDoc(): TrackerDoc {
    return this.doc;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Вызывается при каждой локальной правке (синхронизатор ставит отложенный цикл). */
  onLocalChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  // ---- записи ----

  upsertEntry(e: Entry): void {
    const i = this.doc.entries.findIndex((x) => x.id === e.id);
    const entries = [...this.doc.entries];
    if (i >= 0) entries[i] = e;
    else entries.push(e);
    this.commit({ ...this.doc, entries });
  }

  updateEntry(id: string, patch: Partial<Entry>): void {
    const cur = this.doc.entries.find((x) => x.id === id);
    if (!cur) return;
    this.upsertEntry(patchEntry(cur, patch));
  }

  deleteEntry(id: string): void {
    this.updateEntry(id, { deleted: true });
  }

  addEntries(list: Entry[]): void {
    this.commit({ ...this.doc, entries: [...this.doc.entries, ...list] });
  }

  // ---- справочники ----

  upsertContact(c: Contact): void {
    const contacts = upsertById(this.doc.contacts, { ...c, updatedAt: nowIso() });
    this.commit({ ...this.doc, contacts });
  }

  upsertSource(s: Source): void {
    const sources = upsertById(this.doc.sources, { ...s, updatedAt: nowIso() });
    this.commit({ ...this.doc, sources });
  }

  updateSettings(patch: Partial<Settings>): void {
    this.commit({ ...this.doc, settings: { ...this.doc.settings, ...patch, updatedAt: nowIso() } });
  }

  // ---- для синхронизации / импорта ----

  /** Заменить документ целиком (результат слияния). markClean — сбросить флаг «есть несохранённое». */
  replaceDoc(doc: TrackerDoc, opts: { markClean?: boolean } = {}): void {
    this.doc = doc;
    if (opts.markClean) this.dirty = false;
    this.persist();
    this.emit();
  }

  /**
   * Восстановление из бэкапа: всё содержимое бэкапа становится «самой свежей правкой»,
   * чтобы при синхронизации оно победило версию в Drive. Записи, которых нет в бэкапе,
   * помечаются удалёнными (иначе слияние вернуло бы их из Drive).
   */
  restoreDoc(backup: TrackerDoc): void {
    const t = nowIso();
    const stamp = <T extends { updatedAt: string; fieldUpdatedAt?: unknown }>(x: T): T => {
      const y = { ...x, updatedAt: t };
      if ('fieldUpdatedAt' in y) delete (y as { fieldUpdatedAt?: unknown }).fieldUpdatedAt;
      return y;
    };
    const keep = <T extends { id: string; updatedAt: string; deleted?: boolean }>(cur: T[], next: T[]): T[] => {
      const ids = new Set(next.map((x) => x.id));
      const gone = cur.filter((x) => !ids.has(x.id)).map((x) => ({ ...x, deleted: true, updatedAt: t }));
      return [...next.map(stamp), ...gone];
    };
    this.commit({
      ...backup,
      entries: keep(this.doc.entries, backup.entries),
      contacts: keep(this.doc.contacts, backup.contacts),
      sources: keep(this.doc.sources, backup.sources),
      settings: { ...backup.settings, updatedAt: t },
    });
  }

  /** Служебные значения синхронизатора (driveFileId, base-снимок, lastSyncAt...). */
  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.db?.get('kv', 'meta:' + key)) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db?.put('kv', value, 'meta:' + key);
  }

  private commit(doc: TrackerDoc): void {
    this.doc = doc;
    this.dirty = true;
    this.persist();
    this.emit();
    for (const fn of this.changeListeners) fn();
  }

  private persist(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 150);
  }

  async flush(): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction('kv', 'readwrite');
    await tx.store.put(this.doc, 'doc');
    await tx.store.put(this.dirty, 'dirty');
    await tx.done;
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.doc);
  }
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const copy = [...list];
  copy[i] = item;
  return copy;
}

/**
 * Документ из IndexedDB → текущая схема. Старые записи: вид 'shoot' → 'job', поля media/withEditing стираются.
 * Старые типы задач (с флагом builtin или без taskTypes) → обычные типы. Имя календаря пользователя
 * не трогается — по умолчанию подставляется только для документов без него. Идемпотентно.
 */
export function migrate(doc: TrackerDoc): TrackerDoc {
  const base = emptyDoc();
  return {
    ...base,
    ...doc,
    entries: Array.isArray(doc.entries) ? normalizeEntries(doc.entries) : base.entries,
    settings: {
      ...base.settings,
      ...doc.settings,
      taskTypes: normalizeTaskTypes(doc.settings),
      calendar: { ...base.settings.calendar, ...(doc.settings?.calendar ?? {}) },
    },
  };
}

export const store = new TrackerStore();
