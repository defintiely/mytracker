// Контракт модуля импорта ODS. Реализация — readOds.ts, importOds.ts, parseLine.ts.
import type { Contact, Entry, EntryType, ISODate, Source, YearMonth } from '../model/types';

export interface OdsCell {
  /** Текст ячейки, абзацы через перевод строки. */
  text: string;
  valueType?: 'float' | 'currency' | 'percentage' | 'date' | 'time' | 'boolean' | 'string';
  value?: number;
  dateValue?: string;
  formula?: string;
  /** Цвет фона ячейки '#rrggbb' (из стиля), если задан и не белый. */
  bg?: string;
}

export interface OdsRow {
  /** Номер строки в листе, с 1 (с учётом number-rows-repeated). */
  index: number;
  cells: OdsCell[];
}

export interface OdsSheet {
  name: string;
  rows: OdsRow[]; // только непустые строки
}

export interface OdsWorkbook {
  sheets: OdsSheet[];
}

/** Роль цвета: id любого типа задачи (встроенного или своего) или пометка 'important'. */
export type ColorRole = EntryType | 'important';

export interface ImportedRow {
  entry: Entry;
  /** low — парсер не уверен хотя бы в одном поле; показать подсветку в мастере. */
  confidence: 'high' | 'low';
  /** Человекочитаемые пометки: «дата из другого месяца», «время не распознано»… */
  issues: string[];
}

export interface ColorStat {
  color: string; // '#rrggbb'
  count: number;
  samples: string[]; // до 5 сырых строк
  /** Предложенный тип по эвристике (что чаще всего у строк этого цвета по тексту). */
  suggested?: EntryType;
}

export interface MonthCheck {
  sheet: string;
  month: YearMonth;
  sheetSum?: number; // значение итоговой SUM-ячейки листа
  importedSum: number; // сумма amount импортированных записей листа
  ok: boolean;
}

export interface SkippedRow {
  sheet: string;
  row: number;
  raw: string;
  reason: string;
}

export interface ImportOptions {
  /**
   * Сопоставление цвет фона → тип задачи (подтверждается в мастере).
   * 'important' — цвет не тип, а пометка «важно»: тип определяется по тексту, в заметки добавляется «❗ важно».
   */
  colorMap?: Record<string, ColorRole>;
  /** Уже существующие справочники — для переиспользования источников/контактов. */
  existingSources?: Source[];
  existingContacts?: Contact[];
  /** Ключи origin уже импортированных записей (`${sheet}|${row}|${raw}`) — повторный импорт не дублирует. */
  existingOriginKeys?: Set<string>;
  /** Импортировать листы-заготовки будущих месяцев (по умолчанию нет). */
  includeTemplateSheets?: boolean;
  today?: ISODate;
  /**
   * id типов без денег (для сопоставления цвета со своим типом). По умолчанию — только 'personal'.
   * У строк таких типов деньги не заводятся, как у личных дел.
   */
  noMoneyTypes?: string[];
}

export interface ImportResult {
  rows: ImportedRow[];
  contacts: Contact[]; // новые
  sources: Source[]; // новые
  colors: ColorStat[];
  monthChecks: MonthCheck[];
  skipped: SkippedRow[];
}

/** Результат разбора одной строки быстрого ввода / ячейки. */
export interface ParsedLine {
  entry: Partial<Entry>;
  /** Имя источника, найденное в тексте («Петя»), — для сопоставления со справочником. */
  sourceName?: string;
  contact?: { name?: string; phones: string[]; channels: Contact['channels'] };
  issues: string[];
}

export interface ParseContext {
  /** Год и месяц, к которым относится строка (лист импорта или текущий месяц). */
  year: number;
  month: number; // 1..12
  sources: Source[];
  today?: ISODate;
}
