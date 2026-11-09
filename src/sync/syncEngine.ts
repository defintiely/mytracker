// Синхронизатор store ↔ Drive appDataFolder/tracker.json (SPEC §7).
//
// Цикл: getToken → скачать tracker.json (нет — создать из локального) → merge(base, local, remote)
// → если результат отличается от remote — записать с проверкой версии (изменилась — повторить цикл)
// → применить локально → base = результат → журнал конфликтов → бэкап раз в сутки → afterSync-хуки.
// Запуски: при старте, при возврате на вкладку, при появлении сети, раз в 60 с и через ~3 с после
// локальной правки. Одновременно идёт один цикл; запрос во время цикла — ещё один цикл после него.
import {
  auth as defaultAuth,
  invalidateToken,
  NeedsAuthError,
  onAuthChange,
  rememberAccount,
  type GoogleAuth,
} from './auth';
import { createDriveClient, DriveHttpError, OfflineError, type DriveApi } from './drive';
import { deepEqual, merge } from './merge';
import type { AfterSyncHook, Conflict, SyncState } from './types';
import type { Settings, TrackerDoc } from '../model/types';
import { DEFAULT_SETTINGS } from '../model/types';
import { store as defaultStore, type TrackerStore } from '../store/store';

/** Синхронизатор store ↔ Drive appDataFolder/tracker.json (SPEC §7). */
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
export const META_LAST_BACKUP = 'sync.lastBackupDate';
export const META_ACCOUNT = 'sync.account';
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
  auth: Pick<GoogleAuth, 'configured' | 'getToken' | 'isSignedIn'>;
  /** Клиент Drive; по умолчанию — createDriveClient(auth.getToken). */
  drive?: DriveApi;
  now?: () => Date;
  isOnline?: () => boolean;
  env?: SyncEnv;
  /** Подписка на вход/выход — после входа запускается цикл. */
  onAuthChange?: (fn: () => void) => () => void;
  /** Сообщить email аккаунта модулю авторизации (подсказка для тихого входа). */
  rememberAccount?: (email: string) => void;
  /** Забыть токен в памяти (Drive ответил 401) — следующий getToken запросит новый. */
  invalidateToken?: () => void;
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

