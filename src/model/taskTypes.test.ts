import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { emptyDoc, monthTotals, newEntry, payState, turnoverByType } from './entry';
import {
  defaultNoMoneyTypeId,
  defaultTypeId,
  normalizeTaskTypes,
  taskTypes,
  typeColor,
  typeDef,
  typeHasMoney,
  typeName,
  UNKNOWN_TYPE_COLOR,
} from './taskTypes';
import type { Settings, TrackerDoc } from './types';
import { DEFAULT_SETTINGS } from './types';
import { migrate } from '../store/store';
import { normalizeDoc } from '../sync/syncEngine';
import { parseBackup } from '../export/backup';

/** Документ старой версии: typeColors вместо taskTypes. */
function legacyDoc(): TrackerDoc {
  const d = emptyDoc() as unknown as { settings: Record<string, unknown> };
  delete d.settings.taskTypes;
  d.settings.typeColors = { main: '#111111', joint: '#222222', personal: '#333333' };
  return d as unknown as TrackerDoc;
}

function withTypes(extra: Settings['taskTypes']): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), taskTypes: [...DEFAULT_SETTINGS.taskTypes, ...extra] };
}

/** Документ прошлой версии: типы с флагом builtin, записи с видом 'shoot' и полями media/withEditing. */
function builtinDoc(): TrackerDoc {
  const d = emptyDoc() as unknown as { settings: Record<string, unknown>; entries: unknown[] };
  d.settings.taskTypes = [
    { id: 'main', name: 'Работа', color: '#111111', money: true, builtin: true },
    { id: 'joint', name: 'С коллегой', color: '#222222', money: true, builtin: true },
    { id: 'personal', name: 'Личное', color: '#333333', money: false, builtin: true },
    { id: 'edu', name: 'Обучение', color: '#444444', money: true },
  ];
  d.settings.calendar = { ...(d.settings.calendar as object), calendarName: 'Мой календарь' };
  d.entries = [
    {
      ...newEntry({ title: 'Встреча с клиентом', date: '2026-06-01' }),
      kind: 'shoot',
      media: ['photo'],
      withEditing: false,
      fieldUpdatedAt: { title: '2026-06-01T00:00:00.000Z', media: '2026-06-01T00:00:00.000Z' },
    },
  ];
  return d as unknown as TrackerDoc;
}

