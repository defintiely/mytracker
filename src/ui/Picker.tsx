// «Выбрать» — общий виджет выбора контакта и источника (combobox): поле → поиск со списком и «+ Добавить» → плашка.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { digits, norm } from './util';

export interface PickerItem {
  id: string;
  label: string;
  /** Подстрока в списке и на плашке (у контакта — телефон). */
  sub?: string;
  /** Дополнительный текст для поиска (телефоны, варианты имени). */
  search?: string;
}

export type PickerKind = 'contact' | 'source';

export interface PickerProps {
  kind: PickerKind;
  /** Видимая подпись над полем: «Контакт», «Источник». */
  label: string;
  items: PickerItem[];
  value?: string;
  onChange: (id: string | undefined) => void;
  /** Создать новый элемент; вернуть его id. Дубликаты по имени Picker отсекает сам. */
  onCreate: (name: string, extra: { phone?: string }) => string | Promise<string>;
  icon?: ReactNode;
  placeholder?: string;
  /** Подпись поля для экранного диктора; по умолчанию «<label>: выбрать». */
  ariaLabel?: string;
  /** Подстрока плашки, если у элемента нет своей (у источника — «посредник»). */
  defaultSub?: string;
  /** Что показать под плашкой выбранного элемента (кнопки связи у контакта). */
  actions?: ReactNode;
}

const KIND_WORD: Record<PickerKind, string> = { contact: 'контакт', source: 'источник' };
const MAX_OPTIONS = 50;

type Mode = 'closed' | 'open' | 'form';

