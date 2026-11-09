import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { TrackerStore } from '../store/store';
import { newEntry } from '../model/entry';
import type { Entry } from '../model/types';
import type { CalendarRequest, CalendarResponse, ScriptClient } from '../sync/scriptApi';
import { createCalendarSync, META_REMOVED, proposalToEntry, type CalendarProposal, type CalendarSync } from './calendarSync';
import { createGsRunner, type GsRunner } from './gsFakes';
import { CALENDAR_TIME_ZONE } from './mapping';

const NOW = () => new Date('2026-11-09T10:00:00Z');

/** ScriptClient, который исполняет настоящий handleCalendar_ на фейках Apps Script. */
class FakeScriptClient implements ScriptClient {
  requests: Omit<CalendarRequest, 'action'>[] = [];
  isConfigured = true;
  constructor(readonly gs: GsRunner) {}
  configured() {
    return this.isConfigured;
  }
  ping(): never {
    throw new Error('не нужен');
  }
  load(): never {
    throw new Error('не нужен');
  }
  save(): never {
    throw new Error('не нужен');
  }
  async calendar(req: Omit<CalendarRequest, 'action'>): Promise<CalendarResponse> {
    this.requests.push(req);
    // как по сети: JSON туда и обратно
    return JSON.parse(JSON.stringify(this.gs.handleCalendar(JSON.parse(JSON.stringify(req)))));
  }
}

let gs: GsRunner;
let client: FakeScriptClient;
let store: TrackerStore;
let sync: CalendarSync;

async function setup(enabled = true): Promise<void> {
  // каждый тест — с чистой IndexedDB
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  gs = createGsRunner(CALENDAR_TIME_ZONE);
  client = new FakeScriptClient(gs);
  store = new TrackerStore();
  await store.load();
  store.updateSettings({ calendar: { ...store.getDoc().settings.calendar, enabled } });
  sync = createCalendarSync({ store, now: NOW });
}

function add(p: Partial<Entry>): Entry {
  const e = newEntry({ title: 'Задача', date: '2026-11-20', ...p });
  store.upsertEntry(e);
  return e;
}

const entry = (id: string) => store.getDoc().entries.find((e) => e.id === id)!;
const lastReq = () => client.requests.at(-1)!;

