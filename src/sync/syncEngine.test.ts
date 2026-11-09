import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { TrackerStore } from '../store/store';
import { newEntry } from '../model/entry';
import type { TrackerDoc } from '../model/types';
import { NeedsAuthError } from './auth';
import type { DriveApi, RemoteFile } from './drive';
import { OfflineError } from './errors';
import { deepEqual, stableStringify } from './merge';
import { createSyncEngine, META_BASE, type SyncEngineDeps } from './syncEngine';
import type { SyncState } from './types';

/** Общий «Drive» в памяти: хранит JSON-строку и номер версии, как настоящий. */
class FakeDrive {
  file?: { id: string; content: string; version: number };
  backups = new Map<string, string>();
  writes = 0;
  offline = false;
  unauthorized = false;
  /** Вызывается между скачиванием и проверкой версии — имитация записи другим устройством. */
  beforeVersionCheck?: () => void;

  private guard() {
    if (this.offline) throw new OfflineError();
    if (this.unauthorized) throw new NeedsAuthError();
  }

  client(): DriveApi {
    const self = this;
    return {
      async findDataFile(): Promise<RemoteFile | undefined> {
        self.guard();
        return self.file ? { id: self.file.id, version: String(self.file.version) } : undefined;
      },
      async download(id) {
        self.guard();
        if (!self.file || self.file.id !== id) throw new Error('404');
        return { doc: JSON.parse(self.file.content) as TrackerDoc, version: String(self.file.version) };
      },
      async getVersion() {
        self.guard();
        const hook = self.beforeVersionCheck;
        self.beforeVersionCheck = undefined;
        hook?.();
        return String(self.file!.version);
      },
      async createDataFile(doc) {
        self.guard();
        self.file = { id: 'f1', content: JSON.stringify(doc), version: 1 };
        self.writes++;
        return { id: 'f1', version: '1' };
      },
      async updateDataFile(id, doc) {
        self.guard();
        self.file = { id, content: JSON.stringify(doc), version: self.file!.version + 1 };
        self.writes++;
        return { id, version: String(self.file.version) };
      },
      async getAccountEmail() {
        return 'me@example.com';
      },
      async writeDailyBackup(doc, date) {
        self.backups.set(date, JSON.stringify(doc));
      },
    };
  }

  remoteDoc(): TrackerDoc {
    return JSON.parse(this.file!.content) as TrackerDoc;
  }
}

/** Отдельный IndexedDB на каждое «устройство». */
async function newDevice(): Promise<TrackerStore> {
  globalThis.indexedDB = new IDBFactory();
  const s = new TrackerStore();
  await s.load();
  return s;
}

function engineFor(store: TrackerStore, drive: FakeDrive, extra: Partial<SyncEngineDeps> = {}) {
  return createSyncEngine({
    store,
    auth: { configured: () => true, isSignedIn: () => true, getToken: async () => 'token' },
    drive: drive.client(),
    isOnline: () => true,
    env: {},
    ...extra,
  });
}

function same(a: TrackerDoc, b: TrackerDoc): boolean {
  return stableStringify(a) === stableStringify(b);
}

