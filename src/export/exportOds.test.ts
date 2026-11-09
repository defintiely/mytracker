import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';
import type { Entry, TrackerDoc } from '../model/types';
import { emptyDoc, newEntry } from '../model/entry';
import { exportOds, ODS_MIMETYPE } from './exportOds';

const NS_TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const NS_TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const NS_OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const NS_STYLE = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
const NS_FO = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0';

export function sampleDoc(): TrackerDoc {
  const doc = emptyDoc();
  const colors: Record<string, string> = { main: '#00ff00', joint: '#0000ff', personal: '#ffff00' };
  doc.settings.taskTypes = doc.settings.taskTypes.map((t) => ({ ...t, color: colors[t.id] }));
  doc.sources = [
    { id: 's1', name: 'Петя', aliases: ['петя'], createdAt: '', updatedAt: '' },
  ];
  doc.contacts = [
    {
      id: 'c1',
      name: 'Анна',
      phones: ['+44 99000001'],
      channels: [{ kind: 'telegram', value: '@anna' }],
      createdAt: '',
      updatedAt: '',
    },
  ];
  const e = (p: Partial<Entry>) => newEntry(p);
  doc.entries = [
    // Июнь 2026
    e({
      title: 'Кафе Ромашка <день рождения> & "торт"',
      date: '2026-06-12',
      timeStart: '15:00',
      location: 'Кафе Ромашка',
      category: 'день рождения',
      amount: 300,
      money: [{ amount: 300, where: 'owner', method: 'cash' }],
      contactId: 'c1',
      status: 'done',
      notes: 'строка 1\nстрока 2',
      invoiceNo: '28',
    }),
    e({
      type: 'joint',
      title: 'Свадьба на море',
      date: '2026-06-05',
      dateEnd: '2026-06-06',
      amount: 400,
      money: [
        { amount: 200, where: 'intermediary', holderId: 's1', method: 'revolut' },
        { amount: 200, where: 'client' },
      ],
      sourceId: 's1',
    }),
    e({
      type: 'personal',
      kind: 'event',
      title: 'зубной',
      date: '2026-06-20',
      timeStart: '17:30',
      dateTentative: true,
    }),
    e({ title: 'удалённая', date: '2026-06-01', amount: 999, deleted: true }),
    // Июль 2026 — частичная оплата
    e({
      title: 'Альфа',
      date: '2026-07-03',
      amount: 500,
      money: [
        { amount: 250, where: 'owner', method: 'bank' },
        { amount: 250, where: 'client' },
      ],
    }),
    // Без даты
    e({ kind: 'work', title: 'ретушь', amount: 700, money: [{ amount: 700, where: 'client' }] }),
  ];
  return doc;
}

function unpack(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  const content = new DOMParser().parseFromString(strFromU8(files['content.xml']), 'text/xml');
  return { files, content };
}

function tables(content: Document) {
  return Array.from(content.getElementsByTagNameNS(NS_TABLE, 'table'));
}

function rowsOf(table: Element) {
  return Array.from(table.getElementsByTagNameNS(NS_TABLE, 'table-row'));
}

function cellsOf(row: Element) {
  return Array.from(row.getElementsByTagNameNS(NS_TABLE, 'table-cell'));
}

function cellText(cell: Element) {
  return Array.from(cell.getElementsByTagNameNS(NS_TEXT, 'p'))
    .map((p) => p.textContent)
    .join('\n');
}

/** Ячейка по индексу колонки с учётом number-columns-repeated. */
function cellAt(row: Element, col: number): Element | undefined {
  let i = 0;
  for (const c of cellsOf(row)) {
    const rep = Number(c.getAttributeNS(NS_TABLE, 'number-columns-repeated') || 1);
    if (col < i + rep) return c;
    i += rep;
  }
  return undefined;
}

