// Общие компоненты интерфейса: контекст навигации, модалка, значки, поля с фиксацией по blur.
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { Entry, EntryType, Settings } from '../model/types';
import { STATUS_LABELS, TYPE_LABELS } from '../model/types';
import { payState } from '../model/entry';
import { PAY_ICONS, STATUS_ICONS } from './util';

// ---------- контекст: открыть карточку / создать запись ----------

export interface UiApi {
  openEntry(id: string): void;
  /** Открыть карточку новой записи (в store попадает только по кнопке «Создать»). */
  createEntry(partial?: Partial<Entry>): void;
  openMoney(id: string): void;
}

export const UiContext = createContext<UiApi>({
  openEntry: () => {},
  createEntry: () => {},
  openMoney: () => {},
});

export function useUi(): UiApi {
  return useContext(UiContext);
}

// ---------- медиа-запрос ----------

const MOBILE_QUERY = '(max-width: 759px)';

function subscribeMedia(cb: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener?.('change', cb);
  return () => mq.removeEventListener?.('change', cb);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeMedia,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(MOBILE_QUERY).matches : false),
    () => false,
  );
}

// ---------- значки ----------

export function typeColor(settings: Settings, t: EntryType): string {
  return settings.typeColors[t];
}

export function TypeDot({ type, settings }: { type: EntryType; settings: Settings }) {
  return (
    <span
      className="type-dot"
      style={{ background: settings.typeColors[type] }}
      title={TYPE_LABELS[type]}
      aria-label={TYPE_LABELS[type]}
    />
  );
}

export function StatusBadge({ status, compact }: { status: Entry['status']; compact?: boolean }) {
  return (
    <span className={`status-badge st-${status}`} title={STATUS_LABELS[status]}>
      <span aria-hidden>{STATUS_ICONS[status]}</span>
      {!compact && <span className="status-text">{STATUS_LABELS[status]}</span>}
    </span>
  );
}

export function PayIcon({ entry }: { entry: Pick<Entry, 'amount' | 'money' | 'type'> }) {
  const ps = payState(entry);
  if (ps === 'none') return null;
  const p = PAY_ICONS[ps];
  return (
    <span className={`pay-icon pay-${ps}`} title={p.label} aria-label={p.label}>
      {p.icon}
    </span>
  );
}

// ---------- модалка ----------

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' modal-wide' : '')} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- поля, фиксирующие значение по blur / Enter ----------

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>;

export function CommitInput({
  value,
  onCommit,
  ...rest
}: InputProps & { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value);
  }, [value]);
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  return (
    <input
      {...rest}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => {
        focused.current = true;
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        focused.current = false;
        commit();
        rest.onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setV(value);
        rest.onKeyDown?.(e);
      }}
    />
  );
}

export function CommitTextarea({
  value,
  onCommit,
  ...rest
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string;
  onCommit: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value);
  }, [value]);
  return (
    <textarea
      {...rest}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        if (v !== value) onCommit(v);
      }}
    />
  );
}

/** Число или undefined из строки поля ввода. */
export function parseAmount(s: string): number | undefined {
  const t = s.replace(/\s/g, '').replace(',', '.').replace('€', '');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
