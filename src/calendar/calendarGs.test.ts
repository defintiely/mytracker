import { beforeEach, describe, expect, it } from 'vitest';
import type { DesiredEvent } from '../sync/scriptApi';
import { CALENDAR_GS } from './calendarGs';
import { createGsRunner, type GsRunner } from './gsFakes';

const TZ = 'Europe/Athens'; // ноябрь — UTC+2

function timed(entryId: string, start: string, end: string, p: Partial<DesiredEvent> = {}): DesiredEvent {
  return { entryId, hash: 'h-' + entryId, title: 'Задача ' + entryId, allDay: false, start, end, reminders: [1440, 120], ...p };
}

function allDay(entryId: string, start: string, endExclusive: string, p: Partial<DesiredEvent> = {}): DesiredEvent {
  return { entryId, hash: 'h-' + entryId, title: 'День ' + entryId, allDay: true, start, end: endExclusive, reminders: [], ...p };
}

let gs: GsRunner;

function call(events: DesiredEvent[], calendarName = 'Трекер') {
  return gs.handleCalendar({ calendarName, timeZone: TZ, events, windowStart: '2026-09-10', windowEnd: '2028-11-09' });
}

describe('CALENDAR_GS', () => {
  beforeEach(() => {
    gs = createGsRunner(TZ);
  });

  it('чистый Apps Script: без import/export, TypeScript и шаблонных подстановок', () => {
    expect(CALENDAR_GS).not.toMatch(/^\s*(import|export)\s/m);
    expect(CALENDAR_GS).not.toContain('${');
    expect(CALENDAR_GS).toContain('function handleCalendar_(req)');
    // все функции верхнего уровня — с суффиксом _
    const names = [...CALENDAR_GS.matchAll(/^function (\w+)/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(3);
    for (const n of names) expect(n.endsWith('_')).toBe(true);
  });

  it('первая выгрузка создаёт календарь и события с полями, напоминаниями и тегами', () => {
    const res = call([
      timed('a', '2026-11-20T10:00', '2026-11-20T12:00', {
        description: 'Категория: встреча',
        location: 'Old Town',
        colorId: '9',
      }),
      allDay('b', '2026-11-21', '2026-11-22'),
    ]);

    expect(res.ok).toBe(true);
    expect(res.stats).toEqual({ created: 2, updated: 0, deleted: 0 });
    const cal = gs.calendar();
    expect(res.calendarId).toBe(cal.id);
    expect(cal.name).toBe('Трекер');
    expect(cal.timeZone).toBe(TZ);
    expect(gs.primary.events).toHaveLength(0); // основной календарь не тронут

    const a = cal.byEntry('a')!;
    expect(a.title).toBe('Задача a');
    expect(a.description).toBe('Категория: встреча');
    expect(a.location).toBe('Old Town');
    expect(a.color).toBe('9');
    expect(a.reminders).toEqual([1440, 120]);
    expect(a.start.toISOString()).toBe('2026-11-20T08:00:00.000Z');
    expect(a.tags).toEqual({ wltEntry: 'a', wltHash: 'h-a', wltWhen: '2026-11-20T10:00|2026-11-20T12:00|false' });

    const b = cal.byEntry('b')!;
    expect(b.allDay).toBe(true);
    expect([b.startDay, b.endDay]).toEqual(['2026-11-21', '2026-11-22']);
    expect(b.tags.wltWhen).toBe('2026-11-21|2026-11-22|true');

    expect(JSON.parse(gs.env.properties.get('calPushed')!)).toEqual({ a: a.id, b: b.id });
    expect(res.moved).toEqual([]);
    expect(res.removedByUser).toEqual([]);
    expect(res.foreign).toEqual([]);
  });

  it('повтор с теми же хэшами — ни одной записи и ни одного getEventById', () => {
    const events = [timed('a', '2026-11-20T10:00', '2026-11-20T12:00'), allDay('b', '2026-11-21', '2026-11-23')];
    call(events);
    gs.resetCounters();
    const res = call(events);
    expect(res.stats).toEqual({ created: 0, updated: 0, deleted: 0 });
    expect(gs.env.writes).toBe(0);
    expect(gs.env.getByIdCalls).toBe(0);
    expect(gs.env.reads).toBe(1); // одна выборка окна
  });

  it('смена хэша — обновление полей и времени, в т.ч. переход со времени на весь день', () => {
    call([timed('a', '2026-11-20T10:00', '2026-11-20T12:00', { location: 'Old' })]);
    const id = gs.calendar().byEntry('a')!.id;

    let res = call([timed('a', '2026-11-20T15:00', '2026-11-20T16:30', { hash: 'h2', title: 'Новое', reminders: [30] })]);
    expect(res.stats).toEqual({ created: 0, updated: 1, deleted: 0 });
    const ev = gs.calendar().byEntry('a')!;
    expect(ev.id).toBe(id);
    expect(ev.title).toBe('Новое');
    expect(ev.location).toBe(''); // место сняли
    expect(ev.reminders).toEqual([30]);
    expect(ev.tags.wltHash).toBe('h2');
    expect(ev.tags.wltWhen).toBe('2026-11-20T15:00|2026-11-20T16:30|false');
    expect(res.moved).toEqual([]);

    res = call([allDay('a', '2026-11-20', '2026-11-22', { hash: 'h3' })]);
    expect(res.stats.updated).toBe(1);
    expect(ev.allDay).toBe(true);
    expect([ev.startDay, ev.endDay]).toEqual(['2026-11-20', '2026-11-22']);
    expect(res.moved).toEqual([]);
  });

  it('перенос пользователем → moved, время не откатывается, остальные поля обновляются', () => {
    call([timed('a', '2026-11-20T10:00', '2026-11-20T12:00')]);
    const cal = gs.calendar();
    const ev = cal.byEntry('a')!;
    cal.userMoveTimed(ev.id, '2026-11-22T14:00', '2026-11-22T16:00', TZ);

    // трекер ещё не знает о переносе и шлёт старое время, но с новым заголовком
    const res = call([timed('a', '2026-11-20T10:00', '2026-11-20T12:00', { hash: 'h2', title: 'Новое' })]);
    expect(res.moved).toEqual([{ entryId: 'a', allDay: false, start: '2026-11-22T14:00', end: '2026-11-22T16:00' }]);
    expect(ev.start.toISOString()).toBe('2026-11-22T12:00:00.000Z'); // не откатили
    expect(ev.title).toBe('Новое');
    expect(ev.deleted).toBe(false);

    // трекер подтянул перенос и прислал новое время — событие сходится, переноса больше нет
    const res2 = call([timed('a', '2026-11-22T14:00', '2026-11-22T16:00', { hash: 'h3', title: 'Новое' })]);
    expect(res2.moved).toEqual([]);
    expect(res2.stats.updated).toBe(1);
    expect(ev.tags.wltHash).toBe('h3');
    expect(ev.tags.wltWhen).toBe('2026-11-22T14:00|2026-11-22T16:00|false');
    gs.resetCounters();
    const res3 = call([timed('a', '2026-11-22T14:00', '2026-11-22T16:00', { hash: 'h3', title: 'Новое' })]);
    expect(res3.moved).toEqual([]);
    expect(gs.env.writes).toBe(0);
  });

  it('перенос события, которое трекеру уже не нужно, — не удаляется в том же вызове', () => {
    call([timed('a', '2026-11-20T10:00', '2026-11-20T12:00')]);
    const cal = gs.calendar();
    const ev = cal.byEntry('a')!;
    cal.userMoveTimed(ev.id, '2026-11-21T10:00', '2026-11-21T12:00', TZ);
    const res = call([]);
    expect(res.moved.map((m) => m.entryId)).toEqual(['a']);
    expect(ev.deleted).toBe(false);
    const res2 = call([]);
    expect(res2.stats.deleted).toBe(1);
    expect(ev.deleted).toBe(true);
  });

  it('удаление пользователем → removedByUser, событие не пересоздаётся', () => {
    const events = [timed('a', '2026-11-20T10:00', '2026-11-20T12:00'), timed('b', '2026-11-21T10:00', '2026-11-21T11:00')];
    call(events);
    const cal = gs.calendar();
    cal.userDelete(cal.byEntry('a')!.id);

    const res = call(events);
    expect(res.removedByUser).toEqual(['a']);
    expect(res.stats).toEqual({ created: 0, updated: 0, deleted: 0 });
    expect(cal.byEntry('a')).toBeUndefined();
    expect(Object.keys(JSON.parse(gs.env.properties.get('calPushed')!))).toEqual(['b']);

    // трекер больше не шлёт «a» — тишина; прислал снова (запись изменилась) — создаётся заново
    expect(call([events[1]]).removedByUser).toEqual([]);
    const res3 = call([{ ...events[0], hash: 'h2' }, events[1]]);
    expect(res3.stats.created).toBe(1);
    expect(cal.byEntry('a')).toBeDefined();
  });

  it('лишнее событие приложения удаляется', () => {
    call([timed('a', '2026-11-20T10:00', '2026-11-20T12:00'), allDay('b', '2026-11-21', '2026-11-22')]);
    const cal = gs.calendar();
    const b = cal.byEntry('b')!;
    const res = call([timed('a', '2026-11-20T10:00', '2026-11-20T12:00')]);
    expect(res.stats).toEqual({ created: 0, updated: 0, deleted: 1 });
    expect(b.deleted).toBe(true);
    expect(Object.keys(JSON.parse(gs.env.properties.get('calPushed')!))).toEqual(['a']);
  });

  it('дубль события одной записи удаляется', () => {
    call([timed('a', '2026-11-20T10:00', '2026-11-20T12:00')]);
    const cal = gs.calendar();
    const dup = cal.userCreateTimed('копия', '2026-11-20T10:00', '2026-11-20T12:00', TZ);
    dup.tags = { ...cal.byEntry('a')!.tags };
    const res = call([timed('a', '2026-11-20T10:00', '2026-11-20T12:00')]);
    expect(res.stats.deleted).toBe(1);
    expect(dup.deleted).toBe(true);
    expect(cal.live()).toHaveLength(1);
  });

  it('чужое событие → foreign и не трогается', () => {
    call([]);
    const cal = gs.calendar();
    const f1 = cal.userCreateTimed('Фотосессия в порту', '2026-12-01T11:00', '2026-12-01T13:00', TZ, 'Harbor');
    const f2 = cal.userCreateAllDay('Отпуск', '2026-12-05', '2026-12-08');
    cal.userCreateAllDay('Давно', '2025-01-01', '2025-01-02'); // вне окна
    const res = call([]);
    expect(res.foreign).toEqual([
      { eventId: f1.id, title: 'Фотосессия в порту', allDay: false, start: '2026-12-01T11:00', end: '2026-12-01T13:00', location: 'Harbor' },
      { eventId: f2.id, title: 'Отпуск', allDay: true, start: '2026-12-05', end: '2026-12-08' },
    ]);
    expect(res.stats).toEqual({ created: 0, updated: 0, deleted: 0 });
    expect(f1.deleted || f2.deleted).toBe(false);
  });

  it('adoptEventId: чужое событие становится событием записи вместо дубля', () => {
    call([]);
    const cal = gs.calendar();
    const f = cal.userCreateTimed('Консультация', '2026-12-01T11:00', '2026-12-01T13:00', TZ);
    const res = gs.handleCalendar({
      calendarName: 'Трекер',
      timeZone: TZ,
      windowStart: '2026-09-10',
      windowEnd: '2028-11-09',
      events: [{ ...timed('x', '2026-12-01T11:00', '2026-12-01T13:00', { title: 'Консультация Анны' }), adoptEventId: f.id }],
    });
    expect(res.stats).toEqual({ created: 0, updated: 1, deleted: 0 });
    expect(res.foreign).toEqual([]);
    expect(cal.live()).toHaveLength(1);
    expect(f.tags.wltEntry).toBe('x');
    expect(f.title).toBe('Консультация Анны');
  });

  it('all-day на несколько дней: конец исключительный, перенос распознаётся', () => {
    call([allDay('a', '2026-11-20', '2026-11-23')]);
    const cal = gs.calendar();
    const ev = cal.byEntry('a')!;
    expect([ev.startDay, ev.endDay]).toEqual(['2026-11-20', '2026-11-23']);
    cal.userMoveAllDay(ev.id, '2026-11-25', '2026-11-27');
    const res = call([allDay('a', '2026-11-20', '2026-11-23')]);
    expect(res.moved).toEqual([{ entryId: 'a', allDay: true, start: '2026-11-25', end: '2026-11-27' }]);
    expect([ev.startDay, ev.endDay]).toEqual(['2026-11-25', '2026-11-27']);
  });

  it('пояс скрипта отличается от пояса трекера — даты all-day не съезжают', () => {
    gs = createGsRunner('America/Los_Angeles');
    call([allDay('a', '2026-11-20', '2026-11-22'), timed('b', '2026-11-20T00:30', '2026-11-20T01:30')]);
    const cal = gs.calendar();
    expect([cal.byEntry('a')!.startDay, cal.byEntry('a')!.endDay]).toEqual(['2026-11-20', '2026-11-22']);
    expect(cal.byEntry('b')!.start.toISOString()).toBe('2026-11-19T22:30:00.000Z');
    gs.resetCounters();
    const res = call([allDay('a', '2026-11-20', '2026-11-22'), timed('b', '2026-11-20T00:30', '2026-11-20T01:30')]);
    expect(res.moved).toEqual([]);
    expect(gs.env.writes).toBe(0);
  });

  it('событие за пределами окна находится по учёту, а не пересоздаётся', () => {
    call([timed('far', '2029-06-01T10:00', '2029-06-01T11:00')]);
    gs.resetCounters();
    const res = call([timed('far', '2029-06-01T10:00', '2029-06-01T11:00')]);
    expect(res.stats).toEqual({ created: 0, updated: 0, deleted: 0 });
    expect(gs.env.getByIdCalls).toBe(1);
    expect(gs.calendar().live()).toHaveLength(1);
  });

  it('смена имени — переименование; удалённый календарь — создаётся новый', () => {
    call([timed('a', '2026-11-20T10:00', '2026-11-20T12:00')]);
    const first = gs.calendar();
    call([timed('a', '2026-11-20T10:00', '2026-11-20T12:00')], 'Работа');
    expect(gs.calendar()).toBe(first);
    expect(first.name).toBe('Работа');

    gs.env.calendars = gs.env.calendars.filter((c) => c !== first);
    const res = call([timed('a', '2026-11-20T10:00', '2026-11-20T12:00')], 'Работа');
    expect(res.calendarId).not.toBe(first.id);
    expect(res.stats.created).toBe(1);
    expect(res.removedByUser).toEqual([]); // учёт старого календаря не переносится
  });

  it('основной календарь не используется, даже если его id оказался в свойствах', () => {
    gs.env.properties.set('calendarId', gs.primary.id);
    const res = call([timed('a', '2026-11-20T10:00', '2026-11-20T12:00')]);
    expect(res.calendarId).not.toBe(gs.primary.id);
    expect(gs.primary.events).toHaveLength(0);
  });

  it('большой учёт выгруженного режется на куски по 9 КБ', () => {
    const events = Array.from({ length: 300 }, (_, i) =>
      timed('entry-with-a-long-identifier-' + i, '2026-11-20T10:00', '2026-11-20T11:00'),
    );
    call(events);
    expect(gs.env.properties.get('calPushed')!.startsWith('#')).toBe(true);
    gs.resetCounters();
    const res = call(events);
    expect(res.stats).toEqual({ created: 0, updated: 0, deleted: 0 });
    // учёт прочитан целиком: удаление одного события распознаётся
    const cal = gs.calendar();
    cal.userDelete(cal.byEntry('entry-with-a-long-identifier-299')!.id);
    expect(call(events).removedByUser).toEqual(['entry-with-a-long-identifier-299']);
    // учёт уменьшился — лишние куски удалены
    call(events.slice(0, 5));
    expect([...gs.env.properties.keys()].filter((k) => k.startsWith('calPushed.'))).toEqual([]);
  });
});
