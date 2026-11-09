// Сквозная проверка на своём файле трекера (путь — в TRACKER_ODS; в репозиторий не кладётся):
// импорт .ods → документ трекера → выгрузка .ods → обратное чтение. Суммы месяцев должны совпасть.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importOds } from './ods/importOds';
import { readOds } from './ods/readOds';
import { exportOds } from './export/exportOds';
import { emptyDoc, monthTotals, entryMonth } from './model/entry';

const FILE = process.env.TRACKER_ODS ?? '';

describe.skipIf(!FILE || !existsSync(FILE))('реальный файл: импорт → экспорт → чтение', () => {
  it('суммы месяцев сохраняются через полный круг', () => {
    const res = importOds(new Uint8Array(readFileSync(FILE)), {
      today: '2026-11-09',
      colorMap: { '#00ff00': 'personal', '#00ffff': 'main', '#ffff00': 'main', '#ff0000': 'important' },
    });
    const doc = emptyDoc();
    doc.entries = res.rows.map((r) => r.entry);
    doc.sources = res.sources;
    doc.contacts = res.contacts;

    const ods = exportOds(doc);
    const wb = readOds(ods);
    const months = [...new Set(doc.entries.map(entryMonth).filter(Boolean))] as string[];
    expect(wb.sheets.length).toBeGreaterThanOrEqual(months.length + 1); // + «Итоги»

    // У каждого листа месяца есть строка с формулой SUM; её значение = оборот месяца по monthTotals.
    let checked = 0;
    for (const m of months) {
      const t = monthTotals(doc.entries, m, doc.settings);
      const sheet = wb.sheets.find((s) => s.rows.some((r) => r.cells.some((c) => c.formula && /SUM/i.test(c.formula))) && s.name.toLowerCase().includes(m.slice(0, 4)) && sheetMonthMatches(s.name, m));
      expect(sheet, 'лист для ' + m).toBeDefined();
      const sumCell = sheet!.rows.flatMap((r) => r.cells).find((c) => c.formula && /SUM/i.test(c.formula));
      expect(sumCell!.value ?? 0).toBeCloseTo(t.turnover, 2);
      checked++;
    }
    expect(checked).toBe(months.length);
  });
});

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
function sheetMonthMatches(name: string, ym: string): boolean {
  const mm = Number(ym.slice(5, 7));
  const n = name.toLowerCase();
  if (mm === 5) return n.startsWith('май');
  if (mm === 3) return n.startsWith('март');
  return n.startsWith(MONTHS[mm - 1]);
}
