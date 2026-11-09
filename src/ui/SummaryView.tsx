// Экран «Итоги» (SPEC §6.4): по месяцам и годам — оборот, чистыми ≈, съёмки, средний чек,
// разбивка по категориям и источникам, деньги у клиентов/посредников, сравнение с прошлым годом.
import { useMemo, useState } from 'react';
import type { Entry, TrackerDoc, YearMonth } from '../model/types';
import { entryMonth, formatEUR, monthLabel, monthTotals, type MonthTotals } from '../model/entry';
import { useTracker } from '../store/useTracker';
import { MONTH_NAMES_RU } from '../model/entry';
import { sourceName } from './util';

function countable(doc: TrackerDoc): Entry[] {
  return doc.entries.filter((e) => !e.deleted && e.status !== 'cancelled' && e.type !== 'personal');
}

/** Средний чек: оборот / число записей с положительной суммой (съёмки и обработка). */
function avgCheck(list: Entry[]): number {
  const paid = list.filter((e) => (e.amount ?? 0) > 0 && (e.kind === 'shoot' || e.kind === 'work'));
  if (!paid.length) return 0;
  return Math.round(paid.reduce((s, e) => s + (e.amount ?? 0), 0) / paid.length);
}

function sumTotals(list: MonthTotals[], month: string): MonthTotals {
  const t: MonthTotals = { month, turnover: 0, net: 0, main: 0, joint: 0, received: 0, atIntermediary: 0, atClient: 0, shoots: 0 };
  for (const x of list) {
    t.turnover += x.turnover;
    t.net += x.net;
    t.main += x.main;
    t.joint += x.joint;
    t.received += x.received;
    t.atIntermediary += x.atIntermediary;
    t.atClient += x.atClient;
    t.shoots += x.shoots;
  }
  t.net = Math.round(t.net * 100) / 100;
  return t;
}

