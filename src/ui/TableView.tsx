// Экран «Таблица» (SPEC §6.1): группировка по месяцам, итоги, редактирование по месту, фильтры, виртуализация.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react';
import {
  columnOrderingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  tableFeatures,
  useTable,
  type ColumnOrderState,
  type ColumnSizingState,
  type ColumnVisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Entry, EntryKind, EntryStatus, EntryType, ISODate, Settings, TrackerDoc, YearMonth } from '../model/types';
import { KIND_LABELS, STATUS_LABELS } from '../model/types';
import {
  entryMonth,
  formatEUR,
  monthLabel,
  monthTotals,
  nowIso,
  payState,
  turnoverByType,
  type MonthTotals,
  type PayState,
} from '../model/entry';
import { taskTypes, typeColor, typeHasMoney, typeName, typeOptions } from '../model/taskTypes';
import { store } from '../store/store';
import { useTracker } from '../store/useTracker';
import { PayIcon, StatusBadge, parseAmount, useIsMobile, useUi } from './common';
import { methodFromLabel } from './MoneyEditor';
import {
  PAY_ICONS,
  addDays,
  contactName,
  formatDate,
  formatDateRange,
  formatTime,
  isWeekend,
  lsGet,
  WEEKEND_CLASS,
  lsSet,
  methodLabel,
  moneySummary,
  pad2,
  parseISODate,
  parseTimeInput,
  sourceName,
  todayISO,
  uniqueSorted,
  withHistory,
} from './util';
import { useShowEmptyDays, useTableMode, useTableSort, type SortDir, type TableMode } from './tablePrefs';
import { YearView } from './YearView';

// ---------- колонки ----------

type ColId =
  | 'open'
  | 'type'
  | 'date'
  | 'time'
  | 'title'
  | 'location'
  | 'category'
  | 'amount'
  | 'money'
  | 'method'
  | 'invoiceNo'
  | 'contact'
  | 'source'
  | 'status'
  | 'notes';

interface ColMeta {
  id: ColId;
  label: string;
  width: string;
  editable: boolean;
  hideable: boolean;
}

const COLS: ColMeta[] = [
  { id: 'open', label: '', width: '34px', editable: false, hideable: false },
  { id: 'type', label: 'Тип', width: '110px', editable: true, hideable: true },
  { id: 'date', label: 'Дата', width: '96px', editable: true, hideable: false },
  { id: 'time', label: 'Время', width: '96px', editable: true, hideable: true },
  { id: 'title', label: 'Название', width: 'minmax(180px, 2fr)', editable: true, hideable: false },
  { id: 'location', label: 'Место', width: 'minmax(120px, 1fr)', editable: true, hideable: true },
  { id: 'category', label: 'Категория', width: '130px', editable: true, hideable: true },
  { id: 'amount', label: 'Сумма', width: '84px', editable: true, hideable: true },
  { id: 'money', label: 'Где деньги', width: 'minmax(130px, 1fr)', editable: false, hideable: true },
  { id: 'method', label: 'Способ', width: '84px', editable: true, hideable: true },
  { id: 'invoiceNo', label: '№ инв.', width: '64px', editable: true, hideable: true },
  { id: 'contact', label: 'Контакт', width: '130px', editable: true, hideable: true },
  { id: 'source', label: 'Источник', width: '110px', editable: true, hideable: true },
  { id: 'status', label: 'Статус', width: '130px', editable: true, hideable: true },
  { id: 'notes', label: 'Заметки', width: 'minmax(120px, 1fr)', editable: true, hideable: true },
];
const COL_BY_ID = Object.fromEntries(COLS.map((c) => [c.id, c])) as Record<ColId, ColMeta>;

const features = tableFeatures({ columnVisibilityFeature, columnOrderingFeature, columnSizingFeature });
const helper = createColumnHelper<typeof features, Entry>();
const columns = COLS.map((c) => helper.display({ id: c.id, header: c.label, enableHiding: c.hideable }));

const COLS_KEY = 'wlt.table.columns';
const FILTERS_KEY = 'wlt.table.filters';
/** Ширины и порядок колонок на этом устройстве. Версия в ключе — на случай смены формата. */
export const LAYOUT_KEY = 'wlt.table.layout.v1';

// ---------- ширина и порядок колонок ----------

/** Колонка с кнопкой «Открыть карточку» всегда первая: её не двигают и не растягивают. */
const FIXED_COL: ColId = 'open';
export const COL_MIN = 60;
export const COL_MAX = 800;
/** Предел для «подогнать по содержимому» — длинные заметки не растягивают колонку на весь экран. */
const AUTOFIT_MAX = 500;
const MIN_GRID_WIDTH = 1300;

interface Layout {
  order: ColumnOrderState;
  sizing: ColumnSizingState;
}

const DEFAULT_ORDER: ColId[] = COLS.map((c) => c.id);
const DEFAULT_LAYOUT: Layout = { order: DEFAULT_ORDER, sizing: {} };

const clampWidth = (w: number, max = COL_MAX) => Math.round(Math.min(max, Math.max(COL_MIN, w)));

/** Ширина колонки по умолчанию в пикселях — первое число из CSS-описания ('96px', 'minmax(180px, 2fr)'). */
function defaultPx(id: ColId): number {
  const m = /(\d+)px/.exec(COL_BY_ID[id].width);
  return m ? Number(m[1]) : 100;
}

/** Сливает сохранённый порядок с текущим набором колонок: неизвестные отбрасывает, новые — в конец. */
export function mergeOrder(saved: unknown): ColId[] {
  const known = new Set<string>(DEFAULT_ORDER);
  const seen = new Set<string>([FIXED_COL]);
  const out: ColId[] = [FIXED_COL];
  if (Array.isArray(saved)) {
    for (const id of saved) {
      if (typeof id === 'string' && known.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id as ColId);
      }
    }
  }
  for (const id of DEFAULT_ORDER) if (!seen.has(id)) out.push(id);
  return out;
}

function cleanSizing(saved: unknown): ColumnSizingState {
  const out: ColumnSizingState = {};
  if (!saved || typeof saved !== 'object') return out;
  for (const [id, w] of Object.entries(saved as Record<string, unknown>)) {
    if (id in COL_BY_ID && id !== FIXED_COL && typeof w === 'number' && Number.isFinite(w)) out[id] = clampWidth(w);
  }
  return out;
}

function loadLayout(): Layout {
  const raw = lsGet<Partial<Layout> | null>(LAYOUT_KEY, null);
  if (!raw || typeof raw !== 'object') return DEFAULT_LAYOUT;
  return { order: mergeOrder(raw.order), sizing: cleanSizing(raw.sizing) };
}

function clearLayout() {
  try {
    localStorage.removeItem(LAYOUT_KEY);
  } catch {
    /* хранилище недоступно — не критично */
  }
}

// ---------- фильтры ----------

