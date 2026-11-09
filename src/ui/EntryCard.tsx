// Карточка записи: главное сверху, остальное — разделами по кнопкам «Добавить ещё».
// Существующая запись правится сразу в store, новая — черновиком до «Создать».
import { useState, type ReactNode } from 'react';
import type { ChecklistItem, Contact, Entry, EntryStatus } from '../model/types';
import { STATUS_LABELS } from '../model/types';
import { newId, patchEntry } from '../model/entry';
import { typeColor, typeHasMoney, typeOptions } from '../model/taskTypes';
import { store } from '../store/store';
import { useTracker } from '../store/useTracker';
import { CommitInput, CommitTextarea, Modal, PayIcon, StatusBadge, parseAmount, useIsMobile } from './common';
import { MoneyEditor } from './MoneyEditor';
import { ArrowIcon, PersonIcon, Picker, type PickerItem } from './Picker';
import { digits, findSource, makeContact, makeSource, mapLink, uniqueSorted, waNumber, withHistory } from './util';

const STATUSES: EntryStatus[] = ['lead', 'booked', 'shot', 'editing', 'delivered', 'done', 'cancelled'];

type SectionKey = 'place' | 'category' | 'pay' | 'notes' | 'checklist';

const SECTIONS: { key: SectionKey; chip: string; title: string }[] = [
  { key: 'place', chip: '+ Место', title: 'Место' },
  { key: 'category', chip: '+ Категория', title: 'Категория' },
  { key: 'pay', chip: '+ Оплата и инвойс', title: 'Оплата и инвойс' },
  { key: 'notes', chip: '+ Заметка', title: 'Заметка' },
  { key: 'checklist', chip: '+ Чек-лист', title: 'Чек-лист' },
];

/** Есть ли в разделе данные — такой раздел показывается сразу, без кнопки. */
function sectionHasData(e: Entry, key: SectionKey): boolean {
  switch (key) {
    case 'place':
      return Boolean(e.location || e.mapUrl);
    case 'category':
      return Boolean(e.category);
    case 'pay':
      return e.money.length > 0 || Boolean(e.invoiceNo);
    case 'notes':
      return Boolean(e.notes);
    case 'checklist':
      return e.checklist.length > 0;
  }
}

