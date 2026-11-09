// Экран «Деньги»: сколько и за какие записи у клиентов и у каждого посредника; «передал владельцу» пачкой.
import { useMemo, useState } from 'react';
import type { Entry, TrackerDoc } from '../model/types';
import { formatEUR, moneyTotal } from '../model/entry';
import { typeHasMoney } from '../model/taskTypes';
import { store } from '../store/store';
import { useTracker } from '../store/useTracker';
import { EntryMini } from './EntryMini';
import { atClient, daysBetween, intermediaryToOwner, todayISO } from './util';

interface HolderGroup {
  holderId: string; // '' — посредник не указан
  name: string;
  total: number;
  items: { e: Entry; amount: number; since?: string }[];
}

export function moneyGroups(doc: TrackerDoc) {
  const live = doc.entries.filter(
    (e) => !e.deleted && e.status !== 'cancelled' && typeHasMoney(doc.settings, e.type),
  );
  const clients = live
    .map((e) => ({ e, amount: atClient(e, doc.settings) }))
    .filter((x) => x.amount > 0)
    .sort((a, b) => (a.e.date ?? '9999').localeCompare(b.e.date ?? '9999'));
  const holders = new Map<string, HolderGroup>();
  for (const e of live) {
    for (const p of e.money) {
      if (p.where !== 'intermediary') continue;
      const key = p.holderId ?? '';
      let g = holders.get(key);
      if (!g) {
        g = {
          holderId: key,
          name: doc.sources.find((s) => s.id === key)?.name ?? 'Посредник не указан',
          total: 0,
          items: [],
        };
        holders.set(key, g);
      }
      g.total += p.amount;
      const ex = g.items.find((x) => x.e.id === e.id);
      if (ex) ex.amount += p.amount;
      else g.items.push({ e, amount: p.amount, since: p.at?.slice(0, 10) ?? e.date });
    }
  }
  return {
    clients,
    clientTotal: clients.reduce((s, x) => s + x.amount, 0),
    holders: [...holders.values()].sort((a, b) => b.total - a.total),
  };
}

export function MoneyView() {
  const doc = useTracker();
  const g = useMemo(() => moneyGroups(doc), [doc]);
  const interTotal = g.holders.reduce((s, h) => s + h.total, 0);
  return (
    <div className="view money-view">
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">У клиентов</div>
          <div className="stat-value">{formatEUR(g.clientTotal)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">У посредников</div>
          <div className="stat-value">{formatEUR(interTotal)}</div>
        </div>
      </div>
      {g.holders.map((h) => (
        <HolderBlock key={h.holderId} h={h} doc={doc} />
      ))}
      <section className="money-block">
        <h3>
          У клиентов <span className="muted">{formatEUR(g.clientTotal)}</span>
        </h3>
        {g.clients.length === 0 && <div className="muted small">Все клиенты рассчитались.</div>}
        {g.clients.map(({ e, amount }) => (
          <EntryMini key={e.id} e={e} doc={doc} note={`ждём ${formatEUR(amount)}`} />
        ))}
      </section>
    </div>
  );
}

function HolderBlock({ h, doc }: { h: HolderGroup; doc: TrackerDoc }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const today = todayISO();
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectedSum = h.items.filter((x) => sel.has(x.e.id)).reduce((s, x) => s + x.amount, 0);
  const transfer = () => {
    const ids = [...sel];
    if (!ids.length) return;
    if (!window.confirm(`${h.name} передал(а) владельцу ${formatEUR(selectedSum)} за ${ids.length} зап.?`)) return;
    for (const id of ids) {
      const e = store.getDoc().entries.find((x) => x.id === id);
      if (!e) continue;
      store.updateEntry(id, intermediaryToOwner(e, h.holderId || undefined, doc.sources));
    }
    setSel(new Set());
  };
  return (
    <section className="money-block">
      <h3>
        У {h.name} <span className="muted">{formatEUR(h.total)}</span>
      </h3>
      <div className="row gap wrap">
        <label className="check">
          <input
            type="checkbox"
            checked={sel.size === h.items.length && h.items.length > 0}
            onChange={(ev) => setSel(ev.target.checked ? new Set(h.items.map((x) => x.e.id)) : new Set())}
          />{' '}
          Выделить все
        </label>
        <button type="button" className="primary small" disabled={!sel.size} onClick={transfer}>
          Передал владельцу{sel.size ? ` ${formatEUR(selectedSum)}` : ''}
        </button>
      </div>
      {h.items.map(({ e, amount, since }) => (
        <div key={e.id} className="select-row">
          <input type="checkbox" aria-label={'Выбрать ' + e.title} checked={sel.has(e.id)} onChange={() => toggle(e.id)} />
          <EntryMini
            e={e}
            doc={doc}
            note={`${formatEUR(amount)} у ${h.name}${since ? `, ${daysBetween(since, today)} дн.` : ''}${
              moneyTotal(e.money, 'owner') ? ` · уже получено ${formatEUR(moneyTotal(e.money, 'owner'))}` : ''
            }`}
          />
        </div>
      ))}
    </section>
  );
}
