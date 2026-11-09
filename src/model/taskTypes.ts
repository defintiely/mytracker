// Типы задач из настроек (SPEC §5, §6.5). Все типы равноправны: встроенных нет.
// Все чтения типа записи (цвет, название, «с деньгами») идут через эти помощники.
import type { EntryType, Settings, TaskTypeDef } from './types';
import { DEFAULT_TASK_TYPES } from './types';

/** Цвет для записи неизвестного типа (тип удалён на другом устройстве и т.п.). */
export const UNKNOWN_TYPE_COLOR = '#cfd8dc';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function defaultsWithColors(legacyColors: Record<string, unknown>): TaskTypeDef[] {
  return DEFAULT_TASK_TYPES.map((d) => {
    const c = legacyColors[d.id];
    return typeof c === 'string' && c ? { ...d, color: c } : { ...d };
  });
}

/**
 * Привести типы задач к полному виду. Нет списка (документ старой версии) — три типа по умолчанию
 * (цвета из старого typeColors, если были). Битые элементы отбрасываются, старый флаг builtin стирается.
 * Если живых типов не осталось вовсе — типы по умолчанию возвращаются (без типов приложение не работает).
 * Включает tombstone-ы (deleted) — они нужны синхронизации. Идемпотентно.
 */
export function normalizeTaskTypes(s: { taskTypes?: unknown; typeColors?: unknown } | undefined): TaskTypeDef[] {
  const raw = s?.taskTypes;
  const legacyColors = isObject(s?.typeColors) ? s!.typeColors : {};
  if (!Array.isArray(raw)) return defaultsWithColors(legacyColors);
  const seen = new Set<string>();
  const list: TaskTypeDef[] = [];
  for (const it of raw) {
    if (!isObject(it) || typeof it.id !== 'string' || !it.id || seen.has(it.id)) continue;
    seen.add(it.id);
    const def = DEFAULT_TASK_TYPES.find((d) => d.id === it.id);
    const t: TaskTypeDef = {
      id: it.id,
      name: typeof it.name === 'string' && it.name.trim() ? it.name : (def?.name ?? it.id),
      color: typeof it.color === 'string' && it.color ? it.color : (def?.color ?? UNKNOWN_TYPE_COLOR),
      money: typeof it.money === 'boolean' ? it.money : (def?.money ?? true),
    };
    if (it.deleted === true) t.deleted = true;
    list.push(t);
  }
  if (list.some((t) => !t.deleted)) return list;
  // Живых типов нет: вернуть типы по умолчанию (удалённые с теми же id — оживить).
  const defaults = defaultsWithColors(legacyColors);
  const revived = list.map((t) => {
    if (!defaults.some((d) => d.id === t.id)) return t;
    const { deleted: _gone, ...alive } = t;
    return alive;
  });
  const missing = defaults.filter((d) => !seen.has(d.id));
  return [...missing, ...revived];
}

const cache = new WeakMap<object, TaskTypeDef[]>();

/** Все типы, включая удалённые (tombstone). Результат кэшируется на объект настроек. */
function allTypes(settings: Settings): TaskTypeDef[] {
  let v = cache.get(settings);
  if (!v) {
    v = normalizeTaskTypes(settings);
    cache.set(settings, v);
  }
  return v;
}

/** Типы задач для выбора и отображения, без удалённых. */
export function taskTypes(settings: Settings): TaskTypeDef[] {
  return allTypes(settings).filter((t) => !t.deleted);
}

/**
 * Варианты для выбора типа: активные типы + текущий тип записи, если он удалён или неизвестен
 * (чтобы выбор не «терял» значение).
 */
export function typeOptions(settings: Settings, current?: EntryType): TaskTypeDef[] {
  const list = taskTypes(settings);
  if (current === undefined || list.some((t) => t.id === current)) return list;
  return [...list, typeDef(settings, current)];
}

/**
 * Определение типа по id. Удалённый тип ещё отдаёт своё имя и цвет (записи могли прийти
 * с другого устройства); неизвестный id — серый тип «с деньгами» с именем id.
 */
export function typeDef(settings: Settings, id: EntryType): TaskTypeDef {
  const t = allTypes(settings).find((x) => x.id === id);
  return t ?? { id, name: String(id ?? ''), color: UNKNOWN_TYPE_COLOR, money: true };
}

export function typeColor(settings: Settings, id: EntryType): string {
  return typeDef(settings, id).color;
}

export function typeName(settings: Settings, id: EntryType): string {
  return typeDef(settings, id).name;
}

/** «С деньгами» — только по флагу money типа. */
export function typeHasMoney(settings: Settings, id: EntryType): boolean {
  return typeDef(settings, id).money;
}

/**
 * Тип по умолчанию (новые записи, записи с суммой при быстром вводе и импорте):
 * Settings.defaultTypeId, если тип жив; иначе первый живой тип с деньгами; иначе первый живой.
 */
export function defaultTypeId(settings: Settings): EntryType {
  const list = taskTypes(settings);
  const chosen = settings.defaultTypeId && list.find((t) => t.id === settings.defaultTypeId);
  if (chosen) return chosen.id;
  return (list.find((t) => t.money) ?? list[0])?.id ?? DEFAULT_TASK_TYPES[0].id;
}

/**
 * Тип для дел без денег (запись без суммы и без признаков работы):
 * Settings.defaultNoMoneyTypeId, если тип жив; иначе первый живой тип без денег; иначе тип по умолчанию.
 */
export function defaultNoMoneyTypeId(settings: Settings): EntryType {
  const list = taskTypes(settings);
  const chosen = settings.defaultNoMoneyTypeId && list.find((t) => t.id === settings.defaultNoMoneyTypeId);
  if (chosen) return chosen.id;
  return list.find((t) => !t.money)?.id ?? defaultTypeId(settings);
}
