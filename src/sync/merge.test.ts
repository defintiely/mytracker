import { describe, expect, it } from 'vitest';
import type { Contact, Entry, TrackerDoc } from '../model/types';
import { DEFAULT_SETTINGS } from '../model/types';
import { deepEqual, merge, stableStringify } from './merge';

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-02T10:00:00.000Z';
const T2 = '2026-11-03T10:00:00.000Z';
const T3 = '2026-11-04T10:00:00.000Z';
const NOW = new Date('2026-11-09T12:00:00.000Z');

function entry(id: string, p: Partial<Entry> = {}): Entry {
  return {
    id,
    type: 'main',
    kind: 'shoot',
    title: 'Съёмка ' + id,
    dateTentative: false,
    allDay: true,
    media: [],
    currency: 'EUR',
    money: [],
    status: 'booked',
    checklist: [],
    createdAt: T0,
    updatedAt: T0,
    ...p,
  };
}

/** Правка как в patchEntry, но с заданным временем. */
function edit(e: Entry, at: string, patch: Partial<Entry>): Entry {
  const fua = { ...(e.fieldUpdatedAt ?? {}) };
  for (const k of Object.keys(patch) as (keyof Entry)[]) fua[k] = at;
  return { ...e, ...patch, updatedAt: at, fieldUpdatedAt: fua };
}

function doc(entries: Entry[] = [], extra: Partial<TrackerDoc> = {}): TrackerDoc {
  return {
    schemaVersion: 1,
    entries,
    contacts: [],
    sources: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    ...extra,
  };
}

function find(d: TrackerDoc, id: string): Entry | undefined {
  return d.entries.find((e) => e.id === id);
}

describe('merge: по полям', () => {
  it('два устройства правят разные поля одной записи — сохраняются оба', () => {
    const b = entry('a');
    const base = doc([b]);
    const local = doc([edit(b, T1, { title: 'Новое название' })]);
    const remote = doc([edit(b, T2, { location: 'Порт' })]);
    const { doc: out, conflicts } = merge(base, local, remote, { now: NOW });
    const e = find(out, 'a')!;
    expect(e.title).toBe('Новое название');
    expect(e.location).toBe('Порт');
    expect(e.updatedAt).toBe(T2);
    expect(e.fieldUpdatedAt).toEqual({ title: T1, location: T2 });
    expect(conflicts).toEqual([]);
  });

  it('одно поле правят обе стороны — побеждает поздняя, проигравшее значение в конфликте', () => {
    const b = entry('a', { amount: 100 });
    const base = doc([b]);
    const local = doc([edit(b, T2, { amount: 300 })]);
    const remote = doc([edit(b, T1, { amount: 250 })]);
    const { doc: out, conflicts } = merge(base, local, remote, { now: NOW });
    expect(find(out, 'a')!.amount).toBe(300);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      collection: 'entries',
      id: 'a',
      field: 'amount',
      lostValue: 250,
      keptValue: 300,
      at: NOW.toISOString(),
    });

    // и наоборот: поздняя — удалённая сторона
    const r2 = merge(base, doc([edit(b, T1, { amount: 300 })]), doc([edit(b, T3, { amount: 250 })]), { now: NOW });
    expect(find(r2.doc, 'a')!.amount).toBe(250);
    expect(r2.conflicts[0]).toMatchObject({ lostValue: 300, keptValue: 250 });
  });

  it('поле решается по fieldUpdatedAt этого поля, а не по updatedAt записи', () => {
    const b = entry('a');
    const base = doc([b]);
    // local: title в T3, потом ничего; remote: title в T1, но notes в T2 (updatedAt remote = T2 < T3)
    let l = edit(b, T3, { title: 'L' });
    let r = edit(b, T1, { title: 'R' });
    r = edit(r, T2, { notes: 'заметка' });
    const { doc: out } = merge(base, doc([l]), doc([r]), { now: NOW });
    expect(find(out, 'a')!.title).toBe('L');
    expect(find(out, 'a')!.notes).toBe('заметка');
    // fallback на updatedAt, если fieldUpdatedAt нет
    l = { ...b, title: 'L', updatedAt: T1 };
    r = { ...b, title: 'R', updatedAt: T2 };
    expect(find(merge(base, doc([l]), doc([r]), { now: NOW }).doc, 'a')!.title).toBe('R');
  });

  it('массивы money/checklist сравниваются по значению', () => {
    const b = entry('a', { money: [{ amount: 100, where: 'client' }] });
    const base = doc([b]);
    // Одинаковое значение, но другие объекты — это не изменение.
    const local = doc([{ ...b, money: [{ amount: 100, where: 'client' }] }]);
    const remote = doc([edit(b, T1, { checklist: [{ id: 'c1', text: 'отдать фото', done: false }] })]);
    const { doc: out, conflicts } = merge(base, local, remote, { now: NOW });
    expect(find(out, 'a')!.checklist).toHaveLength(1);
    expect(conflicts).toEqual([]);

    // Обе стороны меняют money → массив целиком по времени поля.
    const l2 = edit(b, T2, { money: [{ amount: 100, where: 'owner' }] });
    const r2 = edit(b, T1, { money: [{ amount: 100, where: 'intermediary', holderId: 's1' }] });
    const m = merge(base, doc([l2]), doc([r2]), { now: NOW });
    expect(find(m.doc, 'a')!.money).toEqual([{ amount: 100, where: 'owner' }]);
    expect(m.conflicts[0].field).toBe('money');
  });

  it('изменение только одной стороны — берётся эта сторона целиком', () => {
    const b = entry('a');
    const base = doc([b]);
    const changed = edit(b, T1, { title: 'X', status: 'shot' });
    expect(find(merge(base, doc([b]), doc([changed]), { now: NOW }).doc, 'a')).toEqual(changed);
    expect(find(merge(base, doc([changed]), doc([b]), { now: NOW }).doc, 'a')).toEqual(changed);
  });

  it('поле удалено одной стороной (undefined) — тоже правка', () => {
    const b = entry('a', { location: 'Центр' });
    const base = doc([b]);
    const local = doc([edit(b, T1, { location: undefined })]);
    const remote = doc([edit(b, T2, { notes: 'n' })]);
    const e = find(merge(base, local, remote, { now: NOW }).doc, 'a')!;
    expect(e.location).toBeUndefined();
    expect(e.notes).toBe('n');
  });
});

