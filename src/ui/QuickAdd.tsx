// Строка быстрого ввода: «12.12 встреча 11-12 200 от Пети» → предпросмотр → Enter создаёт запись.
import { useMemo, useState } from 'react';
import type { Entry, TrackerDoc } from '../model/types';
import { KIND_LABELS } from '../model/types';
import { formatEUR, newEntry } from '../model/entry';
import { typeName } from '../model/taskTypes';
import type { ParsedLine } from '../ods/types';
import { parseQuickLine } from '../ods/parseLine';
import { store } from '../store/store';
import { useTracker } from '../store/useTracker';
import { findContactByPhone, findSource, formatDateRange, formatTime, makeContact, makeSource, todayISO } from './util';

interface Preview {
  text: string;
  parsed?: ParsedLine;
  error?: string;
}

function parse(text: string, doc: TrackerDoc): Preview {
  const today = todayISO();
  const [y, m] = today.split('-').map(Number);
  try {
    const parsed = parseQuickLine(text, {
      year: y,
      month: m,
      sources: doc.sources,
      today,
      categories: doc.settings.categories,
      settings: doc.settings,
    });
    return { text, parsed };
  } catch (e) {
    return { text, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Собрать запись из результата разбора; источник/контакт ищутся или создаются в справочниках. */
export function entryFromQuick(p: Preview, doc: TrackerDoc): Entry {
  if (!p.parsed) return newEntry({ title: p.text.trim() }, doc.settings);
  const partial: Partial<Entry> = { ...p.parsed.entry };
  if (!partial.title?.trim()) partial.title = p.text.trim();
  if (p.parsed.sourceName) {
    let s = findSource(store.getDoc().sources, p.parsed.sourceName);
    if (!s) {
      s = makeSource(p.parsed.sourceName);
      store.upsertSource(s);
    }
    partial.sourceId = s.id;
  }
  const pc = p.parsed.contact;
  if (pc && (pc.name || pc.phones.length || pc.channels.length)) {
    let c = findContactByPhone(store.getDoc().contacts, pc.phones);
    if (!c) {
      c = makeContact({ name: pc.name ?? '', phones: pc.phones, channels: pc.channels });
      store.upsertContact(c);
    }
    partial.contactId = c.id;
  }
  return newEntry(partial, doc.settings);
}

export function QuickAdd({ onCreated }: { onCreated?: (e: Entry) => void }) {
  const doc = useTracker();
  const [text, setText] = useState('');
  const [lines, setLines] = useState<string[]>([]);

  const previews = useMemo<Preview[]>(() => {
    const src = lines.length ? lines : text.trim() ? [text.trim()] : [];
    return src.map((t) => parse(t, doc));
  }, [text, lines, doc]);

  const submit = () => {
    if (!previews.length) return;
    let last: Entry | undefined;
    for (const p of previews) {
      const e = entryFromQuick(p, doc);
      store.upsertEntry(e);
      last = e;
    }
    setText('');
    setLines([]);
    if (last && previews.length === 1) onCreated?.(last);
  };

  return (
    <div className="quick-add">
      <input
        className="quick-input"
        aria-label="Быстрый ввод"
        placeholder="12.12 встреча 11-12 200 от Пети — Enter"
        value={lines.length ? `${lines.length} строк из буфера` : text}
        readOnly={lines.length > 0}
        onChange={(ev) => setText(ev.target.value)}
        onPaste={(ev) => {
          const t = ev.clipboardData.getData('text');
          if (t.includes('\n')) {
            const ls = t
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean);
            if (ls.length > 1) {
              ev.preventDefault();
              setLines(ls);
            }
          }
        }}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            submit();
          }
          if (ev.key === 'Escape') {
            setText('');
            setLines([]);
          }
        }}
      />
      {previews.length > 0 && (
        <div className="quick-preview" aria-live="polite">
          {previews.slice(0, 6).map((p, i) => (
            <PreviewLine key={i} p={p} doc={doc} />
          ))}
          {previews.length > 6 && <div className="muted small">…и ещё {previews.length - 6}</div>}
          <div className="row gap">
            <button type="button" className="small primary" onClick={submit}>
              {previews.length > 1 ? `Добавить ${previews.length}` : 'Добавить'} (Enter)
            </button>
            <button
              type="button"
              className="small"
              onClick={() => {
                setText('');
                setLines([]);
              }}
            >
              Очистить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewLine({ p, doc }: { p: Preview; doc: TrackerDoc }) {
  if (!p.parsed) {
    return (
      <div className="pv-line">
        <span className="chip">Название: {p.text}</span>
        <span className="muted small">разбор недоступен — запись будет создана с этим названием</span>
      </div>
    );
  }
  const e = p.parsed.entry;
  const chips: string[] = [];
  if (e.type) chips.push(typeName(doc.settings, e.type));
  if (e.date) chips.push('📅 ' + formatDateRange({ date: e.date, dateEnd: e.dateEnd, dateTentative: !!e.dateTentative }));
  const time = formatTime({ timeStart: e.timeStart, timeEnd: e.timeEnd, timeNote: e.timeNote, allDay: !!e.allDay });
  if (time) chips.push('🕑 ' + time);
  if (e.category) chips.push(e.category);
  if (e.location) chips.push('📍 ' + e.location);
  if (e.amount !== undefined) chips.push(formatEUR(e.amount));
  if (p.parsed.sourceName) {
    const known = findSource(doc.sources, p.parsed.sourceName);
    chips.push('от ' + (known?.name ?? p.parsed.sourceName + ' (новый)'));
  }
  if (p.parsed.contact?.phones.length) chips.push('☎ ' + p.parsed.contact.phones.join(', '));
  return (
    <div className="pv-line">
      <strong>{e.title?.trim() || p.text}</strong>
      {chips.map((c, i) => (
        <span className="chip" key={i}>
          {c}
        </span>
      ))}
      {p.parsed.issues.map((s, i) => (
        <span className="chip warn" key={'i' + i}>
          {s}
        </span>
      ))}
    </div>
  );
}
