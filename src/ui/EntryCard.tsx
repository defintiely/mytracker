// Карточка записи: все поля Entry. Существующая запись правится сразу в store, новая — черновиком до «Создать».
import { useState } from 'react';
import type { ChecklistItem, Contact, Entry, EntryKind, EntryStatus, TrackerDoc } from '../model/types';
import { KIND_LABELS, STATUS_LABELS } from '../model/types';
import { newId, patchEntry } from '../model/entry';
import { typeColor, typeHasMoney, typeOptions } from '../model/taskTypes';
import { store } from '../store/store';
import { useTracker } from '../store/useTracker';
import { CommitInput, CommitTextarea, Modal, PayIcon, StatusBadge, parseAmount, useIsMobile } from './common';
import { MoneyEditor } from './MoneyEditor';
import { digits, makeContact, mapLink, uniqueSorted, waNumber, withHistory } from './util';

const STATUSES: EntryStatus[] = ['lead', 'booked', 'shot', 'editing', 'delivered', 'done', 'cancelled'];

export function EntryCard({
  id,
  draft: initialDraft,
  onClose,
}: {
  id?: string;
  draft?: Entry;
  onClose: () => void;
}) {
  const doc = useTracker();
  const mobile = useIsMobile();
  const [draft, setDraft] = useState<Entry | undefined>(initialDraft);
  const stored = id ? doc.entries.find((x) => x.id === id) : undefined;
  const e = draft ?? stored;
  if (!e) return null;
  const isNew = Boolean(draft);

  const apply = (patch: Partial<Entry>) => {
    const full = withHistory(e, patch, doc.sources);
    if (isNew) setDraft(patchEntry(e, full));
    else store.updateEntry(e.id, full);
  };

  const create = () => {
    store.upsertEntry({ ...e, title: e.title.trim() || 'Без названия' });
    onClose();
  };

  const remove = () => {
    if (window.confirm(`Удалить «${e.title || 'без названия'}»?`)) {
      store.deleteEntry(e.id);
      onClose();
    }
  };

  const personal = !typeHasMoney(doc.settings, e.type);
  const color = typeColor(doc.settings, e.type);
  const typeChoices = typeOptions(doc.settings, e.type);
  const locations = uniqueSorted(doc.entries.map((x) => x.location));
  const categories = uniqueSorted([...doc.settings.categories, ...doc.entries.map((x) => x.category)]);

  return (
    <Modal
      wide
      onClose={onClose}
      title={
        <span className="card-title-row">
          <span className="type-strip-mini" style={{ background: color }} />
          {isNew ? 'Новая запись' : 'Запись'}
          {!isNew && <StatusBadge status={e.status} />}
          {!isNew && <PayIcon entry={e} settings={doc.settings} />}
        </span>
      }
      footer={
        isNew ? (
          <>
            <button type="button" onClick={onClose}>
              Отмена
            </button>
            <button type="button" className="primary" onClick={create}>
              Создать
            </button>
          </>
        ) : (
          <>
            <button type="button" className="danger" onClick={remove}>
              Удалить
            </button>
            <button type="button" className="primary" onClick={onClose}>
              Готово
            </button>
          </>
        )
      }
    >
      <div className={'entry-card' + (mobile ? ' mobile' : '')} style={{ ['--tc' as string]: color }}>
        <div className="field">
          <label htmlFor="ec-title">Название</label>
          <CommitInput
            id="ec-title"
            className="title-input"
            value={e.title}
            placeholder="Например: Проект сайта для Альфы"
            onCommit={(v) => apply({ title: v })}
            autoFocus={isNew}
          />
        </div>

        <div className="field">
          <label>Тип</label>
          <div className="seg">
            {typeChoices.map((t) => (
              <button
                type="button"
                key={t.id}
                className={'seg-btn' + (e.type === t.id ? ' on' : '')}
                aria-pressed={e.type === t.id}
                style={{ ['--tc' as string]: t.color }}
                onClick={() => apply({ type: t.id, ...(!t.money && e.kind === 'job' ? { kind: 'event' } : {}) })}
              >
                <span className="type-dot" style={{ background: t.color }} />
                {t.name}
              </button>
            ))}
          </div>
        </div>

        <div className="grid2">
          <div className="field">
            <label htmlFor="ec-kind">Вид</label>
            <select id="ec-kind" value={e.kind} onChange={(ev) => apply({ kind: ev.target.value as EntryKind })}>
              {(Object.keys(KIND_LABELS) as EntryKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ec-cat">Категория</label>
            <CommitInput
              id="ec-cat"
              list="ec-categories"
              value={e.category ?? ''}
              onCommit={(v) => apply({ category: v.trim() || undefined })}
            />
            <datalist id="ec-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="field">
          <label>Переместить в…</label>
          <div className="status-row">
            {STATUSES.map((s) => (
              <button
                type="button"
                key={s}
                className={'chip' + (e.status === s ? ' on' : '')}
                onClick={() => apply({ status: s })}
              >
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        <fieldset className="block">
          <legend>Когда</legend>
          <div className="grid3">
            <div className="field">
              <label htmlFor="ec-date">Дата</label>
              <input
                id="ec-date"
                type="date"
                value={e.date ?? ''}
                onChange={(ev) => apply({ date: ev.target.value || undefined })}
              />
            </div>
            <div className="field">
              <label htmlFor="ec-dateEnd">По</label>
              <input
                id="ec-dateEnd"
                type="date"
                value={e.dateEnd ?? ''}
                onChange={(ev) => apply({ dateEnd: ev.target.value || undefined })}
              />
            </div>
            <div className="field">
              <label htmlFor="ec-am">Засчитать в месяц</label>
              <input
                id="ec-am"
                type="month"
                value={e.accountingMonth ?? ''}
                onChange={(ev) => apply({ accountingMonth: ev.target.value || undefined })}
              />
            </div>
          </div>
          <div className="row gap wrap">
            <label className="check">
              <input type="checkbox" checked={e.allDay} onChange={(ev) => apply({ allDay: ev.target.checked })} /> Весь
              день
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={e.dateTentative}
                onChange={(ev) => apply({ dateTentative: ev.target.checked })}
              />{' '}
              Под вопросом
            </label>
          </div>
          {!e.allDay && (
            <div className="grid3">
              <div className="field">
                <label htmlFor="ec-ts">С</label>
                <input
                  id="ec-ts"
                  type="time"
                  value={e.timeStart ?? ''}
                  onChange={(ev) => apply({ timeStart: ev.target.value || undefined })}
                />
              </div>
              <div className="field">
                <label htmlFor="ec-te">До</label>
                <input
                  id="ec-te"
                  type="time"
                  value={e.timeEnd ?? ''}
                  onChange={(ev) => apply({ timeEnd: ev.target.value || undefined })}
                />
              </div>
            </div>
          )}
          <div className="field">
            <label htmlFor="ec-tn">Примечание ко времени</label>
            <CommitInput
              id="ec-tn"
              value={e.timeNote ?? ''}
              placeholder="вечер, уточнить…"
              onCommit={(v) => apply({ timeNote: v.trim() || undefined })}
            />
          </div>
        </fieldset>

        <fieldset className="block">
          <legend>Где</legend>
          <div className="field">
            <label htmlFor="ec-loc">Место</label>
            <div className="row gap">
              <CommitInput
                id="ec-loc"
                list="ec-locations"
                value={e.location ?? ''}
                onCommit={(v) => apply({ location: v.trim() || undefined })}
              />
              {mapLink(e) && (
                <a className="btn" href={mapLink(e)} target="_blank" rel="noreferrer">
                  Карта
                </a>
              )}
            </div>
            <datalist id="ec-locations">
              {locations.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label htmlFor="ec-map">Ссылка на карту</label>
            <CommitInput
              id="ec-map"
              value={e.mapUrl ?? ''}
              placeholder="https://maps.app.goo.gl/…"
              onCommit={(v) => apply({ mapUrl: v.trim() || undefined })}
            />
          </div>
        </fieldset>

        <ContactBlock doc={doc} entry={e} onPick={(contactId) => apply({ contactId })} />

        <div className="field">
          <label htmlFor="ec-src">Источник / посредник</label>
          <select id="ec-src" value={e.sourceId ?? ''} onChange={(ev) => apply({ sourceId: ev.target.value || undefined })}>
            <option value="">— свой заказ —</option>
            {doc.sources
              .filter((s) => !s.deleted || s.id === e.sourceId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </div>

        {!personal && (
          <fieldset className="block">
            <legend>Деньги</legend>
            <div className="grid2">
              <div className="field">
                <label htmlFor="ec-amount">Сумма, €</label>
                <CommitInput
                  id="ec-amount"
                  inputMode="decimal"
                  value={e.amount === undefined ? '' : String(e.amount)}
                  onCommit={(v) => apply({ amount: parseAmount(v) })}
                />
              </div>
              <div className="field">
                <label htmlFor="ec-inv">№ инвойса</label>
                <CommitInput
                  id="ec-inv"
                  value={e.invoiceNo ?? ''}
                  onCommit={(v) => apply({ invoiceNo: v.trim() || undefined })}
                />
              </div>
            </div>
            <MoneyEditor entry={e} sources={doc.sources} onChange={(money) => apply({ money })} />
          </fieldset>
        )}

        <Checklist items={e.checklist} onChange={(checklist) => apply({ checklist })} />

        <div className="field">
          <label htmlFor="ec-notes">Заметки</label>
          <CommitTextarea id="ec-notes" rows={3} value={e.notes ?? ''} onCommit={(v) => apply({ notes: v || undefined })} />
        </div>

        {e.origin && (
          <div className="muted small">
            Импорт: лист «{e.origin.sheet}», строка {e.origin.row}: <code>{e.origin.raw}</code>
          </div>
        )}

        {e.history && e.history.length > 0 && (
          <details className="history">
            <summary>История ({e.history.length})</summary>
            <ul>
              {[...e.history].reverse().map((h, i) => (
                <li key={i}>
                  <span className="muted">{new Date(h.at).toLocaleString('ru-RU')}</span> — {h.text}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  );
}

function Checklist({ items, onChange }: { items: ChecklistItem[]; onChange: (items: ChecklistItem[]) => void }) {
  const [text, setText] = useState('');
  const add = () => {
    if (!text.trim()) return;
    onChange([...items, { id: newId(), text: text.trim(), done: false }]);
    setText('');
  };
  return (
    <fieldset className="block">
      <legend>Чек-лист</legend>
      {items.map((it) => (
        <div className="check-item" key={it.id}>
          <input
            type="checkbox"
            checked={it.done}
            aria-label={it.text}
            onChange={(ev) => onChange(items.map((x) => (x.id === it.id ? { ...x, done: ev.target.checked } : x)))}
          />
          <CommitInput
            className={it.done ? 'done' : ''}
            value={it.text}
            onCommit={(v) => onChange(items.map((x) => (x.id === it.id ? { ...x, text: v } : x)))}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label="Удалить пункт"
            onClick={() => onChange(items.filter((x) => x.id !== it.id))}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="row gap">
        <input
          value={text}
          placeholder="Новый пункт"
          onChange={(ev) => setText(ev.target.value)}
          onKeyDown={(ev) => ev.key === 'Enter' && add()}
        />
        <button type="button" onClick={add}>
          Добавить
        </button>
      </div>
    </fieldset>
  );
}

function telegramLink(c: Contact): string | undefined {
  const tg = c.channels.find((x) => x.kind === 'telegram');
  if (tg) {
    const v = tg.value.trim();
    if (/^https?:/.test(v)) return v;
    if (/^@?[A-Za-z][\w]{3,}$/.test(v)) return 'https://t.me/' + v.replace(/^@/, '');
    if (digits(v).length >= 8) return 'https://t.me/+' + waNumber(v);
  }
  if (c.phones[0]) return 'https://t.me/+' + waNumber(c.phones[0]);
  return undefined;
}

function ContactBlock({ doc, entry, onPick }: { doc: TrackerDoc; entry: Entry; onPick: (id: string | undefined) => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const c = doc.contacts.find((x) => x.id === entry.contactId);
  const phoneVal = c?.phones[0];
  const save = () => {
    if (!name.trim() && !phone.trim()) return;
    const nc = makeContact({ name: name.trim(), phones: phone.trim() ? [phone.trim()] : [] });
    store.upsertContact(nc);
    onPick(nc.id);
    setCreating(false);
    setName('');
    setPhone('');
  };
  return (
    <fieldset className="block">
      <legend>Контакт</legend>
      <div className="row gap wrap">
        <select
          aria-label="Контакт"
          value={entry.contactId ?? ''}
          onChange={(ev) => {
            if (ev.target.value === '__new') setCreating(true);
            else onPick(ev.target.value || undefined);
          }}
        >
          <option value="">— нет —</option>
          {doc.contacts
            .filter((x) => !x.deleted || x.id === entry.contactId)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name || x.phones[0] || 'без имени'}
                {x.name && x.phones[0] ? ` · ${x.phones[0]}` : ''}
              </option>
            ))}
          <option value="__new">+ новый контакт…</option>
        </select>
        {c && phoneVal && (
          <>
            <a className="btn" href={'tel:' + phoneVal.replace(/[^\d+]/g, '')}>
              Позвонить
            </a>
            <a className="btn" href={'https://wa.me/' + waNumber(phoneVal)} target="_blank" rel="noreferrer">
              WhatsApp
            </a>
          </>
        )}
        {c && telegramLink(c) && (
          <a className="btn" href={telegramLink(c)} target="_blank" rel="noreferrer">
            Telegram
          </a>
        )}
      </div>
      {creating && (
        <div className="row gap wrap">
          <input placeholder="Имя" value={name} onChange={(ev) => setName(ev.target.value)} />
          <input placeholder="Телефон" inputMode="tel" value={phone} onChange={(ev) => setPhone(ev.target.value)} />
          <button type="button" className="primary" onClick={save}>
            Сохранить
          </button>
          <button type="button" onClick={() => setCreating(false)}>
            Отмена
          </button>
        </div>
      )}
      {c?.notes && <div className="muted small">{c.notes}</div>}
    </fieldset>
  );
}
