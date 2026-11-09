import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { TrackerStore } from '../store/store';
import { newEntry } from '../model/entry';
import type { TrackerDoc } from '../model/types';
import { OfflineError, ScriptCallError } from './errors';
import { deepEqual, stableStringify } from './merge';
import type { ScriptClient } from './scriptApi';
import { createSyncEngine, META_BASE, type SyncEngineDeps } from './syncEngine';
import type { SyncState } from './types';

/** Скрипт в памяти: хранит JSON-строку и ревизию, save с чужой ревизией → conflict (как настоящий). */
class FakeScript {
  content?: string;
  rev = 0;
  writes = 0;
  loads = 0;
  pings = 0;
  offline = false;
  forbidden = false;
  protocol = 1;
  /** Вызывается между load и save — имитация записи другим устройством. */
  beforeSave?: () => void | Promise<void>;

  private guard() {
    if (this.offline) throw new OfflineError();
    if (this.forbidden) throw new ScriptCallError('forbidden', 'Неверный ключ');
  }

  client(): ScriptClient {
    const self = this;
    return {
      configured: () => true,
      async ping() {
        self.guard();
        self.pings++;
        return { ok: true, protocol: self.protocol, email: 'me@example.com' };
      },
      async load() {
        self.guard();
        self.loads++;
        return { ok: true, doc: self.content ? (JSON.parse(self.content) as TrackerDoc) : null, rev: self.rev };
      },
      async save(doc, baseRev) {
        self.guard();
        const hook = self.beforeSave;
        self.beforeSave = undefined;
        await hook?.();
        if (baseRev !== self.rev) return { ok: false, code: 'conflict', error: 'conflict', rev: self.rev };
        self.content = JSON.stringify(doc);
        self.rev++;
        self.writes++;
        return { ok: true, rev: self.rev };
      },
      async calendar() {
        throw new Error('не используется');
      },
    };
  }

  remoteDoc(): TrackerDoc {
    return JSON.parse(this.content!) as TrackerDoc;
  }

  /** Запись «другим устройством» в обход движка. */
  writeExternal(doc: TrackerDoc) {
    this.content = JSON.stringify(doc);
    this.rev++;
  }
}

/** Отдельный IndexedDB на каждое «устройство». */
async function newDevice(): Promise<TrackerStore> {
  globalThis.indexedDB = new IDBFactory();
  const s = new TrackerStore();
  await s.load();
  return s;
}

function engineFor(store: TrackerStore, script: FakeScript, extra: Partial<SyncEngineDeps> = {}) {
  return createSyncEngine({
    store,
    client: script.client(),
    connectionUrl: () => 'https://script.google.com/macros/s/x/exec',
    isOnline: () => true,
    env: {},
    ...extra,
  });
}

function same(a: TrackerDoc, b: TrackerDoc): boolean {
  return stableStringify(a) === stableStringify(b);
}