describe('syncEngine: два устройства через один Drive', () => {
  it('сходятся к одинаковому документу', async () => {
    const drive = new FakeDrive();
    const A = await newDevice();
    const B = await newDevice();
    const ea = engineFor(A, drive);
    const eb = engineFor(B, drive);

    // A создаёт записи и первым синхронизируется — создаётся tracker.json.
    const shoot = newEntry({ title: 'Свадьба', amount: 500 });
    A.upsertEntry(shoot);
    A.upsertEntry(newEntry({ title: 'Ретушь', kind: 'work', amount: 100 }));
    expect(ea.getState().status).toBe('dirty');
    await ea.syncNow();
    expect(ea.getState().status).toBe('synced');
    expect(A.isDirty()).toBe(false);
    expect(drive.remoteDoc().entries).toHaveLength(2);
    expect(drive.backups.size).toBe(1);
    expect(ea.getState().account).toBe('me@example.com');

    // B — первая синхронизация, у него своя запись.
    B.upsertEntry(newEntry({ title: 'Зубной', type: 'personal' }));
    await eb.syncNow();
    expect(B.getDoc().entries).toHaveLength(3);
    expect(drive.remoteDoc().entries).toHaveLength(3);

    // Параллельные правки разных полей одной записи.
    A.updateEntry(shoot.id, { location: 'Порт' });
    await new Promise((r) => setTimeout(r, 5));
    B.updateEntry(shoot.id, { status: 'shot' });
    await eb.syncNow();
    await ea.syncNow();
    await eb.syncNow();

    expect(same(A.getDoc(), B.getDoc())).toBe(true);
    expect(same(A.getDoc(), drive.remoteDoc())).toBe(true);
    const merged = A.getDoc().entries.find((e) => e.id === shoot.id)!;
    expect(merged.location).toBe('Порт');
    expect(merged.status).toBe('shot');
    expect(await ea.getConflicts()).toEqual([]);

    // Одно поле — побеждает поздняя правка, конфликт в журнале.
    A.updateEntry(shoot.id, { amount: 550 });
    await new Promise((r) => setTimeout(r, 5));
    B.updateEntry(shoot.id, { amount: 600 });
    await ea.syncNow();
    await eb.syncNow();
    await ea.syncNow();
    expect(same(A.getDoc(), B.getDoc())).toBe(true);
    expect(A.getDoc().entries.find((e) => e.id === shoot.id)!.amount).toBe(600);
    const conflicts = await eb.getConflicts();
    expect(conflicts[0]).toMatchObject({ id: shoot.id, field: 'amount', lostValue: 550, keptValue: 600 });

    // Удаление на B доходит до A.
    B.deleteEntry(shoot.id);
    await eb.syncNow();
    await ea.syncNow();
    expect(A.getDoc().entries.find((e) => e.id === shoot.id)!.deleted).toBe(true);
    expect(same(A.getDoc(), B.getDoc())).toBe(true);

    // Base сохранён и равен документу в Drive.
    expect(deepEqual(await A.getMeta<TrackerDoc>(META_BASE), drive.remoteDoc())).toBe(true);
  });

  it('без изменений файл в Drive не перезаписывается', async () => {
    const drive = new FakeDrive();
    const A = await newDevice();
    const ea = engineFor(A, drive);
    A.upsertEntry(newEntry({ title: 'x' }));
    await ea.syncNow();
    const writes = drive.writes;
    await ea.syncNow();
    await ea.syncNow();
    expect(drive.writes).toBe(writes);
  });

  it('файл изменился между чтением и записью — цикл повторяется и ничего не теряется', async () => {
    const drive = new FakeDrive();
    const A = await newDevice();
    const B = await newDevice();
    const ea = engineFor(A, drive);
    const eb = engineFor(B, drive);
    await ea.syncNow();
    await eb.syncNow();

    A.upsertEntry(newEntry({ title: 'от A' }));
    B.upsertEntry(newEntry({ title: 'от B' }));
    // Пока A сливает, B успевает записать свою версию.
    let bWrote = false;
    drive.beforeVersionCheck = () => {
      bWrote = true;
      const remote = drive.remoteDoc();
      const fromB = B.getDoc().entries;
      drive.file = {
        id: drive.file!.id,
        content: JSON.stringify({ ...remote, entries: [...remote.entries, ...fromB] }),
        version: drive.file!.version + 1,
      };
    };
    await ea.syncNow();
    expect(bWrote).toBe(true);
    expect(drive.remoteDoc().entries.map((e) => e.title).sort()).toEqual(['от A', 'от B']);
    await eb.syncNow();
    expect(same(A.getDoc(), B.getDoc())).toBe(true);
  });

  it('гонка: A перетирает запись B в окне между проверкой версии и PATCH — обе правки сохраняются', async () => {
    const drive = new FakeDrive();
    const A = await newDevice();
    const B = await newDevice();
    const ea = engineFor(A, drive);
    const eb = engineFor(B, drive);
    const e = newEntry({ title: 'Свадьба' });
    A.upsertEntry(e);
    await ea.syncNow();
    await eb.syncNow();

    // B: правка title и новая запись; A: правка location той же записи и удаление — позже по часам.
    B.updateEntry(e.id, { title: 'Свадьба Анны' });
    const extra = newEntry({ title: 'Ретушь' });
    B.upsertEntry(extra);
    await new Promise((r) => setTimeout(r, 5));
    A.updateEntry(e.id, { location: 'Порт' });

    // A уже проверил версию, и ровно перед его PATCH B успевает целиком синхронизироваться.
    let raced = false;
    const client = drive.client();
    const eaRace = engineFor(A, drive, {
      drive: {
        ...client,
        async updateDataFile(id, doc) {
          if (!raced) {
            raced = true;
            await eb.syncNow();
            expect(drive.remoteDoc().entries.find((x) => x.id === e.id)!.title).toBe('Свадьба Анны');
          }
          return client.updateDataFile(id, doc); // перетирает запись B
        },
      },
    });
    void ea;
    await eaRace.syncNow();
    expect(raced).toBe(true);

    await eb.syncNow();
    await eaRace.syncNow();
    await eb.syncNow();

    for (const d of [A.getDoc(), B.getDoc(), drive.remoteDoc()]) {
      const got = d.entries.find((x) => x.id === e.id)!;
      expect(got.title).toBe('Свадьба Анны');
      expect(got.location).toBe('Порт');
      expect(d.entries.some((x) => x.id === extra.id)).toBe(true);
    }
    expect(same(A.getDoc(), B.getDoc())).toBe(true);
    expect(same(A.getDoc(), drive.remoteDoc())).toBe(true);
  });

  it('правка во время цикла не теряется и уходит следующим циклом', async () => {
    const drive = new FakeDrive();
    const A = await newDevice();
    const ea = engineFor(A, drive);
    A.upsertEntry(newEntry({ title: 'первая' }));
    drive.beforeVersionCheck = undefined;
    // Правка прямо во время загрузки (в момент createDataFile).
    const client = drive.client();
    const orig = client.createDataFile.bind(client);
    const e2 = createSyncEngine({
      store: A,
      auth: { configured: () => true, isSignedIn: () => true, getToken: async () => 't' },
      drive: {
        ...client,
        async createDataFile(doc) {
          A.upsertEntry(newEntry({ title: 'вторая' }));
          return orig(doc);
        },
      },
      isOnline: () => true,
      env: {},
    });
    void ea;
    await e2.syncNow();
    expect(A.getDoc().entries.map((e) => e.title).sort()).toEqual(['вторая', 'первая']);
    expect(drive.remoteDoc().entries.map((e) => e.title).sort()).toEqual(['вторая', 'первая']);
    expect(A.isDirty()).toBe(false);
  });

  it('состояния: disabled, needs-auth, offline; ошибка хука пишется в error', async () => {
    const drive = new FakeDrive();
    const A = await newDevice();

    const disabled = engineFor(A, drive, {
      auth: { configured: () => false, isSignedIn: () => false, getToken: async () => 't' },
    });
    await disabled.syncNow();
    expect(disabled.getState().status).toBe('disabled');

    const noAuth = engineFor(A, drive, {
      auth: {
        configured: () => true,
        isSignedIn: () => false,
        getToken: async () => {
          throw new NeedsAuthError();
        },
      },
    });
    await noAuth.syncNow();
    expect(noAuth.getState().status).toBe('needs-auth');

    const e = engineFor(A, drive);
    drive.offline = true;
    await e.syncNow();
    expect(e.getState().status).toBe('offline');
    drive.offline = false;

    const states: SyncState[] = [];
    e.subscribe((s) => states.push(s));
    let hookToken = '';
    e.addAfterSyncHook(async (getToken) => {
      hookToken = await getToken();
      throw new Error('календарь недоступен');
    });
    await e.syncNow();
    expect(hookToken).toBe('token');
    expect(e.getState().status).toBe('synced');
    expect(e.getState().error).toContain('календарь недоступен');
    expect(states.map((s) => s.status)).toContain('syncing');

    // 401 от Drive при «живом» токене: токен сбрасывается, цикл повторяется один раз.
    let invalidated = 0;
    const e401 = engineFor(A, drive, {
      invalidateToken: () => {
        invalidated++;
        drive.unauthorized = false;
      },
    });
    drive.unauthorized = true;
    A.upsertEntry(newEntry({ title: 'после 401' }));
    await e401.syncNow();
    expect(invalidated).toBe(1);
    expect(e401.getState().status).toBe('synced');
  });

  it('start(): цикл при старте, после правки (debounce), при online и возврате на вкладку; needs-auth не долбит', async () => {
    const drive = new FakeDrive();
    const A = await newDevice();
    let finds = 0;
    const client = drive.client();
    const winListeners: Record<string, () => void> = {};
    let visibility: ((v: boolean) => void) | undefined;
    let signedIn = true;
    const e = engineFor(A, drive, {
      drive: {
        ...client,
        async findDataFile() {
          finds++;
          return client.findDataFile();
        },
      },
      auth: {
        configured: () => true,
        isSignedIn: () => signedIn,
        getToken: async () => {
          if (!signedIn) throw new NeedsAuthError();
          return 't';
        },
      },
      debounceMs: 20,
      intervalMs: 60_000,
      env: {
        addWindowListener: (type, fn) => {
          winListeners[type] = fn;
          return () => delete winListeners[type];
        },
        addVisibilityListener: (fn) => {
          visibility = fn;
          return () => (visibility = undefined);
        },
      },
    });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    e.start();
    expect(e.getState().status).toBe('syncing'); // цикл при старте уже идёт
    await e.syncNow(); // запрос во время цикла → ещё один цикл после
    expect(finds).toBe(2);

    A.upsertEntry(newEntry({ title: 'правка' }));
    await wait(60);
    await e.syncNow(); // дождаться, если цикл ещё идёт
    expect(drive.remoteDoc().entries).toHaveLength(1);
    const afterEdit = finds;

    winListeners.online();
    await e.syncNow();
    visibility!(false);
    visibility!(true);
    await e.syncNow();
    expect(finds).toBeGreaterThan(afterEdit);

    // Нужен вход: автоматические триггеры не запускают цикл.
    signedIn = false;
    await e.syncNow();
    expect(e.getState().status).toBe('needs-auth');
    const n = finds;
    winListeners.online();
    visibility!(true);
    A.upsertEntry(newEntry({ title: 'ещё' }));
    await wait(60);
    expect(finds).toBe(n);

    e.stop();
    expect(Object.keys(winListeners)).toEqual([]);
    expect(visibility).toBeUndefined();
  });

  it('syncNow во время цикла запускает ещё один цикл после текущего', async () => {
    const drive = new FakeDrive();
    const A = await newDevice();
    let finds = 0;
    const client = drive.client();
    const e = engineFor(A, drive, {
      drive: {
        ...client,
        async findDataFile() {
          finds++;
          return client.findDataFile();
        },
      },
    });
    const p1 = e.syncNow();
    const p2 = e.syncNow();
    const p3 = e.syncNow();
    await Promise.all([p1, p2, p3]);
    expect(finds).toBe(2);
  });
});
