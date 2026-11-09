// Сборка маленького .ods в памяти — только для тестов (синтетические данные, без реальных строк).
import { strToU8, zipSync } from 'fflate';

export interface TestCell {
  text?: string | string[]; // массив — несколько абзацев
  /** Готовый XML внутри ячейки вместо text (для text:s, span, ссылок). */
  xml?: string;
  type?: 'float' | 'currency' | 'date' | 'string' | 'percentage';
  value?: number;
  date?: string;
  formula?: string;
  style?: string;
  repeat?: number;
  covered?: boolean;
}

export interface TestRow {
  cells: TestCell[];
  repeat?: number;
  defaultStyle?: string;
}

export interface TestSheet {
  name: string;
  rows: TestRow[];
  /** Колонки: [defaultCellStyle | undefined, repeat]. */
  columns?: [string | undefined, number][];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function cellXml(c: TestCell): string {
  const attrs: string[] = [];
  if (c.style) attrs.push(`table:style-name="${c.style}"`);
  if (c.repeat) attrs.push(`table:number-columns-repeated="${c.repeat}"`);
  if (c.formula) attrs.push(`table:formula="${esc(c.formula)}"`);
  if (c.type) {
    attrs.push(`office:value-type="${c.type}"`);
    if (c.type === 'currency') attrs.push('office:currency="EUR"');
    if (c.value !== undefined) attrs.push(`office:value="${c.value}"`);
    if (c.date) attrs.push(`office:date-value="${c.date}"`);
  }
  const tag = c.covered ? 'table:covered-table-cell' : 'table:table-cell';
  let inner = '';
  if (c.xml) inner = c.xml;
  else if (c.text !== undefined) {
    const paras = Array.isArray(c.text) ? c.text : [c.text];
    inner = paras.map((p) => `<text:p>${esc(p)}</text:p>`).join('');
  }
  return inner ? `<${tag} ${attrs.join(' ')}>${inner}</${tag}>` : `<${tag} ${attrs.join(' ')}/>`;
}

export function buildOds(sheets: TestSheet[], opts: { autoStyles?: string; styles?: string } = {}): Uint8Array {
  const tables = sheets
    .map((s) => {
      const cols = (s.columns ?? [[undefined, 1024]])
        .map(
          ([style, rep]) =>
            `<table:table-column table:number-columns-repeated="${rep}"${style ? ` table:default-cell-style-name="${style}"` : ''}/>`,
        )
        .join('');
      const rows = s.rows
        .map((r) => {
          const a = [r.repeat ? `table:number-rows-repeated="${r.repeat}"` : '', r.defaultStyle ? `table:default-cell-style-name="${r.defaultStyle}"` : '']
            .filter(Boolean)
            .join(' ');
          return `<table:table-row ${a}>${r.cells.map(cellXml).join('')}</table:table-row>`;
        })
        .join('');
      return `<table:table table:name="${esc(s.name)}">${cols}${rows}</table:table>`;
    })
    .join('');
  const ns =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"';
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ns} office:version="1.3"><office:automatic-styles>${opts.autoStyles ?? ''}</office:automatic-styles><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ns} office:version="1.3"><office:styles><style:style style:name="Default" style:family="table-cell"/>${opts.styles ?? ''}</office:styles></office:document-styles>`;
  return zipSync({
    mimetype: strToU8('application/vnd.oasis.opendocument.spreadsheet'),
    'content.xml': strToU8(content),
    'styles.xml': strToU8(styles),
  });
}

/** Стиль ячейки с фоном. */
export function bgStyle(name: string, color: string, parent = 'Default'): string {
  return `<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="${parent}"><style:table-cell-properties fo:background-color="${color}"/></style:style>`;
}

/** Стиль без своего фона (наследует родителя). */
export function plainStyle(name: string, parent: string): string {
  return `<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="${parent}"><style:table-cell-properties/></style:style>`;
}