describe('syncEngine: два устройства через один скрипт', () => {
  it('сходятся к одинаковому документу', async () => {
    const script = new FakeScript();
    const A = await newDevice();
    const B = await newDevice();
    const ea = engineFor(A, script);
    const eb = engineFor(B, script);

    // A создаёт записи и первым синхронизируется — создаётся tracker.json.
    const shoot = newEntry({ title: 'Свадьба', amount: 500 });
    A.upsertEntry(shoot);
    A.upsertEntry(newEntry({ title: 'Ретушь', kind: 'work', amount: 100 }));
    expect(ea.getState().status).toBe('dirty');
    await ea.syncNow();
    expect(ea.getState().status).toBe('synced');
    expect(A.isDirty()).toBe(false);
    expect(script.remoteDoc().entries).toHaveLength(2);
    expect(script.rev).toBe(1);
    expect(ea.getState().account).toBe('me@example.com');

    // B — первая синхронизация, у него своя запись.
    B.upsertEntry(newEntry({ title: 'Зубной', type: 'personal' }));
    await eb.syncNow();
    expect(B.getDoc().entries).toHaveLength(3);
    expect(script.remoteDoc().entries).toHaveLength(3);

    // Параллельные правки разных полей одной записи.
    A.updateEntry(shoot.id, { location: 'Порт' });
    await new Promise((r) => setTimeout(r, 5));
    B.updateEntry(shoot.id, { status: 'shot' });
    await eb.syncNow();
    await ea.syncNow();
    await eb.syncNow();

    expect(same(A.getDoc(), B.getDoc())).toBe(true);
    expect(same(A.getDoc(), script.remoteDoc())).toBe(true);
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
    expect(deepEqual(await A.getMeta<TrackerDoc>(META_BASE), script.remoteDoc())).toBe(true);
  });

  it('без изменений файл не перезаписывается; email запрашивается один раз', async () => {
    const script = new FakeScript();
    const A = await newDevice();
    const ea = engineFor(A, script);
    A.upsertEntry(newEntry({ title: 'x' }));
    await ea.syncNow();
    const writes = script.writes;
    await ea.syncNow();
    await ea.syncNow();
    expect(script.writes).toBe(writes);
    expect(script.pings).toBe(1);

    // Новый движок на том же устройстве берёт email из кеша.
    const again = engineFor(A, script);
    await again.syncNow();
    expect(again.getState().account).toBe('me@example.com');
    expect(script.pings).toBe(1);
  });

  it('пустой документ: файла нет — он создаётся', async () => {
    const script = new FakeScript();
    const A = await newDevice();
    await engineFor(A, script).syncNow();
    expect(script.rev).toBe(1);
    expect(script.remoteDoc().entries).toEqual([]);
  });

  it('conflict: файл изменился между load и save — цикл повторяется и ничего не теряется', async () => {
    const script = new FakeScript();
    const A = await newDevice();
    const B = await newDevice();
    const ea = engineFor(A, script);
    const eb = engineFor(B, script);
    await ea.syncNow();
    await eb.syncNow();

    A.upsertEntry(newEntry({ title: 'от A' }));
    B.upsertEntry(newEntry({ title: 'от B' }));
    // Пока A сливает, B успевает целиком синхронизироваться.
    let bSynced = false;
    script.beforeSave = async () => {
      await eb.syncNow();
      bSynced = true;
    };
    const loadsBefore = script.loads;
    await ea.syncNow();
    expect(bSynced).toBe(true);
    expect(script.loads - loadsBefore).toBeGreaterThanOrEqual(3); // load A, load B, повторный load A
    expect(script.remoteDoc().entries.map((e) => e.title).sort()).toEqual(['от A', 'от B']);
    expect(ea.getState().status).toBe('synced');
    await eb.syncNow();
    expect(same(A.getDoc(), B.getDoc())).toBe(true);
  });

  it('постоянный conflict — после 5 попыток ошибка, локальные данные целы', async () => {
    const script = new FakeScript();
    const A = await newDevice();
    const ea = engineFor(A, script);
    await ea.syncNow();
    A.upsertEntry(newEntry({ title: 'моя' }));
    const client = script.client();
    let saves = 0;
    const e = engineFor(A, script, {
      client: {
        ...client,
        async save(doc, baseRev) {
          saves++;
          script.writeExternal(script.remoteDoc()); // кто-то всё время пишет раньше
          return client.save(doc, baseRev);
        },
      },
    });
    await e.syncNow();
    expect(saves).toBe(5);
    expect(e.getState().status).toBe('error');
    expect(A.getDoc().entries.map((x) => x.title)).toEqual(['моя']);
    expect(A.isDirty()).toBe(true);
  });

  it('правка во время цикла не теряется и уходит следующим циклом', async () => {
    const script = new FakeScript();
    const A = await newDevice();
    A.upsertEntry(newEntry({ title: 'первая' }));
    script.beforeSave = () => {
      A.upsertEntry(newEntry({ title: 'вторая' }));
    };
    await engineFor(A, script).syncNow();
    expect(A.getDoc().entries.map((e) => e.title).sort()).toEqual(['вторая', 'первая']);
    expect(script.remoteDoc().entries.map((e) => e.title).sort()).toEqual(['вторая', 'первая']);
    expect(A.isDirty()).toBe(false);
  });

  it('смена скрипта: base сбрасывается, данные объединяются, а не удаляются', async () => {
    const s1 = new FakeScript();
    const s2 = new FakeScript();
    const A = await newDevice();
    let url = 'u1';
    const keep = newEntry({ title: 'старая' });
    A.upsertEntry(keep);
    await engineFor(A, s1, { connectionUrl: () => url }).syncNow();

    url = 'u2';
    s2.writeExternal({ ...s1.remoteDoc(), entries: [newEntry({ title: 'из нового Drive' })] });
    const e2 = engineFor(A, s2, { connectionUrl: () => url });
    await e2.syncNow();
    const titles = A.getDoc().entries.filter((x) => !x.deleted).map((x) => x.title).sort();
    expect(titles).toEqual(['из нового Drive', 'старая']);
    expect(s2.pings).toBe(1); // email нового скрипта запрошен заново
  });

  it('состояния: disabled, offline, ошибка ключа; ошибка хука не валит синк; хук получает клиент', async () => {
    const script = new FakeScript();
    const A = await newDevice();

    const disabled = engineFor(A, script, { client: { ...script.client(), configured: () => false } });
    await disabled.syncNow();
    expect(disabled.getState().status).toBe('disabled');

    const e = engineFor(A, script);
    script.offline = true;
    await e.syncNow();
    expect(e.getState().status).toBe('offline');
    script.offline = false;

    const offlineDevice = engineFor(A, script, { isOnline: () => false });
    await offlineDevice.syncNow();
    expect(offlineDevice.getState().status).toBe('offline');

    script.forbidden = true;
    await e.syncNow();
    expect(e.getState()).toMatchObject({ status: 'error', error: 'Неверный ключ' });
    script.forbidden = false;

    const states: SyncState[] = [];
    e.subscribe((s) => states.push(s));
    let hookClient: ScriptClient | undefined;
    e.addAfterSyncHook(async (client) => {
      hookClient = client;
      throw new Error('календарь недоступен');
    });
    let secondHookRan = false;
    e.addAfterSyncHook(async () => {
      secondHookRan = true;
    });
    A.upsertEntry(newEntry({ title: 'после ошибки' }));
    await e.syncNow();
    expect(hookClient?.configured()).toBe(true);
    expect(secondHookRan).toBe(true);
    expect(e.getState().status).toBe('synced');
    expect(e.getState().error).toContain('календарь недоступен');
    expect(states.map((s) => s.status)).toContain('syncing');
    expect(script.remoteDoc().entries.some((x) => x.title === 'после ошибки')).toBe(true);
  });

  it('устаревший скрипт (другой protocol) — предупреждение, синк проходит', async () => {
    const script = new FakeScript();
    script.protocol = 0;
    const A = await newDevice();
    const e = engineFor(A, script);
    await e.syncNow();
    expect(e.getState().status).toBe('synced');
    expect(e.getState().error).toMatch(/устарел/);
  });

  it('start(): цикл при старте, после правки (debounce), при online и возврате на вкладку; без подключения не долбит', async () => {
    const script = new FakeScript();
    const A = await newDevice();
    const winListeners: Record<string, () => void> = {};
    let visibility: ((v: boolean) => void) | undefined;
    let connected = true;
    let connListener: (() => void) | undefined;
    const e = engineFor(A, script, {
      client: { ...script.client(), configured: () => connected },
      onConnectionChange: (fn) => {
        connListener = fn;
        return () => (connListener = undefined);
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
    expect(script.loads).toBe(2);

    A.upsertEntry(newEntry({ title: 'правка' }));
    await wait(60);
    await e.syncNow(); // дождаться, если цикл ещё идёт
    expect(script.remoteDoc().entries).toHaveLength(1);
    const afterEdit = script.loads;

    winListeners.online();
    await e.syncNow();
    visibility!(false);
    visibility!(true);
    await e.syncNow();
    expect(script.loads).toBeGreaterThan(afterEdit);

    // Отключили: статус disabled, автоматические триггеры не запускают запросы.
    connected = false;
    connListener!();
    await e.syncNow();
    expect(e.getState().status).toBe('disabled');
    expect(e.getState().account).toBeUndefined();
    const n = script.loads;
    winListeners.online();
    visibility!(true);
    A.upsertEntry(newEntry({ title: 'ещё' }));
    await wait(60);
    expect(script.loads).toBe(n);

    // Подключили снова — цикл сразу.
    connected = true;
    connListener!();
    await e.syncNow();
    expect(script.remoteDoc().entries).toHaveLength(2);

    e.stop();
    expect(Object.keys(winListeners)).toEqual([]);
    expect(visibility).toBeUndefined();
    expect(connListener).toBeUndefined();
  });

  it('syncNow во время цикла запускает ещё один цикл после текущего', async () => {
    const script = new FakeScript();
    const A = await newDevice();
    const e = engineFor(A, script);
    const p1 = e.syncNow();
    const p2 = e.syncNow();
    const p3 = e.syncNow();
    await Promise.all([p1, p2, p3]);
    expect(script.loads).toBe(2);
  });
});