describe('merge: новые и удалённые записи', () => {
  it('новые записи с обеих сторон — обе попадают в результат', () => {
    const base = doc([entry('a')]);
    const local = doc([entry('a'), entry('l', { createdAt: T1 })]);
    const remote = doc([entry('a'), entry('r', { createdAt: T2 })]);
    const { doc: out } = merge(base, local, remote, { now: NOW });
    expect(out.entries.map((e) => e.id)).toEqual(['a', 'l', 'r']);
  });

  it('удаление против более ранней правки — удаление побеждает', () => {
    const b = entry('a');
    const base = doc([b]);
    const local = doc([edit(b, T2, { deleted: true })]);
    const remote = doc([edit(b, T1, { title: 'правка' })]);
    const { doc: out, conflicts } = merge(base, local, remote, { now: NOW });
    expect(find(out, 'a')!.deleted).toBe(true);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ field: 'deleted', keptValue: true });
  });

  it('удаление против более поздней правки — правка побеждает', () => {
    const b = entry('a');
    const base = doc([b]);
    const local = doc([edit(b, T1, { deleted: true })]);
    const remote = doc([edit(b, T2, { title: 'правка' })]);
    const { doc: out, conflicts } = merge(base, local, remote, { now: NOW });
    const e = find(out, 'a')!;
    expect(e.deleted).toBeFalsy();
    expect(e.title).toBe('правка');
    expect(conflicts[0]).toMatchObject({ field: 'deleted', lostValue: true });
  });

  it('удаление одной стороной без правок другой — tombstone', () => {
    const b = entry('a');
    const base = doc([b]);
    const del = edit(b, T1, { deleted: true });
    expect(find(merge(base, doc([b]), doc([del]), { now: NOW }).doc, 'a')!.deleted).toBe(true);
  });

  it('tombstone старше 90 дней вычищается, свежий — остаётся', () => {
    const old = edit(entry('old'), '2026-07-01T00:00:00.000Z', { deleted: true });
    const fresh = edit(entry('fresh'), '2026-10-01T00:00:00.000Z', { deleted: true });
    const alive = entry('alive', { updatedAt: '2026-01-01T00:00:00.000Z' });
    const d = doc([old, fresh, alive]);
    const { doc: out } = merge(d, d, d, { now: NOW });
    expect(out.entries.map((e) => e.id).sort()).toEqual(['alive', 'fresh']);
  });

  it('запись, уже вычищенная на другой стороне, не воскресает', () => {
    const old = edit(entry('old'), '2026-07-01T00:00:00.000Z', { deleted: true });
    const base = doc([old]);
    const { doc: out } = merge(base, doc([old]), doc([]), { now: NOW });
    expect(out.entries).toEqual([]);
  });

  it('запись пропала только с одной стороны (не tombstone) — не теряется', () => {
    const a = entry('a');
    const { doc: out } = merge(doc([a]), doc([a]), doc([]), { now: NOW });
    expect(out.entries).toEqual([a]);
  });
});

