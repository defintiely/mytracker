// Синхронизация с Google Календарём (SPEC §10) через Google Apps Script в аккаунте пользователя.
// Трекер готовит полный список событий (DesiredEvent) и шлёт скрипту запрос `calendar`; скрипт сам
// ведёт отдельный календарь через CalendarApp (src/calendar/calendarGs.ts) и отвечает, что пользователь
// перенёс или удалил в календаре и какие чужие события там есть. Основной календарь не трогается.
import type { AfterSyncHook } from '../sync/types';
import type { CalendarResponse, DesiredEvent, ScriptClient } from '../sync/scriptApi';
import type { Entry, Settings, TrackerDoc } from '../model/types';
import { newEntry } from '../model/entry';
import { store as defaultStore } from '../store/store';
import {
  CALENDAR_TIME_ZONE,
  calendarWindow,
  desiredInWindow,
  entryToDesired,
  foreignToFields,
  movedToPatch,
} from './mapping';

/** События календаря «Съёмки», созданные не приложением, — предложить импорт (SPEC §10). */
export interface CalendarProposal {
  eventId: string;
  title: string;
  date?: string;
  /** Последний день многодневного события. */
  dateEnd?: string;
  timeStart?: string;
  timeEnd?: string;
  location?: string;
}

/**
 * DesiredEvent + необязательный adoptEventId — расширение контракта scriptApi: id чужого события,
 * из которого импортирована запись. Скрипт помечает само это событие, а не создаёт рядом дубль.
 */
export type DesiredEventToSend = DesiredEvent & { adoptEventId?: string };

