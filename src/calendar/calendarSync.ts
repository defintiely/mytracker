// Синхронизация с Google Календарём (SPEC §10): Calendar REST v3 через fetch, без своего сервера.
// Скоуп calendar.app.created — работаем только с календарём, который создало приложение;
// primary и calendarList других календарей не трогаем.
import type { AfterSyncHook } from '../sync/types';
import type { Entry, Settings, TrackerDoc } from '../model/types';
import { newEntry } from '../model/entry';
import { store as defaultStore } from '../store/store';
import {
  CALENDAR_TIME_ZONE,
  entryToEvent,
  eventHash,
  eventToEntryPatch,
  eventToProposalFields,
  type GCalEvent,
} from './mapping';

/** События календаря «Съёмки», созданные не приложением, — предложить импорт (SPEC §10). */
export interface CalendarProposal {
  eventId: string;
  title: string;
  date?: string;
  timeStart?: string;
  timeEnd?: string;
  location?: string;
}

/** То, что модуль использует из TrackerStore (для тестов подставляется настоящий store на fake-indexeddb). */
export interface CalendarStoreLike {
  getDoc(): TrackerDoc;
  updateEntry(id: string, patch: Partial<Entry>): void;
  updateSettings(patch: Partial<Settings>): void;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

export interface CalendarSyncDeps {
  fetch: typeof fetch;
  store: CalendarStoreLike;
  /** Пауза перед повтором при rateLimitExceeded (в тестах — мгновенная). */
  sleep?: (ms: number) => Promise<void>;
  /** Сколько запросов к API одновременно. По умолчанию 4. */
  concurrency?: number;
  /** Повторов при 403 rateLimitExceeded / 429 / 5xx. По умолчанию 5. */
  maxRetries?: number;
}

export interface CalendarSync {
  afterSync: AfterSyncHook;
  getProposals(): CalendarProposal[];
  subscribeProposals(fn: (list: CalendarProposal[]) => void): () => void;
  dismissProposal(eventId: string): void;
}

export class CalendarApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarApiError';
  }
}

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const META_STATE = 'calendarState';
const META_PROPOSALS = 'calendarProposals';
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

/** Локальное (на устройство) состояние синхронизации — в meta IndexedDB, не в Drive. */
interface SyncState {
  calendarId?: string;
  syncToken?: string;
  /** entryId → событие в календаре и хэш выгруженного в него содержимого. */
  pushed: Record<string, { eventId: string; hash: string }>;
  /** Событие удалили в календаре: entryId → хэш на тот момент. Пока запись не изменится — не выгружаем снова. */
  unlinked: Record<string, string>;
}

interface ProposalsState {
  list: CalendarProposal[];
  dismissed: string[];
}

const enc = encodeURIComponent;