describe('merge: потерянная запись в Drive (файл перетёрт устаревшей версией)', () => {
  // B записал правку X (title) в Drive, base_B = документ с X. A, не видя X, перетёр файл своей версией.
  const orig = entry('e', { title: 'старое' });
  const withX = edit(orig, T2, { title: 'X' });

  it('local == base, remote — откат записи: остаётся правка local', () => {
    const base = doc([withX]);
    const { doc: out, conflicts } = merge(base, doc([withX]), doc([orig]), { now: NOW });
    expect(find(out, 'e')!.title).toBe('X');
    expect(conflicts).toEqual([]);
    // симметрично: откат с локальной стороны
    expect(find(merge(base, doc([orig]), doc([withX]), { now: NOW }).doc, 'e')!.title).toBe('X');
  });

  it('remote откатил одно поле, но честно поменял другое — сохраняются оба', () => {
    const base = doc([withX]);
    const remote = doc([edit(orig, T3, { location: 'Порт' })]); // A правил свою (старую) версию позже
    const e = find(merge(base, doc([withX]), remote, { now: NOW }).doc, 'e')!;
    expect(e.title).toBe('X');
    expect(e.location).toBe('Порт');
  });

  it('честная правка другого устройства, сделанная раньше по часам, не отбрасывается', () => {
    // local правил title в T3 и уже синхронизировался; remote принёс location, правленный офлайн в T1.
    const lb = edit(orig, T3, { title: 'L' });
    const base = doc([lb]);
    const remote = doc([{ ...edit(lb, T1, { location: 'Центр' }), updatedAt: T3 }]);
    expect(find(merge(base, doc([lb]), remote, { now: NOW }).doc, 'e')!.location).toBe('Центр');
  });

  it('удаление, перетёртое старой не удалённой версией, не воскресает', () => {
    const del = edit(orig, T2, { deleted: true });
    const base = doc([del]);
    expect(find(merge(base, doc([del]), doc([orig]), { now: NOW }).doc, 'e')!.deleted).toBe(true);
  });

  it('контакт без fieldUpdatedAt: откат по updatedAt не принимается', () => {
    const c: Contact = { id: 'c', name: 'Анна', phones: [], channels: [], createdAt: T0, updatedAt: T0 };
    const newer = { ...c, phones: ['99000001'], updatedAt: T2 };
    const base = doc([], { contacts: [newer] });
    const { doc: out } = merge(base, doc([], { contacts: [newer] }), doc([], { contacts: [c] }), { now: NOW });
    expect(out.contacts[0].phones).toEqual(['99000001']);
  });
});

describe('merge: первая синхронизация (base нет)', () => {
  it('объединяет записи обеих сторон', () => {
    const { doc: out, conflicts } = merge(undefined, doc([entry('l')]), doc([entry('r')]), { now: NOW });
    expect(out.entries.map((e) => e.id)).toEqual(['l', 'r']);
    expect(conflicts).toEqual([]);
  });

  it('одинаковая запись с обеих сторон, разные значения — побеждает поздняя, конфликт не пишется', () => {
    const l = entry('a', { title: 'L', updatedAt: T1 });
    const r = entry('a', { title: 'R', updatedAt: T2, notes: 'n' });
    const { doc: out, conflicts } = merge(undefined, doc([l]), doc([r]), { now: NOW });
    expect(find(out, 'a')!.title).toBe('R');
    expect(find(out, 'a')!.notes).toBe('n');
    expect(conflicts).toEqual([]);
  });

  it('пустое локальное устройство получает документ из Drive', () => {
    const remote = doc([entry('a'), entry('b')], {
      settings: { ...DEFAULT_SETTINGS, netFactor: 0.7, updatedAt: T1 },
    });
    const { doc: out } = merge(undefined, doc(), remote, { now: NOW });
    expect(deepEqual(out, remote)).toBe(true);
  });
});