describe('calendarAfterSync (Apps Script)', () => {
  beforeEach(() => setup());

  it('выключено в настройках или скрипт не подключён — ни одного запроса', async () => {
    await setup(false);
    add({});
    await sync.afterSync(client);
    expect(client.requests).toHaveLength(0);

    await setup(true);
    client.isConfigured = false;
    add({});
    await sync.afterSync(client);
    expect(client.requests).toHaveLength(0);
  });

  it('выгрузка: запрос с событиями записей, календарь создан, calendarId сохранён', async () => {
    const a = add({ title: 'Альфа', timeStart: '10:00', timeEnd: '12:00', location: 'Old Town' });
    const b = add({ title: 'Выездной семинар', date: '2026-11-21', dateEnd: '2026-11-22' });
    add({ title: 'Предоплата', kind: 'payment' });
    add({ title: 'Без даты', date: undefined });
    add({ title: 'Давно', date: '2026-01-10' }); // старше окна — не шлём

    await sync.afterSync(client);

    const req = lastReq();
    expect(req.calendarName).toBe('Трекер');
    expect(req.timeZone).toBe(CALENDAR_TIME_ZONE);
    expect(req.windowStart).toBe('2026-09-10');
    expect(req.windowEnd).toBe('2028-11-08');
    expect(req.events.map((d) => d.entryId).sort()).toEqual([a.id, b.id].sort());
    const da = req.events.find((d) => d.entryId === a.id)!;
    expect(da).toMatchObject({
      title: 'Альфа',
      allDay: false,
      start: '2026-11-20T10:00',
      end: '2026-11-20T12:00',
      location: 'Old Town',
      reminders: [1440, 120],
    });
    expect(da.hash).toBeTruthy();
    expect(req.events.find((d) => d.entryId === b.id)).toMatchObject({ allDay: true, start: '2026-11-21', end: '2026-11-23' });

    const cal = gs.calendar();
    expect(store.getDoc().settings.calendar.calendarId).toBe(cal.id);
    expect(cal.live()).toHaveLength(2);
    expect(cal.byEntry(a.id)!.title).toBe('Альфа');
    expect(gs.primary.events).toHaveLength(0);

    // повтор без изменений — в календаре ничего не пишется, настройки не трогаются
    const settingsAt = store.getDoc().settings.updatedAt;
    gs.resetCounters();
    await sync.afterSync(client);
    expect(gs.env.writes).toBe(0);
    expect(store.getDoc().settings.updatedAt).toBe(settingsAt);
  });

  it('правка записи → обновление события', async () => {
    const a = add({ title: 'A', timeStart: '10:00' });
    await sync.afterSync(client);
    store.updateEntry(a.id, { title: 'A2', location: 'Old Town' });
    await sync.afterSync(client);
    const ev = gs.calendar().byEntry(a.id)!;
    expect(ev.title).toBe('A2');
    expect(ev.location).toBe('Old Town');
  });

  it('перенос в календаре подтягивается в запись и дальше стабилен', async () => {
    const a = add({ title: 'A', timeStart: '10:00', timeEnd: '12:00' });
    await sync.afterSync(client);
    const cal = gs.calendar();
    const ev = cal.byEntry(a.id)!;
    cal.userMoveTimed(ev.id, '2026-11-22T14:00', '2026-11-22T16:00', CALENDAR_TIME_ZONE);

    await sync.afterSync(client);
    const got = entry(a.id);
    expect(got.date).toBe('2026-11-22');
    expect(got.timeStart).toBe('14:00');
    expect(got.timeEnd).toBe('16:00');
    expect(got.fieldUpdatedAt?.date).toBeDefined(); // уйдёт в Drive как обычная правка
    expect(ev.start.toISOString()).toBe('2026-11-22T12:00:00.000Z'); // не откатили

    await sync.afterSync(client); // догоняющий цикл с новым временем
    gs.resetCounters();
    await sync.afterSync(client);
    expect(gs.env.writes).toBe(0);
    expect(entry(a.id).timeStart).toBe('14:00');
  });

  it('перенос на весь день на несколько дней', async () => {
    const a = add({ title: 'A', timeStart: '10:00' });
    await sync.afterSync(client);
    const cal = gs.calendar();
    cal.userMoveAllDay(cal.byEntry(a.id)!.id, '2026-11-25', '2026-11-28');
    await sync.afterSync(client);
    expect(entry(a.id)).toMatchObject({ date: '2026-11-25', dateEnd: '2026-11-27', allDay: true });
    expect(entry(a.id).timeStart).toBeUndefined();
  });

  it('перенос в приложении календарь не откатывает', async () => {
    const a = add({ title: 'A', timeStart: '10:00' });
    await sync.afterSync(client);
    store.updateEntry(a.id, { timeStart: '18:00' });
    await sync.afterSync(client);
    expect(entry(a.id).timeStart).toBe('18:00');
    expect(gs.calendar().byEntry(a.id)!.start.toISOString()).toBe('2026-11-20T16:00:00.000Z');
  });

  it('удаление и отмена записи убирают событие', async () => {
    const a = add({ title: 'A' });
    const b = add({ title: 'B' });
    await sync.afterSync(client);
    store.deleteEntry(a.id);
    store.updateEntry(b.id, { status: 'cancelled' }); // onCancel по умолчанию — delete
    await sync.afterSync(client);
    expect(gs.calendar().live()).toHaveLength(0);
  });

  it('удалено пользователем в календаре — не выгружается снова, пока запись не изменится', async () => {
    const a = add({ title: 'A' });
    await sync.afterSync(client);
    const cal = gs.calendar();
    cal.userDelete(cal.byEntry(a.id)!.id);

    await sync.afterSync(client);
    expect(entry(a.id).deleted).toBeFalsy();
    expect(await store.getMeta<Record<string, string>>(META_REMOVED)).toHaveProperty(a.id);

    await sync.afterSync(client);
    expect(lastReq().events.map((d) => d.entryId)).not.toContain(a.id);
    expect(cal.live()).toHaveLength(0);

    // запись изменили — выгружаем снова
    store.updateEntry(a.id, { title: 'A2' });
    await sync.afterSync(client);
    expect(cal.live().map((e) => e.title)).toEqual(['A2']);
    expect(await store.getMeta<Record<string, string>>(META_REMOVED)).toEqual({});
  });

  it('чужие события → предложения; dismiss и импорт без дубля', async () => {
    await sync.afterSync(client);
    const seen: CalendarProposal[][] = [];
    sync.subscribeProposals((l) => seen.push(l));

    const cal = gs.calendar();
    const u1 = cal.userCreateTimed('Встреча в порту', '2026-12-01T11:00', '2026-12-01T13:00', CALENDAR_TIME_ZONE, 'Harbor');
    const u2 = cal.userCreateAllDay('Отпуск', '2026-12-05', '2026-12-08');
    await sync.afterSync(client);

    const list = sync.getProposals();
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.eventId === u1.id)).toEqual({
      eventId: u1.id,
      title: 'Встреча в порту',
      date: '2026-12-01',
      timeStart: '11:00',
      timeEnd: '13:00',
      location: 'Harbor',
    });
    expect(list.find((p) => p.eventId === u2.id)).toEqual({
      eventId: u2.id,
      title: 'Отпуск',
      date: '2026-12-05',
      dateEnd: '2026-12-07',
    });
    expect(seen.at(-1)).toHaveLength(2);
    expect(cal.live()).toHaveLength(2); // молча записи не создаются и события не трогаются

    sync.dismissProposal(u2.id);
    expect(sync.getProposals().map((p) => p.eventId)).toEqual([u1.id]);

    // импорт: запись с calendarEventId → скрипт помечает само чужое событие
    const e = proposalToEntry(list.find((p) => p.eventId === u1.id)!);
    expect(e).toMatchObject({ type: 'main', kind: 'job', date: '2026-12-01', timeStart: '11:00', calendarEventId: u1.id });
    store.upsertEntry(e);
    expect(sync.getProposals()).toHaveLength(0);
    await sync.afterSync(client);
    expect(cal.live()).toHaveLength(2);
    expect(u1.tags.wltEntry).toBe(e.id);
    expect(u1.title).toBe('Встреча в порту');
    expect(u1.tags.wltHash).toBe(lastReq().events.find((d) => d.entryId === e.id)!.hash);

    // отклонённое не возвращается
    await sync.afterSync(client);
    expect(sync.getProposals()).toHaveLength(0);

    // чужое событие удалили в календаре — предложение пропадает
    const u3 = cal.userCreateAllDay('Ещё', '2026-12-10', '2026-12-11');
    await sync.afterSync(client);
    expect(sync.getProposals().map((p) => p.eventId)).toEqual([u3.id]);
    cal.userDelete(u3.id);
    await sync.afterSync(client);
    expect(sync.getProposals()).toHaveLength(0);
  });

  it('предложения переживают перезапуск (meta)', async () => {
    await sync.afterSync(client);
    const u = gs.calendar().userCreateAllDay('X', '2026-12-05', '2026-12-06');
    await sync.afterSync(client);
    const again = createCalendarSync({ store, now: NOW });
    const got = await new Promise<CalendarProposal[]>((resolve) => {
      const off = again.subscribeProposals((l) => {
        off();
        resolve(l);
      });
    });
    expect(got.map((p) => p.eventId)).toEqual([u.id]);
  });

  it('личное busy: «Занято» без подробностей', async () => {
    store.updateSettings({ calendar: { ...store.getDoc().settings.calendar, personalMode: 'busy' } });
    add({ type: 'personal', kind: 'event', title: 'Врач', location: 'Клиника' });
    await sync.afterSync(client);
    const [ev] = gs.calendar().live();
    expect(ev.title).toBe('Занято');
    expect(ev.location).toBe('');
    expect(JSON.stringify(client.requests)).not.toContain('Врач');
  });

  it('параллельный вызов ждёт текущий прогон', async () => {
    add({ title: 'A' });
    await Promise.all([sync.afterSync(client), sync.afterSync(client)]);
    expect(client.requests).toHaveLength(1);
  });
});