export interface Filters {
  from: string;
  to: string;
  types: EntryType[];
  kind: EntryKind | '';
  pay: PayState | '';
  source: string; // '' — все, '__none' — свои
  q: string;
  showCancelled: boolean;
}

const DEFAULT_FILTERS: Filters = {
  from: '',
  to: '',
  types: [],
  kind: '',
  pay: '',
  source: '',
  q: '',
  showCancelled: false,
};

export function applyFilters(doc: TrackerDoc, f: Filters): Entry[] {
  const q = f.q.trim().toLowerCase();
  return doc.entries.filter((e) => {
    if (e.deleted) return false;
    if (!f.showCancelled && e.status === 'cancelled') return false;
    const m = entryMonth(e);
    if (f.from && (!m || m < f.from)) return false;
    if (f.to && (!m || m > f.to)) return false;
    if (f.types.length && !f.types.includes(e.type)) return false;
    if (f.pay && payState(e, doc.settings) !== f.pay) return false;
    if (f.source === '__none' && e.sourceId) return false;
    if (f.source && f.source !== '__none' && e.sourceId !== f.source) return false;
    if (q) {
      const hay = [
        e.title,
        e.location,
        e.category,
        e.notes,
        e.invoiceNo,
        e.timeNote,
        e.origin?.raw,
        sourceName(doc, e.sourceId),
        contactName(doc, e.contactId),
        ...e.checklist.map((c) => c.text),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Порядок записей в месяце: по дате и времени в выбранную сторону; записи без даты — всегда в конце. */
function sortInMonth(dir: SortDir) {
  const sign = dir === 'asc' ? 1 : -1;
  return (a: Entry, b: Entry): number => {
    if (a.date && b.date)
      return sign * (a.date.localeCompare(b.date) || (a.timeStart ?? '').localeCompare(b.timeStart ?? ''));
    if (a.date) return -1;
    if (b.date) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  };
}

/** Фильтры, при которых день «пуст» лишь потому, что его записи отфильтрованы: пустые дни тогда не показываем. */
export function narrowsEntries(f: Filters): boolean {
  return Boolean(f.q.trim() || f.types.length || f.pay || f.source);
}

export type Item =
  | { k: 'month'; key: string; label: string; count: number }
  | { k: 'row'; entry: Entry }
  | { k: 'empty'; key: ISODate; weekend: boolean }
  | { k: 'total'; key: string; t: MonthTotals };

const NO_MONTH = '__none';

export interface EmptyDaysOpts {
  /** Месяц «сейчас» — показывается всегда, если попадает в период. */
  currentMonth: YearMonth;
  from?: YearMonth;
  to?: YearMonth;
}

function nextMonth(m: YearMonth): YearMonth {
  const [y, mm] = m.split('-').map(Number);
  return mm === 12 ? `${y + 1}-01` : `${y}-${pad2(mm + 1)}`;
}

function monthDays(m: YearMonth): ISODate[] {
  const [y, mm] = m.split('-').map(Number);
  const n = new Date(y, mm, 0).getDate();
  return Array.from({ length: n }, (_, i) => `${m}-${pad2(i + 1)}`);
}

/** Дни, занятые хоть одной записью (многодневная запись занимает все свои дни; длина — не больше года). */
function coveredDays(entries: Entry[]): Set<ISODate> {
  const out = new Set<ISODate>();
  for (const e of entries) {
    if (!e.date) continue;
    out.add(e.date);
    if (e.dateEnd && e.dateEnd > e.date) {
      let d = e.date;
      for (let i = 0; i < 366 && d < e.dateEnd; i++) {
        d = addDays(d, 1);
        out.add(d);
      }
    }
  }
  return out;
}

/**
 * Строки таблицы: месяц → записи → итоги. С emptyDays внутри каждого месяца (кроме «Без даты») ещё и
 * строки дней без записей — вперемешку с записями, в том же порядке по дате. Месяцы тогда: те, где есть
 * записи, плюс текущий (в пределах периода фильтра).
 * dir — порядок по дате и для месяцев, и для дней внутри месяца: 'desc' — сначала новые, 'asc' — сначала
 * старые. «Без даты» — всегда последняя группа, итоги — всегда последняя строка своего месяца.
 */
export function buildItems(entries: Entry[], doc: TrackerDoc, emptyDays?: EmptyDaysOpts, dir: SortDir = 'desc'): Item[] {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const m = entryMonth(e) ?? NO_MONTH;
    const g = groups.get(m);
    if (g) g.push(e);
    else groups.set(m, [e]);
  }
  const monthSet = new Set([...groups.keys()].filter((k) => k !== NO_MONTH));
  if (emptyDays) {
    const { currentMonth, from, to } = emptyDays;
    // Месяцы без единой записи не показываем; исключение — текущий месяц (к нему перематывается таблица).
    if ((!from || currentMonth >= from) && (!to || currentMonth <= to)) monthSet.add(currentMonth);
  }
  const keys = [...monthSet].sort((a, b) => (dir === 'asc' ? a.localeCompare(b) : b.localeCompare(a)));
  if (groups.has(NO_MONTH)) keys.push(NO_MONTH);
  const covered = emptyDays ? coveredDays(entries) : undefined;
  const items: Item[] = [];
  for (const k of keys) {
    const list = (groups.get(k) ?? []).sort(sortInMonth(dir));
    items.push({ k: 'month', key: k, label: k === NO_MONTH ? 'Без даты' : monthLabel(k), count: list.length });
    if (covered && k !== NO_MONTH) {
      const days = monthDays(k).filter((d) => !covered.has(d));
      if (dir === 'desc') days.reverse();
      const before = (d: ISODate, until: ISODate) => (dir === 'asc' ? d < until : d > until);
      let di = 0;
      /** Выложить пустые дни, которые по порядку идут раньше until (без until — все оставшиеся). */
      const flush = (until?: ISODate) => {
        for (; di < days.length && (until === undefined || before(days[di], until)); di++) {
          const wd = parseISODate(days[di]).getDay();
          items.push({ k: 'empty', key: days[di], weekend: wd === 0 || wd === 6 });
        }
      };
      for (const e of list) {
        flush(e.date);
        items.push({ k: 'row', entry: e });
      }
      flush();
    } else {
      for (const e of list) items.push({ k: 'row', entry: e });
    }
    if (k !== NO_MONTH && list.length) items.push({ k: 'total', key: k, t: monthTotals(list, k, doc.settings) });
  }
  return items;
}

/**
 * Строка дня для перемотки (обычно «сегодня»): запись или пустой день на эту дату, иначе ближайшая строка этого
 * месяца дальше по направлению чтения (при «сначала новые» — более ранняя дата, при «сначала старые» — более
 * поздняя), иначе заголовок месяца дня, иначе ближайший месяц дальше по направлению чтения, иначе ближайший
 * с другой стороны. «Без даты» не выбирается. -1 — ничего подходящего.
 */
export function todayIndex(items: Item[], today: ISODate, dir: SortDir = 'desc'): number {
  const month = today.slice(0, 7);
  const dateOf = (it: Item): ISODate | undefined => (it.k === 'row' ? it.entry.date : it.k === 'empty' ? it.key : undefined);
  const exact = items.findIndex((it) => dateOf(it) === today);
  if (exact >= 0) return exact;
  const ahead = (a: string, b: string) => (dir === 'asc' ? a > b : a < b);
  const next = items.findIndex((it) => {
    const d = dateOf(it);
    return !!d && d.slice(0, 7) === month && ahead(d, today);
  });
  if (next >= 0) return next;
  const header = items.findIndex((it) => it.k === 'month' && it.key === month);
  if (header >= 0) return header;
  const isMonth = (it: Item): it is Extract<Item, { k: 'month' }> => it.k === 'month' && it.key !== NO_MONTH;
  const nextMonth = items.findIndex((it) => isMonth(it) && ahead(it.key, month));
  if (nextMonth >= 0) return nextMonth;
  // все месяцы — по другую сторону от дня: ближайший из них стоит последним
  for (let i = items.length - 1; i >= 0; i--) if (isMonth(items[i])) return i;
  return -1;
}

type Scroller = { scrollToIndex: (i: number, o?: { align?: 'start' | 'center' | 'end' | 'auto' }) => void };

/** При открытии таблицы — один раз перемотать к дню target (обычно сегодня; без target — не перематывать). */
function useScrollToDay(virtualizer: Scroller, items: Item[], target: ISODate | undefined, dir: SortDir) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !items.length || !target) return;
    done.current = true;
    const idx = todayIndex(items, target, dir);
    if (idx < 0) return;
    // заголовок месяца над строкой — тоже в кадре
    const row = idx > 0 && items[idx].k !== 'month' ? idx - 1 : idx;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => setTimeout(f, 0);
    raf(() => virtualizer.scrollToIndex(row, { align: 'start' }));
  }, [items, virtualizer, target, dir]);
}

