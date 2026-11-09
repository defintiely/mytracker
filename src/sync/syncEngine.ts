// Синхронизатор store ↔ tracker.json в Drive пользователя через Google Apps Script (SPEC §7).
//
// Цикл: load() → merge(base, local, remote ?? local) → если результат отличается от remote или файла
// ещё нет → save(result, rev). Скрипт пишет под блокировкой и только если ревизия не изменилась с load,
// иначе отвечает conflict — тогда цикл повторяется (до 5 раз). Успех → применить локально → base =
// результат → журнал конфликтов → afterSync-хуки (календарь) получают клиент скрипта.
// Бэкапы раз в сутки делает сам скрипт.
// Запуски: при старте, при возврате на вкладку, при появлении сети, раз в 60 с и через ~3 с после
// локальной правки. Одновременно идёт один цикл; запрос во время цикла — ещё один цикл после него.
import { OfflineError, ScriptCallError } from './errors';
import { deepEqual, merge } from './merge';
import { SCRIPT_PROTOCOL_VERSION, type ScriptClient } from './scriptApi';
import { getConnection, onConnectionChange, scriptClient } from './scriptClient';
import type { AfterSyncHook, Conflict, SyncState } from './types';
import type { Settings, TrackerDoc } from '../model/types';
import { DEFAULT_SETTINGS } from '../model/types';
import { normalizeTaskTypes } from '../model/taskTypes';
import { normalizeEntries } from '../model/entry';
import { store as defaultStore, type TrackerStore } from '../store/store';

/** Синхронизатор store ↔ tracker.json в Drive (через Apps Script). */
export interface SyncEngine {
  start(): void;
  stop(): void;
  syncNow(): Promise<void>;
  getState(): SyncState;
  subscribe(fn: (s: SyncState) => void): () => void;
  getConflicts(): Promise<Conflict[]>;
  addAfterSyncHook(h: AfterSyncHook): void;
}

export const META_BASE = 'sync.base';
export const META_CONFLICTS = 'sync.conflicts';
export const META_LAST_SYNC = 'sync.lastSyncAt';
/** { url, email } — email владельца скрипта для подключения с этим адресом. */
export const META_ACCOUNT = 'sync.account';
/** Адрес скрипта, с которым снят base-снимок. Другой адрес → base сбрасывается. */
export const META_SYNC_URL = 'sync.scriptUrl';
export const MAX_CONFLICTS = 200;
const MAX_ATTEMPTS = 5;

export type SyncStore = Pick<
  TrackerStore,
  'getDoc' | 'isDirty' | 'replaceDoc' | 'onLocalChange' | 'getMeta' | 'setMeta'
>;

/** Минимум от window/document, на который вешаются триггеры (в тестах — не задаётся). */
export interface SyncEnv {
  addWindowListener?(type: 'online' | 'offline', fn: () => void): () => void;
  addVisibilityListener?(fn: (visible: boolean) => void): () => void;
}

export interface SyncEngineDeps {
  store: SyncStore;
  client: ScriptClient;
  /** Адрес текущего подключения (для сброса base при смене скрипта). По умолчанию — из localStorage. */
  connectionUrl?: () => string | undefined;
  /** Подписка на подключение/отключение — после него запускается цикл. */
  onConnectionChange?: (fn: () => void) => () => void;
  now?: () => Date;
  isOnline?: () => boolean;
  env?: SyncEnv;
  intervalMs?: number;
  debounceMs?: number;
}

function browserEnv(): SyncEnv {
  const env: SyncEnv = {};
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    env.addWindowListener = (type, fn) => {
      window.addEventListener(type, fn);
      return () => window.removeEventListener(type, fn);
    };
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    env.addVisibilityListener = (fn) => {
      const h = () => fn(document.visibilityState === 'visible');
      document.addEventListener('visibilitychange', h);
      return () => document.removeEventListener('visibilitychange', h);
    };
  }
  return env;
}

function defaultIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Привести документ из Drive к текущей схеме (недостающие поля — по умолчанию). Записи старых версий:
 * вид 'shoot' → 'job', поля media/withEditing стираются; типы задач со старым флагом builtin или без
 * taskTypes → обычные типы (normalizeTaskTypes).
 */
