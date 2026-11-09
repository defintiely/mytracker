// Экран «Таблица» (SPEC §6.1): группировка по месяцам, итоги, редактирование по месту, фильтры, виртуализация.
import { useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react';
import {
  columnVisibilityFeature,
  createColumnHelper,
  tableFeatures,
  useTable,
  type ColumnVisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Entry, EntryKind, EntryStatus, EntryType, Settings, TrackerDoc } from '../model/types';
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
  contactName,
  formatDateRange,
  formatTime,
  lsGet,
  lsSet,
  methodLabel,
  moneySummary,
  parseTimeInput,
  sourceName,
  uniqueSorted,
  withHistory,
} from './util';

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

const features = tableFeatures({ columnVisibilityFeature });
const helper = createColumnHelper<typeof features, Entry>();
const columns = COLS.map((c) => helper.display({ id: c.id, header: c.label, enableHiding: c.hideable }));

const COLS_KEY = 'wlt.table.columns';
const FILTERS_KEY = 'wlt.table.filters';

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
    if (f.kind && e.kind !== f.kind) return false;
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

function sortInMonth(a: Entry, b: Entry): number {
  if (a.date && b.date) return a.date.localeCompare(b.date) || (a.timeStart ?? '').localeCompare(b.timeStart ?? '');
  if (a.date) return -1;
  if (b.date) return 1;
  return a.createdAt.localeCompare(b.createdAt);
}

type Item =
  | { k: 'month'; key: string; label: string; count: number }
  | { k: 'row'; entry: Entry }
  | { k: 'total'; key: string; t: MonthTotals };

const NO_MONTH = '__none';

function buildItems(entries: Entry[], doc: TrackerDoc): Item[] {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const m = entryMonth(e) ?? NO_MONTH;
    const g = groups.get(m);
    if (g) g.push(e);
    else groups.set(m, [e]);
  }
  const keys = [...groups.keys()].filter((k) => k !== NO_MONTH).sort((a, b) => b.localeCompare(a));
  if (groups.has(NO_MONTH)) keys.push(NO_MONTH);
  const items: Item[] = [];
  for (const k of keys) {
    const list = groups.get(k)!.sort(sortInMonth);
    items.push({ k: 'month', key: k, label: k === NO_MONTH ? 'Без даты' : monthLabel(k), count: list.length });
    for (const e of list) items.push({ k: 'row', entry: e });
    if (k !== NO_MONTH) items.push({ k: 'total', key: k, t: monthTotals(list, k, doc.settings) });
  }
  return items;
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

  const filtered = useMemo(() => applyFilters(doc, filters), [doc, filters]);

  const table = useTable({
    features,
    columns,
    data: filtered,
    getRowId: (e: Entry) => e.id,
    state: { columnVisibility: colVis },
    onColumnVisibilityChange: (u) => {
      setColVis((prev) => {
        const next = typeof u === 'function' ? u(prev) : u;
        lsSet(COLS_KEY, next);
        return next;
      });
    },
  });

  const items = useMemo(() => buildItems(table.getRowModel().rows.map((r) => r.original), doc), [table, filtered, doc]);
  const visibleCols = table.getVisibleLeafColumns().map((c) => COL_BY_ID[c.id as ColId]);

  return (
    <div className="view table-view">
      <FilterBar doc={doc} filters={filters} onChange={setFilters} count={filtered.length} />
      {!mobile && (
        <details className="col-menu">
          <summary>Колонки</summary>
          <div className="col-menu-list">
            {table
              .getAllLeafColumns()
              .filter((c) => COL_BY_ID[c.id as ColId].hideable)
              .map((c) => (
                <label key={c.id} className="check">
                  <input type="checkbox" checked={c.getIsVisible()} onChange={() => c.toggleVisibility()} />{' '}
                  {COL_BY_ID[c.id as ColId].label}
                </label>
              ))}
          </div>
        </details>
      )}
      {items.length === 0 ? (
        <div className="empty">Записей нет. Добавьте первую строкой быстрого ввода сверху.</div>
      ) : mobile ? (
        <MobileList items={items} doc={doc} />
      ) : (
        <Grid items={items} cols={visibleCols} doc={doc} />
      )}
    </div>
  );
}

function FilterBar({
  doc,
  filters: f,
  onChange,
  count,
}: {
  doc: TrackerDoc;
  filters: Filters;
  onChange: (f: Filters) => void;
  count: number;
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
            Вид
            <select value={f.kind} onChange={(e) => set({ kind: e.target.value as EntryKind | '' })}>
              <option value="">все</option>
              {(Object.keys(KIND_LABELS) as EntryKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
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
      <span className="muted small">{count} зап.</span>
    </div>
  );
}

// ---------- сетка (ПК) ----------

interface EditPos {
  id: string;
  col: ColId;
}

function Grid({ items, cols, doc }: { items: Item[]; cols: ColMeta[]; doc: TrackerDoc }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<EditPos | null>(null);
  const ui = useUi();
  const template = cols.map((c) => c.width).join(' ');
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i].k === 'row' ? 34 : items[i].k === 'month' ? 38 : 52),
    getItemKey: (i) => {
      const it = items[i];
      return it.k === 'row' ? it.entry.id : it.k + ':' + it.key;
    },
    overscan: 10,
    initialRect: { width: 1200, height: 800 },
  });

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
      <div className="grid-inner" style={{ ['--cols' as string]: template }}>
        <div className="grid-head grid-row" role="row">
          {cols.map((c) => (
            <div key={c.id} className="gh" role="columnheader">
              {c.label}
            </div>
          ))}
        </div>
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
                  <div key={c.id} className={'gc gc-' + c.id} role="gridcell">
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
      return <span className={e.dateTentative ? 'tentative' : ''}>{formatDateRange(e, true)}</span>;
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

function MobileList({ items, doc }: { items: Item[]; doc: TrackerDoc }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const ui = useUi();
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i].k === 'row' ? 60 : items[i].k === 'month' ? 40 : 70),
    getItemKey: (i) => {
      const it = items[i];
      return it.k === 'row' ? it.entry.id : it.k + ':' + it.key;
    },
    overscan: 8,
    initialRect: { width: 390, height: 700 },
  });
  return (
    <div className="mlist-scroll" ref={scrollRef}>
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
          const e = it.entry;
          return (
            <button
              type="button"
              key={vi.key}
              className="mlist-row"
              style={{ ...style, ['--tc' as string]: typeColor(doc.settings, e.type) }}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              onClick={() => ui.openEntry(e.id)}
            >
              <span className={'mr-date' + (e.dateTentative ? ' tentative' : '')}>
                {formatDateRange(e) || '—'}
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
          );
        })}
      </div>
    </div>
  );
}
