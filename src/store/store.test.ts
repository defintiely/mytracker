import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { TrackerStore } from './store';
import { monthTotals, newEntry, payState } from '../model/entry';
import { DEFAULT_SETTINGS } from '../model/types';

describe('TrackerStore', () => {
  it('сохраняет записи в IndexedDB и поднимает их заново', async () => {
    const a = new TrackerStore();
    await a.load();
    const e = newEntry({ title: 'Альфа', date: '2026-11-13', amount: 200 });
    a.upsertEntry(e);
    a.updateEntry(e.id, { amount: 250 });
    await a.flush();
    expect(a.isDirty()).toBe(true);

    const b = new TrackerStore();
    await b.load();
    const got = b.getDoc().entries.find((x) => x.id === e.id)!;
    expect(got.amount).toBe(250);
    expect(got.fieldUpdatedAt?.amount).toBeDefined();
    expect(b.isDirty()).toBe(true);
  });

  it('replaceDoc с markClean снимает флаг несохранённых правок', async () => {
    const s = new TrackerStore();
    await s.load();
    s.upsertEntry(newEntry({ title: 'x' }));
    s.replaceDoc(s.getDoc(), { markClean: true });
    expect(s.isDirty()).toBe(false);
  });

  it('restoreDoc: бэкап становится свежей правкой, лишние записи — tombstone', async () => {
    const s = new TrackerStore();
    await s.load();
    const old = newEntry({ title: 'из бэкапа', updatedAt: '2020-01-01T00:00:00.000Z' });
    const extra = newEntry({ title: 'появилась после бэкапа' });
    s.upsertEntry(extra);
    const backup = { ...s.getDoc(), entries: [old] };
    s.restoreDoc(backup);
    const doc = s.getDoc();
    expect(doc.entries.find((x) => x.id === old.id)!.updatedAt > '2020-01-01').toBe(true);
    expect(doc.entries.find((x) => x.id === extra.id)!.deleted).toBe(true);
    expect(s.isDirty()).toBe(true);
  });

  it('удаление — tombstone, запись остаётся с deleted', async () => {
    const s = new TrackerStore();
    await s.load();
    const e = newEntry({ title: 'y' });
    s.upsertEntry(e);
    s.deleteEntry(e.id);
    expect(s.getDoc().entries.find((x) => x.id === e.id)?.deleted).toBe(true);
  });
});

describe('итоги месяца и статус оплаты', () => {
  it('считает оборот, чистыми, деньги по местам; личное и отменённое не входят', () => {
    const entries = [
      newEntry({ type: 'main', date: '2026-10-02', amount: 350, money: [{ amount: 350, where: 'owner' }] }),
      newEntry({ type: 'joint', date: '2026-10-08', amount: 700, money: [{ amount: 700, where: 'intermediary', holderId: 's' }] }),
      newEntry({ type: 'main', kind: 'work', accountingMonth: '2026-10', amount: 550, money: [] }),
      newEntry({ type: 'personal', date: '2026-10-19' }),
      newEntry({ type: 'main', date: '2026-10-20', amount: 999, status: 'cancelled' }),
    ];
    const t = monthTotals(entries, '2026-10', DEFAULT_SETTINGS);
    expect(t.turnover).toBe(1600);
    expect(t.net).toBe(1072);
    expect(t.byType).toEqual({ main: 900, joint: 700 });
    expect(t.received).toBe(350);
    expect(t.atIntermediary).toBe(700);
    expect(t.atClient).toBe(550);
    expect(t.jobs).toBe(2);
  });

  it('payState', () => {
    expect(payState(newEntry({ amount: 100, money: [{ amount: 100, where: 'owner' }] }))).toBe('paid');
    expect(payState(newEntry({ amount: 100, money: [{ amount: 50, where: 'owner' }] }))).toBe('partial');
    expect(payState(newEntry({ amount: 100, money: [{ amount: 100, where: 'intermediary' }] }))).toBe('intermediary');
    expect(payState(newEntry({ amount: 100 }))).toBe('unpaid');
    expect(payState(newEntry({ type: 'personal' }))).toBe('none');
  });
});
