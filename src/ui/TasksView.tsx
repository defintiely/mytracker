// Экран «Задачи» (SPEC §6.2): канбан по статусам с перетаскиванием и списки «Сегодня / Неделя / Без даты / Просрочено».
import { useMemo, useState } from 'react';
import type { Entry, EntryStatus, TrackerDoc } from '../model/types';
import { STATUS_LABELS } from '../model/types';
import { typeHasMoney } from '../model/taskTypes';
import { store } from '../store/store';
import { useTracker } from '../store/useTracker';
import { useIsMobile } from './common';
import { EntryMini } from './EntryMini';
import { addDays, coversDay, lsGet, lsSet, overdueReason, todayISO, withHistory } from './util';

const BOARD: EntryStatus[] = ['lead', 'booked', 'shot', 'editing', 'delivered', 'done'];
const DONE_LIMIT = 30;

export function moveStatus(doc: TrackerDoc, id: string, status: EntryStatus) {
  const e = doc.entries.find((x) => x.id === id);
  if (!e || e.status === status) return;
  store.updateEntry(id, withHistory(e, { status }, doc.sources));
}

export interface TaskLists {
  today: Entry[];
  week: Entry[];
  undated: Entry[];
  overdue: { e: Entry; reason: string }[];
}

export function buildLists(doc: TrackerDoc, today: string): TaskLists {
  const live = doc.entries.filter((e) => !e.deleted && e.status !== 'cancelled');
  const weekEnd = addDays(today, 7);
  const byDate = (a: Entry, b: Entry) =>
    (a.date ?? '').localeCompare(b.date ?? '') || (a.timeStart ?? '').localeCompare(b.timeStart ?? '');
  const today_ = live.filter((e) => coversDay(e, today)).sort(byDate);
  const week = live.filter((e) => e.date && e.date > today && e.date <= weekEnd).sort(byDate);
  const undated = live
    .filter((e) => !e.date && e.status !== 'done' && e.kind !== 'payment')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const overdue = live
    .map((e) => ({ e, reason: overdueReason(e, doc.settings, today) }))
    .filter((x): x is { e: Entry; reason: string } => Boolean(x.reason))
    .sort((a, b) => byDate(a.e, b.e));
  return { today: today_, week, undated, overdue };
}

type Mode = 'lists' | 'board';

export function TasksView() {
  const doc = useTracker();
  const mobile = useIsMobile();
  const [mode, setModeState] = useState<Mode>(() => lsGet<Mode>('wlt.tasks.mode', mobile ? 'lists' : 'board'));
  const [showPersonal, setShowPersonal] = useState(false);
  const setMode = (m: Mode) => {
    setModeState(m);
    lsSet('wlt.tasks.mode', m);
  };
  return (
    <div className="view tasks-view">
      <div className="toolbar">
        <div className="seg">
          <button type="button" className={'seg-btn' + (mode === 'lists' ? ' on' : '')} onClick={() => setMode('lists')}>
            Списки
          </button>
          <button type="button" className={'seg-btn' + (mode === 'board' ? ' on' : '')} onClick={() => setMode('board')}>
            Канбан
          </button>
        </div>
        {mode === 'board' && (
          <label className="check">
            <input type="checkbox" checked={showPersonal} onChange={(e) => setShowPersonal(e.target.checked)} /> Личные
            дела
          </label>
        )}
      </div>
      {mode === 'lists' ? <Lists doc={doc} /> : <Board doc={doc} showPersonal={showPersonal} mobile={mobile} />}
    </div>
  );
}

function Lists({ doc }: { doc: TrackerDoc }) {
  const today = todayISO();
  const l = useMemo(() => buildLists(doc, today), [doc, today]);
  const section = (title: string, list: Entry[], notes?: Map<string, string>, cls = '') => (
    <section className={'task-list ' + cls}>
      <h3>
        {title} <span className="muted small">{list.length}</span>
      </h3>
      {list.length === 0 ? (
        <div className="muted small">пусто</div>
      ) : (
        list.map((e) => <EntryMini key={e.id} e={e} doc={doc} note={notes?.get(e.id)} />)
      )}
    </section>
  );
  return (
    <div className="lists">
      {l.overdue.length > 0 &&
        section(
          'Просрочено',
          l.overdue.map((x) => x.e),
          new Map(l.overdue.map((x) => [x.e.id, x.reason])),
          'overdue',
        )}
      {section('Сегодня', l.today)}
      {section('Неделя', l.week)}
      {section('Без даты', l.undated)}
    </div>
  );
}

function Board({ doc, showPersonal, mobile }: { doc: TrackerDoc; showPersonal: boolean; mobile: boolean }) {
  const [over, setOver] = useState<EntryStatus | null>(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const cols = useMemo(() => {
    const m = new Map<EntryStatus, Entry[]>(BOARD.map((s) => [s, []]));
    for (const e of doc.entries) {
      if (e.deleted || e.status === 'cancelled') continue;
      if (!showPersonal && !typeHasMoney(doc.settings, e.type)) continue;
      if (e.kind === 'note') continue;
      m.get(e.status)?.push(e);
    }
    for (const [s, list] of m) {
      list.sort((a, b) =>
        s === 'done'
          ? (b.date ?? b.updatedAt).localeCompare(a.date ?? a.updatedAt)
          : (a.date ?? '9999').localeCompare(b.date ?? '9999'),
      );
    }
    return m;
  }, [doc, showPersonal]);

  return (
    <div className="board">
      {BOARD.map((s) => {
        let list = cols.get(s) ?? [];
        const total = list.length;
        if (s === 'done' && !showAllDone) list = list.slice(0, DONE_LIMIT);
        return (
          <div
            key={s}
            className={'board-col' + (over === s ? ' drop' : '')}
            onDragOver={(ev) => {
              ev.preventDefault();
              ev.dataTransfer.dropEffect = 'move';
              if (over !== s) setOver(s);
            }}
            onDragLeave={() => setOver((o) => (o === s ? null : o))}
            onDrop={(ev) => {
              ev.preventDefault();
              setOver(null);
              const id = ev.dataTransfer.getData('text/plain');
              if (id) moveStatus(doc, id, s);
            }}
          >
            <h3>
              {STATUS_LABELS[s]} <span className="muted small">{total}</span>
            </h3>
            {list.map((e) => (
              <EntryMini
                key={e.id}
                e={e}
                doc={doc}
                draggable={!mobile}
                extra={
                  <select
                    className="move-select"
                    aria-label="Переместить в…"
                    value=""
                    onChange={(ev) => ev.target.value && moveStatus(doc, e.id, ev.target.value as EntryStatus)}
                  >
                    <option value="">→</option>
                    {(Object.keys(STATUS_LABELS) as EntryStatus[])
                      .filter((x) => x !== e.status)
                      .map((x) => (
                        <option key={x} value={x}>
                          {STATUS_LABELS[x]}
                        </option>
                      ))}
                  </select>
                }
              />
            ))}
            {s === 'done' && total > DONE_LIMIT && (
              <button type="button" className="small" onClick={() => setShowAllDone((v) => !v)}>
                {showAllDone ? 'Свернуть' : `Показать все (${total})`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