/** Для каждой строки — индекс заголовка её месяца (-1, если над строкой заголовка нет). */
export function monthHeaderIndex(items: Item[]): number[] {
  const out: number[] = new Array(items.length);
  let cur = -1;
  items.forEach((it, i) => {
    if (it.k === 'month') cur = i;
    out[i] = cur;
  });
  return out;
}

interface VirtualRow {
  index: number;
  start: number;
  end: number;
}

/**
 * Закреплённый заголовок месяца: месяц верхней видимой строки, если его заголовок уже уехал вверх.
 * shift < 0 — следующий заголовок подъезжает снизу и выталкивает закреплённый.
 */
export function pinnedMonth(
  items: Item[],
  headerOf: number[],
  rows: VirtualRow[],
  scrollTop: number,
  pinHeight: number,
): { index: number; shift: number } | null {
  const top = rows.find((r) => r.end > scrollTop);
  if (!top) return null;
  const hi = headerOf[top.index];
  if (hi < 0) return null;
  const headerRow = rows.find((r) => r.index === hi);
  if (headerRow && headerRow.start >= scrollTop) return null; // свой заголовок ещё виден
  const next = rows.find((r) => r.index > top.index && items[r.index].k === 'month' && r.start > scrollTop);
  const gap = next ? next.start - scrollTop : Infinity;
  return { index: hi, shift: gap < pinHeight ? gap - pinHeight : 0 };
}

function MonthPin({ items, headerOf, rows, scrollTop, className, height }: {
  items: Item[];
  headerOf: number[];
  rows: VirtualRow[];
  scrollTop: number;
  className: string;
  height: number;
}) {
  const pin = pinnedMonth(items, headerOf, rows, scrollTop, height);
  const it = pin ? items[pin.index] : undefined;
  return (
    <div className="month-pin-anchor" aria-hidden={!it}>
      {it && it.k === 'month' && (
        <div className={className + ' month-pin'} style={{ transform: `translateY(${pin!.shift}px)` }}>
          {it.label} <span className="muted small">· {it.count}</span>
        </div>
      )}
    </div>
  );
}

function itemKey(it: Item): string {
  return it.k === 'row' ? it.entry.id : it.k + ':' + it.key;
}

// ---------- экран ----------

