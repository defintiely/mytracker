// Мастер импорта .ods (SPEC §9): файл → типы (для строк с суммой / без суммы и «цвет → тип») → проверка → импорт.
import { useMemo, useState } from 'react';
import type { Entry, EntryStatus, Source, TrackerDoc } from '../model/types';
import { KIND_LABELS, STATUS_LABELS } from '../model/types';
import { formatEUR, monthLabel } from '../model/entry';
import { defaultNoMoneyTypeId, defaultTypeId, taskTypes, typeColor, typeHasMoney, typeOptions } from '../model/taskTypes';
import type { ColorRole, ImportOptions, ImportResult, ImportedRow } from '../ods/types';
import { importOds } from '../ods/importOds';
import { store } from '../store/store';
import { useTracker } from '../store/useTracker';
import { CommitInput, parseAmount } from './common';
import { errorText, formatDateRange, intermediaryToOwner } from './util';

type Step = 'file' | 'colors' | 'review' | 'done';
const PAGE = 200;

function originKeys(doc: TrackerDoc): Set<string> {
  const s = new Set<string>();
  for (const e of doc.entries) if (e.origin) s.add(`${e.origin.sheet}|${e.origin.row}|${e.origin.raw}`);
  return s;
}

export function ImportWizard() {
  const doc = useTracker();
  const [step, setStep] = useState<Step>('file');
  const [data, setData] = useState<Uint8Array>();
  const [fileName, setFileName] = useState('');
  const [first, setFirst] = useState<ImportResult>();
  const [colorMap, setColorMap] = useState<Record<string, ColorRole | ''>>({});
  const [result, setResult] = useState<ImportResult>();
  const [rows, setRows] = useState<ImportedRow[]>([]);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [onlyLow, setOnlyLow] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();

  const [moneyTypeId, setMoneyTypeId] = useState(() => defaultTypeId(doc.settings));
  const [noMoneyTypeId, setNoMoneyTypeId] = useState(() => defaultNoMoneyTypeId(doc.settings));

  const baseOpts = (): ImportOptions => ({
    existingSources: doc.sources,
    existingContacts: doc.contacts,
    existingOriginKeys: originKeys(doc),
    taskTypes: doc.settings.taskTypes,
    categories: doc.settings.categories,
    moneyTypeId,
    noMoneyTypeId,
  });

  const reset = () => {
    setStep('file');
    setData(undefined);
    setFirst(undefined);
    setResult(undefined);
    setRows([]);
    setExcluded(new Set());
    setSelected(new Set());
    setErr(undefined);
    setShown(PAGE);
  };

  const toReview = (r: ImportResult) => {
    setResult(r);
    setRows(r.rows);
    setExcluded(new Set());
    setSelected(new Set());
    setShown(PAGE);
    setStep('review');
  };

  const onFile = async (f: File) => {
    setErr(undefined);
    setBusy(true);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      setData(bytes);
      setFileName(f.name);
      const r = importOds(bytes, baseOpts());
      setFirst(r);
      setColorMap(Object.fromEntries(r.colors.map((c) => [c.color, ''])));
      // Шаг «типы» показывается всегда: там же выбираются типы для строк без цвета.
      setStep('colors');
    } catch (e) {
      setErr('Не удалось разобрать файл: ' + errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const applyColors = () => {
    if (!data) return;
    setErr(undefined);
    try {
      const cm: Record<string, ColorRole> = {};
      for (const [k, v] of Object.entries(colorMap)) if (v) cm[k] = v;
      toReview(importOds(data, { ...baseOpts(), colorMap: cm }));
    } catch (e) {
      setErr('Ошибка разбора: ' + errorText(e));
    }
  };

  const allSources: Source[] = useMemo(() => [...doc.sources, ...(result?.sources ?? [])].filter((s) => !s.deleted), [doc.sources, result]);

  const patchRow = (i: number, patch: Partial<Entry>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, entry: { ...r.entry, ...patch } } : r)));

  const bulk = (fn: (e: Entry) => Partial<Entry>) => {
    setRows((rs) => rs.map((r, j) => (selected.has(j) ? { ...r, entry: { ...r.entry, ...fn(r.entry) } } : r)));
  };

  const doImport = () => {
    if (!result) return;
    const entries = rows.filter((_, i) => !excluded.has(i)).map((r) => r.entry);
    const usedSources = new Set<string>();
    const usedContacts = new Set<string>();
    for (const e of entries) {
      if (e.sourceId) usedSources.add(e.sourceId);
      if (e.contactId) usedContacts.add(e.contactId);
      for (const p of e.money) if (p.holderId) usedSources.add(p.holderId);
    }
    const newSources = result.sources.filter((s) => usedSources.has(s.id));
    const newContacts = result.contacts.filter((c) => usedContacts.has(c.id));
    for (const s of newSources) store.upsertSource(s);
    for (const c of newContacts) store.upsertContact(c);
    store.addEntries(entries);
    setDone(
      `Импортировано записей: ${entries.length}, новых источников: ${newSources.length}, контактов: ${newContacts.length}.`,
    );
    setStep('done');
  };

  if (step === 'done')
    return (
      <div className="wizard">
        <div className="hint ok">{done}</div>
        <button type="button" onClick={reset}>
          Импортировать ещё файл
        </button>
      </div>
    );

  return (
    <div className="wizard">
      <ol className="wizard-steps">
        <li className={step === 'file' ? 'on' : ''}>Файл</li>
        <li className={step === 'colors' ? 'on' : ''}>Типы</li>
        <li className={step === 'review' ? 'on' : ''}>Проверка</li>
      </ol>
      {err && <div className="hint warn">{err}</div>}

      {step === 'file' && (
        <div>
          <p className="hint">
            Выберите файл трекера (.ods). Он читается прямо в браузере и никуда не загружается. Повторный импорт того же
            файла не создаёт дублей.
          </p>
          <label className="btn primary">
            {busy ? 'Читаю…' : 'Выбрать файл .ods'}
            <input
              type="file"
              accept=".ods,application/vnd.oasis.opendocument.spreadsheet"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      )}

      {step === 'colors' && first && (
        <div>
          <p className="hint">
            Файл «{fileName}». Строки без цвета (и цвета «по тексту») получают тип по сумме: есть сумма или признаки
            работы — один тип, нет — другой.
          </p>
          <div className="grid2">
            <div className="field">
              <label htmlFor="iw-money">Строки с суммой → тип</label>
              <select id="iw-money" value={moneyTypeId} onChange={(e) => setMoneyTypeId(e.target.value)}>
                {taskTypes(doc.settings).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="iw-nomoney">Строки без суммы → тип</label>
              <select id="iw-nomoney" value={noMoneyTypeId} onChange={(e) => setNoMoneyTypeId(e.target.value)}>
                {taskTypes(doc.settings).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {first.colors.length > 0 && (
            <p className="hint">
              Если цвет фона строки в файле обозначал тип — сопоставьте цвета с типами. Цветов может быть больше, чем
              типов: лишний цвет можно оставить «по тексту».
            </p>
          )}
          <div className="color-map">
            {first.colors.map((c) => (
              <div className="color-row" key={c.color}>
                <span className="swatch" style={{ background: c.color }} title={c.color} />
                <div className="color-info">
                  <div>
                    <b>{c.count}</b> строк · <code>{c.color}</code>
                    <span className="muted small"> · с суммой или признаками работы: {c.withMoney}</span>
                  </div>
                  <ul className="samples">
                    {c.samples.slice(0, 5).map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
                <select
                  aria-label={'Тип для ' + c.color}
                  value={colorMap[c.color] ?? ''}
                  onChange={(e) => setColorMap({ ...colorMap, [c.color]: e.target.value as ColorRole | '' })}
                >
                  <option value="">по тексту строки</option>
                  {taskTypes(doc.settings).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                  <option value="important">не тип — пометка «важно»</option>
                </select>
              </div>
            ))}
          </div>
          <div className="row gap">
            <button type="button" onClick={reset}>
              Назад
            </button>
            <button type="button" className="primary" onClick={applyColors}>
              Дальше
            </button>
          </div>
        </div>
      )}

      {step === 'review' && result && (
        <Review
          result={result}
          rows={rows}
          sources={allSources}
          excluded={excluded}
          setExcluded={setExcluded}
          selected={selected}
          setSelected={setSelected}
          onlyLow={onlyLow}
          setOnlyLow={setOnlyLow}
          shown={shown}
          setShown={setShown}
          patchRow={patchRow}
          bulk={bulk}
          onBack={() => (first ? setStep('colors') : reset())}
          onImport={doImport}
        />
      )}
    </div>
  );
}

/**
 * Старые записи: в файле часто нет пометки «оплачено», и импорт считает деньги «у клиента».
 * Одним действием: всё, что раньше выбранной даты, — деньги получены, запись закрыта.
 */
function SettleBefore(props: { rows: ImportedRow[]; patchRow: (i: number, p: Partial<Entry>) => void }) {
  const [before, setBefore] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 2);
    return d.toISOString().slice(0, 10);
  });
  const [done, setDone] = useState<number>();
  const apply = () => {
    let n = 0;
    props.rows.forEach((r, i) => {
      const e = r.entry;
      const when = e.date ?? (e.accountingMonth ? e.accountingMonth + '-01' : undefined);
      if (!when || when >= before || !typeHasMoney(store.getDoc().settings, e.type) || !e.amount) return;
      const settled = e.money.every((m) => m.where === 'owner');
      if (settled && e.status === 'done') return;
      const method = e.money.find((m) => m.method)?.method;
      props.patchRow(i, {
        money: [{ amount: e.amount, where: 'owner', ...(method ? { method } : {}) }],
        status: e.status === 'cancelled' ? 'cancelled' : 'done',
      });
      n++;
    });
    setDone(n);
  };
  return (
    <div className="row gap wrap">
      <span className="muted small">Всё раньше</span>
      <input type="date" aria-label="Дата, раньше которой всё получено" value={before} onChange={(e) => setBefore(e.target.value)} />
      <button type="button" className="small" onClick={apply} disabled={!before}>
        → деньги получены, закрыто
      </button>
      {done !== undefined && <span className="muted small">изменено {done}</span>}
    </div>
  );
}