function Breakdown({ title, rows }: { title: string; rows: [string, number][] }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r[1])));
  return (
    <section className="breakdown">
      <h3>{title}</h3>
      {rows.length === 0 && <div className="muted small">нет данных</div>}
      {rows.map(([k, v]) => (
        <div className="bar-row" key={k}>
          <span className="bar-label">{k}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(Math.abs(v) / max) * 100}%` }} />
          </span>
          <span className="bar-value">{formatEUR(v)}</span>
        </div>
      ))}
    </section>
  );
}

function groupSum(list: Entry[], key: (e: Entry) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const e of list) m.set(key(e), (m.get(key(e)) ?? 0) + (e.amount ?? 0));
  return [...m.entries()].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
}

export function SummaryView() {
  const doc = useTracker();
  const list = useMemo(() => countable(doc), [doc]);
  const years = useMemo(() => {
    const ys = new Set<number>();
    for (const e of list) {
      const m = entryMonth(e);
      if (m) ys.add(Number(m.slice(0, 4)));
    }
    ys.add(new Date().getFullYear());
    return [...ys].sort((a, b) => b - a);
  }, [list]);
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState<YearMonth | ''>('');

  const months = useMemo(
    () => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}` as YearMonth),
    [year],
  );
  const totals = months.map((m) => monthTotals(list, m, doc.settings));
  const prevTotals = months.map((m) => monthTotals(list, `${year - 1}${m.slice(4)}`, doc.settings));
  const yearT = sumTotals(totals, String(year));
  const prevYearT = sumTotals(prevTotals, String(year - 1));
  const maxTurnover = Math.max(1, ...totals.map((t) => t.turnover), ...prevTotals.map((t) => t.turnover));

  const scope = list.filter((e) => {
    const m = entryMonth(e);
    return month ? m === month : m?.startsWith(String(year));
  });
  const byCat = groupSum(scope, (e) => e.category || 'без категории');
  const bySrc = groupSum(scope, (e) => sourceName(doc, e.sourceId) || 'свои заказы');
  const scopeT = month ? totals[months.indexOf(month)] : yearT;
  const scopePrev = month ? prevTotals[months.indexOf(month)] : prevYearT;

  const allYears = years
    .map((y) => {
      const ts = Array.from({ length: 12 }, (_, i) => monthTotals(list, `${y}-${String(i + 1).padStart(2, '0')}`, doc.settings));
      return { y, t: sumTotals(ts, String(y)) };
    })
    .filter((x) => x.t.turnover !== 0 || x.y === new Date().getFullYear());
  const maxYear = Math.max(1, ...allYears.map((x) => x.t.turnover));

  const delta = (cur: number, prev: number) => {
    if (!prev) return null;
    const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
    return <span className={pct >= 0 ? 'up' : 'down'}>{(pct >= 0 ? '+' : '') + pct}%</span>;
  };

  return (
    <div className="view summary-view">
      <div className="toolbar">
        <select value={year} onChange={(e) => (setYear(Number(e.target.value)), setMonth(''))} aria-label="Год">
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <select value={month} onChange={(e) => setMonth(e.target.value as YearMonth | '')} aria-label="Месяц">
          <option value="">весь год</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </select>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Оборот</div>
          <div className="stat-value">{formatEUR(scopeT.turnover)}</div>
          <div className="stat-sub">
            год назад {formatEUR(scopePrev.turnover)} {delta(scopeT.turnover, scopePrev.turnover)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Чистыми ≈</div>
          <div className="stat-value">{formatEUR(scopeT.net)}</div>
          <div className="stat-sub">× {doc.settings.netFactor}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Съёмок</div>
          <div className="stat-value">{scopeT.shoots}</div>
          <div className="stat-sub">год назад {scopePrev.shoots}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Средний чек</div>
          <div className="stat-value">{formatEUR(avgCheck(scope))}</div>
        </div>
        <div className="stat">
          <div className="stat-label">У клиентов / у посредников</div>
          <div className="stat-value small-value">
            {formatEUR(scopeT.atClient)} / {formatEUR(scopeT.atIntermediary)}
          </div>
          <div className="stat-sub">получено {formatEUR(scopeT.received)}</div>
        </div>
      </div>

      <section className="months-chart">
        <h3>
          Оборот по месяцам {year} <span className="legend-prev">— {year - 1}</span>
        </h3>
        <div className="mchart">
          {totals.map((t, i) => (
            <button
              type="button"
              key={t.month}
              className={'mbar' + (month === t.month ? ' on' : '')}
              onClick={() => setMonth(month === t.month ? '' : t.month)}
              title={`${monthLabel(t.month)}: ${formatEUR(t.turnover)} (год назад ${formatEUR(prevTotals[i].turnover)})`}
            >
              <span className="mbar-val">{t.turnover ? Math.round(t.turnover / 100) / 10 + 'k' : ''}</span>
              <span className="mbar-cols">
                <span className="mbar-prev" style={{ height: `${(prevTotals[i].turnover / maxTurnover) * 100}%` }} />
                <span className="mbar-cur" style={{ height: `${(t.turnover / maxTurnover) * 100}%` }} />
              </span>
              <span className="mbar-label">{MONTH_NAMES_RU[i].slice(0, 3)}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="table-wrap">
        <table className="summary-table">
          <thead>
            <tr>
              <th>Месяц</th>
              <th>Оборот</th>
              <th>осн.</th>
              <th>совм.</th>
              <th>Чистыми ≈</th>
              <th>Съёмок</th>
              <th>Год назад</th>
              <th>У клиентов</th>
              <th>У посредников</th>
            </tr>
          </thead>
          <tbody>
            {totals.map((t, i) => (
              <tr key={t.month} className={month === t.month ? 'on' : ''}>
                <td>{monthLabel(t.month)}</td>
                <td>{formatEUR(t.turnover)}</td>
                <td>{formatEUR(t.main)}</td>
                <td>{formatEUR(t.joint)}</td>
                <td>{formatEUR(t.net)}</td>
                <td>{t.shoots}</td>
                <td>
                  {formatEUR(prevTotals[i].turnover)} {delta(t.turnover, prevTotals[i].turnover)}
                </td>
                <td>{formatEUR(t.atClient)}</td>
                <td>{formatEUR(t.atIntermediary)}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Итого {year}</td>
              <td>{formatEUR(yearT.turnover)}</td>
              <td>{formatEUR(yearT.main)}</td>
              <td>{formatEUR(yearT.joint)}</td>
              <td>{formatEUR(yearT.net)}</td>
              <td>{yearT.shoots}</td>
              <td>
                {formatEUR(prevYearT.turnover)} {delta(yearT.turnover, prevYearT.turnover)}
              </td>
              <td>{formatEUR(yearT.atClient)}</td>
              <td>{formatEUR(yearT.atIntermediary)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="grid2 breakdowns">
        <Breakdown title={`По категориям · ${month ? monthLabel(month) : year}`} rows={byCat} />
        <Breakdown title={`По источникам · ${month ? monthLabel(month) : year}`} rows={bySrc} />
      </div>

      <section className="breakdown">
        <h3>По годам</h3>
        {allYears.map(({ y, t }) => (
          <div className="bar-row" key={y}>
            <span className="bar-label">{y}</span>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${(Math.max(0, t.turnover) / maxYear) * 100}%` }} />
            </span>
            <span className="bar-value">
              {formatEUR(t.turnover)} <span className="muted small">≈{formatEUR(t.net)} · {t.shoots} съёмок</span>
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
