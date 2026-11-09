import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { importOds, originKey, parseSheetName, resolveSheetMonths } from './importOds';
import { readOds } from './readOds';
import { bgStyle, buildOds, type TestCell, type TestRow } from './buildOdsForTest';

const cur = (v: number, extra: Partial<TestCell> = {}): TestCell => ({ type: 'currency', value: v, text: `€${v}.00`, ...extra });
const row = (...cells: (string | TestCell)[]): TestRow => ({
  cells: cells.map((c) => (typeof c === 'string' ? (c ? { text: c } : {}) : c)),
});
const totals = (sum: number, sumRow: number): TestRow[] => [
  row('', '', '', cur(sum, { formula: 'of:=SUM([.D1:.D31])' })),
  row('', '', '', cur(Math.round(sum * 67) / 100, { formula: `of:=[.D${sumRow}]*0.67` })),
];

function sample(): Uint8Array {
  return buildOds(
    [
      {
        name: 'ноябрь',
        rows: [
          row({ text: '1.11 Студия', style: 'Y' }, '9.00 утра', 'день рождения', cur(150), 'Анна 99000001', '', '', 'оплачено', { type: 'float', value: 1, text: '1' }, 'инв'),
          row({ text: 'ретушь', style: 'C' }, '', '', cur(200)),
          row('5.11 видео с петей', '', '', cur(100), '', '', '', '', 'у Пети'),
          row({ text: '7.11 ветеринар', style: 'G' }, '12.00'),
          ...totals(450, 5),
          row('интервью по одному'),
        ],
      },
      { name: 'Sheet3', rows: [] },
      {
        name: 'Декабрь',
        rows: [row('3.12 др', '', '', cur(100), 'Аня +4499000001'), ...totals(999, 2)],
      },
      {
        name: 'январь  2023',
        rows: [row('21.01 Bistro', '', '16.00 - 19.00', cur(200), '', 'смс'), ...totals(200, 2)],
      },
      {
        name: 'февраль 2023',
        rows: [row('21.01 Bistro', '', '16.00 - 19.00', cur(200), '', 'смс'), ...totals(200, 2)],
      },
    ],
    { autoStyles: bgStyle('Y', '#ffff00') + bgStyle('C', '#00ffff') + bgStyle('G', '#00ff00') },
  );
}

