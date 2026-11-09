// Мини-карточка записи: полоса цвета типа слева, заголовок, дата/время, место, статус и оплата.
import type { Entry, TrackerDoc } from '../model/types';
import { formatEUR } from '../model/entry';
import { typeColor, typeHasMoney } from '../model/taskTypes';
import { PayIcon, StatusBadge, useUi } from './common';
import { formatTime, sourceName } from './util';
import { formatDayRange, useDateFormat } from './dates';

export function EntryMini({
  e,
  doc,
  note,
  draggable,
  extra,
}: {
  e: Entry;
  doc: TrackerDoc;
  note?: string;
  draggable?: boolean;
  extra?: React.ReactNode;
}) {
  const ui = useUi();
  useDateFormat();
  const when = [formatDayRange(e, { weekday: true }), formatTime(e)].filter(Boolean).join(' · ');
  return (
    <div
      className={'mini' + (e.dateTentative ? ' tentative' : '')}
      style={{ ['--tc' as string]: typeColor(doc.settings, e.type) }}
      draggable={draggable}
      onDragStart={(ev) => {
        ev.dataTransfer.setData('text/plain', e.id);
        ev.dataTransfer.effectAllowed = 'move';
      }}
    >
      <button type="button" className="mini-main" onClick={() => ui.openEntry(e.id)}>
        <span className="mini-title">{e.title || 'без названия'}</span>
        {when && <span className="mini-sub">{when}</span>}
        {(e.location || e.sourceId) && (
          <span className="mini-sub muted">{[e.location, sourceName(doc, e.sourceId)].filter(Boolean).join(' · ')}</span>
        )}
        {note && <span className="mini-note">{note}</span>}
      </button>
      <div className="mini-side">
        {typeHasMoney(doc.settings, e.type) && e.amount !== undefined && (
          <span className="mini-amount">{formatEUR(e.amount)}</span>
        )}
        <span className="row gap-s">
          <PayIcon entry={e} settings={doc.settings} />
          <StatusBadge status={e.status} compact />
        </span>
        {extra}
      </div>
    </div>
  );
}
