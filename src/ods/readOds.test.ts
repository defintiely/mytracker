import { describe, expect, test } from 'vitest';
import { readOds, normalizeColor } from './readOds';
import { bgStyle, buildOds, plainStyle } from './buildOdsForTest';

describe('readOds', () => {
  const data = buildOds(
    [
      {
        name: 'Лист  1',
        columns: [
          [undefined, 1],
          ['colGreen', 1],
          [undefined, 16382],
        ],
        rows: [
          {
            cells: [
              { text: '1.06 Студия', style: 'ceYellow' },
              { text: 'без стиля — зелёная колонка' },
              { text: 'x', style: 'ceWhite' },
              { type: 'currency', value: 150, text: '€150.00', style: 'ceInherit' },
            ],
          },
          { cells: [{ repeat: 1024 }], repeat: 3 }, // пустые строки
          {
            cells: [
              { text: ['первый абзац', 'второй абзац'] },
              {
                xml: '<text:p>a<text:s text:c="3"/>b <text:span>span</text:span> <text:a xlink:href="https://x.test">ссылка</text:a></text:p><office:annotation><text:p>комментарий</text:p></office:annotation>',
              },
              { text: 'объединено' },
              { covered: true },
              { type: 'float', value: 19.3, text: '19.3' },
              { repeat: 16000 }, // огромный пустой хвост
            ],
          },
          { cells: [{ text: 'повтор' }, { repeat: 1000 }], repeat: 2 },
          {
            defaultStyle: 'ceRed',
            cells: [
              { type: 'date', date: '2026-11-09', text: '09.11.2026' },
              { type: 'currency', value: 300, text: '€300.00', formula: 'of:=SUM([.D1:.D31])', style: 'ceTransparent' },
            ],
          },
          { cells: [{ repeat: 1024 }], repeat: 1048000 },
        ],
      },
      { name: 'Пустой', rows: [{ cells: [{ repeat: 1024 }], repeat: 1048576 }] },
    ],
    {
      autoStyles:
        bgStyle('ceYellow', '#FFFF00') +
        bgStyle('ceWhite', '#ffffff') +
        bgStyle('ceTransparent', 'transparent') +
        bgStyle('ceRed', '#ff0000') +
        bgStyle('colGreen', '#00ff00') +
        plainStyle('ceInherit', 'NamedCyan'),
      styles: bgStyle('NamedCyan', '#00ffff'),
    },
  );
  const wb = readOds(data);

  test('листы и имена', () => {
    expect(wb.sheets.map((s) => s.name)).toEqual(['Лист  1', 'Пустой']);
    expect(wb.sheets[1].rows).toEqual([]);
  });

  test('индексы строк учитывают number-rows-repeated, пустые не попадают', () => {
    expect(wb.sheets[0].rows.map((r) => r.index)).toEqual([1, 5, 6, 7, 8]);
  });

  test('цвета: стиль ячейки, наследование из styles.xml, колонка по умолчанию, белый/transparent', () => {
    const [a, b, c, d] = wb.sheets[0].rows[0].cells;
    expect(a.bg).toBe('#ffff00');
    expect(b.bg).toBe('#00ff00');
    expect(c.bg).toBeUndefined();
    expect(d.bg).toBe('#00ffff');
    expect(d).toMatchObject({ valueType: 'currency', value: 150, text: '€150.00' });
  });

  test('абзацы, text:s, span, ссылка, без аннотаций, covered-ячейка держит место', () => {
    const cells = wb.sheets[0].rows[1].cells;
    expect(cells[0].text).toBe('первый абзац\nвторой абзац');
    expect(cells[1].text).toBe('a   b span ссылка');
    expect(cells[2].text).toBe('объединено');
    expect(cells[3].text).toBe('');
    expect(cells[4]).toMatchObject({ valueType: 'float', value: 19.3 });
    expect(cells.length).toBe(5); // хвост из 16000 пустых не развёрнут
  });

  test('повтор непустой строки разворачивается', () => {
    const rows = wb.sheets[0].rows;
    expect(rows[2].cells[0].text).toBe('повтор');
    expect(rows[3].cells[0].text).toBe('повтор');
    expect(rows[3].index).toBe(7);
  });

  test('дата, формула, стиль строки по умолчанию', () => {
    const [d, s] = wb.sheets[0].rows[4].cells;
    expect(d).toMatchObject({ valueType: 'date', dateValue: '2026-11-09', bg: '#ff0000' });
    expect(s).toMatchObject({ formula: 'of:=SUM([.D1:.D31])', value: 300 });
    expect(s.bg).toBeUndefined();
  });

  test('не zip — понятная ошибка', () => {
    expect(() => readOds(new Uint8Array([1, 2, 3]))).toThrow(/ods/i);
  });

  test('normalizeColor', () => {
    expect(normalizeColor('#FFF')).toBeUndefined();
    expect(normalizeColor('#0F0')).toBe('#00ff00');
    expect(normalizeColor('Transparent')).toBeUndefined();
    expect(normalizeColor('#00FFFF')).toBe('#00ffff');
  });
});