export function normalizeDoc(raw: unknown): TrackerDoc {
  const d = (raw ?? {}) as Partial<TrackerDoc>;
  if (typeof d.schemaVersion === 'number' && d.schemaVersion > 1) {
    throw new Error(`tracker.json создан более новой версией приложения (schemaVersion ${d.schemaVersion}) — обновите приложение`);
  }
  const s = (d.settings ?? {}) as Partial<Settings>;
  return {
    schemaVersion: 1,
    entries: Array.isArray(d.entries) ? normalizeEntries(d.entries) : [],
    contacts: Array.isArray(d.contacts) ? d.contacts : [],
    sources: Array.isArray(d.sources) ? d.sources : [],
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      ...s,
      taskTypes: normalizeTaskTypes(s),
      calendar: { ...DEFAULT_SETTINGS.calendar, ...(s.calendar ?? {}) },
    },
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isOfflineError(e: unknown): boolean {
  return e instanceof OfflineError || (e instanceof TypeError && /fetch|network/i.test(e.message));
}

class RevisionConflict extends Error {}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const { store, client } = deps;
  const now = deps.now ?? (() => new Date());
  const isOnline = deps.isOnline ?? defaultIsOnline;
  const intervalMs = deps.intervalMs ?? 60_000;
  const debounceMs = deps.debounceMs ?? 3_000;
  const connectionUrl = deps.connectionUrl ?? (() => getConnection()?.url);

  let state: SyncState = { status: 'disabled' };
  let stateInitialized = false;
  const listeners = new Set<(s: SyncState) => void>();
  const hooks: AfterSyncHook[] = [];

  let localRev = 0;
  let started = false;
  let loop: Promise<void> | undefined;
  let requested = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let cleanups: (() => void)[] = [];

  function setState(patch: Partial<SyncState>, replaceError = false): void {
    const next: SyncState = { ...state, ...patch };
    if (replaceError && !('error' in patch)) delete next.error;
    if ('account' in patch && patch.account === undefined) delete next.account;
    stateInitialized = true;
    if (deepEqual(next, state)) return;
    state = next;
    for (const fn of listeners) {
      try {
        fn(state);
      } catch {
        /* слушатель UI не должен ломать синхронизацию */
      }
    }
  }

  function idleStatus(): SyncState['status'] {
    if (!client.configured()) return 'disabled';
    if (!isOnline()) return 'offline';
    return store.isDirty() ? 'dirty' : 'synced';
  }

  // Локальные правки: счётчик (чтобы заметить правки во время цикла), статус и отложенный цикл.
  store.onLocalChange(() => {
    localRev++;
    if (state.status === 'synced') setState({ status: 'dirty' });
    if (started) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(autoSync, debounceMs);
    }
  });

  /** Автоматический запуск (таймер, сеть, вкладка, правка). Без подключения — не запускаем. */
  function autoSync(): void {
    if (!client.configured()) return;
    void engine.syncNow();
  }

  async function appendConflicts(list: Conflict[]): Promise<void> {
    if (!list.length) return;
    const prev = (await store.getMeta<Conflict[]>(META_CONFLICTS)) ?? [];
    await store.setMeta(META_CONFLICTS, [...prev, ...list].slice(-MAX_CONFLICTS));
  }

  /** Одна попытка. RevisionConflict — файл успел измениться другим устройством, нужно повторить. */
  async function attempt(): Promise<TrackerDoc> {
    const rev0 = localRev;
    const local = store.getDoc();
    const base = (await store.getMeta<TrackerDoc | null>(META_BASE)) ?? undefined;
    const loaded = await client.load();
    const remote = loaded.doc ? normalizeDoc(loaded.doc) : null;

    const m = merge(base, local, remote ?? local, { now: now() });
    const result = m.doc;
    if (!remote || !deepEqual(result, remote)) {
      // Скрипт запишет, только если ревизия всё ещё loaded.rev (под блокировкой) — запись атомарна.
      const saved = await client.save(result, loaded.rev);
      if (saved.ok === false) throw new RevisionConflict();
    }

    // Применить локально. replaceDoc синхронный, поэтому между проверкой и заменой правок не будет.
    if (localRev === rev0) {
      store.replaceDoc(deepEqual(result, local) ? local : result, { markClean: true });
    } else {
      // Во время цикла были новые правки: накладываем их на результат (base = то, что мы сливали)
      // и запускаем ещё один цикл, чтобы отправить их в Drive.
      const rebased = merge(local, store.getDoc(), result, { now: now() }).doc;
      store.replaceDoc(rebased);
      requested = true;
    }
    await store.setMeta(META_BASE, result);
    await appendConflicts(remote ? m.conflicts : []);
    return result;
  }

  /** Сменился адрес скрипта (другой Drive / новый скрипт) — base от старого файла сливать нельзя. */
  async function checkConnectionChanged(url: string): Promise<void> {
    if ((await store.getMeta<string>(META_SYNC_URL)) === url) return;
    await store.setMeta(META_BASE, null);
    await store.setMeta(META_ACCOUNT, null);
    await store.setMeta(META_SYNC_URL, url);
    setState({ account: undefined });
  }

  async function refreshAccount(url: string, errors: string[]): Promise<void> {
    if (state.account) return;
    try {
      const cached = await store.getMeta<{ url: string; email: string } | null>(META_ACCOUNT);
      if (cached && typeof cached === 'object' && cached.url === url && cached.email) {
        setState({ account: cached.email });
        return;
      }
      const ping = await client.ping();
      if (ping.protocol !== SCRIPT_PROTOCOL_VERSION) {
        errors.push('Скрипт в Google устарел — в настройках нажмите «Показать код скрипта ещё раз» и обновите его');
      }
      if (ping.email) {
        await store.setMeta(META_ACCOUNT, { url, email: ping.email });
        setState({ account: ping.email });
      }
    } catch {
      /* не критично */
    }
  }

  async function runCycle(): Promise<void> {
    if (!client.configured()) {
      setState({ status: 'disabled', account: undefined }, true);
      return;
    }
    if (!isOnline()) {
      setState({ status: 'offline' }, true);
      return;
    }
    setState({ status: 'syncing' }, true);
    const url = connectionUrl() ?? '';
    try {
      await checkConnectionChanged(url);
      let ok = false;
      for (let i = 0; i < MAX_ATTEMPTS && !ok; i++) {
        try {
          await attempt();
          ok = true;
        } catch (e) {
          if (!(e instanceof RevisionConflict)) throw e;
        }
      }
      if (!ok) throw new Error('Данные постоянно меняются на другом устройстве — повторю позже');
    } catch (e) {
      if (isOfflineError(e)) setState({ status: 'offline' }, true);
      else setState({ status: 'error', error: errorMessage(e) });
      return;
    }

    const at = now().toISOString();
    await store.setMeta(META_LAST_SYNC, at);
    const errors: string[] = [];

    await refreshAccount(url, errors);

    for (const h of hooks) {
      try {
        await h(client);
      } catch (e) {
        errors.push('Календарь: ' + errorMessage(e));
      }
    }

    const next: Partial<SyncState> = { status: store.isDirty() ? 'dirty' : 'synced', lastSyncAt: at };
    if (errors.length) next.error = errors.join('; ');
    setState(next, true);
  }

  async function runLoop(): Promise<void> {
    while (requested) {
      requested = false;
      try {
        await runCycle();
      } catch (e) {
        setState({ status: 'error', error: errorMessage(e) });
      }
    }
  }

  const engine: SyncEngine = {
    start() {
      if (started) return;
      started = true;
      const env = deps.env ?? browserEnv();
      cleanups = [];
      if (env.addWindowListener) {
        cleanups.push(env.addWindowListener('online', autoSync));
        cleanups.push(
          env.addWindowListener('offline', () => client.configured() && setState({ status: 'offline' })),
        );
      }
      if (env.addVisibilityListener) {
        cleanups.push(env.addVisibilityListener((visible) => visible && autoSync()));
      }
      const unConn = (deps.onConnectionChange ?? (() => () => {}))(() => {
        setState({ status: idleStatus(), account: undefined }, true);
        void engine.syncNow();
      });
      cleanups.push(unConn);
      intervalTimer = setInterval(() => {
        if (isOnline()) autoSync();
      }, intervalMs);
      void store.getMeta<string>(META_LAST_SYNC).then(
        (lastSyncAt) => lastSyncAt && !state.lastSyncAt && setState({ lastSyncAt }),
        () => {},
      );
      void engine.syncNow();
    },

    stop() {
      started = false;
      clearTimeout(debounceTimer);
      clearInterval(intervalTimer);
      for (const c of cleanups) c();
      cleanups = [];
    },

    syncNow() {
      requested = true;
      loop ??= runLoop().finally(() => {
        loop = undefined;
        // Запрос, пришедший между последней проверкой цикла и этим местом, не теряем.
        if (requested) void engine.syncNow();
      });
      return loop;
    },

    getState() {
      if (!stateInitialized) {
        try {
          state = { ...state, status: idleStatus() };
        } catch {
          /* store ещё не готов */
        }
      }
      return state;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async getConflicts() {
      const list = (await store.getMeta<Conflict[]>(META_CONFLICTS)) ?? [];
      return [...list].reverse(); // новые сверху
    },

    addAfterSyncHook(h) {
      if (!hooks.includes(h)) hooks.push(h);
    },
  };
  return engine;
}

export { OfflineError, ScriptCallError };

export const syncEngine: SyncEngine = createSyncEngine({
  store: defaultStore,
  client: scriptClient,
  onConnectionChange,
});
