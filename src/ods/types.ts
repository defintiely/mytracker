// Контракт модуля импорта ODS. Реализация — readOds.ts, importOds.ts, parseLine.ts.
import type { Contact, Entry, EntryType, ISODate, Settings, Source, TaskTypeDef, YearMonth } from '../model/types';

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

/** Роль цвета: id любого типа задачи или пометка 'important'. */
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
  /** Сколько строк этого цвета с деньгами (сумма или признаки работы) — подсказка для сопоставления. */
  withMoney: number;
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
   * Тип для строк с суммой или признаками работы (без цвета или с цветом «по тексту»).
   * По умолчанию — тип по умолчанию из taskTypes (первый с деньгами).
   */
  moneyTypeId?: EntryType;
  /** Тип для строк без суммы и без признаков работы. По умолчанию — первый тип без денег. */
  noMoneyTypeId?: EntryType;
  /**
   * Типы задач документа — откуда берётся флаг «с деньгами» для типов из colorMap и типов по умолчанию.
   * По умолчанию — типы нового документа. Тип, которого нет в списке, считается «с деньгами».
   */
  taskTypes?: TaskTypeDef[];
  /** Категории из настроек — категория строки определяется по совпадению с ними. */
  categories?: string[];
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
  /** Признак денег: сумма или признаки работы (тип в entry.type выбран по нему). */
  money: boolean;
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
  /** Категории из настроек (по умолчанию — DEFAULT_CATEGORIES). */
  categories?: string[];
  /** Настройки документа — тип по умолчанию и тип для дел без денег (по умолчанию — DEFAULT_SETTINGS). */
  settings?: Settings;
}