describe('названия листов', () => {
  test('parseSheetName', () => {
    expect(parseSheetName('Июнь  2024')).toEqual({ month: 6, year: 2024 });
    expect(parseSheetName('июнь')).toEqual({ month: 6 });
    expect(parseSheetName('Sheet3')).toBeUndefined();
  });

  test('листы без года — по порядку назад от первого листа с годом', () => {
    const names = ['июнь', 'Sheet3', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь', 'январь', 'февраль 2023', 'март 2023'];
    expect(resolveSheetMonths(names, 2026)).toEqual([
      '2022-06', undefined, '2022-07', '2022-08', '2022-09', '2022-10', '2022-11', '2022-12', '2023-01', '2023-02', '2023-03',
    ]);
  });
});

describe('importOds на синтетическом файле', () => {
  const data = sample();
  const res = importOds(data, { today: '2026-11-09' });
  const bySheet = (s: string) => res.rows.filter((r) => r.entry.origin!.sheet === s);

  test('строки ноября: съёмка, ретушь, посредник, личное, заметка под итогом', () => {
    const nov = bySheet('ноябрь').map((r) => r.entry);
    expect(nov.map((e) => e.kind)).toEqual(['shoot', 'work', 'shoot', 'event', 'note']);
    const [shoot, retouch, joint, vet, note] = nov;
    expect(shoot).toMatchObject({
      date: '2022-11-01',
      timeStart: '09:00',
      amount: 150,
      money: [{ amount: 150, where: 'owner' }],
      invoiceNo: '1',
      category: 'день рождения',
      status: 'done',
      type: 'main',
      origin: { sheet: 'ноябрь', row: 1 },
    });
    expect(retouch).toMatchObject({ accountingMonth: '2022-11', amount: 200, category: 'ретушь' });
    expect(joint.type).toBe('joint');
    expect(joint.money[0]).toMatchObject({ where: 'intermediary', amount: 100 });
    expect(joint.money[0].holderId).toBe(joint.sourceId);
    expect(vet).toMatchObject({ type: 'personal', timeStart: '12:00', money: [] });
    expect(note).toMatchObject({ title: 'интервью по одному', accountingMonth: '2022-11' });
  });

  test('сверка с SUM: ноябрь сошёлся, декабрь — нет', () => {
    const nov = res.monthChecks.find((m) => m.sheet === 'ноябрь')!;
    expect(nov).toEqual({ sheet: 'ноябрь', month: '2022-11', sheetSum: 450, importedSum: 450, ok: true });
    const dec = res.monthChecks.find((m) => m.sheet === 'Декабрь')!;
    expect(dec).toMatchObject({ month: '2022-12', sheetSum: 999, importedSum: 100, ok: false });
  });

  test('лист-заготовка пропущен, Sheet3 пустой', () => {
    expect(bySheet('февраль 2023')).toEqual([]);
    expect(res.skipped.find((s) => s.sheet === 'февраль 2023')?.reason).toMatch(/заготовка/);
    expect(res.monthChecks.map((m) => m.month)).toEqual(['2022-11', '2022-12', '2023-01']);
    const withTemplates = importOds(data, { today: '2026-11-09', includeTemplateSheets: true });
    expect(withTemplates.rows.filter((r) => r.entry.origin!.sheet === 'февраль 2023')).toHaveLength(1);
  });

  test('контакты сливаются по телефону, источник создан один раз', () => {
    expect(res.contacts).toHaveLength(1);
    // тот же номер с кодом страны заменяет короткую запись
    expect(res.contacts[0]).toMatchObject({ name: 'Анна', phones: ['+4499000001'] });
    expect(res.sources.map((s) => s.name)).toEqual(['Петя']);
    expect(res.sources[0].aliases).toEqual(expect.arrayContaining(['петя', 'пети', 'петей']));
  });

  test('цвета: статистика и предложенный тип', () => {
    const map = Object.fromEntries(res.colors.map((c) => [c.color, c]));
    expect(map['#ffff00']).toMatchObject({ count: 1, suggested: 'main' });
    expect(map['#00ff00']).toMatchObject({ count: 1, suggested: 'personal' });
    expect(map['#00ffff'].samples[0]).toContain('ретушь');
  });

  test('colorMap задаёт тип', () => {
    const r = importOds(data, { today: '2026-11-09', colorMap: { '#ffff00': 'joint', '#00ff00': 'personal' } });
    expect(r.rows[0].entry.type).toBe('joint');
  });

  test('повторный импорт не дублирует', () => {
    const keys = new Set(res.rows.map((r) => originKey(r.entry.origin!)));
    const again = importOds(data, { today: '2026-11-09', existingOriginKeys: keys, existingContacts: res.contacts, existingSources: res.sources });
    expect(again.rows).toHaveLength(0);
    expect(again.contacts).toHaveLength(0);
    expect(again.sources).toHaveLength(0);
    // сверка считается и для уже импортированного
    expect(again.monthChecks.find((m) => m.sheet === 'ноябрь')!.ok).toBe(true);
  });
});

// ───────── интеграция на реальном файле (персональные данные — только инварианты, без снимков) ─────────

// Путь к своему трекеру — в переменной окружения TRACKER_ODS (файл с личными данными в репозиторий не кладётся).
const REAL = process.env.TRACKER_ODS ?? '';
const hasReal = !!REAL && existsSync(REAL);

describe.skipIf(!hasReal)('реальный файл', () => {
  const data = hasReal ? new Uint8Array(readFileSync(REAL)) : new Uint8Array();
  const res = hasReal ? importOds(data, { today: '2026-11-09' }) : undefined!;

  test('все листы разобраны: у каждого сверка, пропуск или он пуст', () => {
    const wb = readOds(data);
    const checked = new Set(res.monthChecks.map((m) => m.sheet));
    const skipped = new Set(res.skipped.map((s) => s.sheet));
    for (const s of wb.sheets) {
      if (s.rows.length === 0) continue;
      expect(checked.has(s.name) || skipped.has(s.name), `лист «${s.name}»`).toBe(true);
    }
  });

  test('сверка с SUM листа сходится', () => {
    const bad = res.monthChecks.filter((m) => !m.ok);
    if (bad.length) console.log('Несовпадения MonthCheck:', bad);
    expect(res.monthChecks.length).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  test('деньги согласованы, у каждой записи origin', () => {
    for (const { entry: e } of res.rows) {
      expect(e.origin?.raw).toBeTruthy();
      if (e.amount !== undefined && e.amount !== 0 && e.type !== 'personal') {
        const sum = e.money.reduce((s, m) => s + m.amount, 0);
        expect(Math.abs(sum - e.amount), e.origin!.raw).toBeLessThan(0.005);
      }
      if (e.money.some((m) => m.where === 'intermediary')) {
        expect(e.money.find((m) => m.where === 'intermediary')!.holderId).toBeTruthy();
      }
    }
    console.log(
      `Импорт: записей ${res.rows.length}, контактов ${res.contacts.length}, источников ${res.sources.length}, ` +
        `пропущено ${res.skipped.length}, low ${res.rows.filter((r) => r.confidence === 'low').length}, ` +
        `цвета ${res.colors.map((c) => `${c.color}×${c.count}→${c.suggested}`).join(', ')}`,
    );
  });

  test('повторный импорт с existingOriginKeys даёт 0 записей', () => {
    const keys = new Set(res.rows.map((r) => originKey(r.entry.origin!)));
    const again = importOds(data, { today: '2026-11-09', existingOriginKeys: keys, existingSources: res.sources, existingContacts: res.contacts });
    expect(again.rows).toHaveLength(0);
    expect(again.sources).toHaveLength(0);
    expect(again.contacts).toHaveLength(0);
  });
});