describe('merge: settings и справочники', () => {
  it('settings сливаются как одна запись по полям', () => {
    const base = doc();
    const local = doc([], { settings: { ...DEFAULT_SETTINGS, netFactor: 0.6, updatedAt: T1 } });
    const remote = doc([], {
      settings: { ...DEFAULT_SETTINGS, calendar: { ...DEFAULT_SETTINGS.calendar, enabled: true }, updatedAt: T2 },
    });
    const { doc: out, conflicts } = merge(base, local, remote, { now: NOW });
    expect(out.settings.netFactor).toBe(0.6);
    expect(out.settings.calendar.enabled).toBe(true);
    expect(out.settings.updatedAt).toBe(T2);
    expect(conflicts).toEqual([]);
  });

  it('settings: одно поле с обеих сторон — по updatedAt, конфликт в журнал', () => {
    const base = doc();
    const local = doc([], { settings: { ...DEFAULT_SETTINGS, netFactor: 0.6, updatedAt: T2 } });
    const remote = doc([], { settings: { ...DEFAULT_SETTINGS, netFactor: 0.5, updatedAt: T1 } });
    const { doc: out, conflicts } = merge(base, local, remote, { now: NOW });
    expect(out.settings.netFactor).toBe(0.6);
    expect(conflicts).toEqual([
      expect.objectContaining({ collection: 'settings', id: 'settings', field: 'netFactor', lostValue: 0.5 }),
    ]);
  });

  it('контакты сливаются по id с updatedAt', () => {
    const c: Contact = { id: 'c', name: 'Анна', phones: [], channels: [], createdAt: T0, updatedAt: T0 };
    const base = doc([], { contacts: [c] });
    const local = doc([], { contacts: [{ ...c, phones: ['99000001'], updatedAt: T1 }] });
    const remote = doc([], { contacts: [{ ...c, name: 'Анна К.', updatedAt: T2 }] });
    const { doc: out } = merge(base, local, remote, { now: NOW });
    expect(out.contacts[0]).toMatchObject({ name: 'Анна К.', phones: ['99000001'], updatedAt: T2 });
  });
});

describe('merge: детерминированность', () => {
  const b = entry('a', { amount: 100 });
  const base = doc([b, entry('x')]);
  const cases: [string, TrackerDoc, TrackerDoc][] = [
    [
      'разные поля + новые записи',
      doc([edit(b, T1, { title: 'L' }), entry('x'), entry('l1', { createdAt: T1 })]),
      doc([edit(b, T2, { notes: 'R' }), entry('x'), entry('r1', { createdAt: T1 })]),
    ],
    ['одно поле, разное время', doc([edit(b, T1, { amount: 1 }), entry('x')]), doc([edit(b, T2, { amount: 2 }), entry('x')])],
    ['одно поле, РАВНОЕ время', doc([edit(b, T1, { amount: 1 }), entry('x')]), doc([edit(b, T1, { amount: 2 }), entry('x')])],
    [
      'удаление vs правка в одно время',
      doc([edit(b, T1, { deleted: true }), entry('x')]),
      doc([edit(b, T1, { title: 'R' }), entry('x')]),
    ],
    [
      'settings в одно время',
      doc([b, entry('x')], { settings: { ...DEFAULT_SETTINGS, netFactor: 0.1, updatedAt: T1 } }),
      doc([b, entry('x')], { settings: { ...DEFAULT_SETTINGS, netFactor: 0.2, updatedAt: T1 } }),
    ],
  ];
  for (const [name, a, c] of cases) {
    it(`merge(base,a,b) == merge(base,b,a): ${name}`, () => {
      const ab = merge(base, a, c, { now: NOW }).doc;
      const ba = merge(base, c, a, { now: NOW }).doc;
      expect(stableStringify(ab)).toBe(stableStringify(ba));
      // и без base
      expect(stableStringify(merge(undefined, a, c, { now: NOW }).doc)).toBe(
        stableStringify(merge(undefined, c, a, { now: NOW }).doc),
      );
    });
  }

  it('результат слияния стабилен: повторное слияние с самим собой ничего не меняет', () => {
    const [, a, c] = cases[0];
    const r = merge(base, a, c, { now: NOW }).doc;
    expect(deepEqual(merge(r, r, r, { now: NOW }).doc, r)).toBe(true);
    // устройство A после записи (base=r, local=r) и Drive=r → то же
    expect(deepEqual(merge(r, r, c, { now: NOW }).doc, merge(r, c, r, { now: NOW }).doc)).toBe(true);
  });
});

describe('stableStringify / deepEqual', () => {
  it('порядок ключей и undefined-поля не важны', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1, d: undefined })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});