/** Что очистить, когда раздел убирают. */
const SECTION_CLEAR: Record<SectionKey, Partial<Entry>> = {
  place: { location: undefined, mapUrl: undefined },
  category: { category: undefined },
  pay: { money: [], invoiceNo: undefined },
  notes: { notes: undefined },
  checklist: { checklist: [] },
};

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
  const [opened, setOpened] = useState<SectionKey[]>([]);
  const [justOpened, setJustOpened] = useState<SectionKey | undefined>();
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

  const hasMoney = typeHasMoney(doc.settings, e.type);
  const color = typeColor(doc.settings, e.type);
  const typeChoices = typeOptions(doc.settings, e.type);
  const locations = uniqueSorted(doc.entries.map((x) => x.location));
  const categories = uniqueSorted([...doc.settings.categories, ...doc.entries.map((x) => x.category)]);

  const available = SECTIONS.filter((s) => s.key !== 'pay' || hasMoney);
  const isShown = (k: SectionKey) => opened.includes(k) || sectionHasData(e, k);
  const shown = available.filter((s) => isShown(s.key));
  const hidden = available.filter((s) => !isShown(s.key));

  const openSection = (k: SectionKey) => {
    setOpened((list) => (list.includes(k) ? list : [...list, k]));
    setJustOpened(k);
  };
  const removeSection = (k: SectionKey) => {
    setOpened((list) => list.filter((x) => x !== k));
    if (sectionHasData(e, k)) apply(SECTION_CLEAR[k]);
  };

  // ---------- контакт и источник ----------

  const contactItems: PickerItem[] = doc.contacts
    .filter((c) => !c.deleted || c.id === e.contactId)
    .map((c) => ({
      id: c.id,
      label: c.name || c.phones[0] || 'без имени',
      sub: c.name ? c.phones[0] : undefined,
      search: c.phones.join(' '),
    }));
  const sourceItems: PickerItem[] = doc.sources
    .filter((s) => !s.deleted || s.id === e.sourceId)
    .map((s) => ({ id: s.id, label: s.name, search: s.aliases.join(' ') }));

  const contact = doc.contacts.find((c) => c.id === e.contactId);

  const createContact = (name: string, extra: { phone?: string }) => {
    const nc = makeContact({ name, phones: extra.phone ? [extra.phone] : [] });
    store.upsertContact(nc);
    return nc.id;
  };
  const createSource = (name: string) => {
    const existing = findSource(doc.sources, name);
    if (existing) return existing.id;
    const src = makeSource(name);
    store.upsertSource(src);
    return src.id;
  };

  // ---------- разделы «Добавить ещё» ----------

  const sectionBody = (k: SectionKey): ReactNode => {
    const focus = justOpened === k;
    switch (k) {
      case 'place':
        return (
          <>
            <div className="field">
              <label htmlFor="ec-loc">Место</label>
              <div className="row gap">
                <CommitInput
                  id="ec-loc"
                  list="ec-locations"
                  value={e.location ?? ''}
                  autoFocus={focus}
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
          </>
        );
      case 'category':
        return (
          <div className="field">
            <label htmlFor="ec-cat">Категория</label>
            <CommitInput
              id="ec-cat"
              list="ec-categories"
              value={e.category ?? ''}
              autoFocus={focus}
              onCommit={(v) => apply({ category: v.trim() || undefined })}
            />
            <datalist id="ec-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
        );
      case 'pay':
        return (
          <>
            <MoneyEditor entry={e} sources={doc.sources} onChange={(money) => apply({ money })} />
            <div className="field">
              <label htmlFor="ec-inv">№ инвойса</label>
              <CommitInput
                id="ec-inv"
                value={e.invoiceNo ?? ''}
                autoFocus={focus}
                onCommit={(v) => apply({ invoiceNo: v.trim() || undefined })}
              />
            </div>
          </>
        );
      case 'notes':
        return (
          <div className="field">
            <label htmlFor="ec-notes">Заметки</label>
            <CommitTextarea
              id="ec-notes"
              rows={3}
              value={e.notes ?? ''}
              autoFocus={focus}
              onCommit={(v) => apply({ notes: v || undefined })}
            />
          </div>
        );
      case 'checklist':
        return <Checklist items={e.checklist} autoFocus={focus} onChange={(checklist) => apply({ checklist })} />;
    }
  };

  return (
    <Modal
      wide
      className="entry-modal"
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
            <button type="button" className="primary card-create" onClick={create}>
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
          <label htmlFor="ec-title">Что сделать</label>
          <CommitInput
            id="ec-title"
            className="title-input"
            value={e.title}
            placeholder="Например: проект сайта для Альфы"
            onCommit={(v) => apply({ title: v })}
            autoFocus={isNew}
          />
        </div>

        <div className="field">
          <span className="field-label" id="ec-type-label">
            Тип
          </span>
          <div className="type-chips" role="group" aria-labelledby="ec-type-label">
            {typeChoices.map((t) => (
              <button
                type="button"
                key={t.id}
                className={'type-chip' + (e.type === t.id ? ' on' : '')}
                aria-pressed={e.type === t.id}
                style={{ ['--tc' as string]: t.color }}
                onClick={() => apply({ type: t.id })}
              >
                <span className="type-dot" style={{ background: t.color }} />
                {t.name}
              </button>
            ))}
          </div>
        </div>

        <div className="when">
          <div className={'when-row' + (e.allDay ? ' all-day' : '')}>
            <div className="field">
              <label htmlFor="ec-date">Когда</label>
              <input
                id="ec-date"
                type="date"
                value={e.date ?? ''}
                onChange={(ev) => apply({ date: ev.target.value || undefined })}
              />
            </div>
            {!e.allDay && (
              <>
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
              </>
            )}
          </div>
          <div className="when-checks">
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
              Дата под вопросом
            </label>
          </div>
          <div className="when-extra">
            <div className="field">
              <label htmlFor="ec-dateEnd">По (если несколько дней)</label>
              <input
                id="ec-dateEnd"
                type="date"
                value={e.dateEnd ?? ''}
                onChange={(ev) => apply({ dateEnd: ev.target.value || undefined })}
              />
            </div>
            <div className="field">
              <label htmlFor="ec-tn">Примечание ко времени</label>
              <CommitInput
                id="ec-tn"
                value={e.timeNote ?? ''}
                placeholder="вечер, уточнить…"
                onCommit={(v) => apply({ timeNote: v.trim() || undefined })}
              />
            </div>
            {(!e.date || e.accountingMonth) && (
              <div className="field">
                <label htmlFor="ec-am">Засчитать в месяц</label>
                <input
                  id="ec-am"
                  type="month"
                  value={e.accountingMonth ?? ''}
                  onChange={(ev) => apply({ accountingMonth: ev.target.value || undefined })}
                />
              </div>
            )}
          </div>
        </div>

        {hasMoney && (
          <div className="field">
            <label htmlFor="ec-amount">Сумма, €</label>
            <CommitInput
              id="ec-amount"
              inputMode="decimal"
              placeholder="0"
              value={e.amount === undefined ? '' : String(e.amount)}
              onCommit={(v) => apply({ amount: parseAmount(v) })}
            />
          </div>
        )}

        <Picker
          kind="contact"
          label="Контакт"
          icon={<PersonIcon />}
          items={contactItems}
          value={e.contactId}
          onChange={(contactId) => apply({ contactId })}
          onCreate={createContact}
          actions={contact && <ContactActions contact={contact} />}
        />

        <Picker
          kind="source"
          label="Источник"
          icon={<ArrowIcon />}
          items={sourceItems}
          value={e.sourceId}
          defaultSub="посредник"
          onChange={(sourceId) => apply({ sourceId })}
          onCreate={createSource}
        />

        <div className="field">
          <span className="field-label" id="ec-status-label">
            Статус
          </span>
          <div className="status-row" role="group" aria-labelledby="ec-status-label">
            {STATUSES.map((s) => (
              <button
                type="button"
                key={s}
                className={'chip' + (e.status === s ? ' on' : '')}
                aria-pressed={e.status === s}
                onClick={() => apply({ status: s })}
              >
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        {shown.map((s) => (
          <section className="card-section" key={s.key}>
            <div className="card-section-head">
              <h3>{s.title}</h3>
              <button
                type="button"
                className="small card-section-remove"
                aria-label={`Убрать раздел «${s.title}»`}
                onClick={() => removeSection(s.key)}
              >
                Убрать
              </button>
            </div>
            {sectionBody(s.key)}
          </section>
        ))}

        {hidden.length > 0 && (
          <div className="field">
            <span className="field-label" id="ec-more-label">
              Добавить ещё
            </span>
            <div className="add-chips" role="group" aria-labelledby="ec-more-label">
              {hidden.map((s) => (
                <button type="button" key={s.key} className="add-chip" onClick={() => openSection(s.key)}>
                  {s.chip}
                </button>
              ))}
            </div>
          </div>
        )}

        {e.history && e.history.length > 0 && (
          <details className="history">
            <summary>История изменений ({e.history.length})</summary>
            <ul>
              {[...e.history].reverse().map((h, i) => (
                <li key={i}>
                  <span className="muted">{new Date(h.at).toLocaleString('ru-RU')}</span> — {h.text}
                </li>
              ))}
            </ul>
          </details>
        )}

        {e.origin && (
          <details className="history">
            <summary>Откуда импортировано</summary>
            <div className="muted small">
              Лист «{e.origin.sheet}», строка {e.origin.row}: <code>{e.origin.raw}</code>
            </div>
          </details>
        )}
      </div>
    </Modal>
  );
}

function ContactActions({ contact }: { contact: Contact }) {
  const phone = contact.phones[0];
  const tg = telegramLink(contact);
  if (!phone && !tg && !contact.notes) return null;
  return (
    <>
      {phone && (
        <>
          <a className="btn" href={'tel:' + phone.replace(/[^\d+]/g, '')}>
            Позвонить
          </a>
          <a className="btn" href={'https://wa.me/' + waNumber(phone)} target="_blank" rel="noreferrer">
            WhatsApp
          </a>
        </>
      )}
      {tg && (
        <a className="btn" href={tg} target="_blank" rel="noreferrer">
          Telegram
        </a>
      )}
      {contact.notes && <div className="muted small picker-note">{contact.notes}</div>}
    </>
  );
}

function Checklist({
  items,
  onChange,
  autoFocus,
}: {
  items: ChecklistItem[];
  onChange: (items: ChecklistItem[]) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const add = () => {
    if (!text.trim()) return;
    onChange([...items, { id: newId(), text: text.trim(), done: false }]);
    setText('');
  };
  return (
    <div className="checklist">
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
            aria-label="Текст пункта"
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
          aria-label="Новый пункт"
          autoFocus={autoFocus}
          onChange={(ev) => setText(ev.target.value)}
          onKeyDown={(ev) => ev.key === 'Enter' && add()}
        />
        <button type="button" onClick={add}>
          Добавить
        </button>
      </div>
    </div>
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
