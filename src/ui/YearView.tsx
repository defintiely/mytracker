// Вид «Год» экрана «Таблица»: 12 карточек месяцев с мини-календарём и коротким итогом.
// Клик по карточке открывает таблицу этого месяца, клик по дню — тот же месяц с перемоткой к дню.
import { useMemo } from 'react';
import type { Entry, EntryType, ISODate, TrackerDoc, YearMonth } from '../model/types';
import { MONTH_NAMES_RU, entryMonth, formatEUR, monthLabel, monthTotals, type MonthTotals } from '../model/entry';
import { typeColor, typeName } from '../model/taskTypes';
import { WEEKDAYS_MON_FIRST, WEEKEND_CLASS, addDays, isWeekend, pad2, parseISODate, todayISO } from './util';

/** Не больше стольких точек типов под днём. */
const MAX_DOTS = 3;

/** «1 задача», «2 задачи», «5 задач». */
export function tasksWord(n: number): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return 'задача';
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return 'задачи';
  return 'задач';
}

interface MonthCard {
  month: YearMonth;
  count: number;
  totals: MonthTotals;
}

export function YearView({
  doc,
  entries,
  year,
  onYear,
  onOpenMonth,
  hint,
}: {
  doc: TrackerDoc;
  /** Записи после фильтров таблицы (без периода). */
  entries: Entry[];
  year: number;
  onYear: (y: number) => void;
  onOpenMonth: (m: YearMonth, day?: ISODate) => void;
  hint?: string;
}) {
  const today = todayISO();
  const currentMonth = today.slice(0, 7);
  const currentYear = Number(today.slice(0, 4));

  const { cards, dayTypes } = useMemo(() => {
    const prefix = year + '-';
    const byMonth = new Map<YearMonth, Entry[]>();
    /** День → типы записей этого дня (по порядку появления, без повторов). */
    const days = new Map<ISODate, EntryType[]>();
    const mark = (d: ISODate, t: EntryType) => {
      if (!d.startsWith(prefix)) return;
      const list = days.get(d);
      if (!list) days.set(d, [t]);
      else if (!list.includes(t)) list.push(t);
    };
    for (const e of entries) {
      const m = entryMonth(e);
      if (m?.startsWith(prefix)) {
        const g = byMonth.get(m);
        if (g) g.push(e);
        else byMonth.set(m, [e]);
      }
      if (e.date) {
        // многодневная запись отмечает все свои дни (не больше года)
        let d = e.date;
        mark(d, e.type);
        for (let i = 0; i < 366 && e.dateEnd && d < e.dateEnd; i++) {
          d = addDays(d, 1);
          mark(d, e.type);
        }
      }
    }
    const cards: MonthCard[] = Array.from({ length: 12 }, (_, i) => {
      const month = `${year}-${pad2(i + 1)}`;
      const list = byMonth.get(month) ?? [];
      return { month, count: list.length, totals: monthTotals(list, month, doc.settings) };
    });
    return { cards, dayTypes: days };
  }, [entries, year, doc.settings]);

  return (
    <div className="year-view">
      <div className="year-nav">
        <button type="button" aria-label="Предыдущий год" onClick={() => onYear(year - 1)}>
          ‹
        </button>
        <h2 className="year-title">{year}</h2>
        <button type="button" aria-label="Следующий год" onClick={() => onYear(year + 1)}>
          ›
        </button>
        {year !== currentYear && (
          <button type="button" className="small" onClick={() => onYear(currentYear)}>
            Текущий год
          </button>
        )}
      </div>
      {hint && <p className="hint">{hint}</p>}
      <div className="year-grid">
        {cards.map((c) => (
          <YearCard
            key={c.month}
            card={c}
            doc={doc}
            dayTypes={dayTypes}
            today={today}
            current={c.month === currentMonth}
            onOpen={onOpenMonth}
          />
        ))}
      </div>
    </div>
  );
}

function YearCard({
  card,
  doc,
  dayTypes,
  today,
  current,
  onOpen,
}: {
  card: MonthCard;
  doc: TrackerDoc;
  dayTypes: Map<ISODate, EntryType[]>;
  today: ISODate;
  current: boolean;
  onOpen: (m: YearMonth, day?: ISODate) => void;
}) {
  const { month, count, totals: t } = card;
  const [y, mm] = month.split('-').map(Number);
  const name = MONTH_NAMES_RU[mm - 1];
  const daysInMonth = new Date(y, mm, 0).getDate();
  // пустые клетки до первого числа: неделя с понедельника
  const lead = (parseISODate(`${month}-01`).getDay() + 6) % 7;
  const waiting = t.atClient + t.atIntermediary;
  const label = `${monthLabel(month)}: ${count} ${tasksWord(count)}, оборот ${formatEUR(t.turnover)}`;

  return (
    <div className={'ycard' + (current ? ' is-current' : '') + (count ? '' : ' is-empty')}>
      <button type="button" className="ycard-open" aria-label={label} onClick={() => onOpen(month)}>
        <span className="ycard-name">{name[0].toUpperCase() + name.slice(1)}</span>
        {current && <span className="ycard-now">сейчас</span>}
      </button>
      <div className="ycal">
        {WEEKDAYS_MON_FIRST.map((w, i) => (
          <span key={w} className={'ycal-wd' + (i >= 5 ? ' ycal-wd-end' : '')} aria-hidden>
            {w[0]}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={'b' + i} aria-hidden />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const d = `${month}-${pad2(i + 1)}`;
          const types = dayTypes.get(d) ?? [];
          const names = types.map((tp) => typeName(doc.settings, tp)).join(', ');
          return (
            <button
              type="button"
              key={d}
              tabIndex={-1}
              className={
                'yday' +
                (isWeekend(d) ? ' ' + WEEKEND_CLASS : '') +
                (d === today ? ' is-today' : '') +
                (types.length ? ' has-entries' : '')
              }
              aria-label={`Открыть ${i + 1} ${monthGenitive(mm)} ${y}` + (names ? ` (${names})` : '')}
              title={names || undefined}
              onClick={() => onOpen(month, d)}
            >
              <span className="yday-n">{i + 1}</span>
              <span className="yday-dots" aria-hidden>
                {types.slice(0, MAX_DOTS).map((tp) => (
                  <i key={tp} style={{ background: typeColor(doc.settings, tp) }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      {count === 0 ? (
        <p className="ycard-sum muted">Записей нет</p>
      ) : (
        <dl className="ycard-sum">
          <div>
            <dt>Задач</dt>
            <dd>{count}</dd>
          </div>
          <div>
            <dt>Оборот</dt>
            <dd>
              <b>{formatEUR(t.turnover)}</b>
            </dd>
          </div>
          <div>
            <dt>Чистыми ≈</dt>
            <dd>{formatEUR(t.net)}</dd>
          </div>
          <div>
            <dt>Получено</dt>
            <dd>{formatEUR(t.received)}</dd>
          </div>
          <div title={`у клиентов ${formatEUR(t.atClient)} · у посредников ${formatEUR(t.atIntermediary)}`}>
            <dt>Ждём</dt>
            <dd>{formatEUR(waiting)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function monthGenitive(mm: number): string {
  return MONTHS_GENITIVE[mm - 1];
}
