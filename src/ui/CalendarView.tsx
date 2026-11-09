// Экран «Календарь» (SPEC §6.3): месяц и неделя, предварительные пунктиром, пересечения подсвечены,
// тап по дню — новая запись на эту дату; блок предложений из Google Календаря.
import { useEffect, useMemo, useState } from 'react';
import type { Entry, ISODate, TrackerDoc } from '../model/types';
import { MONTH_NAMES_RU } from '../model/entry';
import { store } from '../store/store';
import { useTracker } from '../store/useTracker';
import type { CalendarProposal } from '../calendar/calendarSync';
import { dismissProposal, getCalendarProposals, proposalToEntry, subscribeProposals } from '../calendar/calendarSync';
import { useIsMobile, useUi } from './common';
import {
  WEEKDAYS_MON_FIRST,
  addDays,
  coversDay,
  errorText,
  formatDate,
  overlappingIds,
  parseISODate,
  toISODate,
  todayISO,
} from './util';

type Mode = 'month' | 'week';

function mondayOf(d: ISODate): ISODate {
  const wd = (parseISODate(d).getDay() + 6) % 7;
  return addDays(d, -wd);
}

function entriesOn(list: Entry[], d: ISODate): Entry[] {
  return list
    .filter((e) => coversDay(e, d))
    .sort((a, b) => (a.timeStart ?? '99').localeCompare(b.timeStart ?? '99'));
}