export function createCalendarSync(deps: CalendarSyncDeps): CalendarSync {
  const { store } = deps;
  const doFetch = deps.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const concurrency = Math.max(1, deps.concurrency ?? 4);
  const maxRetries = deps.maxRetries ?? 5;

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

  // ---------- HTTP ----------

  interface ReqOpts {
    query?: Record<string, string | undefined>;
    body?: unknown;
  }

  async function request<T>(getToken: () => Promise<string>, method: string, path: string, opts: ReqOpts = {}): Promise<T> {
    const url = new URL(CALENDAR_API + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      const token = await getToken();
      const res = await doFetch(url.toString(), {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      let reason: string | undefined;
      let message = `Calendar API ${method} ${path}: HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
        reason = j.error?.errors?.[0]?.reason;
        if (j.error?.message) message += ' — ' + j.error.message;
      } catch {
        /* тело не JSON */
      }
      if (res.status === 401 && !authRetried) {
        authRetried = true; // getToken обновит протухший токен
        continue;
      }
      const retryable =
        res.status === 429 || res.status >= 500 || (res.status === 403 && reason !== undefined && RATE_REASONS.has(reason));
      if (retryable && attempt < maxRetries) {
        await sleep(Math.min(32_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250));
        continue;
      }
      throw new CalendarApiError(res.status, reason, message);
    }
  }

  const isGone = (e: unknown) => e instanceof CalendarApiError && (e.status === 404 || e.status === 410);

  async function pool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<unknown[]> {
    const errors: unknown[] = [];
    let i = 0;
    const worker = async () => {
      while (i < items.length) {
        const item = items[i++];
        try {
          await fn(item);
        } catch (e) {
          errors.push(e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return errors;
  }

  // ---------- шаги синхронизации ----------

  async function ensureCalendar(getToken: () => Promise<string>): Promise<string> {
    const cal = store.getDoc().settings.calendar;
    if (cal.calendarId) {
      try {
        const c = await request<{ id: string; summary?: string }>(getToken, 'GET', `/calendars/${enc(cal.calendarId)}`);
        if (cal.calendarName && c.summary !== cal.calendarName) {
          await request(getToken, 'PATCH', `/calendars/${enc(cal.calendarId)}`, { body: { summary: cal.calendarName } });
        }
        return cal.calendarId;
      } catch (e) {
        if (!isGone(e)) throw e;
        // календарь удалили — создаём заново
      }
    }
    const created = await request<{ id: string }>(getToken, 'POST', '/calendars', {
      body: { summary: cal.calendarName || 'Съёмки', timeZone: CALENDAR_TIME_ZONE },
    });
    const cur = store.getDoc().settings.calendar;
    store.updateSettings({ calendar: { ...cur, calendarId: created.id, syncToken: undefined } });
    return created.id;
  }

  async function listChanges(
    getToken: () => Promise<string>,
    calendarId: string,
    state: SyncState,
  ): Promise<{ items: GCalEvent[]; nextSyncToken?: string; full: boolean }> {
    let syncToken = state.syncToken;
    for (;;) {
      const items: GCalEvent[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | undefined;
      try {
        do {
          const page = await request<{ items?: GCalEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
            getToken,
            'GET',
            `/calendars/${enc(calendarId)}/events`,
            { query: { syncToken, pageToken, maxResults: '250' } },
          );
          items.push(...(page.items ?? []));
          pageToken = page.nextPageToken;
          nextSyncToken = page.nextSyncToken;
        } while (pageToken);
      } catch (e) {
        if (syncToken && e instanceof CalendarApiError && e.status === 410) {
          syncToken = undefined; // токен протух — полная выборка
          continue;
        }
        throw e;
      }
      return { items, nextSyncToken, full: !syncToken };
    }
  }

  /** Входящие: перенос времени, удаление события в календаре, чужие события → предложения. */
  function applyIncoming(items: GCalEvent[], state: SyncState): boolean {
    const doc = store.getDoc();
    const byId = new Map(doc.entries.map((e) => [e.id, e]));
    const byEventId = new Map(doc.entries.filter((e) => e.calendarEventId).map((e) => [e.calendarEventId!, e]));
    const dismissed = new Set(proposals.dismissed);
    let proposalsChanged = false;

    const unlink = (entry: Entry, eventId: string) => {
      if (entry.deleted) return;
      if (entry.calendarEventId && entry.calendarEventId !== eventId) return;
      if (entry.calendarEventId) store.updateEntry(entry.id, { calendarEventId: undefined });
      const want = entryToEvent(entry, doc);
      if (want) state.unlinked[entry.id] = eventHash(want)!;
    };
    const dropProposal = (eventId: string) => {
      const n = proposals.list.length;
      proposals.list = proposals.list.filter((p) => p.eventId !== eventId);
      if (proposals.list.length !== n) proposalsChanged = true;
    };

    for (const ev of items) {
      if (!ev.id) continue;
      const entryId = ev.extendedProperties?.private?.entryId;
      const cancelled = ev.status === 'cancelled';

      if (!entryId) {
        const linked = byEventId.get(ev.id);
        if (cancelled || linked) {
          dropProposal(ev.id);
          if (cancelled && linked) unlink(linked, ev.id);
          continue;
        }
        if (dismissed.has(ev.id)) continue;
        const p: CalendarProposal = {
          eventId: ev.id,
          title: ev.summary?.trim() || '(без названия)',
          ...eventToProposalFields(ev),
          ...(ev.location ? { location: ev.location } : {}),
        };
        const i = proposals.list.findIndex((x) => x.eventId === ev.id);
        if (i >= 0) proposals.list[i] = p;
        else proposals.list.push(p);
        proposalsChanged = true;
        continue;
      }

      const entry = byId.get(entryId);
      if (cancelled) {
        if (state.pushed[entryId]?.eventId === ev.id) delete state.pushed[entryId];
        if (entry) unlink(entry, ev.id);
        continue;
      }
      if (entry?.calendarEventId && entry.calendarEventId !== ev.id) {
        // дубль (например, две копии приложения выгрузили одновременно) — не трогаем
        continue;
      }
      state.pushed[entryId] = { eventId: ev.id, hash: eventHash(ev) ?? '' };
      if (!entry) continue; // запись ещё не пришла из Drive — привяжем, когда придёт
      const patch: Partial<Entry> = {};
      if (!entry.calendarEventId) patch.calendarEventId = ev.id;
      if (!entry.deleted) Object.assign(patch, eventToEntryPatch(ev, entry) ?? {});
      if (Object.keys(patch).length) store.updateEntry(entry.id, patch);
    }
    return proposalsChanged;
  }

  /** Исходящие: insert / update / delete по разнице между записями и выгруженным. */
  async function pushOutgoing(getToken: () => Promise<string>, calendarId: string, state: SyncState): Promise<unknown[]> {
    const doc = store.getDoc();
    const base = `/calendars/${enc(calendarId)}/events`;
    type Task = () => Promise<void>;
    const tasks: Task[] = [];

    const insert = async (entry: Entry, body: GCalEvent) => {
      const created = await request<GCalEvent>(getToken, 'POST', base, { body });
      state.pushed[entry.id] = { eventId: created.id!, hash: eventHash(body)! };
      store.updateEntry(entry.id, { calendarEventId: created.id });
    };

    for (const entry of doc.entries) {
      const want = entryToEvent(entry, doc);
      const known = state.pushed[entry.id];
      let eventId: string | undefined = entry.calendarEventId ?? known?.eventId;

      if (!want) {
        delete state.unlinked[entry.id];
        if (!eventId) continue;
        const id = eventId;
        tasks.push(async () => {
          try {
            await request(getToken, 'DELETE', `${base}/${enc(id)}`);
          } catch (e) {
            if (!isGone(e)) throw e;
          }
          delete state.pushed[entry.id];
          if (entry.calendarEventId) store.updateEntry(entry.id, { calendarEventId: undefined });
        });
        continue;
      }

      const hash = eventHash(want)!;
      if (state.unlinked[entry.id] !== undefined) {
        if (state.unlinked[entry.id] === hash) continue; // удалено в календаре, запись не менялась
        delete state.unlinked[entry.id];
        eventId = undefined; // запись изменилась — выгружаем заново новым событием
      }

      if (!eventId) {
        tasks.push(() => insert(entry, want));
      } else if (known && known.eventId === eventId && known.hash === hash) {
        if (!entry.calendarEventId) store.updateEntry(entry.id, { calendarEventId: eventId });
      } else {
        const id = eventId;
        tasks.push(async () => {
          try {
            // PUT, а не PATCH: тело полное, а переход «весь день ↔ со временем» и снятые поля
            // через PATCH пришлось бы обнулять явно.
            await request(getToken, 'PUT', `${base}/${enc(id)}`, { body: want });
          } catch (e) {
            if (!isGone(e)) throw e;
            await insert(entry, want); // события нет (другой календарь) — создаём
            return;
          }
          state.pushed[entry.id] = { eventId: id, hash };
          if (entry.calendarEventId !== id) store.updateEntry(entry.id, { calendarEventId: id });
        });
      }
    }
    return pool(tasks, (t) => t());
  }

  async function run(getToken: () => Promise<string>): Promise<void> {
    if (!store.getDoc().settings.calendar.enabled) return;
    await loadProposals();

    const calendarId = await ensureCalendar(getToken);
    const saved = await store.getMeta<SyncState>(META_STATE);
    let state: SyncState =
      saved && saved.calendarId === calendarId
        ? { ...saved, pushed: saved.pushed ?? {}, unlinked: saved.unlinked ?? {} }
        : { calendarId, pushed: {}, unlinked: {} };

    // 1. входящие — раньше исходящих, чтобы не затереть перенос, сделанный в календаре
    const { items, nextSyncToken, full } = await listChanges(getToken, calendarId, state);
    if (full) state = { ...state, pushed: {} }; // полная выборка — карта выгруженного строится заново
    let proposalsChanged = applyIncoming(items, state);
    if (full) {
      // полная выборка — предложения по событиям, которых больше нет, убираем
      const alive = new Set(items.filter((e) => e.status !== 'cancelled').map((e) => e.id));
      const n = proposals.list.length;
      proposals.list = proposals.list.filter((p) => alive.has(p.eventId));
      proposalsChanged ||= proposals.list.length !== n;
    }
    state.syncToken = nextSyncToken ?? state.syncToken;
    await store.setMeta(META_STATE, state);
    if (proposalsChanged) await saveProposals();

    // 2. исходящие
    let errors: unknown[] = [];
    try {
      errors = await pushOutgoing(getToken, calendarId, state);
    } finally {
      await store.setMeta(META_STATE, state);
      emitProposals();
    }
    if (errors.length) {
      const first = errors[0];
      throw first instanceof Error
        ? new Error(`Календарь: не выгружено ${errors.length} событий — ${first.message}`, { cause: first })
        : first;
    }
  }

  return {
    afterSync(getToken) {
      // повторный вызов во время работы ждёт текущий прогон, а не запускает второй параллельно
      running ??= run(getToken).finally(() => {
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

// ---------- экспорт по умолчанию: глобальные fetch и store ----------

let defaultSync: CalendarSync | undefined;
function getDefault(): CalendarSync {
  defaultSync ??= createCalendarSync({ fetch: (...args) => fetch(...args), store: defaultStore });
  return defaultSync;
}

/** Хук после синхронизации Drive: выгрузить изменения в календарь и подтянуть перенос времени. */
export const calendarAfterSync: AfterSyncHook = (getToken) => getDefault().afterSync(getToken);

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
    timeStart: p.timeStart,
    timeEnd: p.timeEnd,
    allDay: !p.timeStart,
    location: p.location,
    calendarEventId: p.eventId,
  });
}