/** Привести документ из Drive к текущей схеме (недостающие поля — по умолчанию). */
export function normalizeDoc(raw: unknown): TrackerDoc {
  const d = (raw ?? {}) as Partial<TrackerDoc>;
  if (typeof d.schemaVersion === 'number' && d.schemaVersion > 1) {
    throw new Error(`tracker.json создан более новой версией приложения (schemaVersion ${d.schemaVersion}) — обновите приложение`);
  }
  const s = (d.settings ?? {}) as Partial<Settings>;
  return {
    schemaVersion: 1,
    entries: Array.isArray(d.entries) ? d.entries : [],
    contacts: Array.isArray(d.contacts) ? d.contacts : [],
    sources: Array.isArray(d.sources) ? d.sources : [],
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      ...s,
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

class VersionChangedError extends Error {}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const { store } = deps;
  const authApi = deps.auth;
  const drive = deps.drive ?? createDriveClient(() => authApi.getToken());
  const now = deps.now ?? (() => new Date());
  const isOnline = deps.isOnline ?? defaultIsOnline;
  const intervalMs = deps.intervalMs ?? 60_000;
  const debounceMs = deps.debounceMs ?? 3_000;
  const getToken = () => authApi.getToken();

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
    if (!authApi.configured()) return 'disabled';
    if (!authApi.isSignedIn()) return 'needs-auth';
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

  /**
   * Автоматический запуск (таймер, сеть, вкладка, правка). Пока нужен вход — не запускаем: тихий
   * запрос токена GIS открывает окно/iframe, и делать его раз в минуту нельзя. Ждём входа по кнопке
   * (onAuthChange) или явного syncNow().
   */
  function autoSync(): void {
    if (state.status === 'needs-auth') return;
    void engine.syncNow();
  }

  async function appendConflicts(list: Conflict[]): Promise<void> {
    if (!list.length) return;
    const prev = (await store.getMeta<Conflict[]>(META_CONFLICTS)) ?? [];
    await store.setMeta(META_CONFLICTS, [...prev, ...list].slice(-MAX_CONFLICTS));
  }

  /** Одна попытка: true — успех, VersionChangedError — файл изменился, нужно повторить. */
  async function attempt(): Promise<{ result: TrackerDoc }> {
    const rev0 = localRev;
    const local = store.getDoc();
    const base = await store.getMeta<TrackerDoc>(META_BASE);
    const file = await drive.findDataFile();

    let result: TrackerDoc;
    let conflicts: Conflict[] = [];
    if (!file) {
      result = merge(base, local, local, { now: now() }).doc;
      await drive.createDataFile(result);
    } else {
      const dl = await drive.download(file.id);
      const remote = normalizeDoc(dl.doc);
      const m = merge(base, local, remote, { now: now() });
      result = m.doc;
      conflicts = m.conflicts;
      if (!deepEqual(result, remote)) {
        // Drive не умеет If-Match для содержимого: перечитываем версию прямо перед записью (см. drive.ts).
        const current = await drive.getVersion(file.id);
        if (current !== dl.version) throw new VersionChangedError();
        const written = await drive.updateDataFile(file.id, result);
        // Версия выросла больше чем на 1 — между проверкой и записью файл писал кто-то ещё, и мы могли
        // перетереть его правки. Сразу ещё один цикл (сами правки слияние сохранит у автора: см. merge.ts).
        const expected = Number(dl.version) + 1;
        if (Number.isFinite(expected) && Number(written.version) > expected) requested = true;
      }
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
    await appendConflicts(conflicts);
    return { result };
  }

  async function runCycle(): Promise<void> {
    if (!authApi.configured()) {
      setState({ status: 'disabled' }, true);
      return;
    }
    if (!isOnline()) {
      setState({ status: 'offline' }, true);
      return;
    }
    setState({ status: 'syncing' }, true);
    let result: TrackerDoc | undefined;
    const syncDrive = async (): Promise<TrackerDoc> => {
      await getToken();
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        try {
          return (await attempt()).result;
        } catch (e) {
          if (!(e instanceof VersionChangedError)) throw e;
        }
      }
      throw new Error('Файл в Drive постоянно меняется другим устройством — повторю позже');
    };
    try {
      try {
        result = await syncDrive();
      } catch (e) {
        // 401 при «живом» по часам токене (отозван/истёк раньше) — сбросить токен и повторить один раз.
        if (!(e instanceof NeedsAuthError) || !deps.invalidateToken) throw e;
        deps.invalidateToken();
        result = await syncDrive();
      }
    } catch (e) {
      if (e instanceof NeedsAuthError) setState({ status: 'needs-auth' }, true);
      else if (isOfflineError(e)) setState({ status: 'offline' }, true);
      else setState({ status: 'error', error: errorMessage(e) });
      return;
    }

    const at = now().toISOString();
    await store.setMeta(META_LAST_SYNC, at);
    const errors: string[] = [];

    // Email аккаунта — один раз.
    if (!state.account) {
      try {
        let account = await store.getMeta<string>(META_ACCOUNT);
        if (!account) {
          account = await drive.getAccountEmail();
          if (account) await store.setMeta(META_ACCOUNT, account);
        }
        if (account) {
          deps.rememberAccount?.(account);
          setState({ account });
        }
      } catch {
        /* не критично */
      }
    }

    // Бэкап раз в сутки (по локальной дате устройства).
    const today = localDate(now());
    try {
      if ((await store.getMeta<string>(META_LAST_BACKUP)) !== today) {
        await drive.writeDailyBackup(result, today);
        await store.setMeta(META_LAST_BACKUP, today);
      }
    } catch (e) {
      errors.push('Бэкап: ' + errorMessage(e));
    }

    for (const h of hooks) {
      try {
        await h(getToken);
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
        cleanups.push(env.addWindowListener('offline', () => setState({ status: 'offline' })));
      }
      if (env.addVisibilityListener) {
        cleanups.push(env.addVisibilityListener((visible) => visible && autoSync()));
      }
      const unAuth = (deps.onAuthChange ?? (() => () => {}))(() => {
        setState({ status: idleStatus() }, true);
        void engine.syncNow();
      });
      cleanups.push(unAuth);
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

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export { DriveHttpError, OfflineError };

export const syncEngine: SyncEngine = createSyncEngine({
  store: defaultStore,
  auth: defaultAuth,
  onAuthChange,
  rememberAccount,
  invalidateToken,
});
