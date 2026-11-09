// Типы задач: встроенные main/joint/personal + свои из настроек (SPEC §5, §6.5).
// Все чтения типа записи (цвет, название, «с деньгами») идут через эти помощники.
import type { BuiltinType, EntryType, Settings, TaskTypeDef } from './types';
import { DEFAULT_SETTINGS } from './types';

export const BUILTIN_TYPES: readonly BuiltinType[] = ['main', 'joint', 'personal'];

/** Цвет для записи неизвестного типа (тип удалён на другом устройстве и т.п.). */
export const UNKNOWN_TYPE_COLOR = '#cfd8dc';

export function isBuiltinType(id: string): id is BuiltinType {
  return (BUILTIN_TYPES as readonly string[]).includes(id);
}

function defaultBuiltin(id: BuiltinType): TaskTypeDef {
  return { ...DEFAULT_SETTINGS.taskTypes.find((t) => t.id === id)! };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Привести типы задач к полному виду: встроенные есть всегда (не удалены, money зафиксирован),
 * битые элементы отбрасываются. Старый документ без taskTypes — типы из typeColors и названий по умолчанию.
 * Включает tombstone-ы (deleted) — они нужны синхронизации.
 */
export function normalizeTaskTypes(s: { taskTypes?: unknown; typeColors?: unknown } | undefined): TaskTypeDef[] {
  const raw = s?.taskTypes;
  if (!Array.isArray(raw)) {
    const legacy = isObject(s?.typeColors) ? s!.typeColors : {};
    return BUILTIN_TYPES.map((id) => {
      const d = defaultBuiltin(id);
      const c = legacy[id];
      return typeof c === 'string' && c ? { ...d, color: c } : d;
    });
  }
  const seen = new Set<string>();
  const list: TaskTypeDef[] = [];
  for (const it of raw) {
    if (!isObject(it) || typeof it.id !== 'string' || !it.id || seen.has(it.id)) continue;
    seen.add(it.id);
    const id = it.id;
    if (isBuiltinType(id)) {
      const d = defaultBuiltin(id);
      list.push({
        id,
        name: typeof it.name === 'string' && it.name.trim() ? it.name : d.name,
        color: typeof it.color === 'string' && it.color ? it.color : d.color,
        money: d.money,
        builtin: true,
      });
    } else {
      const t: TaskTypeDef = {
        id,
        name: typeof it.name === 'string' && it.name.trim() ? it.name : id,
        color: typeof it.color === 'string' && it.color ? it.color : UNKNOWN_TYPE_COLOR,
        money: it.money !== false,
      };
      if (it.deleted === true) t.deleted = true;
      list.push(t);
    }
  }
  // Недостающие встроенные — в начало, в каноническом порядке.
  const missing = BUILTIN_TYPES.filter((id) => !seen.has(id)).map(defaultBuiltin);
  return [...missing, ...list];
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

/** Типы задач для выбора и отображения: встроенные + свои, без удалённых. */
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

export function typeHasMoney(settings: Settings, id: EntryType): boolean {
  return typeDef(settings, id).money;
}