export function Picker({
  kind,
  label,
  items,
  value,
  onChange,
  onCreate,
  icon,
  placeholder = 'Выбрать',
  ariaLabel,
  defaultSub,
  actions,
}: PickerProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<'trigger' | 'clear' | null>(null);
  const [mode, setMode] = useState<Mode>('closed');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');

  const selected = value ? items.find((x) => x.id === value) : undefined;
  const word = KIND_WORD[kind];

  const q = query.trim();
  const matches = useMemo(() => {
    const nq = norm(q);
    const dq = digits(q);
    const list = !nq
      ? items
      : items.filter(
          (it) =>
            norm(`${it.label} ${it.search ?? ''}`).includes(nq) ||
            (dq.length >= 2 && digits(it.search ?? '').includes(dq)),
        );
    return list.slice(0, MAX_OPTIONS);
  }, [items, q]);
  const exact = (name: string) => items.find((it) => norm(it.label) === norm(name));
  const showAdd = Boolean(q) && !exact(q);
  const optionCount = matches.length + (showAdd ? 1 : 0);

  useEffect(() => setActive(0), [q]);

  // Клик вне виджета закрывает список.
  useEffect(() => {
    if (mode !== 'open') return;
    const onDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  });

  // Вернуть фокус на поле или на крестик после закрытия.
  useEffect(() => {
    if (!focusAfter.current) return;
    const target = focusAfter.current === 'clear' ? clearRef.current : triggerRef.current;
    focusAfter.current = null;
    target?.focus();
  });

  function close(restoreFocus: boolean) {
    setMode('closed');
    setQuery('');
    if (restoreFocus) focusAfter.current = 'trigger';
  }

  function choose(id: string) {
    onChange(id);
    setMode('closed');
    setQuery('');
    focusAfter.current = 'clear';
  }

  function create(name: string, extra: { phone?: string }) {
    const dup = name ? exact(name) : undefined;
    if (dup) return choose(dup.id);
    const r = onCreate(name, extra);
    if (typeof r === 'string') choose(r);
    else void r.then(choose);
  }

  function startAdd() {
    if (!q) return;
    const dup = exact(q);
    if (dup) return choose(dup.id);
    if (kind === 'contact') {
      setFormName(q);
      setFormPhone('');
      setMode('form');
    } else {
      create(q, {});
    }
  }

  function pick(index: number) {
    if (index < matches.length) choose(matches[index].id);
    else if (showAdd) startAdd();
  }

  function onSearchKey(ev: KeyboardEvent<HTMLInputElement>) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (optionCount) setActive((a) => (a + 1) % optionCount);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (optionCount) setActive((a) => (a - 1 + optionCount) % optionCount);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (optionCount && active >= 0 && active < optionCount) pick(active);
    } else if (ev.key === 'Escape') {
      // Не закрывать всю карточку — только список.
      ev.preventDefault();
      ev.stopPropagation();
      close(true);
    }
  }

  function saveForm() {
    const name = formName.trim();
    const phone = formPhone.trim();
    if (!name && !phone) return;
    create(name, phone ? { phone } : {});
  }

  function onFormKey(ev: KeyboardEvent<HTMLInputElement>) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      saveForm();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close(true);
    }
  }

  const optionId = (i: number) => `${uid}-opt-${i}`;
  const initial = (s: string) => (s.trim()[0] ?? '?').toUpperCase();

  return (
    <div className={`picker picker-${kind}`} ref={rootRef}>
      <div className="picker-label" id={`${uid}-label`}>
        {label}
      </div>

      {mode === 'closed' && !selected && (
        <button
          type="button"
          ref={triggerRef}
          className="picker-trigger"
          aria-haspopup="listbox"
          aria-expanded={false}
          aria-label={ariaLabel ?? `${label}: выбрать`}
          onClick={() => setMode('open')}
        >
          <span className="picker-ico" aria-hidden>
            {icon}
          </span>
          <span className="picker-text">{placeholder}</span>
          <svg className="picker-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      )}

      {mode === 'closed' && selected && (
        <>
          <div className="picker-plate" role="group" aria-labelledby={`${uid}-label`}>
            <span className="picker-av" aria-hidden>
              {initial(selected.label)}
            </span>
            <span className="picker-names">
              <span className="picker-name">{selected.label}</span>
              {(selected.sub ?? defaultSub) && <span className="picker-sub">{selected.sub ?? defaultSub}</span>}
            </span>
            <button
              type="button"
              ref={clearRef}
              className="picker-x"
              aria-label={`Убрать ${word}`}
              onClick={() => {
                onChange(undefined);
                focusAfter.current = 'trigger';
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          {actions && <div className="picker-actions">{actions}</div>}
        </>
      )}

      {mode === 'open' && (
        <div className="picker-drop">
          <div className="picker-search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-4-4" />
            </svg>
            <input
              role="combobox"
              aria-label={`Поиск: ${word}`}
              aria-expanded={true}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={optionCount ? optionId(active) : undefined}
              placeholder={kind === 'contact' ? 'Имя или телефон' : 'Имя'}
              value={query}
              autoFocus
              onChange={(ev) => setQuery(ev.target.value)}
              onKeyDown={onSearchKey}
            />
          </div>
          <ul className="picker-list" id={listId} role="listbox" aria-label={label}>
            {matches.map((it, i) => (
              <li
                key={it.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={'picker-opt' + (i === active ? ' active' : '')}
                onMouseDown={(ev) => ev.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(i)}
              >
                <span className="picker-av small" aria-hidden>
                  {initial(it.label)}
                </span>
                <span className="picker-names">
                  <span>{it.label}</span>
                  {it.sub && <span className="picker-sub muted">{it.sub}</span>}
                </span>
              </li>
            ))}
            {showAdd && (
              <li
                id={optionId(matches.length)}
                role="option"
                aria-selected={active === matches.length}
                className={'picker-opt picker-add' + (active === matches.length ? ' active' : '')}
                onMouseDown={(ev) => ev.preventDefault()}
                onMouseEnter={() => setActive(matches.length)}
                onClick={() => pick(matches.length)}
              >
                + Добавить «{q}»
              </li>
            )}
            {!optionCount && (
              <li className="picker-empty muted" role="presentation">
                {items.length ? 'Ничего не найдено' : 'Список пуст — начните вводить имя'}
              </li>
            )}
          </ul>
        </div>
      )}

      {mode === 'form' && (
        <div className="picker-form" role="group" aria-label="Новый контакт">
          <div className="field">
            <label htmlFor={`${uid}-name`}>Имя</label>
            <input
              id={`${uid}-name`}
              value={formName}
              onChange={(ev) => setFormName(ev.target.value)}
              onKeyDown={onFormKey}
            />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-phone`}>Телефон (необязательно)</label>
            <input
              id={`${uid}-phone`}
              type="tel"
              inputMode="tel"
              autoFocus
              value={formPhone}
              onChange={(ev) => setFormPhone(ev.target.value)}
              onKeyDown={onFormKey}
            />
          </div>
          <div className="row gap">
            <button type="button" className="primary" onClick={saveForm} disabled={!formName.trim() && !formPhone.trim()}>
              Сохранить
            </button>
            <button type="button" onClick={() => close(true)}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function PersonIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  );
}

export function ArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 12h12" />
      <path d="M12 6l6 6-6 6" />
      <path d="M20 5v14" />
    </svg>
  );
}
