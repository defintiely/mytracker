import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { TrackerStore } from '../store/store';
import { newEntry } from '../model/entry';
import type { Entry } from '../model/types';
import { createCalendarSync, proposalToEntry, type CalendarProposal, type CalendarSync } from './calendarSync';
import { FakeCalendarApi } from './fakeCalendarApi';
import { CALENDAR_TIME_ZONE } from './mapping';

const getToken = async () => 'token';

let api: FakeCalendarApi;
let store: TrackerStore;
let sync: CalendarSync;

async function setup(enabled = true): Promise<void> {
  // каждый тест — с чистой IndexedDB
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  api = new FakeCalendarApi();
  store = new TrackerStore();
  await store.load();
  store.updateSettings({ calendar: { ...store.getDoc().settings.calendar, enabled } });
  sync = createCalendarSync({ fetch: api.fetch, store, sleep: async () => {} });
}

function add(p: Partial<Entry>): Entry {
  const e = newEntry({ title: 'Съёмка', date: '2026-11-20', media: ['photo'], ...p });
  store.upsertEntry(e);
  return e;
}

const entry = (id: string) => store.getDoc().entries.find((e) => e.id === id)!;
const calId = () => store.getDoc().settings.calendar.calendarId!;

describe('calendarAfterSync', () => {
  beforeEach(() => setup());

  it('выключено в настройках — ни одного запроса', async () => {
    await setup(false);
    add({});
    await sync.afterSync(getToken);
    expect(api.requests).toHaveLength(0);
  });

  it('первая выгрузка создаёт отдельный календарь и события', async () => {
    const a = add({ title: 'Альфа', timeStart: '10:00', timeEnd: '12:00' });
    const b = add({ title: 'Свадьба', date: '2026-11-21' });
    add({ title: 'Предоплата', kind: 'payment' });
    add({ title: 'Без даты', date: undefined });

    await sync.afterSync(getToken);

    expect(api.requests.some((r) => r.path.includes('primary') || r.path.includes('calendarList'))).toBe(false);
    const create = api.requests.find((r) => r.method === 'POST' && r.path === '/calendars')!;
    expect(create.body).toEqual({ summary: 'Съёмки', timeZone: CALENDAR_TIME_ZONE });
    expect(calId()).toBeTruthy();

    const events = api.liveEvents(calId());
    expect(events).toHaveLength(2);
    expect(entry(a.id).calendarEventId).toBeTruthy();
    expect(entry(b.id).calendarEventId).toBeTruthy();
    const ea = events.find((e) => e.id === entry(a.id).calendarEventId)!;
    expect(ea.summary).toBe('📷 Альфа');
    expect(ea.extendedProperties!.private!.entryId).toBe(a.id);
  });

  it('повторный запуск без изменений — 0 запросов на запись', async () => {
    add({ title: 'A', timeStart: '10:00' });
    add({ title: 'B' });
    await sync.afterSync(getToken);
    api.reset();

    await sync.afterSync(getToken);
    expect(api.writes).toHaveLength(0);

    // и ещё раз — синхронизация по syncToken, по-прежнему без записи
    api.reset();
    await sync.afterSync(getToken);
    expect(api.writes).toHaveLength(0);
    expect(api.requests.find((r) => r.path.endsWith('/events'))!.query.syncToken).toBeTruthy();
  });

  it('правка записи → обновление события; без правки — не трогаем', async () => {
    const a = add({ title: 'A', timeStart: '10:00' });
    add({ title: 'B' });
    await sync.afterSync(getToken);
    api.reset();

    store.updateEntry(a.id, { title: 'A2', location: 'Old Town' });
    await sync.afterSync(getToken);
    expect(api.eventWrites).toHaveLength(1);
    expect(api.eventWrites[0].method).toBe('PUT');
    const ev = api.liveEvents(calId()).find((e) => e.id === entry(a.id).calendarEventId)!;
    expect(ev.summary).toBe('📷 A2');
    expect(ev.location).toBe('Old Town');
  });

  it('перенос времени в календаре подтягивается в запись и не затирается выгрузкой', async () => {
    const a = add({ title: 'A', timeStart: '10:00', timeEnd: '12:00' });
    await sync.afterSync(getToken);
    const evId = entry(a.id).calendarEventId!;

    // Google отдаёт время со смещением; в тестах пояс Europe/Athens (vite.config.ts), ноябрь — UTC+2
    api.userEdit(calId(), evId, {
      start: { dateTime: '2026-11-22T14:00:00+02:00', timeZone: CALENDAR_TIME_ZONE },
      end: { dateTime: '2026-11-22T16:00:00+02:00', timeZone: CALENDAR_TIME_ZONE },
    });
    await sync.afterSync(getToken);

    const got = entry(a.id);
    expect(got.date).toBe('2026-11-22');
    expect(got.timeStart).toBe('14:00');
    expect(got.timeEnd).toBe('16:00');
    expect(got.fieldUpdatedAt?.date).toBeDefined(); // уйдёт в Drive как обычная правка
    const ev = api.calendar(calId()).events.get(evId)!;
    expect(ev.start!.dateTime).toContain('2026-11-22T14:00');

    // дальше стабильно
    api.reset();
    await sync.afterSync(getToken);
    expect(api.writes).toHaveLength(0);
  });

  it('перенос в приложении календарь не откатывает', async () => {
    const a = add({ title: 'A', timeStart: '10:00' });
    await sync.afterSync(getToken);
    store.updateEntry(a.id, { timeStart: '18:00' });
    await sync.afterSync(getToken);
    expect(entry(a.id).timeStart).toBe('18:00');
    const ev = api.calendar(calId()).events.get(entry(a.id).calendarEventId!)!;
    expect(ev.start!.dateTime).toBe('2026-11-20T18:00:00');
  });

  it('удаление записи удаляет событие', async () => {
    const a = add({ title: 'A' });
    await sync.afterSync(getToken);
    const evId = entry(a.id).calendarEventId!;
    store.deleteEntry(a.id);
    await sync.afterSync(getToken);
    expect(api.calendar(calId()).events.get(evId)!.status).toBe('cancelled');
    expect(entry(a.id).calendarEventId).toBeUndefined();
    api.reset();
    await sync.afterSync(getToken);
    expect(api.writes).toHaveLength(0);
  });

  it('отмена записи: delete — событие удаляется, mark — «Отменено: »', async () => {
    const a = add({ title: 'A' });
    await sync.afterSync(getToken);
    const evId = entry(a.id).calendarEventId!;

    store.updateSettings({ calendar: { ...store.getDoc().settings.calendar, onCancel: 'mark' } });
    store.updateEntry(a.id, { status: 'cancelled' });
    await sync.afterSync(getToken);
    expect(api.calendar(calId()).events.get(evId)!.summary).toBe('Отменено: 📷 A');

    store.updateSettings({ calendar: { ...store.getDoc().settings.calendar, onCancel: 'delete' } });
    await sync.afterSync(getToken);
    expect(api.calendar(calId()).events.get(evId)!.status).toBe('cancelled');
  });

  it('событие удалили в календаре — запись остаётся, calendarEventId снят, событие не пересоздаётся', async () => {
    const a = add({ title: 'A' });
    await sync.afterSync(getToken);
    api.userDelete(calId(), entry(a.id).calendarEventId!);
    api.reset();
    await sync.afterSync(getToken);
    expect(entry(a.id).deleted).toBeFalsy();
    expect(entry(a.id).calendarEventId).toBeUndefined();
    expect(api.writes).toHaveLength(0);

    // запись изменили — выгружаем снова
    store.updateEntry(a.id, { title: 'A2' });
    await sync.afterSync(getToken);
    expect(entry(a.id).calendarEventId).toBeTruthy();
    expect(api.liveEvents(calId()).map((e) => e.summary)).toEqual(['📷 A2']);
  });

  it('событие без entryId → предложение; dismiss и импорт убирают его', async () => {
    await sync.afterSync(getToken);
    const seen: CalendarProposal[][] = [];
    sync.subscribeProposals((l) => seen.push(l));

    const u1 = api.userInsert(calId(), {
      summary: 'Фотосессия в порту',
      location: 'Harbor',
      start: { dateTime: '2026-12-01T11:00:00+02:00', timeZone: CALENDAR_TIME_ZONE },
      end: { dateTime: '2026-12-01T13:00:00+02:00', timeZone: CALENDAR_TIME_ZONE },
    });
    const u2 = api.userInsert(calId(), { summary: 'Ещё', start: { date: '2026-12-05' }, end: { date: '2026-12-06' } });
    await sync.afterSync(getToken);

    const list = sync.getProposals();
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.eventId === u1)).toEqual({
      eventId: u1,
      title: 'Фотосессия в порту',
      date: '2026-12-01',
      timeStart: '11:00',
      timeEnd: '13:00',
      location: 'Harbor',
    });
    expect(seen.at(-1)).toHaveLength(2);
    expect(api.liveEvents(calId())).toHaveLength(2); // молча записи не создаются и события не трогаются

    sync.dismissProposal(u2);
    expect(sync.getProposals().map((p) => p.eventId)).toEqual([u1]);

    // импорт: запись с calendarEventId, при выгрузке событию проставляется entryId
    const e = proposalToEntry(list.find((p) => p.eventId === u1)!);
    expect(e).toMatchObject({ type: 'main', kind: 'shoot', date: '2026-12-01', timeStart: '11:00', calendarEventId: u1 });
    store.upsertEntry(e);
    expect(sync.getProposals()).toHaveLength(0);
    await sync.afterSync(getToken);
    const ev = api.calendar(calId()).events.get(u1)!;
    expect(ev.extendedProperties!.private!.entryId).toBe(e.id);
    expect(ev.summary).toBe('Фотосессия в порту');

    // отклонённое не возвращается и после полной выборки
    api.expireTokensBefore = Number.MAX_SAFE_INTEGER;
    await sync.afterSync(getToken);
    expect(sync.getProposals()).toHaveLength(0);
  });

  it('предложения переживают перезапуск (meta)', async () => {
    await sync.afterSync(getToken);
    const u = api.userInsert(calId(), { summary: 'X', start: { date: '2026-12-05' }, end: { date: '2026-12-06' } });
    await sync.afterSync(getToken);
    const again = createCalendarSync({ fetch: api.fetch, store, sleep: async () => {} });
    const got = await new Promise<CalendarProposal[]>((resolve) => {
      const off = again.subscribeProposals((l) => {
        off();
        resolve(l);
      });
    });
    expect(got.map((p) => p.eventId)).toEqual([u]);
  });

  it('410 Gone на syncToken → полная выборка, без дублей', async () => {
    add({ title: 'A' });
    add({ title: 'B' });
    await sync.afterSync(getToken);
    api.expireTokensBefore = Number.MAX_SAFE_INTEGER;
    api.reset();
    await sync.afterSync(getToken);
    const lists = api.requests.filter((r) => r.path.endsWith('/events') && r.method === 'GET');
    expect(lists[0].query.syncToken).toBeTruthy();
    expect(lists[1].query.syncToken).toBeUndefined();
    expect(api.writes).toHaveLength(0);
    expect(api.liveEvents(calId())).toHaveLength(2);
  });

  it('не создаёт дубль: событие с entryId есть, а у записи нет calendarEventId — привязывает', async () => {
    const a = add({ title: 'A' });
    await sync.afterSync(getToken);
    const evId = entry(a.id).calendarEventId!;
    // другое устройство: та же запись без calendarEventId, своё (пустое) локальное состояние
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    const other = new TrackerStore();
    await other.load();
    other.replaceDoc({ ...store.getDoc(), entries: store.getDoc().entries.map((e) => ({ ...e, calendarEventId: undefined })) });
    const otherSync = createCalendarSync({ fetch: api.fetch, store: other, sleep: async () => {} });
    api.reset();
    await otherSync.afterSync(getToken);
    expect(api.eventWrites).toHaveLength(0);
    expect(other.getDoc().entries[0].calendarEventId).toBe(evId);
  });

  it('пагинация events.list', async () => {
    api.pageSize = 2;
    for (let i = 0; i < 5; i++) add({ title: 'E' + i });
    await sync.afterSync(getToken);
    api.reset();
    await setupSecondDevice();
    expect(api.eventWrites).toHaveLength(0);
  });

  it('403 rateLimitExceeded — повтор с паузой', async () => {
    add({ title: 'A' });
    const pauses: number[] = [];
    sync = createCalendarSync({ fetch: api.fetch, store, sleep: async (ms) => void pauses.push(ms) });
    api.rateLimitNext = 2;
    await sync.afterSync(getToken);
    expect(pauses).toHaveLength(2);
    expect(api.liveEvents(calId())).toHaveLength(1);
  });

  it('не больше 4 запросов одновременно', async () => {
    for (let i = 0; i < 12; i++) add({ title: 'E' + i });
    let inFlight = 0;
    let peak = 0;
    const slowFetch: typeof fetch = async (input, init) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      try {
        return await api.fetch(input, init);
      } finally {
        inFlight--;
      }
    };
    sync = createCalendarSync({ fetch: slowFetch, store, sleep: async () => {} });
    await sync.afterSync(getToken);
    expect(api.liveEvents(calId())).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('личное busy: «Занято» без подробностей', async () => {
    store.updateSettings({ calendar: { ...store.getDoc().settings.calendar, personalMode: 'busy' } });
    add({ type: 'personal', kind: 'event', title: 'Врач', location: 'Клиника', media: [] });
    await sync.afterSync(getToken);
    const [ev] = api.liveEvents(calId());
    expect(ev.summary).toBe('Занято');
    expect(ev.location).toBeUndefined();
  });
});

/** Второе устройство с той же Drive-копией: полная выборка по страницам не должна ничего писать. */
async function setupSecondDevice(): Promise<void> {
  const doc = store.getDoc();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  const other = new TrackerStore();
  await other.load();
  other.replaceDoc(doc);
  await createCalendarSync({ fetch: api.fetch, store: other, sleep: async () => {} }).afterSync(getToken);
}