describe('exportOds', () => {
  const doc = sampleDoc();
  const bytes = exportOds(doc);
  const { files, content } = unpack(bytes);

  it('mimetype — первый файл и без сжатия', () => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint16(8, true)).toBe(0); // method = stored
    const nameLen = dv.getUint16(26, true);
    const extraLen = dv.getUint16(28, true);
    expect(strFromU8(bytes.subarray(30, 30 + nameLen))).toBe('mimetype');
    expect(extraLen).toBe(0);
    const data = bytes.subarray(30 + nameLen, 30 + nameLen + ODS_MIMETYPE.length);
    expect(strFromU8(data)).toBe(ODS_MIMETYPE);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['mimetype', 'META-INF/manifest.xml', 'content.xml', 'styles.xml', 'meta.xml']),
    );
  });

  it('все XML-файлы разбираются', () => {
    for (const name of ['META-INF/manifest.xml', 'styles.xml', 'meta.xml']) {
      const errors: string[] = [];
      new DOMParser({ onError: (_l, m) => errors.push(m) }).parseFromString(strFromU8(files[name]), 'text/xml');
      expect(errors, name).toEqual([]);
    }
  });

  it('листы: «Итоги» первым, месяцы по порядку, «Без даты» последним', () => {
    expect(tables(content).map((t) => t.getAttributeNS(NS_TABLE, 'name'))).toEqual([
      'Итоги',
      'Июнь 2026',
      'Июль 2026',
      'Без даты',
    ]);
  });

  it('лист месяца: шапка, записи по дате, удалённые не выгружены, итоги с формулами', () => {
    const june = tables(content)[1];
    const rows = rowsOf(june);
    // шапка + 3 записи + 5 итоговых строк
    expect(rows).toHaveLength(1 + 3 + 5);
    expect(cellText(cellAt(rows[0], 0)!)).toBe('Дата');
    expect(cellText(cellAt(rows[0], 5)!)).toBe('Сумма');
    expect(cellAt(rows[0], 0)!.getAttributeNS(NS_TABLE, 'style-name')).toBe('ce_head');

    expect(rows.slice(1, 4).map((r) => cellText(cellAt(r, 2)!))).toEqual([
      'Свадьба на море',
      'Кафе Ромашка <день рождения> & "торт"',
      'зубной',
    ]);
    expect(cellText(cellAt(rows[1], 0)!)).toBe('05.06–06.06');
    expect(cellText(cellAt(rows[3], 0)!)).toBe('20.06?');
    expect(cellText(cellAt(rows[1], 6)!)).toBe('у посредника: Петя 200; у клиента 200');
    expect(cellText(cellAt(rows[1], 10)!)).toBe('Петя');
    expect(cellText(cellAt(rows[2], 6)!)).toBe('получено');
    expect(cellText(cellAt(rows[2], 7)!)).toBe('нал');
    expect(cellText(cellAt(rows[2], 9)!)).toBe('Анна\n+44 99000001\ntelegram: @anna');
    expect(cellText(cellAt(rows[2], 11)!)).toBe('Закрыто');
    // перенос строки — несколько text:p
    expect(cellAt(rows[2], 12)!.getElementsByTagNameNS(NS_TEXT, 'p')).toHaveLength(2);

    const amount = cellAt(rows[2], 5)!;
    expect(amount.getAttributeNS(NS_OFFICE, 'value-type')).toBe('currency');
    expect(amount.getAttributeNS(NS_OFFICE, 'currency')).toBe('EUR');
    expect(amount.getAttributeNS(NS_OFFICE, 'value')).toBe('300');

    const sum = cellAt(rows[4], 5)!;
    expect(cellText(cellAt(rows[4], 4)!)).toBe('Итого');
    expect(sum.getAttributeNS(NS_TABLE, 'formula')).toBe('of:=SUM([.F2:.F4])');
    expect(sum.getAttributeNS(NS_OFFICE, 'value')).toBe('700');
    expect(sum.getAttributeNS(NS_OFFICE, 'value-type')).toBe('currency');
    const net = cellAt(rows[5], 5)!;
    expect(cellText(cellAt(rows[5], 4)!)).toBe('чистыми ≈');
    expect(net.getAttributeNS(NS_TABLE, 'formula')).toBe('of:=[.F5]*0.67');
    expect(rows.slice(6).map((r) => [cellText(cellAt(r, 4)!), cellAt(r, 5)!.getAttributeNS(NS_OFFICE, 'value')])).toEqual([
      ['получено', '300'],
      ['у посредников', '200'],
      ['у клиентов', '200'],
    ]);
  });

  it('фон строки — цвет типа записи', () => {
    const styles = new Map<string, string>();
    for (const s of Array.from(content.getElementsByTagNameNS(NS_STYLE, 'style'))) {
      const props = s.getElementsByTagNameNS(NS_STYLE, 'table-cell-properties')[0];
      const bg = props?.getAttributeNS(NS_FO, 'background-color');
      if (bg) styles.set(s.getAttributeNS(NS_STYLE, 'name')!, bg);
    }
    const june = tables(content)[1];
    const rows = rowsOf(june);
    const expectRow = (r: Element, color: string) => {
      for (const c of cellsOf(r)) expect(styles.get(c.getAttributeNS(NS_TABLE, 'style-name')!)).toBe(color);
      expect(cellsOf(r)).toHaveLength(13);
    };
    expectRow(rows[1], '#0000ff'); // joint
    expectRow(rows[2], '#00ff00'); // main
    expectRow(rows[3], '#ffff00'); // personal
  });

  it('частичная оплата и «Без даты»', () => {
    const [, , july, nodate] = tables(content);
    const jr = rowsOf(july);
    expect(jr).toHaveLength(1 + 1 + 5);
    expect(cellText(cellAt(jr[1], 6)!)).toBe('получено 250; у клиента 250');
    expect(cellText(cellAt(jr[1], 7)!)).toBe('счёт');
    expect(cellAt(jr[2], 5)!.getAttributeNS(NS_TABLE, 'formula')).toBe('of:=SUM([.F2:.F2])');
    const nr = rowsOf(nodate);
    expect(cellText(cellAt(nr[1], 0)!)).toBe('');
    expect(cellText(cellAt(nr[1], 6)!)).toBe('у клиента');
  });

  it('сводный лист — значения из monthTotals', () => {
    const rows = rowsOf(tables(content)[0]);
    expect(rows).toHaveLength(1 + 3 + 1);
    const vals = (r: Element) =>
      Array.from({ length: 9 }, (_, i) => {
        const c = cellAt(r, i)!;
        return i === 0 ? cellText(c) : Number(c.getAttributeNS(NS_OFFICE, 'value'));
      });
    expect(vals(rows[1])).toEqual(['Июнь 2026', 700, 300, 400, 469, 300, 200, 200, 2]);
    expect(vals(rows[2])).toEqual(['Июль 2026', 500, 500, 0, 335, 250, 0, 250, 1]);
    expect(vals(rows[3])).toEqual(['Без даты', 700, 700, 0, 469, 0, 0, 700, 0]);
    expect(cellAt(rows[1], 1)!.getAttributeNS(NS_OFFICE, 'value-type')).toBe('currency');
    expect(cellAt(rows[4], 1)!.getAttributeNS(NS_TABLE, 'formula')).toBe('of:=SUM([.B2:.B4])');
  });

  it('период и фильтр', () => {
    const { content: c1 } = unpack(exportOds(doc, { from: '2026-07', to: '2026-07' }));
    expect(tables(c1).map((t) => t.getAttributeNS(NS_TABLE, 'name'))).toEqual(['Итоги', 'Июль 2026']);
    const { content: c2 } = unpack(exportOds(doc, { filter: (e) => e.type === 'joint' }));
    const names = tables(c2).map((t) => t.getAttributeNS(NS_TABLE, 'name'));
    expect(names).toEqual(['Итоги', 'Июнь 2026']);
    expect(rowsOf(tables(c2)[1])).toHaveLength(1 + 1 + 5);
  });

  it('свой тип: фон строки — его цвет, колонка в «Итогах»; без денег — не в обороте; неизвестный id — серый', () => {
    const d = sampleDoc();
    d.settings.taskTypes = [
      ...d.settings.taskTypes,
      { id: 'edu', name: 'Обучение', color: '#AB47BC', money: true },
      { id: 'fam', name: 'Семья', color: '#123456', money: false },
    ];
    d.entries = [
      newEntry({ type: 'edu', title: 'Курс', date: '2026-08-02', amount: 150, money: [] }),
      newEntry({ type: 'fam', title: 'Школа', date: '2026-08-03', amount: 40, money: [] }),
      newEntry({ type: 'нет-такого', title: 'Странная', date: '2026-08-04', amount: 10, money: [] }),
    ];
    const { content: c } = unpack(exportOds(d));
    const styles = new Map<string, string>();
    for (const s of Array.from(c.getElementsByTagNameNS(NS_STYLE, 'style'))) {
      const bg = s.getElementsByTagNameNS(NS_STYLE, 'table-cell-properties')[0]?.getAttributeNS(NS_FO, 'background-color');
      if (bg) styles.set(s.getAttributeNS(NS_STYLE, 'name')!, bg);
    }
    const [summary, aug] = tables(c);
    const rows = rowsOf(aug);
    const bgOf = (r: Element) => styles.get(cellAt(r, 0)!.getAttributeNS(NS_TABLE, 'style-name')!);
    expect(bgOf(rows[1])).toBe('#ab47bc');
    expect(bgOf(rows[2])).toBe('#123456');
    expect(bgOf(rows[3])).toBe('#cfd8dc');
    // Сумма типа без денег не идёт в формулу итога: Итого = 150 + 10.
    expect(cellAt(rows[4], 5)!.getAttributeNS(NS_OFFICE, 'value')).toBe('160');
    expect(cellAt(rows[2], 5)!.getAttributeNS(NS_OFFICE, 'value-type')).not.toBe('currency');

    const srows = rowsOf(summary);
    const head = Array.from({ length: 10 }, (_, i) => cellText(cellAt(srows[0], i)!));
    expect(head).toEqual([
      'Месяц',
      'Оборот',
      'Основная работа',
      'Совместная работа',
      'Обучение',
      'нет-такого',
      'Чистыми ≈',
      'Получено',
      'У посредников',
      'У клиентов',
    ]);
    const val = (i: number) => Number(cellAt(srows[1], i)!.getAttributeNS(NS_OFFICE, 'value'));
    expect([1, 2, 3, 4, 5].map(val)).toEqual([160, 0, 0, 150, 10]);
    // Итоговая строка: формула по колонке своего типа и по «Съёмкам» (K).
    expect(cellAt(srows[2], 4)!.getAttributeNS(NS_TABLE, 'formula')).toBe('of:=SUM([.E2:.E2])');
    expect(cellAt(srows[2], 10)!.getAttributeNS(NS_TABLE, 'formula')).toBe('of:=SUM([.K2:.K2])');
  });

  it('пустой документ — только «Итоги»', () => {
    const { content: c } = unpack(exportOds(emptyDoc()));
    expect(tables(c)).toHaveLength(1);
  });
});
