// Чтение .ods (zip + content.xml) в листы и ячейки с цветами фона.
// Работает и в браузере, и в Node: fflate + @xmldom/xmldom.
import { strFromU8, unzipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import type { OdsCell, OdsRow, OdsSheet, OdsWorkbook } from './types';

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
};

/** Сколько раз максимум разворачивать повтор НЕпустой ячейки/строки (пустые просто пропускаются). */
const MAX_REPEAT_CELL = 256;
const MAX_REPEAT_ROW = 1000;

// Минимальный структурный тип узла — общий для xmldom и браузерного DOM.
interface XNode {
  nodeType: number;
  localName: string | null;
  namespaceURI: string | null;
  nodeValue: string | null;
  childNodes: { length: number; [i: number]: XNode };
  getAttributeNS?(ns: string, name: string): string | null;
}

function isEl(n: XNode, ns: string, local: string): boolean {
  return n.nodeType === 1 && n.localName === local && n.namespaceURI === ns;
}

function attr(n: XNode, ns: string, local: string): string | undefined {
  const v = n.getAttributeNS?.(ns, local);
  return v === null || v === undefined || v === '' ? undefined : v;
}

function children(n: XNode): XNode[] {
  const out: XNode[] = [];
  const list = n.childNodes;
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

function findChild(n: XNode, ns: string, local: string): XNode | undefined {
  return children(n).find((c) => isEl(c, ns, local));
}

function parseXml(xml: string): XNode {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as { documentElement: XNode };
  return doc.documentElement;
}

/** '#FFFFFF' / 'transparent' → undefined; иначе '#rrggbb' в нижнем регистре. */
export function normalizeColor(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const v = c.trim().toLowerCase();
  if (!v || v === 'transparent' || v === 'none') return undefined;
  let hex = v;
  if (/^#[0-9a-f]{3}$/.test(hex)) hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  if (!/^#[0-9a-f]{6}$/.test(hex)) return undefined;
  if (hex === '#ffffff') return undefined;
  return hex;
}

interface StyleInfo {
  bg?: string; // как в файле, до нормализации
  parent?: string;
}

class StyleTable {
  private map = new Map<string, StyleInfo>();
  private cache = new Map<string, string | undefined>();

  addFrom(root: XNode | undefined): void {
    if (!root) return;
    for (const st of children(root)) {
      if (!isEl(st, NS.style, 'style')) continue;
      const family = attr(st, NS.style, 'family');
      if (family && family !== 'table-cell') continue;
      const name = attr(st, NS.style, 'name');
      if (!name) continue;
      const props = findChild(st, NS.style, 'table-cell-properties');
      const bg = props ? attr(props, NS.fo, 'background-color') : undefined;
      this.map.set(name, { bg, parent: attr(st, NS.style, 'parent-style-name') });
    }
  }

  /** Итоговый цвет фона стиля с учётом наследования; undefined — нет цвета. */
  bg(name: string | undefined): string | undefined {
    if (!name) return undefined;
    if (this.cache.has(name)) return this.cache.get(name);
    let result: string | undefined;
    const seen = new Set<string>();
    let cur: string | undefined = name;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const info = this.map.get(cur);
      if (!info) break;
      if (info.bg) {
        result = normalizeColor(info.bg);
        break;
      }
      cur = info.parent;
    }
    this.cache.set(name, result);
    return result;
  }
}

/** Текст ячейки: прямые дочерние text:p / text:h (аннотации пропускаются), абзацы через \n. */
function cellText(cell: XNode): string {
  const paras: string[] = [];
  for (const c of children(cell)) {
    if (isEl(c, NS.text, 'p') || isEl(c, NS.text, 'h')) paras.push(inlineText(c));
  }
  return paras.join('\n');
}

function inlineText(n: XNode): string {
  let s = '';
  for (const c of children(n)) {
    if (c.nodeType === 3 || c.nodeType === 4) {
      s += c.nodeValue ?? '';
    } else if (c.nodeType === 1) {
      if (c.namespaceURI === NS.text) {
        switch (c.localName) {
          case 's': {
            const cnt = Number(attr(c, NS.text, 'c') ?? '1');
            s += ' '.repeat(Number.isFinite(cnt) && cnt > 0 ? Math.min(cnt, 1000) : 1);
            break;
          }
          case 'tab':
            s += '\t';
            break;
          case 'line-break':
            s += '\n';
            break;
          case 'note':
          case 'soft-page-break':
            break;
          default:
            s += inlineText(c); // span, a, и прочие обёртки
        }
      } else if (c.namespaceURI === NS.office && c.localName === 'annotation') {
        // комментарий к ячейке — не текст
      } else {
        s += inlineText(c);
      }
    }
  }
  return s;
}

const VALUE_TYPES = new Set(['float', 'currency', 'percentage', 'date', 'time', 'boolean', 'string']);

function readCell(cell: XNode, styles: StyleTable, styleName: string | undefined): OdsCell {
  const out: OdsCell = { text: cellText(cell) };
  const vt = attr(cell, NS.office, 'value-type') ?? attr(cell, 'urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0', 'value-type');
  if (vt && VALUE_TYPES.has(vt)) out.valueType = vt as OdsCell['valueType'];
  const v = attr(cell, NS.office, 'value');
  if (v !== undefined && Number.isFinite(Number(v))) out.value = Number(v);
  if (vt === 'boolean') {
    const b = attr(cell, NS.office, 'boolean-value');
    if (b !== undefined) out.value = b === 'true' ? 1 : 0;
  }
  const dv = attr(cell, NS.office, 'date-value');
  if (dv) out.dateValue = dv;
  const tv = attr(cell, NS.office, 'time-value');
  if (tv && !out.dateValue) out.dateValue = tv;
  const f = attr(cell, NS.table, 'formula');
  if (f) out.formula = f;
  const bg = styles.bg(styleName);
  if (bg) out.bg = bg;
  return out;
}

function cellIsEmpty(c: OdsCell): boolean {
  return c.text.trim() === '' && c.value === undefined && !c.dateValue && !c.formula;
}

/** Стили колонок по умолчанию — run-length, без разворачивания огромных повторов. */
class ColumnDefaults {
  private runs: { from: number; to: number; style?: string }[] = [];
  private next = 0;
  add(style: string | undefined, repeat: number): void {
    this.runs.push({ from: this.next, to: this.next + repeat - 1, style });
    this.next += repeat;
  }
  get(col: number): string | undefined {
    for (const r of this.runs) if (col >= r.from && col <= r.to) return r.style;
    return undefined;
  }
}

function collectColumns(n: XNode, cols: ColumnDefaults): void {
  for (const c of children(n)) {
    if (isEl(c, NS.table, 'table-column')) {
      const rep = Math.max(1, Number(attr(c, NS.table, 'number-columns-repeated') ?? '1') || 1);
      cols.add(attr(c, NS.table, 'default-cell-style-name'), rep);
    } else if (
      isEl(c, NS.table, 'table-column-group') ||
      isEl(c, NS.table, 'table-header-columns') ||
      isEl(c, NS.table, 'table-columns')
    ) {
      collectColumns(c, cols);
    }
  }
}

function collectRows(n: XNode, out: XNode[]): void {
  for (const c of children(n)) {
    if (isEl(c, NS.table, 'table-row')) out.push(c);
    else if (
      isEl(c, NS.table, 'table-row-group') ||
      isEl(c, NS.table, 'table-header-rows') ||
      isEl(c, NS.table, 'table-rows')
    ) {
      collectRows(c, out);
    }
  }
}

function readRowCells(row: XNode, styles: StyleTable, cols: ColumnDefaults): OdsCell[] {
  const rowDefault = attr(row, NS.table, 'default-cell-style-name');
  const cells: OdsCell[] = [];
  let col = 0;
  for (const c of children(row)) {
    const covered = isEl(c, NS.table, 'covered-table-cell');
    if (!covered && !isEl(c, NS.table, 'table-cell')) continue;
    const rep = Math.max(1, Number(attr(c, NS.table, 'number-columns-repeated') ?? '1') || 1);
    const styleName = attr(c, NS.table, 'style-name') ?? rowDefault ?? cols.get(col) ?? 'Default';
    // Скрытая объединением ячейка — пустая, но место в колонках занимает.
    const cell: OdsCell = covered ? { text: '' } : readCell(c, styles, styleName);
    if (covered) {
      const bg = styles.bg(styleName);
      if (bg) cell.bg = bg;
    }
    if (cellIsEmpty(cell)) {
      // Пустые повторы (часто 1000+ до конца строки) не разворачиваем, только сдвигаем колонку.
      if (cell.bg && rep <= MAX_REPEAT_CELL) for (let i = 0; i < rep; i++) cells[col + i] = { ...cell };
      col += rep;
      continue;
    }
    const n = Math.min(rep, MAX_REPEAT_CELL);
    for (let i = 0; i < n; i++) cells[col + i] = i === 0 ? cell : { ...cell };
    col += rep;
  }
  // Заполнить дыры и отрезать хвост из пустых ячеек.
  let last = -1;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) cells[i] = { text: '' };
    else if (!cellIsEmpty(cells[i])) last = i;
  }
  return cells.slice(0, last + 1);
}