function Review(props: {
  result: ImportResult;
  rows: ImportedRow[];
  sources: Source[];
  excluded: Set<number>;
  setExcluded: (s: Set<number>) => void;
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  onlyLow: boolean;
  setOnlyLow: (v: boolean) => void;
  shown: number;
  setShown: (n: number) => void;
  patchRow: (i: number, p: Partial<Entry>) => void;
  bulk: (fn: (e: Entry) => Partial<Entry>) => void;
  onBack: () => void;
  onImport: () => void;
}) {
  const { result, rows, sources, excluded, selected } = props;
  const idx = rows.map((_, i) => i).filter((i) => !props.onlyLow || rows[i].confidence === 'low');
  const visible = idx.slice(0, props.shown);
  const lowCount = rows.filter((r) => r.confidence === 'low').length;
  const badChecks = result.monthChecks.filter((m) => !m.ok);
  const toggle = (set: Set<number>, i: number) => {
    const n = new Set(set);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    return n;
  };
  const includedCount = rows.length - excluded.size;
  const docSources = sources;
  const settings = store.getDoc().settings;

  return (
    <div className="review">
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Распознано строк</div>
          <div className="stat-value">{rows.length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Неуверенных</div>
          <div className="stat-value">{lowCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Пропущено</div>
          <div className="stat-value">{result.skipped.length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Сверка месяцев</div>
          <div className={'stat-value' + (badChecks.length ? ' bad' : '')}>
            {badChecks.length ? `${badChecks.length} расх.` : 'ОК'}
          </div>
        </div>
      </div>

      <div className="toolbar wrap">
        <label className="check">
          <input type="checkbox" checked={props.onlyLow} onChange={(e) => props.setOnlyLow(e.target.checked)} /> Только
          неуверенные
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={selected.size > 0 && selected.size === idx.length}
            onChange={(e) => props.setSelected(e.target.checked ? new Set(idx) : new Set())}
          />{' '}
          Выделить все ({idx.length})
        </label>
        <SettleBefore rows={rows} patchRow={props.patchRow} />
        {selected.size > 0 && (
          <div className="bulk row gap wrap">
            <span className="muted small">Выделено {selected.size}:</span>
            <select aria-label="Тип выделенным" value="" onChange={(e) => e.target.value && props.bulk(() => ({ type: e.target.value }))}>
              <option value="">тип…</option>
              {taskTypes(settings).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Источник выделенным"
              value=""
              onChange={(e) => e.target.value && props.bulk(() => ({ sourceId: e.target.value === '__none' ? undefined : e.target.value }))}
            >
              <option value="">источник…</option>
              <option value="__none">— свой заказ —</option>
              {docSources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Статус выделенным"
              value=""
              onChange={(e) => e.target.value && props.bulk(() => ({ status: e.target.value as EntryStatus }))}
            >
              <option value="">статус…</option>
              {(Object.keys(STATUS_LABELS) as EntryStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <button type="button" className="small" onClick={() => props.bulk((e) => ({ money: intermediaryToOwner(e, undefined, docSources).money ?? e.money }))}>
              Деньги у посредников → получено
            </button>
            <button type="button" className="small" onClick={() => props.setExcluded(new Set([...excluded, ...selected]))}>
              Не импортировать
            </button>
            <button
              type="button"
              className="small"
              onClick={() => props.setExcluded(new Set([...excluded].filter((i) => !selected.has(i))))}
            >
              Вернуть
            </button>
          </div>
        )}
      </div>

      <div className="table-wrap review-table-wrap">
        <table className="review-table">
          <thead>
            <tr>
              <th />
              <th>Лист / строка</th>
              <th>Как было</th>
              <th>Тип</th>
              <th>Дата</th>
              <th>Название</th>
              <th>Сумма</th>
              <th>Источник</th>
              <th>Статус</th>
              <th>Пометки</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((i) => {
              const r = rows[i];
              const e = r.entry;
              return (
                <tr
                  key={i}
                  className={(r.confidence === 'low' ? 'low ' : '') + (excluded.has(i) ? 'excluded' : '')}
                  style={{ ['--tc' as string]: typeColor(settings, e.type) }}
                >
                  <td>
                    <input
                      type="checkbox"
                      aria-label="Выбрать строку"
                      checked={selected.has(i)}
                      onChange={() => props.setSelected(toggle(selected, i))}
                    />
                  </td>
                  <td className="small muted">
                    {e.origin ? `${e.origin.sheet} · ${e.origin.row}` : ''}
                  </td>
                  <td className="raw">{e.origin?.raw}</td>
                  <td className="type-cell">
                    <select value={e.type} aria-label="Тип" onChange={(ev) => props.patchRow(i, { type: ev.target.value })}>
                      {typeOptions(settings, e.type).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="date"
                      aria-label="Дата"
                      value={e.date ?? ''}
                      onChange={(ev) => props.patchRow(i, { date: ev.target.value || undefined })}
                    />
                    <div className="small muted">{formatDateRange(e)}</div>
                  </td>
                  <td>
                    <CommitInput aria-label="Название" value={e.title} onCommit={(v) => props.patchRow(i, { title: v })} />
                  </td>
                  <td>
                    {!typeHasMoney(settings, e.type) ? (
                      ''
                    ) : (
                      <CommitInput
                        className="num"
                        aria-label="Сумма"
                        value={e.amount === undefined ? '' : String(e.amount)}
                        onCommit={(v) => props.patchRow(i, { amount: parseAmount(v) })}
                      />
                    )}
                  </td>
                  <td>
                    <select
                      aria-label="Источник"
                      value={e.sourceId ?? ''}
                      onChange={(ev) => props.patchRow(i, { sourceId: ev.target.value || undefined })}
                    >
                      <option value="">—</option>
                      {docSources.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label="Статус"
                      value={e.status}
                      onChange={(ev) => props.patchRow(i, { status: ev.target.value as EntryStatus })}
                    >
                      {(Object.keys(STATUS_LABELS) as EntryStatus[]).map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="issues">
                    {r.issues.map((s, k) => (
                      <span key={k} className="chip warn">
                        {s}
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {idx.length > props.shown && (
        <button type="button" onClick={() => props.setShown(props.shown + PAGE)}>
          Показать ещё ({idx.length - props.shown})
        </button>
      )}

      <details open={badChecks.length > 0}>
        <summary>Сверка с итогами листов ({result.monthChecks.length})</summary>
        <div className="table-wrap">
          <table className="checks">
            <thead>
              <tr>
                <th>Лист</th>
                <th>Месяц</th>
                <th>SUM листа</th>
                <th>Импортировано</th>
                <th>Разница</th>
              </tr>
            </thead>
            <tbody>
              {result.monthChecks.map((m, i) => (
                <tr key={i} className={m.ok ? '' : 'bad'}>
                  <td>{m.sheet}</td>
                  <td>{monthLabel(m.month)}</td>
                  <td>{m.sheetSum === undefined ? '—' : formatEUR(m.sheetSum)}</td>
                  <td>{formatEUR(m.importedSum)}</td>
                  <td>{m.sheetSum === undefined ? '' : formatEUR(Math.round((m.importedSum - m.sheetSum) * 100) / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details>
        <summary>Пропущенные строки ({result.skipped.length})</summary>
        <ul className="skipped">
          {result.skipped.map((s, i) => (
            <li key={i}>
              <span className="muted small">
                {s.sheet} · {s.row}:
              </span>{' '}
              {s.raw} — <i>{s.reason}</i>
            </li>
          ))}
        </ul>
      </details>

      <div className="row gap sticky-actions">
        <button type="button" onClick={props.onBack}>
          Назад
        </button>
        <button type="button" className="primary" disabled={includedCount === 0} onClick={props.onImport}>
          Импортировать {includedCount}
        </button>
      </div>
    </div>
  );
}
