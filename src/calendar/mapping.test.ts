import { describe, expect, it } from 'vitest';
import { emptyDoc, newEntry } from '../model/entry';
import type { Entry, TrackerDoc } from '../model/types';
import { CALENDAR_TIME_ZONE, entryToEvent, eventToEntryPatch, nearestColorId, type GCalEvent } from './mapping';

function docWith(cal: Partial<TrackerDoc['settings']['calendar']> = {}): TrackerDoc {
  const d = emptyDoc();
  d.settings.calendar = { ...d.settings.calendar, enabled: true, ...cal };
  d.contacts = [
    { id: 'c1', name: 'Ольга', phones: ['+44 99 123-456'], channels: [], createdAt: '', updatedAt: '' },
  ];
  d.sources = [{ id: 's1', name: 'Петя', aliases: [], createdAt: '', updatedAt: '' }];
  return d;
}

function shoot(p: Partial<Entry> = {}): Entry {
  return newEntry({
    id: 'e1',
    title: 'Альфа праздник осени',
    date: '2026-11-13',
    media: ['photo'],
    ...p,
  });
}

describe('entryToEvent', () => {
  it('без времени — событие на весь день, end.date — следующий день', () => {
    const ev = entryToEvent(shoot(), docWith())!;
    expect(ev.start).toEqual({ date: '2026-11-13' });
    expect(ev.end).toEqual({ date: '2026-11-14' });
    expect(ev.summary).toBe('📷 Альфа праздник осени');
  });

  it('диапазон дат без времени учитывает dateEnd', () => {
    const ev = entryToEvent(shoot({ dateEnd: '2026-09-20', date: '2026-09-19' }), docWith())!;
    expect(ev.start).toEqual({ date: '2026-09-19' });
    expect(ev.end).toEqual({ date: '2026-09-21' });
  });

  it('время с концом — dateTime в поясе устройства', () => {
    const ev = entryToEvent(shoot({ timeStart: '10:00', timeEnd: '12:30' }), docWith())!;
    expect(ev.start).toEqual({ dateTime: '2026-11-13T10:00:00', timeZone: CALENDAR_TIME_ZONE });
    expect(ev.end).toEqual({ dateTime: '2026-11-13T12:30:00', timeZone: CALENDAR_TIME_ZONE });
  });

  it('нет timeEnd — плюс час, с переходом через полночь', () => {
    expect(entryToEvent(shoot({ timeStart: '18:00' }), docWith())!.end!.dateTime).toBe('2026-11-13T19:00:00');
    expect(entryToEvent(shoot({ timeStart: '23:30' }), docWith())!.end!.dateTime).toBe('2026-11-14T00:30:00');
  });

  it('конец раньше начала без диапазона — ночное событие до следующего дня', () => {
    const ev = entryToEvent(shoot({ timeStart: '22:00', timeEnd: '02:00' }), docWith())!;
    expect(ev.end!.dateTime).toBe('2026-11-14T02:00:00');
  });

  it('значки: фото, видео, оба; предварительная — «? »', () => {
    const d = docWith();
    expect(entryToEvent(shoot({ media: ['video'] }), d)!.summary).toBe('🎥 Альфа праздник осени');
    expect(entryToEvent(shoot({ media: ['photo', 'video'] }), d)!.summary).toBe('📷🎥 Альфа праздник осени');
    expect(entryToEvent(shoot({ dateTentative: true }), d)!.summary).toBe('? 📷 Альфа праздник осени');
  });

  it('не выгружаются: удалённые, без даты, payment/work/note', () => {
    const d = docWith();
    expect(entryToEvent(shoot({ deleted: true }), d)).toBeNull();
    expect(entryToEvent(shoot({ date: undefined }), d)).toBeNull();
    expect(entryToEvent(shoot({ kind: 'payment' }), d)).toBeNull();
    expect(entryToEvent(shoot({ kind: 'work' }), d)).toBeNull();
    expect(entryToEvent(shoot({ kind: 'note' }), d)).toBeNull();
    expect(entryToEvent(shoot({ kind: 'event' }), d)).not.toBeNull();
  });

  it('личное: full — как есть без значка, busy — «Занято» без подробностей, skip — не выгружать', () => {
    const p = shoot({ type: 'personal', kind: 'event', title: 'Врач', location: 'Клиника', notes: 'анализы' });
    const full = entryToEvent(p, docWith({ personalMode: 'full' }))!;
    expect(full.summary).toBe('Врач');
    expect(full.location).toBe('Клиника');
    expect(full.description).toContain('анализы');

    const busy = entryToEvent(p, docWith({ personalMode: 'busy' }))!;
    expect(busy.summary).toBe('Занято');
    expect(busy.location).toBeUndefined();
    expect(busy.description).toBeUndefined();
    expect(JSON.stringify(busy)).not.toContain('Врач');

    expect(entryToEvent(p, docWith({ personalMode: 'skip' }))).toBeNull();
  });

  it('отменённая: onCancel delete → null, mark → «Отменено: »', () => {
    const e = shoot({ status: 'cancelled' });
    expect(entryToEvent(e, docWith({ onCancel: 'delete' }))).toBeNull();
    expect(entryToEvent(e, docWith({ onCancel: 'mark' }))!.summary).toBe('Отменено: 📷 Альфа праздник осени');
  });

  it('описание: категория, контакт с tel:, заметки; деньги не протекают при includeMoney=false', () => {
    const e = shoot({
      category: 'свадьба',
      contactId: 'c1',
      notes: 'взять вспышку',
      amount: 350,
      sourceId: 's1',
      location: 'Grand hotel',
    });
    const ev = entryToEvent(e, docWith({ includeMoney: false }))!;
    expect(ev.location).toBe('Grand hotel');
    expect(ev.description).toContain('Категория: свадьба');
    expect(ev.description).toContain('Ольга');
    expect(ev.description).toContain('href="tel:+4499123456"');
    expect(ev.description).toContain('взять вспышку');
    const all = JSON.stringify(ev);
    expect(all).not.toContain('350');
    expect(all).not.toContain('Петя');
    expect(all).not.toContain('Сумма');

    const withMoney = entryToEvent(e, docWith({ includeMoney: true }))!;
    expect(withMoney.description).toContain('Сумма: €350');
    expect(withMoney.description).toContain('Источник: Петя');
  });

  it('цвет — ближайший из палитры Google', () => {
    expect(nearestColorId('#dc2127')).toBe('11');
    expect(nearestColorId('#50b84a')).toBe('10');
    expect(nearestColorId('не цвет')).toBeUndefined();
    const d = docWith();
    d.settings.taskTypes = d.settings.taskTypes.map((t) => (t.id === 'main' ? { ...t, color: '#5484ed' } : t));
    expect(entryToEvent(shoot(), d)!.colorId).toBe('9');
  });

  it('свой тип: цвет события — цвет типа; неизвестный id не роняет выгрузку', () => {
    const d = docWith();
    d.settings.taskTypes = [...d.settings.taskTypes, { id: 'edu', name: 'Обучение', color: '#dc2127', money: true }];
    const ev = entryToEvent(shoot({ type: 'edu' }), d)!;
    expect(ev.colorId).toBe('11');
    expect(ev.summary).toBe('📷 Альфа праздник осени');
    const unknown = entryToEvent(shoot({ type: 'нет-такого' }), d)!;
    expect(unknown).not.toBeNull();
    expect(unknown.summary).toBe('📷 Альфа праздник осени');
  });

  it('свой тип без денег: режим «личного» (busy/skip), без значков и без денег в описании', () => {
    const withType = (cal: Partial<TrackerDoc['settings']['calendar']>) => {
      const d = docWith(cal);
      d.settings.taskTypes = [...d.settings.taskTypes, { id: 'fam', name: 'Семья', color: '#fbd75b', money: false }];
      return d;
    };
    const e = shoot({ type: 'fam', kind: 'event', title: 'Школа', amount: 50, location: 'Школа №1' });
    const full = entryToEvent(e, withType({ personalMode: 'full', includeMoney: true }))!;
    expect(full.summary).toBe('Школа');
    expect(full.description ?? '').not.toContain('Сумма');
    const busy = entryToEvent(e, withType({ personalMode: 'busy' }))!;
    expect(busy.summary).toBe('Занято');
    expect(busy.location).toBeUndefined();
    expect(entryToEvent(e, withType({ personalMode: 'skip' }))).toBeNull();
    // Тип с деньгами при skip выгружается.
    expect(entryToEvent(shoot(), withType({ personalMode: 'skip' }))).not.toBeNull();
  });

  it('напоминания из настроек, popup, без useDefault', () => {
    const ev = entryToEvent(shoot(), docWith({ reminderMinutes: [120, 1440] }))!;
    expect(ev.reminders).toEqual({
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 1440 },
        { method: 'popup', minutes: 120 },
      ],
    });
  });

  it('хэш стабилен и меняется вместе с выгружаемым содержимым', () => {
    const d = docWith();
    const a = entryToEvent(shoot({ timeStart: '10:00' }), d)!;
    const b = entryToEvent({ ...shoot({ timeStart: '10:00' }), updatedAt: '2030-01-01T00:00:00Z', amount: 999 }, d)!;
    expect(a.extendedProperties!.private!.entryId).toBe('e1');
    expect(a.extendedProperties!.private!.wltHash).toBe(b.extendedProperties!.private!.wltHash);
    const c = entryToEvent(shoot({ timeStart: '11:00' }), d)!;
    expect(c.extendedProperties!.private!.wltHash).not.toBe(a.extendedProperties!.private!.wltHash);
    const t = entryToEvent(shoot({ timeStart: '10:00', title: 'Другое' }), d)!;
    expect(t.extendedProperties!.private!.wltHash).not.toBe(a.extendedProperties!.private!.wltHash);
  });
});