function readTable(t: XNode, styles: StyleTable): OdsSheet {
  const name = attr(t, NS.table, 'name') ?? '';
  const cols = new ColumnDefaults();
  collectColumns(t, cols);
  const rowNodes: XNode[] = [];
  collectRows(t, rowNodes);
  const rows: OdsRow[] = [];
  let index = 1;
  for (const r of rowNodes) {
    const rep = Math.max(1, Number(attr(r, NS.table, 'number-rows-repeated') ?? '1') || 1);
    const cells = readRowCells(r, styles, cols);
    if (cells.length > 0) {
      const n = Math.min(rep, MAX_REPEAT_ROW);
      for (let i = 0; i < n; i++) {
        rows.push({ index: index + i, cells: i === 0 ? cells : cells.map((c) => ({ ...c })) });
      }
    }
    index += rep;
  }
  return { name, rows };
}

/** Прочитать .ods (zip) в листы и ячейки с цветами фона. */
export function readOds(data: Uint8Array): OdsWorkbook {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) => f.name === 'content.xml' || f.name === 'styles.xml',
    });
  } catch (e) {
    throw new Error('Не удалось распаковать файл: это не .ods (zip). ' + (e instanceof Error ? e.message : ''));
  }
  const content = files['content.xml'];
  if (!content) throw new Error('В файле нет content.xml — это не .ods');

  const styles = new StyleTable();
  if (files['styles.xml']) {
    const sroot = parseXml(strFromU8(files['styles.xml']));
    styles.addFrom(findChild(sroot, NS.office, 'styles'));
    styles.addFrom(findChild(sroot, NS.office, 'automatic-styles'));
  }
  const root = parseXml(strFromU8(content));
  styles.addFrom(findChild(root, NS.office, 'automatic-styles'));

  const body = findChild(root, NS.office, 'body');
  const spreadsheet = body ? findChild(body, NS.office, 'spreadsheet') : undefined;
  const sheets: OdsSheet[] = [];
  if (spreadsheet) {
    for (const t of children(spreadsheet)) {
      if (isEl(t, NS.table, 'table')) sheets.push(readTable(t, styles));
    }
  }
  return { sheets };
}
