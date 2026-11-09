import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { emptyDoc, monthTotals, newEntry, payState, turnoverByType } from './entry';
import { normalizeTaskTypes, taskTypes, typeColor, typeDef, typeHasMoney, typeName, UNKNOWN_TYPE_COLOR } from './taskTypes';
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

describe('типы задач: миграция старых документов', () => {
  const expectMigrated = (s: Settings) => {
    expect(s.taskTypes.map((t) => [t.id, t.name, t.color, t.money, t.builtin])).toEqual([
      ['main', 'Основная работа', '#111111', true, true],
      ['joint', 'Совместная работа', '#222222', true, true],
      ['personal', 'Личное', '#333333', false, true],
    ]);
  };

  it('store migrate: typeColors → taskTypes', () => {
    expectMigrated(migrate(legacyDoc()).settings);
  });

  it('normalizeDoc (синхронизация): typeColors → taskTypes', () => {
    expectMigrated(normalizeDoc(legacyDoc()).settings);
  });

  it('parseBackup: typeColors → taskTypes', () => {
    expectMigrated(parseBackup(JSON.stringify(legacyDoc())).settings);
  });

  it('без typeColors и taskTypes — встроенные по умолчанию', () => {
    expect(normalizeTaskTypes({})).toEqual(DEFAULT_SETTINGS.taskTypes);
  });

  it('недостающие встроенные дополняются, их money и builtin не подделать, удалить нельзя', () => {
    const list = normalizeTaskTypes({
      taskTypes: [
        { id: 'personal', name: 'Своё', color: '#abcdef', money: true, deleted: true },
        { id: 'x', name: 'Обучение', color: '#000000', money: false },
        { id: 'x', name: 'дубль' },
        { name: 'без id' },
      ],
    });
    expect(list.map((t) => t.id)).toEqual(['main', 'joint', 'personal', 'x']);
    expect(list[2]).toEqual({ id: 'personal', name: 'Своё', color: '#abcdef', money: false, builtin: true });
    expect(list[3]).toEqual({ id: 'x', name: 'Обучение', color: '#000000', money: false });
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
    expect(t.main).toBe(100);
    expect(t.joint).toBe(0);
    expect(t.received).toBe(50);
    expect(t.atClient).toBe(305);
    expect(turnoverByType(s, t.byType).map((x) => [x.name, x.amount])).toEqual([
      ['Основная работа', 100],
      ['Совместная работа', 0],
      ['Обучение', 250],
      ['нет', 5],
    ]);
    expect(payState(entries[2], s)).toBe('none');
    expect(payState(entries[1], s)).toBe('partial');
  });
});