export function CalendarView() {
  const doc = useTracker();
  const ui = useUi();
  const mobile = useIsMobile();
  const [mode, setMode] = useState<Mode>('month');
  const [anchor, setAnchor] = useState<ISODate>(todayISO());
  const today = todayISO();

  const live = useMemo(() => doc.entries.filter((e) => !e.deleted && e.date && e.status !== 'cancelled'), [doc]);

  const days: ISODate[] = useMemo(() => {
    if (mode === 'week') {
      const start = mondayOf(anchor);
      return Array.from({ length: 7 }, (_, i) => addDays(start, i));
    }
    const first = anchor.slice(0, 8) + '01';
    const start = mondayOf(first);
    const d = parseISODate(first);
    const last = toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    const end = addDays(mondayOf(last), 6);
    const out: ISODate[] = [];
    for (let x = start; x <= end; x = addDays(x, 1)) out.push(x);
    return out;
  }, [mode, anchor]);

  const shift = (dir: number) => {
    if (mode === 'week') setAnchor(addDays(anchor, 7 * dir));
    else {
      const d = parseISODate(anchor);
      setAnchor(toISODate(new Date(d.getFullYear(), d.getMonth() + dir, 1)));
    }
  };

  const ad = parseISODate(anchor);
  const title =
    mode === 'month'
      ? MONTH_NAMES_RU[ad.getMonth()][0].toUpperCase() + MONTH_NAMES_RU[ad.getMonth()].slice(1) + ' ' + ad.getFullYear()
      : `${formatDate(days[0])} – ${formatDate(days[6])}`;

  return (
    <div className="view calendar-view">
      <div className="toolbar">
        <button type="button" onClick={() => shift(-1)} aria-label="Назад">
          ‹
        </button>
        <button type="button" onClick={() => setAnchor(todayISO())}>
          Сегодня
        </button>
        <button type="button" onClick={() => shift(1)} aria-label="Вперёд">
          ›
        </button>
        <h2 className="cal-title">{title}</h2>
        <div className="seg">
          <button type="button" className={'seg-btn' + (mode === 'month' ? ' on' : '')} onClick={() => setMode('month')}>
            Месяц
          </button>
          <button type="button" className={'seg-btn' + (mode === 'week' ? ' on' : '')} onClick={() => setMode('week')}>
            Неделя
          </button>
        </div>
      </div>
      <Proposals />
      <div className={'cal cal-' + mode}>
        {WEEKDAYS_MON_FIRST.map((w) => (
          <div key={w} className="cal-wd">
            {w}
          </div>
        ))}
        {days.map((d) => {
          const list = entriesOn(live, d);
          const overlaps = overlappingIds(list);
          const outside = mode === 'month' && d.slice(0, 7) !== anchor.slice(0, 7);
          const maxShown = mode === 'month' ? (mobile ? 3 : 4) : 50;
          return (
            <div
              key={d}
              className={'cal-day' + (d === today ? ' today' : '') + (outside ? ' outside' : '')}
              onClick={(ev) => {
                if (ev.target === ev.currentTarget || (ev.target as HTMLElement).classList.contains('cal-num'))
                  ui.createEntry({ date: d });
              }}
              title="Нажмите на пустое место, чтобы добавить запись"
            >
              <div className="cal-num">
                {mode === 'week' ? `${WEEKDAYS_MON_FIRST[(parseISODate(d).getDay() + 6) % 7]} ${formatDate(d)}` : Number(d.slice(8))}
                {overlaps.size > 0 && (
                  <span className="cal-warn" title="Пересечение по времени">
                    ⚠
                  </span>
                )}
              </div>
              {list.slice(0, maxShown).map((e) => (
                <CalEvent key={e.id} e={e} doc={doc} overlap={overlaps.has(e.id)} compact={mode === 'month' && mobile} />
              ))}
              {list.length > maxShown && (
                <button
                  type="button"
                  className="cal-more"
                  onClick={() => {
                    setAnchor(d);
                    setMode('week');
                  }}
                >
                  +{list.length - maxShown}
                </button>
              )}
              {mode === 'week' && (
                <button type="button" className="cal-add" onClick={() => ui.createEntry({ date: d })}>
                  + запись
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalEvent({ e, doc, overlap, compact }: { e: Entry; doc: TrackerDoc; overlap: boolean; compact: boolean }) {
  const ui = useUi();
  return (
    <button
      type="button"
      className={'cal-ev' + (e.dateTentative ? ' tentative' : '') + (overlap ? ' overlap' : '')}
      style={{ ['--tc' as string]: doc.settings.typeColors[e.type] }}
      onClick={() => ui.openEntry(e.id)}
      title={(e.timeStart ? e.timeStart + ' ' : '') + e.title + (overlap ? ' — пересечение по времени!' : '')}
    >
      {!compact && e.timeStart && <span className="cal-time">{e.timeStart}</span>}
      <span className="cal-ev-title">{e.title || 'без названия'}</span>
    </button>
  );
}

function Proposals() {
  const [list, setList] = useState<CalendarProposal[]>(() => {
    try {
      return getCalendarProposals();
    } catch {
      return [];
    }
  });
  const [err, setErr] = useState<string>();
  useEffect(() => {
    try {
      return subscribeProposals(setList);
    } catch {
      return undefined;
    }
  }, []);
  if (!list.length) return null;
  const add = (p: CalendarProposal) => {
    try {
      store.upsertEntry(proposalToEntry(p));
      dismissProposal(p.eventId);
      setList((l) => l.filter((x) => x.eventId !== p.eventId));
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const hide = (p: CalendarProposal) => {
    try {
      dismissProposal(p.eventId);
    } catch {
      /* модуль календаря недоступен — просто скрываем */
    }
    setList((l) => l.filter((x) => x.eventId !== p.eventId));
  };
  return (
    <div className="proposals">
      <h3>Новые события в Google Календаре</h3>
      {err && <div className="hint warn">{err}</div>}
      {list.map((p) => (
        <div key={p.eventId} className="proposal">
          <div>
            <b>{p.title}</b>{' '}
            <span className="muted small">
              {[formatDate(p.date), p.timeStart && p.timeStart + (p.timeEnd ? '–' + p.timeEnd : ''), p.location]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          <div className="row gap">
            <button type="button" className="small primary" onClick={() => add(p)}>
              Добавить
            </button>
            <button type="button" className="small" onClick={() => hide(p)}>
              Скрыть
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