describe('типы задач: миграция старых документов', () => {
  const expectMigrated = (s: Settings) => {
    expect(s.taskTypes).toEqual([
      { id: 'main', name: 'Основная работа', color: '#111111', money: true },
      { id: 'joint', name: 'Совместная работа', color: '#222222', money: true },
      { id: 'personal', name: 'Личное', color: '#333333', money: false },
    ]);
  };

  const expectBuiltinMigrated = (doc: TrackerDoc) => {
    expect(doc.settings.taskTypes).toEqual([
      { id: 'main', name: 'Работа', color: '#111111', money: true },
      { id: 'joint', name: 'С коллегой', color: '#222222', money: true },
      { id: 'personal', name: 'Личное', color: '#333333', money: false },
      { id: 'edu', name: 'Обучение', color: '#444444', money: true },
    ]);
    expect(doc.settings.calendar.calendarName).toBe('Мой календарь');
    const e = doc.entries[0] as unknown as Record<string, unknown>;
    expect(e.kind).toBe('job');
    expect('media' in e).toBe(false);
    expect('withEditing' in e).toBe(false);
    expect(e.fieldUpdatedAt).toEqual({ title: '2026-06-01T00:00:00.000Z' });
  };

  it('старые встроенные типы → обычные; вид shoot → job; media/withEditing стёрты (migrate, normalizeDoc, parseBackup)', () => {
    expectBuiltinMigrated(migrate(builtinDoc()));
    expectBuiltinMigrated(normalizeDoc(builtinDoc()));
    expectBuiltinMigrated(parseBackup(JSON.stringify(builtinDoc())));
  });

  it('миграция записей и типов идемпотентна', () => {
    const once = migrate(builtinDoc());
    expect(migrate(JSON.parse(JSON.stringify(once)))).toEqual(once);
    const synced = normalizeDoc(builtinDoc());
    expect(normalizeDoc(JSON.parse(JSON.stringify(synced)))).toEqual(synced);
  });

  it('новый документ: календарь «Трекер», три обычных типа', () => {
    const d = emptyDoc();
    expect(d.settings.calendar.calendarName).toBe('Трекер');
    expect(d.settings.taskTypes.map((t) => [t.id, t.money])).toEqual([
      ['main', true],
      ['joint', true],
      ['personal', false],
    ]);
    expect(d.settings.taskTypes.some((t) => 'builtin' in t)).toBe(false);
  });

  it('store migrate: typeColors → taskTypes', () => {
    expectMigrated(migrate(legacyDoc()).settings);
  });

  it('normalizeDoc (синхронизация): typeColors → taskTypes', () => {
    expectMigrated(normalizeDoc(legacyDoc()).settings);
  });

  it('parseBackup: typeColors → taskTypes', () => {
    expectMigrated(parseBackup(JSON.stringify(legacyDoc())).settings);
  });

  it('без typeColors и taskTypes — три типа по умолчанию', () => {
    expect(normalizeTaskTypes({})).toEqual(DEFAULT_SETTINGS.taskTypes);
  });

  it('типы по умолчанию не дополняются: удалённый остаётся удалённым, money и имя — как сохранены', () => {
    const list = normalizeTaskTypes({
      taskTypes: [
        { id: 'personal', name: 'Своё', color: '#abcdef', money: true, deleted: true },
        { id: 'main', name: 'Клиенты', color: '#000001', money: false },
        { id: 'x', name: 'Обучение', color: '#000000', money: false },
        { id: 'x', name: 'дубль' },
        { name: 'без id' },
      ],
    });
    expect(list).toEqual([
      { id: 'personal', name: 'Своё', color: '#abcdef', money: true, deleted: true },
      { id: 'main', name: 'Клиенты', color: '#000001', money: false },
      { id: 'x', name: 'Обучение', color: '#000000', money: false },
    ]);
  });

  it('живых типов не осталось — типы по умолчанию возвращаются', () => {
    const list = normalizeTaskTypes({ taskTypes: [{ id: 'main', name: 'Работа', color: '#111111', money: true, deleted: true }] });
    expect(list.filter((t) => !t.deleted).map((t) => t.id)).toEqual(['joint', 'personal', 'main']);
    expect(list.find((t) => t.id === 'main')).toEqual({ id: 'main', name: 'Работа', color: '#111111', money: true });
  });

  it('тип по умолчанию и тип для дел без денег: из настроек, а если удалён — первый подходящий живой', () => {
    const s: Settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      taskTypes: [
        { id: 'main', name: 'Работа', color: '#1', money: true, deleted: true },
        { id: 'edu', name: 'Обучение', color: '#2', money: false },
        { id: 'a', name: 'Клиенты', color: '#3', money: true },
        { id: 'b', name: 'Семья', color: '#4', money: false },
      ],
    };
    expect(defaultTypeId(s)).toBe('a');
    expect(defaultNoMoneyTypeId(s)).toBe('edu');
    expect(defaultTypeId({ ...s, defaultTypeId: 'b' })).toBe('b');
    expect(defaultTypeId({ ...s, defaultTypeId: 'main' })).toBe('a'); // удалён
    expect(defaultNoMoneyTypeId({ ...s, defaultNoMoneyTypeId: 'b' })).toBe('b');
    const onlyMoney: Settings = { ...s, taskTypes: [{ id: 'a', name: 'Клиенты', color: '#3', money: true }] };
    expect(defaultNoMoneyTypeId(onlyMoney)).toBe('a');
    const noMoneyOnly: Settings = { ...s, taskTypes: [{ id: 'b', name: 'Семья', color: '#4', money: false }] };
    expect(defaultTypeId(noMoneyOnly)).toBe('b');
  });

  it('флаг money решает всё, id роли не играет', () => {
    const s: Settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      taskTypes: [
        { id: 'main', name: 'Работа', color: '#1', money: false },
        { id: 'personal', name: 'Личное', color: '#2', money: true },
      ],
    };
    expect(typeHasMoney(s, 'main')).toBe(false);
    expect(typeHasMoney(s, 'personal')).toBe(true);
    expect(newEntry({}, s)).toMatchObject({ type: 'personal', kind: 'job' });
    expect(payState({ type: 'main', amount: 100, money: [] }, s)).toBe('none');
  });

  it('нормализация идемпотентна (повторная синхронизация не меняет документ)', () => {
    const once = normalizeDoc(legacyDoc());
    expect(normalizeDoc(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

describe('типы задач: помощники', () => {
  const s = withTypes([
    { id: 'edu', name: 'Обучение', color: '#ab47bc', money: true },
    { id: 'fam', name: 'Семья', color: '#123456', money: false },
    { id: 'old', name: 'Старый', color: '#654321', money: true, deleted: true },
  ]);

  it('taskTypes — без удалённых', () => {
    expect(taskTypes(s).map((t) => t.id)).toEqual(['main', 'joint', 'personal', 'edu', 'fam']);
  });

  it('typeDef: удалённый отдаёт своё имя и цвет, неизвестный — серый «с деньгами» с именем id', () => {
    expect(typeName(s, 'old')).toBe('Старый');
    expect(typeDef(s, 'нет')).toEqual({ id: 'нет', name: 'нет', color: UNKNOWN_TYPE_COLOR, money: true });
    expect(typeColor(s, 'edu')).toBe('#ab47bc');
    expect(typeHasMoney(s, 'fam')).toBe(false);
    expect(typeHasMoney(s, 'personal')).toBe(false);
    expect(typeHasMoney(s, 'нет')).toBe(true);
  });

  it('свой тип с деньгами входит в оборот и byType, без денег — нет', () => {
    const entries = [
      newEntry({ type: 'main', date: '2026-10-02', amount: 100, money: [] }),
      newEntry({ type: 'edu', date: '2026-10-03', amount: 250, money: [{ amount: 50, where: 'owner' }] }),
      newEntry({ type: 'fam', date: '2026-10-04', amount: 40, money: [] }),
      newEntry({ type: 'нет', date: '2026-10-05', amount: 5, money: [] }),
    ];
    const t = monthTotals(entries, '2026-10', s);
    expect(t.turnover).toBe(355);
    expect(t.byType).toEqual({ main: 100, edu: 250, нет: 5 });
    expect(t.received).toBe(50);
    expect(t.atClient).toBe(305);
    expect(t.jobs).toBe(3);
    expect(turnoverByType(s, t.byType).map((x) => [x.name, x.amount])).toEqual([
      ['Основная работа', 100],
      ['Обучение', 250],
      ['нет', 5],
    ]);
    expect(turnoverByType(s, t.byType, { allTypes: true }).map((x) => x.name)).toEqual([
      'Основная работа',
      'Совместная работа',
      'Обучение',
      'нет',
    ]);
    expect(payState(entries[2], s)).toBe('none');
    expect(payState(entries[1], s)).toBe('partial');
  });
});