/** То, что модуль использует из TrackerStore (для тестов подставляется настоящий store на fake-indexeddb). */
export interface CalendarStoreLike {
  getDoc(): TrackerDoc;
  updateEntry(id: string, patch: Partial<Entry>): void;
  updateSettings(patch: Partial<Settings>): void;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

export interface CalendarSyncDeps {
  store: CalendarStoreLike;
  /** Текущее время (для окна поиска). */
  now?: () => Date;
}

export interface CalendarSync {
  afterSync: AfterSyncHook;
  getProposals(): CalendarProposal[];
  subscribeProposals(fn: (list: CalendarProposal[]) => void): () => void;
  dismissProposal(eventId: string): void;
}

/** Событие удалили в календаре: entryId → хэш записи на тот момент. Пока хэш не изменится — не выгружаем. */
export const META_REMOVED = 'calendarRemoved';
const META_PROPOSALS = 'calendarProposals';

interface ProposalsState {
  list: CalendarProposal[];
  dismissed: string[];
}

export function createCalendarSync(deps: CalendarSyncDeps): CalendarSync {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  let proposals: ProposalsState = { list: [], dismissed: [] };
  let proposalsLoad: Promise<void> | undefined;
  const listeners = new Set<(list: CalendarProposal[]) => void>();
  let running: Promise<void> | undefined;

  // ---------- предложения ----------

  function loadProposals(): Promise<void> {
    proposalsLoad ??= store
      .getMeta<ProposalsState>(META_PROPOSALS)
      .then((saved) => {
        if (saved) {
          // правки, сделанные до окончания загрузки, не теряем
          const dismissed = new Set([...saved.dismissed, ...proposals.dismissed]);
          const byId = new Map(saved.list.map((p) => [p.eventId, p]));
          for (const p of proposals.list) byId.set(p.eventId, p);
          proposals = { list: [...byId.values()].filter((p) => !dismissed.has(p.eventId)), dismissed: [...dismissed] };
          emitProposals();
        }
      })
      .catch(() => {});
    return proposalsLoad;
  }

  function visibleProposals(): CalendarProposal[] {
    const linked = new Set(store.getDoc().entries.map((e) => e.calendarEventId).filter(Boolean));
    return proposals.list.filter((p) => !linked.has(p.eventId));
  }

  function emitProposals(): void {
    const list = visibleProposals();
    for (const fn of listeners) fn(list);
  }

  function saveProposals(): Promise<void> {
    return store.setMeta(META_PROPOSALS, proposals);
  }

  // ---------- цикл ----------

  async function run(client: ScriptClient): Promise<void> {
    const doc = store.getDoc();
    const cal = doc.settings.calendar;
    if (!cal.enabled || !client.configured()) return;
    await loadProposals();

    const removed: Record<string, string> = { ...((await store.getMeta<Record<string, string>>(META_REMOVED)) ?? {}) };
    let removedChanged = false;
    const { windowStart, windowEnd } = calendarWindow(now());

    const events: DesiredEventToSend[] = [];
    for (const entry of doc.entries) {
      const d: DesiredEventToSend | null = entryToDesired(entry, doc);
      if (!d) {
        if (removed[entry.id] !== undefined) {
          delete removed[entry.id];
          removedChanged = true;
        }
        continue;
      }
      if (!desiredInWindow(d, windowStart)) continue;
      if (removed[entry.id] !== undefined) {
        if (removed[entry.id] === d.hash) continue; // удалено в календаре, запись не менялась
        delete removed[entry.id]; // запись изменилась — выгружаем снова
        removedChanged = true;
      }
      if (entry.calendarEventId) d.adoptEventId = entry.calendarEventId;
      events.push(d);
    }

    const res: CalendarResponse = await client.calendar({
      calendarName: cal.calendarName || 'Съёмки',
      timeZone: CALENDAR_TIME_ZONE,
      events,
      windowStart,
      windowEnd,
    });

    // перенос в календаре → дата/время записи (уйдёт в Drive как обычная правка)
    if (res.moved.length) {
      const byId = new Map(store.getDoc().entries.map((e) => [e.id, e]));
      for (const m of res.moved) {
        const entry = byId.get(m.entryId);
        if (!entry || entry.deleted) continue;
        const patch = movedToPatch(m, entry);
        if (patch) store.updateEntry(entry.id, patch);
      }
    }

    // удалено пользователем в календаре — запомнить хэш, чтобы не выгружать снова
    if (res.removedByUser.length) {
      const sent = new Map(events.map((d) => [d.entryId, d.hash]));
      for (const id of res.removedByUser) {
        const hash = sent.get(id);
        if (hash === undefined) continue;
        removed[id] = hash;
        removedChanged = true;
      }
    }
    if (removedChanged) await store.setMeta(META_REMOVED, removed);

    // чужие события → предложения (окно приходит целиком, поэтому список заменяется)
    const dismissed = new Set(proposals.dismissed);
    proposals.list = res.foreign
      .filter((f) => !dismissed.has(f.eventId))
      .map((f) => ({
        eventId: f.eventId,
        title: f.title?.trim() || '(без названия)',
        ...foreignToFields(f),
        ...(f.location ? { location: f.location } : {}),
      }));
    await saveProposals();
    emitProposals();

    const curCal = store.getDoc().settings.calendar;
    if (res.calendarId && res.calendarId !== curCal.calendarId) {
      store.updateSettings({ calendar: { ...curCal, calendarId: res.calendarId } });
    }
  }

  return {
    afterSync(client) {
      // повторный вызов во время работы ждёт текущий прогон, а не запускает второй параллельно
      running ??= run(client).finally(() => {
        running = undefined;
      });
      return running;
    },
    getProposals() {
      void loadProposals();
      return visibleProposals();
    },
    subscribeProposals(fn) {
      listeners.add(fn);
      void loadProposals();
      return () => {
        listeners.delete(fn);
      };
    },
    dismissProposal(eventId) {
      if (!proposals.dismissed.includes(eventId)) proposals.dismissed.push(eventId);
      proposals.list = proposals.list.filter((p) => p.eventId !== eventId);
      void saveProposals().catch(() => {});
      emitProposals();
    },
  };
}

// ---------- экспорт по умолчанию: глобальный store ----------

let defaultSync: CalendarSync | undefined;
function getDefault(): CalendarSync {
  defaultSync ??= createCalendarSync({ store: defaultStore });
  return defaultSync;
}

/** Хук после синхронизации данных: выгрузить записи в календарь и подтянуть перенос времени. */
export const calendarAfterSync: AfterSyncHook = (client) => getDefault().afterSync(client);

export function getCalendarProposals(): CalendarProposal[] {
  return getDefault().getProposals();
}

export function subscribeProposals(fn: (list: CalendarProposal[]) => void): () => void {
  return getDefault().subscribeProposals(fn);
}

export function dismissProposal(eventId: string): void {
  getDefault().dismissProposal(eventId);
}

/** Превратить предложение в запись (UI сохраняет её через store). */
export function proposalToEntry(p: CalendarProposal): Entry {
  return newEntry({
    type: 'main',
    kind: 'shoot',
    title: p.title,
    date: p.date,
    dateEnd: p.dateEnd,
    timeStart: p.timeStart,
    timeEnd: p.timeEnd,
    allDay: !p.timeStart,
    location: p.location,
    // по этому id скрипт пометит само чужое событие, а не создаст рядом дубль
    calendarEventId: p.eventId,
  });
}
