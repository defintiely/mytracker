// Редактор частей денег записи: сумма, где лежит (клиент / посредник / получено), способ.
import type { Entry, MoneyPart, MoneyWhere, Source } from '../model/types';
import { WHERE_LABELS } from '../model/types';
import { formatEUR, moneyTotal, nowIso } from '../model/entry';
import { CommitInput, Modal, parseAmount } from './common';
import { METHOD_LABELS } from './util';
import { store } from '../store/store';
import { useTracker } from '../store/useTracker';
import { withHistory } from './util';

export function MoneyEditor({
  entry,
  sources,
  onChange,
}: {
  entry: Pick<Entry, 'amount' | 'money'>;
  sources: Source[];
  onChange: (money: MoneyPart[]) => void;
}) {
  const parts = entry.money;
  const sum = moneyTotal(parts);
  const amount = entry.amount ?? 0;
  const rest = Math.round((amount - sum) * 100) / 100;
  const liveSources = sources.filter((s) => !s.deleted);

  const set = (i: number, patch: Partial<MoneyPart>) => {
    const next = parts.map((p, j) => {
      if (j !== i) return p;
      const np: MoneyPart = { ...p, ...patch };
      if (patch.where && patch.where !== p.where) np.at = nowIso();
      if (np.where !== 'intermediary') delete np.holderId;
      return np;
    });
    onChange(next);
  };

  return (
    <div className="money-editor">
      {parts.length === 0 && <div className="muted">Частей нет — вся сумма считается у клиента.</div>}
      {parts.map((p, i) => (
        <div className="money-part" key={i}>
          <CommitInput
            className="money-amount"
            inputMode="decimal"
            aria-label="Сумма части"
            value={String(p.amount)}
            onCommit={(v) => set(i, { amount: parseAmount(v) ?? 0 })}
          />
          <select
            aria-label="Где деньги"
            value={p.where}
            onChange={(e) => set(i, { where: e.target.value as MoneyWhere })}
          >
            {(Object.keys(WHERE_LABELS) as MoneyWhere[]).map((w) => (
              <option key={w} value={w}>
                {WHERE_LABELS[w]}
              </option>
            ))}
          </select>
          {p.where === 'intermediary' && (
            <select
              aria-label="У кого"
              value={p.holderId ?? ''}
              onChange={(e) => set(i, { holderId: e.target.value || undefined })}
            >
              <option value="">— кто? —</option>
              {liveSources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <CommitInput
            className="money-method"
            list="money-methods"
            placeholder="способ"
            aria-label="Способ"
            value={p.method ? METHOD_LABELS[p.method] ?? p.method : ''}
            onCommit={(v) => set(i, { method: methodFromLabel(v) })}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label="Удалить часть"
            onClick={() => onChange(parts.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <datalist id="money-methods">
        {Object.values(METHOD_LABELS).map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <div className="row gap">
        <button
          type="button"
          onClick={() =>
            onChange([...parts, { amount: rest > 0 ? rest : 0, where: 'owner', at: nowIso() }])
          }
        >
          + часть
        </button>
        {rest > 0 && parts.length > 0 && (
          <button type="button" onClick={() => onChange([...parts, { amount: rest, where: 'client', at: nowIso() }])}>
            Остаток {formatEUR(rest)} у клиента
          </button>
        )}
        {amount > 0 && parts.length === 0 && (
          <button type="button" onClick={() => onChange([{ amount, where: 'owner', method: undefined, at: nowIso() }])}>
            Всё получено
          </button>
        )}
      </div>
      {parts.length > 0 && Math.abs(rest) > 0.001 && (
        <div className="hint warn">
          Сумма частей {formatEUR(sum)} ≠ сумме записи {formatEUR(amount)}
          {rest > 0 ? ` (не хватает ${formatEUR(rest)} — считается у клиента)` : ` (лишние ${formatEUR(-rest)})`}
        </div>
      )}
    </div>
  );
}

export function methodFromLabel(v: string): string | undefined {
  const t = v.trim().toLowerCase();
  if (!t) return undefined;
  for (const [k, label] of Object.entries(METHOD_LABELS)) if (label === t || k === t) return k;
  if (/^нал/.test(t)) return 'cash';
  if (/^рев/.test(t)) return 'revolut';
  if (/^сч[её]т|^банк/.test(t)) return 'bank';
  return v.trim();
}

/** Отдельное окно «Где деньги» — из колонки таблицы и экрана «Деньги». */
export function MoneyDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const doc = useTracker();
  const e = doc.entries.find((x) => x.id === id);
  if (!e) return null;
  return (
    <Modal title={`Где деньги: ${e.title || 'без названия'}`} onClose={onClose}>
      <div className="field">
        <label>Сумма</label>
        <CommitInput
          inputMode="decimal"
          value={e.amount === undefined ? '' : String(e.amount)}
          onCommit={(v) => store.updateEntry(e.id, { amount: parseAmount(v) })}
        />
      </div>
      <MoneyEditor
        entry={e}
        sources={doc.sources}
        onChange={(money) => store.updateEntry(e.id, withHistory(e, { money }, doc.sources))}
      />
    </Modal>
  );
}