describe('eventToEntryPatch', () => {
  const d = docWith();

  it('событие не переносили — патча нет (даже если запись правили в приложении)', () => {
    const e = shoot({ timeStart: '10:00' });
    const ev = entryToEvent(e, d)!;
    expect(eventToEntryPatch(ev, e)).toBeNull();
    // запись перенесли в приложении — календарь не должен откатить её назад
    expect(eventToEntryPatch(ev, { ...e, timeStart: '15:00' })).toBeNull();
  });

  it('то же время, но со смещением, как его отдаёт Google, — не перенос', () => {
    const e = shoot({ timeStart: '10:00', timeEnd: '11:00' });
    const ev = entryToEvent(e, d)!;
    const fromGoogle: GCalEvent = {
      ...ev,
      start: { dateTime: '2026-11-13T10:00:00+02:00', timeZone: CALENDAR_TIME_ZONE },
      end: { dateTime: '2026-11-13T11:00:00+02:00', timeZone: CALENDAR_TIME_ZONE },
    };
    expect(eventToEntryPatch(fromGoogle, e)).toBeNull();
  });

  it('перенос времени в календаре → патч времени; часовая длительность без конца не добавляет timeEnd', () => {
    const e = shoot({ timeStart: '10:00' });
    const ev = entryToEvent(e, d)!;
    const moved: GCalEvent = {
      ...ev,
      start: { dateTime: '2026-11-14T15:00:00+02:00' },
      end: { dateTime: '2026-11-14T16:00:00+02:00' },
    };
    expect(eventToEntryPatch(moved, e)).toEqual({ date: '2026-11-14', timeStart: '15:00' });
    const longer: GCalEvent = { ...moved, end: { dateTime: '2026-11-14T17:30:00+02:00' } };
    expect(eventToEntryPatch(longer, e)).toEqual({ date: '2026-11-14', timeStart: '15:00', timeEnd: '17:30' });
  });

  it('событие стало на весь день / на несколько дней', () => {
    const e = shoot({ timeStart: '10:00', timeEnd: '12:00' });
    const ev = entryToEvent(e, d)!;
    const allDay: GCalEvent = { ...ev, start: { date: '2026-11-13' }, end: { date: '2026-11-15' } };
    expect(eventToEntryPatch(allDay, e)).toEqual({
      dateEnd: '2026-11-14',
      timeStart: undefined,
      timeEnd: undefined,
      allDay: true,
    });
  });

  it('из весь-день во время', () => {
    const e = shoot();
    const ev = entryToEvent(e, d)!;
    const timed: GCalEvent = {
      ...ev,
      start: { dateTime: '2026-11-13T09:00:00', timeZone: CALENDAR_TIME_ZONE },
      end: { dateTime: '2026-11-13T11:00:00', timeZone: CALENDAR_TIME_ZONE },
    };
    expect(eventToEntryPatch(timed, e)).toEqual({ timeStart: '09:00', timeEnd: '11:00', allDay: false });
  });

  it('удалённое событие — не патч', () => {
    const e = shoot();
    expect(eventToEntryPatch({ ...entryToEvent(e, d)!, status: 'cancelled', start: { date: '2027-01-01' } }, e)).toBeNull();
  });
});