export function TableView() {
  const doc = useTracker();
  const mobile = useIsMobile();
  const [filters, setFiltersState] = useState<Filters>(() => ({
    ...DEFAULT_FILTERS,
    ...lsGet<Partial<Filters>>(FILTERS_KEY, {}),
    q: '',
  }));
  const setFilters = (f: Filters) => {
    setFiltersState(f);
    lsSet(FILTERS_KEY, { ...f, q: '' });
  };
  const [colVis, setColVis] = useState<ColumnVisibilityState>(() => lsGet(COLS_KEY, { notes: false, invoiceNo: false }));
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const updateLayout = (fn: (prev: Layout) => Layout) =>
    setLayoutState((prev) => {
      const next = fn(prev);
      lsSet(LAYOUT_KEY, next);
      return next;
    });

  const [mode, setModePref] = useTableMode();
  const [sort, setSort] = useTableSort();
  /** Открытый из «Года» месяц (режим «Месяц»); null — сам календарь года. Только в памяти. */
  const [openMonth, setOpenMonth] = useState<YearMonth | null>(null);
  /** День, к которому перемотать открытый месяц (клик по дню в карточке года). */
  const [focusDay, setFocusDay] = useState<ISODate | undefined>(undefined);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const view: 'table' | 'year' | 'month' = mode === 'year' ? (openMonth ? 'month' : 'year') : 'table';

  const setMode = (m: TableMode) => {
    setModePref(m);
    setOpenMonth(null);
    setFocusDay(undefined);
  };
  const openMonthView = (m: YearMonth, day?: ISODate) => {
    setOpenMonth(m);
    setFocusDay(day);
    setYear(Number(m.slice(0, 4)));
  };
  const backToYear = () => {
    if (openMonth) setYear(Number(openMonth.slice(0, 4)));
    setOpenMonth(null);
    setFocusDay(undefined);
  };

  // В «Годе» и «Месяце» период задаёт сам вид — «С месяца / По месяц» из фильтров не действуют.
  const periodIgnored = view !== 'table' && Boolean(filters.from || filters.to);
  const filtered = useMemo(
    () => applyFilters(doc, view === 'table' ? filters : { ...filters, from: '', to: '' }),
    [doc, filters, view],
  );
  const scoped = useMemo(
    () => (view === 'month' ? filtered.filter((e) => entryMonth(e) === openMonth) : filtered),
    [filtered, view, openMonth],
  );

  const table = useTable({
    features,
    columns,
    data: scoped,
    getRowId: (e: Entry) => e.id,
    state: { columnVisibility: colVis, columnOrder: layout.order, columnSizing: layout.sizing },
    onColumnVisibilityChange: (u) => {
      setColVis((prev) => {
        const next = typeof u === 'function' ? u(prev) : u;
        lsSet(COLS_KEY, next);
        return next;
      });
    },
    onColumnOrderChange: (u) =>
      updateLayout((prev) => ({ ...prev, order: mergeOrder(typeof u === 'function' ? u(prev.order) : u) })),
    onColumnSizingChange: (u) =>
      updateLayout((prev) => ({ ...prev, sizing: cleanSizing(typeof u === 'function' ? u(prev.sizing) : u) })),
  });

  const [showEmpty, setShowEmpty] = useShowEmptyDays();
  const emptyHidden = showEmpty && narrowsEntries(filters);
  const emptyOn = showEmpty && !emptyHidden;
  const today = todayISO();
  const currentMonth = today.slice(0, 7);
  const items = useMemo(() => {
    if (view === 'year') return [];
    const empty: EmptyDaysOpts | undefined = !emptyOn
      ? undefined
      : view === 'month'
        ? { currentMonth: openMonth!, from: openMonth!, to: openMonth! }
        : { currentMonth, from: filters.from || undefined, to: filters.to || undefined };
    return buildItems(
      table.getRowModel().rows.map((r) => r.original),
      doc,
      empty,
      sort,
    );
  }, [table, scoped, doc, emptyOn, currentMonth, filters.from, filters.to, sort, view, openMonth]);
  /** К какому дню перемотать при открытии: в таблице — сегодня; в месяце — выбранный день или сегодня, если месяц текущий. */
  const scrollTarget =
    view === 'table' ? today : (focusDay ?? (openMonth === currentMonth ? today : undefined));
  // Новый вид, месяц, день или порядок — список строится заново и снова перематывается к нужному дню.
  const listKey = [view, openMonth ?? '', focusDay ?? '', sort].join(':');
  const visibleCols = table.getVisibleLeafColumns().map((c) => COL_BY_ID[c.id as ColId]);

  const resizeCol = (id: ColId, w: number) => table.setColumnSizing((prev) => ({ ...prev, [id]: clampWidth(w) }));
  /** Переставляет колонку относительно другой (перетаскивание заголовка). */
  const dropCol = (dragId: ColId, targetId: ColId, side: 'before' | 'after') => {
    if (dragId === targetId || dragId === FIXED_COL || targetId === FIXED_COL) return;
    table.setColumnOrder((prev) => {
      const arr = prev.filter((x) => x !== dragId);
      const i = arr.indexOf(targetId);
      if (i < 0) return prev;
      arr.splice(side === 'after' ? i + 1 : i, 0, dragId);
      return arr;
    });
  };
  /** Сдвигает колонку на одну позицию в общем порядке (кнопки ↑/↓ в меню). */
  const shiftCol = (id: ColId, dir: -1 | 1) =>
    table.setColumnOrder((prev) => {
      const arr = [...prev];
      const i = arr.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length || arr[j] === FIXED_COL) return prev;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return arr;
    });
  const resetLayout = () => {
    setLayoutState(DEFAULT_LAYOUT);
    clearLayout();
  };
  const menuIds = layout.order.filter((id) => id !== FIXED_COL) as ColId[];

  const yearPrefix = year + '-';
  const count =
    view === 'year' ? filtered.filter((e) => entryMonth(e)?.startsWith(yearPrefix)).length : scoped.length;
  const filterHint =
    [
      narrowsEntries(filters) ? 'Итоги посчитаны только по записям, подходящим под фильтр.' : '',
      periodIgnored ? 'Период «С месяца / По месяц» здесь не действует.' : '',
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className="view table-view">
      <FilterBar
        doc={doc}
        filters={filters}
        onChange={setFilters}
        count={count}
        showEmpty={showEmpty}
        onShowEmpty={setShowEmpty}
        emptyHidden={emptyHidden && view !== 'year'}
      />
      <div className="table-toolbar">
        <div className="seg" role="group" aria-label="Вид таблицы">
          <button
            type="button"
            className={'seg-btn' + (view === 'table' ? ' on' : '')}
            aria-pressed={view === 'table'}
            onClick={() => setMode('table')}
          >
            Таблица
          </button>
          <button
            type="button"
            className={'seg-btn' + (view !== 'table' ? ' on' : '')}
            aria-pressed={view !== 'table'}
            onClick={() => setMode('year')}
          >
            Год
          </button>
        </div>
        {view !== 'year' && <SortToggle dir={sort} onChange={setSort} />}
        {!mobile && view !== 'year' && (
          <details className="col-menu">
          <summary>Колонки</summary>
          <div className="col-menu-list">
            {menuIds.map((id, i) => {
              const col = table.getColumn(id);
              const meta = COL_BY_ID[id];
              return (
                <div key={id} className="col-menu-item">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={col?.getIsVisible() ?? true}
                      disabled={!meta.hideable}
                      onChange={() => col?.toggleVisibility()}
                    />{' '}
                    {meta.label}
                  </label>
                  <span className="col-menu-move">
                    <button
                      type="button"
                      className="icon-btn small"
                      aria-label={`Выше: ${meta.label}`}
                      disabled={i === 0}
                      onClick={() => shiftCol(id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-btn small"
                      aria-label={`Ниже: ${meta.label}`}
                      disabled={i === menuIds.length - 1}
                      onClick={() => shiftCol(id, 1)}
                    >
                      ↓
                    </button>
                  </span>
                </div>
              );
            })}
            <button type="button" className="small col-menu-reset" onClick={resetLayout}>
              Сбросить ширину и порядок
            </button>
          </div>
        </details>
        )}
      </div>
      {view === 'year' ? (
        <YearView doc={doc} entries={filtered} year={year} onYear={setYear} onOpenMonth={openMonthView} hint={filterHint} />
      ) : (
        <>
          {view === 'month' && (
            <MonthNav month={openMonth!} onBack={backToYear} onOpen={(m) => openMonthView(m)} hint={filterHint} />
          )}
          {items.length === 0 ? (
            <div className="empty">
              {view === 'month'
                ? 'В этом месяце записей нет.'
                : 'Записей нет. Добавьте первую строкой быстрого ввода сверху.'}
            </div>
          ) : mobile ? (
            <MobileList key={listKey} items={items} doc={doc} scrollTo={scrollTarget} dir={sort} />
          ) : (
            <Grid
              key={listKey}
              items={items}
              cols={visibleCols}
              doc={doc}
              sizing={layout.sizing}
              onResize={resizeCol}
              onDropCol={dropCol}
              scrollTo={scrollTarget}
              dir={sort}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Переключатель порядка по дате: подпись говорит, как сейчас, нажатие меняет на обратный. */
function SortToggle({ dir, onChange }: { dir: SortDir; onChange: (d: SortDir) => void }) {
  const now = dir === 'desc' ? 'сначала новые' : 'сначала старые';
  const other = dir === 'desc' ? 'сначала старые' : 'сначала новые';
  return (
    <button
      type="button"
      className="sort-toggle"
      aria-label={`Порядок по дате: ${now}. Нажмите, чтобы ${other}`}
      title={`Нажмите, чтобы ${other}`}
      onClick={() => onChange(dir === 'desc' ? 'asc' : 'desc')}
    >
      {dir === 'desc' ? 'Сначала новые ↓' : 'Сначала старые ↑'}
    </button>
  );
}

function shiftMonth(m: YearMonth, by: number): YearMonth {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1 + by, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** Строка над таблицей одного месяца: «← Год» · «‹ Апрель» «Май 2026» «Июнь ›». */
function MonthNav({ month, onBack, onOpen, hint }: {
  month: YearMonth;
  onBack: () => void;
  onOpen: (m: YearMonth) => void;
  hint?: string;
}) {
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const name = (m: YearMonth) => monthLabel(m).split(' ')[0];
  return (
    <>
      <div className="month-nav">
        <button type="button" className="month-nav-back" onClick={onBack}>
          ← Год
        </button>
        <button type="button" aria-label={`Предыдущий месяц: ${monthLabel(prev)}`} onClick={() => onOpen(prev)}>
          ‹ {name(prev)}
        </button>
        <h2 className="month-nav-title">{monthLabel(month)}</h2>
        <button type="button" aria-label={`Следующий месяц: ${monthLabel(next)}`} onClick={() => onOpen(next)}>
          {name(next)} ›
        </button>
      </div>
      {hint && <p className="hint">{hint}</p>}
    </>
  );
}

function FilterBar({
  doc,
  filters: f,
  onChange,
  count,
  showEmpty,
  onShowEmpty,
  emptyHidden,
}: {
  doc: TrackerDoc;
  filters: Filters;
  onChange: (f: Filters) => void;
  count: number;
  showEmpty: boolean;
  onShowEmpty: (on: boolean) => void;
  emptyHidden: boolean;
}) {
  const set = (p: Partial<Filters>) => onChange({ ...f, ...p });
  const active =
    f.from || f.to || f.types.length || f.kind || f.pay || f.source || f.showCancelled ? true : false;
  return (
    <div className="filters">
      <input
        type="search"
        className="search"
        placeholder="Поиск по всему тексту"
        aria-label="Поиск"
        value={f.q}
        onChange={(e) => set({ q: e.target.value })}
      />
      <details className="filter-more" open={active ? undefined : undefined}>
        <summary>Фильтры{active ? ' •' : ''}</summary>
        <div className="filter-grid">
          <label>
            С месяца
            <input type="month" value={f.from} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label>
            По месяц
            <input type="month" value={f.to} onChange={(e) => set({ to: e.target.value })} />
          </label>
          <div className="filter-types">
            {taskTypes(doc.settings).map(({ id: t, name, color }) => (
              <label key={t} className="check chip-check" style={{ ['--tc' as string]: color }}>
                <input
                  type="checkbox"
                  checked={f.types.includes(t)}
                  onChange={(e) => set({ types: e.target.checked ? [...f.types, t] : f.types.filter((x) => x !== t) })}
                />
                <span className="type-dot" style={{ background: color }} /> {name}
              </label>
            ))}
          </div>
          <label>
            Оплата
            <select value={f.pay} onChange={(e) => set({ pay: e.target.value as PayState | '' })}>
              <option value="">любая</option>
              {(Object.keys(PAY_ICONS) as PayState[]).map((p) => (
                <option key={p} value={p}>
                  {PAY_ICONS[p].label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Источник
            <select value={f.source} onChange={(e) => set({ source: e.target.value })}>
              <option value="">все</option>
              <option value="__none">свои заказы</option>
              {doc.sources
                .filter((s) => !s.deleted)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={f.showCancelled}
              onChange={(e) => set({ showCancelled: e.target.checked })}
            />{' '}
            Показывать отменённые
          </label>
          {active && (
            <button type="button" className="small" onClick={() => onChange({ ...DEFAULT_FILTERS, q: f.q })}>
              Сбросить
            </button>
          )}
        </div>
      </details>
      <label className="check small empty-days-toggle" title="Показывать в таблице дни без записей">
        <input type="checkbox" checked={showEmpty} onChange={(e) => onShowEmpty(e.target.checked)} /> Пустые дни
      </label>
      <span className="muted small">{count} зап.</span>
      {emptyHidden && <span className="hint filters-hint">Пустые дни скрыты, пока включён фильтр</span>}
    </div>
  );
}

// ---------- сетка (ПК) ----------

interface EditPos {
  id: string;
  col: ColId;
}

type DropSide = 'before' | 'after';

function Grid({
  items,
  cols,
  doc,
  sizing,
  onResize,
  onDropCol,
  scrollTo,
  dir,
}: {
  items: Item[];
  cols: ColMeta[];
  doc: TrackerDoc;
  sizing: ColumnSizingState;
  onResize: (id: ColId, w: number) => void;
  onDropCol: (dragId: ColId, targetId: ColId, side: DropSide) => void;
  scrollTo?: ISODate;
  dir: SortDir;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<EditPos | null>(null);
  const ui = useUi();
  const template = cols.map((c) => (sizing[c.id] ? `${sizing[c.id]}px` : c.width)).join(' ');
  const minWidth = Math.max(
    MIN_GRID_WIDTH,
    cols.reduce((s, c) => s + (sizing[c.id] ?? defaultPx(c.id)), 0),
  );

  // --- ширина: ручка у правого края заголовка ---
  const resizeRef = useRef<{ id: ColId; startX: number; startW: number } | null>(null);
  const [resizing, setResizing] = useState<ColId | null>(null);
  const widthOf = (id: ColId, head: HTMLElement | null): number =>
    sizing[id] ?? (head?.getBoundingClientRect().width || defaultPx(id));

  /** Подогнать по содержимому: ширина самого длинного видимого значения или заголовка. */
  const autoFit = (id: ColId) => {
    const root = scrollRef.current;
    if (!root) return;
    let max = 0;
    root.querySelectorAll<HTMLElement>(`[data-col="${id}"]`).forEach((cell) => {
      const content = (cell.classList.contains('gh') ? cell.querySelector('.gh-label') : cell.firstElementChild) as
        | HTMLElement
        | null;
      if (!content) return;
      const { width, whiteSpace } = content.style;
      content.style.width = 'max-content';
      content.style.whiteSpace = 'nowrap';
      max = Math.max(max, content.getBoundingClientRect().width);
      content.style.width = width;
      content.style.whiteSpace = whiteSpace;
    });
    // + поля заголовка и место под ручку
    if (max > 0) onResize(id, clampWidth(Math.ceil(max) + 18, AUTOFIT_MAX));
  };

  // --- порядок: перетаскивание заголовка ---
  const [dragCol, setDragCol] = useState<ColId | null>(null);
  const [drop, setDrop] = useState<{ id: ColId; side: DropSide } | null>(null);
  const endDrag = () => {
    setDragCol(null);
    setDrop(null);
  };
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const k = items[i].k;
      return k === 'row' ? 34 : k === 'empty' ? 26 : k === 'month' ? 38 : 52;
    },
    getItemKey: (i) => itemKey(items[i]),
    overscan: 10,
    initialRect: { width: 1200, height: 800 },
  });
  useScrollToDay(virtualizer, items, scrollTo, dir);
  const headerOf = useMemo(() => monthHeaderIndex(items), [items]);
  // высота шапки столбцов — под ней прилипает заголовок месяца
  const headRef = useRef<HTMLDivElement>(null);
  const [headH, setHeadH] = useState(37);
  useEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const update = () => el.offsetHeight > 0 && setHeadH(el.offsetHeight);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowIndexById = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((it, i) => it.k === 'row' && m.set(it.entry.id, i));
    return m;
  }, [items]);
  const rowOrder = useMemo(() => items.flatMap((it) => (it.k === 'row' ? [it.entry.id] : [])), [items]);
  const editableCols = cols.filter((c) => c.editable).map((c) => c.id);

  const move = (from: EditPos, dx: number, dy: number) => {
    let ci = editableCols.indexOf(from.col);
    let ri = rowOrder.indexOf(from.id);
    if (dx) {
      ci += dx;
      if (ci >= editableCols.length) {
        ci = 0;
        ri++;
      } else if (ci < 0) {
        ci = editableCols.length - 1;
        ri--;
      }
    }
    ri += dy;
    if (ri < 0 || ri >= rowOrder.length) {
      setEditing(null);
      return;
    }
    const next = { id: rowOrder[ri], col: editableCols[ci] };
    setEditing(next);
    const idx = rowIndexById.get(next.id);
    if (idx !== undefined) virtualizer.scrollToIndex(idx, { align: 'auto' });
  };

  return (
    <div className="grid-scroll" ref={scrollRef}>
      <div
        className={'grid-inner' + (resizing ? ' is-resizing' : '')}
        style={{ ['--cols' as string]: template, ['--head-h' as string]: headH + 'px', minWidth }}
      >
        <div className="grid-head grid-row" role="row" ref={headRef}>
          {cols.map((c) => {
            const movable = c.id !== FIXED_COL;
            return (
              <div
                key={c.id}
                className={
                  'gh' +
                  (movable ? ' gh-movable' : '') +
                  (dragCol === c.id ? ' dragging' : '') +
                  (drop && drop.id === c.id && dragCol !== c.id ? ' drop-' + drop.side : '')
                }
                role="columnheader"
                data-col={c.id}
                draggable={movable}
                onDragStart={(ev) => {
                  if (!movable || resizeRef.current || (ev.target as HTMLElement).closest('.col-resizer')) {
                    ev.preventDefault();
                    return;
                  }
                  ev.dataTransfer.effectAllowed = 'move';
                  ev.dataTransfer.setData('text/plain', c.id);
                  setDragCol(c.id);
                }}
                onDragOver={(ev) => {
                  if (!dragCol || !movable) return;
                  ev.preventDefault();
                  ev.dataTransfer.dropEffect = 'move';
                  const r = ev.currentTarget.getBoundingClientRect();
                  const side: DropSide = ev.clientX < r.left + r.width / 2 ? 'before' : 'after';
                  if (!drop || drop.id !== c.id || drop.side !== side) setDrop({ id: c.id, side });
                }}
                onDrop={(ev) => {
                  ev.preventDefault();
                  if (dragCol && drop) onDropCol(dragCol, drop.id, drop.side);
                  endDrag();
                }}
                onDragEnd={endDrag}
              >
                <span className="gh-label">{c.label}</span>
                {movable && (
                  <div
                    className={'col-resizer' + (resizing === c.id ? ' active' : '')}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Ширина: ${c.label}`}
                    aria-valuemin={COL_MIN}
                    aria-valuemax={COL_MAX}
                    aria-valuenow={sizing[c.id] ?? defaultPx(c.id)}
                    tabIndex={0}
                    draggable={false}
                    onPointerDown={(ev) => {
                      if (ev.button !== 0) return;
                      ev.preventDefault();
                      ev.stopPropagation();
                      resizeRef.current = {
                        id: c.id,
                        startX: ev.clientX,
                        startW: widthOf(c.id, ev.currentTarget.parentElement),
                      };
                      ev.currentTarget.setPointerCapture?.(ev.pointerId);
                      setResizing(c.id);
                    }}
                    onPointerMove={(ev) => {
                      const d = resizeRef.current;
                      if (!d) return;
                      const w = clampWidth(d.startW + ev.clientX - d.startX);
                      if (w !== sizing[d.id]) onResize(d.id, w);
                    }}
                    onPointerUp={(ev) => {
                      resizeRef.current = null;
                      ev.currentTarget.releasePointerCapture?.(ev.pointerId);
                      setResizing(null);
                    }}
                    onPointerCancel={() => {
                      resizeRef.current = null;
                      setResizing(null);
                    }}
                    onDoubleClick={() => autoFit(c.id)}
                    onKeyDown={(ev) => {
                      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
                      ev.preventDefault();
                      const step = (ev.shiftKey ? 50 : 10) * (ev.key === 'ArrowLeft' ? -1 : 1);
                      onResize(c.id, widthOf(c.id, ev.currentTarget.parentElement) + step);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
        <MonthPin
          items={items}
          headerOf={headerOf}
          rows={virtualizer.getVirtualItems()}
          scrollTop={virtualizer.scrollOffset ?? 0}
          className="grid-month"
          height={38}
        />
        <div className="grid-body" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const it = items[vi.index];
            const style = { transform: `translateY(${vi.start}px)` };
            if (it.k === 'month')
              return (
                <div key={vi.key} className="grid-month" style={style} data-index={vi.index} ref={virtualizer.measureElement}>
                  {it.label} <span className="muted small">· {it.count}</span>
                </div>
              );
            if (it.k === 'total')
              return (
                <div key={vi.key} className="grid-total" style={style} data-index={vi.index} ref={virtualizer.measureElement}>
                  <TotalsLine t={it.t} settings={doc.settings} />
                </div>
              );
            if (it.k === 'empty')
              return (
                <div
                  key={vi.key}
                  className="grid-row empty-row"
                  style={style}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  role="row"
                >
                  {cols.map((c) => (
                    <div key={c.id} className={'gc gc-' + c.id} role="gridcell" data-col={c.id}>
                      {c.id === 'date' && (
                        <>
                          <span className={'empty-date' + (it.weekend ? ' ' + WEEKEND_CLASS : '')}>
                            {formatDate(it.key, true)}
                          </span>
                          <AddDayButton date={it.key} empty />
                        </>
                      )}
                    </div>
                  ))}
                </div>
              );
            const e = it.entry;
            return (
              <div
                key={vi.key}
                className={'grid-row entry-row' + (e.status === 'cancelled' ? ' cancelled' : '')}
                style={{ ...style, ['--tc' as string]: typeColor(doc.settings, e.type) }}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                role="row"
              >
                {cols.map((c) => (
                  <div key={c.id} className={'gc gc-' + c.id} role="gridcell" data-col={c.id}>
                    {c.id === 'open' ? (
                      <button type="button" className="icon-btn" aria-label="Открыть карточку" onClick={() => ui.openEntry(e.id)}>
                        ↗
                      </button>
                    ) : c.id === 'money' ? (
                      !typeHasMoney(doc.settings, e.type) ? null : (
                        <button type="button" className="cell-btn" onClick={() => ui.openMoney(e.id)}>
                          <PayIcon entry={e} settings={doc.settings} />{' '}
                          {moneySummary(e, doc.sources, doc.settings) || <span className="muted">—</span>}
                        </button>
                      )
                    ) : editing && editing.id === e.id && editing.col === c.id ? (
                      <CellEditor
                        entry={e}
                        col={c.id}
                        doc={doc}
                        onDone={(dx, dy) => (dx || dy ? move(editing, dx, dy) : setEditing(null))}
                      />
                    ) : (
                      <>
                        <div
                          className="cell-view"
                          tabIndex={0}
                          onClick={() => canEdit(e, c.id, doc) && setEditing({ id: e.id, col: c.id })}
                          onKeyDown={(ev) => {
                            if ((ev.key === 'Enter' || ev.key === 'F2') && canEdit(e, c.id, doc)) {
                              ev.preventDefault();
                              setEditing({ id: e.id, col: c.id });
                            }
                          }}
                        >
                          {cellText(e, c.id, doc)}
                        </div>
                        {c.id === 'date' && e.date && <AddDayButton date={e.date} />}
                      </>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** «+» — карточка новой записи на эту дату (тот же путь, что тап по дню в календаре: черновик до «Создать»). */
function AddDayButton({ date, empty, className }: { date: ISODate; empty?: boolean; className?: string }) {
  const ui = useUi();
  const label = (empty ? 'Добавить на ' : 'Добавить ещё на ') + formatDate(date);
  return (
    <button
      type="button"
      className={'day-add' + (empty ? ' day-add-empty' : '') + (className ? ' ' + className : '')}
      aria-label={label}
      title={label}
      onClick={(ev) => {
        ev.stopPropagation();
        ui.createEntry({ date });
      }}
    >
      +
    </button>
  );
}

function canEdit(e: Entry, col: ColId, doc: TrackerDoc): boolean {
  if (!COL_BY_ID[col].editable) return false;
  if (!typeHasMoney(doc.settings, e.type) && (col === 'amount' || col === 'method' || col === 'invoiceNo')) return false;
  return true;
}

function cellText(e: Entry, col: ColId, doc: TrackerDoc): React.ReactNode {
  switch (col) {
    case 'type':
      return (
        <span className="row gap-s">
          <span className="type-dot" style={{ background: typeColor(doc.settings, e.type) }} />
          {typeName(doc.settings, e.type).split(' ')[0]}
        </span>
      );
    case 'date':
      return (
        <span className={[e.dateTentative ? 'tentative' : '', isWeekend(e.date) ? WEEKEND_CLASS : ''].filter(Boolean).join(' ')}>
          {formatDateRange(e, true)}
        </span>
      );
    case 'time':
      return formatTime(e);
    case 'title':
      return (
        <span className="title-cell">
          {e.title || <span className="muted">без названия</span>}
          {e.checklist.length > 0 && (
            <span className="muted small">
              {' '}
              ☑{e.checklist.filter((c) => c.done).length}/{e.checklist.length}
            </span>
          )}
        </span>
      );
    case 'location':
      return e.location ?? '';
    case 'category':
      return e.category ?? '';
    case 'amount':
      return typeHasMoney(doc.settings, e.type) ? formatEUR(e.amount) : '';
    case 'method':
      return uniqueSorted(e.money.map((p) => methodLabel(p.method))).join(', ');
    case 'invoiceNo':
      return e.invoiceNo ?? '';
    case 'contact':
      return contactName(doc, e.contactId);
    case 'source':
      return sourceName(doc, e.sourceId);
    case 'status':
      return <StatusBadge status={e.status} />;
    case 'notes':
      return e.notes ?? '';
    default:
      return '';
  }
}

function editValue(e: Entry, col: ColId, doc: TrackerDoc): string {
  switch (col) {
    case 'date':
      return e.date ?? '';
    case 'time':
      return e.timeStart ? e.timeStart + (e.timeEnd ? '-' + e.timeEnd : '') : e.timeNote ?? '';
    case 'title':
      return e.title;
    case 'location':
      return e.location ?? '';
    case 'category':
      return e.category ?? '';
    case 'amount':
      return e.amount === undefined ? '' : String(e.amount);
    case 'method':
      return methodLabel(e.money[0]?.method);
    case 'invoiceNo':
      return e.invoiceNo ?? '';
    case 'notes':
      return e.notes ?? '';
    case 'type':
      return e.type;
    case 'status':
      return e.status;
    case 'source':
      return e.sourceId ?? '';
    case 'contact':
      return e.contactId ?? '';
    default:
      void doc;
      return '';
  }
}

function patchFor(e: Entry, col: ColId, v: string): Partial<Entry> | undefined {
  const s = v.trim();
  switch (col) {
    case 'date':
      return { date: s || undefined };
    case 'time':
      return parseTimeInput(s);
    case 'title':
      return { title: s };
    case 'location':
      return { location: s || undefined };
    case 'category':
      return { category: s || undefined };
    case 'amount':
      return { amount: parseAmount(s) };
    case 'invoiceNo':
      return { invoiceNo: s || undefined };
    case 'notes':
      return { notes: v || undefined };
    case 'type':
      return { type: v };
    case 'status':
      return { status: v as EntryStatus };
    case 'source':
      return { sourceId: v || undefined };
    case 'contact':
      return { contactId: v || undefined };
    case 'method': {
      const method = methodFromLabel(s);
      if (e.money.length) return { money: e.money.map((p) => ({ ...p, method })) };
      if (e.amount) return { money: [{ amount: e.amount, where: 'client', method, at: nowIso() }] };
      return undefined;
    }
    default:
      return undefined;
  }
}

function commitCell(e: Entry, col: ColId, v: string, doc: TrackerDoc) {
  if (v === editValue(e, col, doc)) return;
  const patch = patchFor(e, col, v);
  if (patch) store.updateEntry(e.id, withHistory(e, patch, doc.sources));
}

function CellEditor({
  entry,
  col,
  doc,
  onDone,
}: {
  entry: Entry;
  col: ColId;
  doc: TrackerDoc;
  onDone: (dx: number, dy: number) => void;
}) {
  const [v, setV] = useState(() => editValue(entry, col, doc));
  const finished = useRef(false);
  const finish = (dx: number, dy: number, save = true, value = v) => {
    if (finished.current) return;
    finished.current = true;
    if (save) commitCell(entry, col, value, doc);
    onDone(dx, dy);
  };
  const onKeyDown = (ev: RKeyboardEvent) => {
    if (ev.key === 'Tab') {
      ev.preventDefault();
      finish(ev.shiftKey ? -1 : 1, 0);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      finish(0, ev.shiftKey ? -1 : 1);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      finish(0, 0, false);
    }
  };
  const common = {
    autoFocus: true,
    className: 'cell-input',
    onKeyDown,
    onBlur: () => finish(0, 0),
    'aria-label': COL_BY_ID[col].label,
  };

  const select = (options: [string, string][]) => (
    <select {...common} value={v} onChange={(ev) => finish(0, 0, true, ev.target.value)}>
      {options.map(([val, label]) => (
        <option key={val} value={val}>
          {label}
        </option>
      ))}
    </select>
  );

  switch (col) {
    case 'type':
      return select(typeOptions(doc.settings, entry.type).map((t) => [t.id, t.name] as [string, string]));
    case 'status':
      return select(Object.entries(STATUS_LABELS));
    case 'source':
      return select([['', '—'], ...doc.sources.filter((s) => !s.deleted).map((s) => [s.id, s.name] as [string, string])]);
    case 'contact':
      return select([
        ['', '—'],
        ...doc.contacts.filter((c) => !c.deleted).map((c) => [c.id, c.name || c.phones[0] || '?'] as [string, string]),
      ]);
    case 'date':
      return <input {...common} type="date" value={v} onChange={(ev) => setV(ev.target.value)} />;
    default: {
      const list = col === 'location' ? 'tbl-locations' : col === 'category' ? 'tbl-categories' : col === 'method' ? 'tbl-methods' : undefined;
      return (
        <>
          <input
            {...common}
            list={list}
            inputMode={col === 'amount' ? 'decimal' : undefined}
            placeholder={col === 'time' ? '11-12 или 19.30' : undefined}
            value={v}
            onChange={(ev) => setV(ev.target.value)}
          />
          {list === 'tbl-locations' && (
            <datalist id="tbl-locations">
              {uniqueSorted(doc.entries.map((x) => x.location)).map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          )}
          {list === 'tbl-categories' && (
            <datalist id="tbl-categories">
              {uniqueSorted([...doc.settings.categories, ...doc.entries.map((x) => x.category)]).map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          )}
          {list === 'tbl-methods' && (
            <datalist id="tbl-methods">
              {['нал', 'револют', 'счёт'].map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          )}
        </>
      );
    }
  }
}

export function TotalsLine({ t, settings }: { t: MonthTotals; settings: Settings }) {
  const parts = turnoverByType(settings, t.byType);
  return (
    <div className="totals">
      <span>
        Оборот <b>{formatEUR(t.turnover)}</b>
      </span>
      <span className="muted totals-types">
        {parts.map((p, i) => (
          <span key={p.id} className="totals-type">
            {i > 0 && ' · '}
            <span className="type-dot" style={{ background: p.color }} /> {p.name.toLowerCase()} {formatEUR(p.amount)}
          </span>
        ))}
      </span>
      <span>
        чистыми ≈ <b>{formatEUR(t.net)}</b>
      </span>
      <span className="muted">
        получено {formatEUR(t.received)} · у посредников {formatEUR(t.atIntermediary)} · у клиентов{' '}
        {formatEUR(t.atClient)}
      </span>
    </div>
  );
}

// ---------- компактный список (телефон) ----------

function MobileList({ items, doc, scrollTo, dir }: { items: Item[]; doc: TrackerDoc; scrollTo?: ISODate; dir: SortDir }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const ui = useUi();
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const k = items[i].k;
      return k === 'row' ? 60 : k === 'empty' ? 40 : k === 'month' ? 40 : 70;
    },
    getItemKey: (i) => itemKey(items[i]),
    overscan: 8,
    initialRect: { width: 390, height: 700 },
  });
  useScrollToDay(virtualizer, items, scrollTo, dir);
  const headerOf = useMemo(() => monthHeaderIndex(items), [items]);
  return (
    <div className="mlist-scroll" ref={scrollRef}>
      <MonthPin
        items={items}
        headerOf={headerOf}
        rows={virtualizer.getVirtualItems()}
        scrollTop={virtualizer.scrollOffset ?? 0}
        className="mlist-month"
        height={40}
      />
      <div className="mlist-body" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const it = items[vi.index];
          const style = { transform: `translateY(${vi.start}px)` };
          if (it.k === 'month')
            return (
              <div key={vi.key} className="mlist-month" style={style} data-index={vi.index} ref={virtualizer.measureElement}>
                {it.label} <span className="muted small">· {it.count}</span>
              </div>
            );
          if (it.k === 'total')
            return (
              <div key={vi.key} className="mlist-total" style={style} data-index={vi.index} ref={virtualizer.measureElement}>
                <TotalsLine t={it.t} settings={doc.settings} />
              </div>
            );
          if (it.k === 'empty')
            return (
              <div
                key={vi.key}
                className="mlist-empty"
                style={style}
                data-index={vi.index}
                ref={virtualizer.measureElement}
              >
                <span className={'empty-date' + (it.weekend ? ' ' + WEEKEND_CLASS : '')}>{formatDate(it.key, true)}</span>
                <AddDayButton date={it.key} empty />
              </div>
            );
          const e = it.entry;
          return (
            <div
              key={vi.key}
              className="mlist-entry"
              style={{ ...style, ['--tc' as string]: typeColor(doc.settings, e.type) }}
              data-index={vi.index}
              ref={virtualizer.measureElement}
            >
              <button type="button" className="mlist-row" onClick={() => ui.openEntry(e.id)}>
                <span className={'mr-date' + (e.dateTentative ? ' tentative' : '')}>
                  <span className={isWeekend(e.date) ? WEEKEND_CLASS : undefined}>{formatDateRange(e) || '—'}</span>
                  <small>{formatTime(e)}</small>
                </span>
                <span className="mr-main">
                  <span className="mr-title">{e.title || 'без названия'}</span>
                  <span className="mr-sub muted">
                    {[e.location, e.category, sourceName(doc, e.sourceId)].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="mr-right">
                  {typeHasMoney(doc.settings, e.type) && e.amount !== undefined && <b>{formatEUR(e.amount)}</b>}
                  <span className="row gap-s">
                    <PayIcon entry={e} settings={doc.settings} />
                    <StatusBadge status={e.status} compact />
                  </span>
                </span>
              </button>
              {e.date && <AddDayButton date={e.date} className="mlist-add" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
