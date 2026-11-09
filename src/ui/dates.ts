// Вывод дат пользователю в формате, выбранном в «Настройках → Внешний вид» (хранится на устройстве).
// Все места, где дата показывается текстом, идут через formatDay / formatDayRange / formatDateTime;
// поля ввода type=date браузер рисует по-своему, экспорт в .ods держит свой формат таблицы.
import type { Entry, ISODate } from '../model/types';
import { devicePref } from './tablePrefs';
import { pad2, parseISODate, toISODate } from './util';

export const DATE_FORMAT_KEY = 'wlt.date.format';

/**
 * Формат даты:
 * - 'dd.mm' — 05.12 (по умолчанию);
 * - 'dd mm' — 05 12;
 * - 'dd mon' — 05 дек;
 * - 'd month' — 5 декабря;
 * - 'dd.mm.yy' — 05.12.26 (год всегда);
 * - 'iso' — 2026-12-05 (год всегда).
 */
export type DateFormat = 'dd.mm' | 'dd mm' | 'dd mon' | 'd month' | 'dd.mm.yy' | 'iso';

/** Порядок вариантов и подписи в «Настройках». */
export const DATE_FORMATS: { id: DateFormat; label: string }[] = [
  { id: 'dd.mm', label: 'ДД.ММ' },
  { id: 'dd mm', label: 'ДД ММ' },
  { id: 'dd mon', label: 'ДД мес' },
  { id: 'd month', label: 'Д месяца' },
  { id: 'dd.mm.yy', label: 'ДД.ММ.ГГ' },
  { id: 'iso', label: 'ГГГГ-ММ-ДД' },
];

export const DEFAULT_DATE_FORMAT: DateFormat = 'dd.mm';

const isDateFormat = (v: unknown): v is DateFormat => DATE_FORMATS.some((f) => f.id === v);

const dateFormat = devicePref<DateFormat>(DATE_FORMAT_KEY, DEFAULT_DATE_FORMAT, (v) => (isDateFormat(v) ? v : undefined));

export const getDateFormat = dateFormat.get;
export const setDateFormat = dateFormat.set;

/** Показывать ли день недели перед датой («пт 05.12») там, где он предусмотрен. По умолчанию — да. */
export const WEEKDAY_KEY = 'wlt.date.weekday';
const weekdayPref = devicePref<boolean>(WEEKDAY_KEY, true, (v) => (typeof v === 'boolean' ? v : undefined));
export const getShowWeekday = weekdayPref.get;
export const setShowWeekday = weekdayPref.set;
export const useShowWeekday = weekdayPref.use;

/**
 * Подписка на настройки дат (формат и день недели): компонент, который выводит даты,
 * перерисуется сразу при смене любой из них.
 */
export function useDateFormat(): ReturnType<typeof dateFormat.use> {
  weekdayPref.use();
  return dateFormat.use();
}

export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export interface DayOpts {
  /**
   * Год для форматов без года: 'auto' (по умолчанию) — дописать, если дата не в текущем году;
   * 'never' — не дописывать (таблица и её месяцы: год ясен из заголовка месяца).
   * Форматы с годом (ДД.ММ.ГГ, ГГГГ-ММ-ДД) показывают год всегда.
   */
  year?: 'auto' | 'never';
  /** Короткий день недели впереди: «пт 05.12» — если не выключен в настройках (см. showWeekday). */
  weekday?: boolean;
  /** Настройка «день недели» вместо сохранённой на устройстве (превью в «Настройках», тесты). */
  showWeekday?: boolean;
  /** Формат вместо настройки на устройстве (превью в «Настройках», тесты). */
  format?: DateFormat;
}

/** Дата ISO (ГГГГ-ММ-ДД) в выбранном формате. Пустая строка для пустой даты. */
export function formatDay(iso: ISODate | undefined, opts: DayOpts = {}): string {
  if (!iso) return '';
  const [ys, ms, ds] = iso.split('-');
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  if (!y || !m || !d) return iso;
  const fmt = opts.format ?? getDateFormat();
  const addYear = opts.year !== 'never' && y !== new Date().getFullYear();
  const dd = pad2(d);
  const mm = pad2(m);
  const yy = pad2(y % 100);
  let out: string;
  switch (fmt) {
    case 'dd mm':
      out = `${dd} ${mm}` + (addYear ? ` ${yy}` : '');
      break;
    case 'dd mon':
      out = `${dd} ${MONTHS_SHORT[m - 1]}` + (addYear ? ` ${y}` : '');
      break;
    case 'd month':
      out = `${d} ${MONTHS_GENITIVE[m - 1]}` + (addYear ? ` ${y}` : '');
      break;
    case 'dd.mm.yy':
      out = `${dd}.${mm}.${yy}`;
      break;
    case 'iso':
      out = `${ys}-${mm}-${dd}`;
      break;
    default:
      out = `${dd}.${mm}` + (addYear ? `.${yy}` : '');
  }
  if (opts.weekday && (opts.showWeekday ?? getShowWeekday())) out = WEEKDAYS_SHORT[parseISODate(iso).getDay()] + ' ' + out;
  return out;
}

/** Даты записи: «05.12», «05.12–07.12», «05.12?»; день недели — только у первой даты. */
export function formatDayRange(e: Pick<Entry, 'date' | 'dateEnd' | 'dateTentative'>, opts: DayOpts = {}): string {
  if (!e.date) return '';
  let s = formatDay(e.date, opts);
  if (e.dateEnd && e.dateEnd !== e.date) s += '–' + formatDay(e.dateEnd, { ...opts, weekday: false });
  if (e.dateTentative) s += '?';
  return s;
}

/** Момент времени (ISO-штамп): дата в выбранном формате (с годом, если он не текущий) и местное время ЧЧ:ММ. */
export function formatDateTime(ts: string | number | Date | undefined, opts: Omit<DayOpts, 'weekday'> = {}): string {
  if (ts === undefined || ts === '') return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${formatDay(toISODate(d), opts)}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
