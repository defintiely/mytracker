// Трёхстороннее слияние документа трекера (SPEC §7). Чистые функции, без побочных эффектов.
//
// base   — снимок документа после последней успешной синхронизации этого устройства;
// local  — текущий документ устройства;
// remote — документ из Drive.
//
// Правила по каждой записи (entries / contacts / sources по id, settings — одна запись):
//  - запись есть только с одной стороны → берём её;
//  - запись изменена только одной стороной относительно base → берём эту сторону, но по полям и
//    только там, где её метка не старее другой стороны (иначе это откат после перезаписи файла в Drive
//    устаревшей версией, а не правка — см. ограничение атомарности в drive.ts);
//  - изменена обеими → слияние по полям: поле поменяла одна сторона → её значение; обе → побеждает
//    больший fieldUpdatedAt[поле] (fallback updatedAt), проигравшее значение уходит в Conflict;
//  - одна сторона удалила (tombstone deleted:true), другая правила → правка побеждает, только если её
//    updatedAt строго позже удаления;
//  - tombstone старше 90 дней вычищается.
// Детерминированность: при равных метках выбирается значение с большим каноническим JSON, а записи
// в массивах сортируются по (createdAt, id) — поэтому merge(base, a, b) и merge(base, b, a) дают один
// и тот же документ, и два устройства сходятся.
import type { Contact, Entry, Settings, Source, TrackerDoc } from '../model/types';
import type { Conflict } from './types';

export const TOMBSTONE_TTL_DAYS = 90;

export interface MergeOptions {
  /** Текущее время (для вычистки tombstone и метки конфликтов). */
  now?: Date;
}

export interface MergeResult {
  doc: TrackerDoc;
  conflicts: Conflict[];
}

type Collection = Conflict['collection'];

interface RecordLike {
  id?: string;
  updatedAt: string;
  createdAt?: string;
  deleted?: boolean;
  fieldUpdatedAt?: Partial<Record<string, string>>;
}

/** Служебные поля, которые не сливаются как данные. */
const META_FIELDS = new Set(['id', 'updatedAt', 'fieldUpdatedAt']);

// ---------------------------------------------------------------- сравнение значений

/** Канонический JSON: ключи отсортированы, undefined-поля опущены. Массивы — по порядку. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** Глубокое сравнение по значению (отсутствующее поле == undefined). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return stableStringify(a) === stableStringify(b);
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- слияние одной записи

/**
 * Время последней правки поля. Нет fieldUpdatedAt у записи вообще (контакты, settings, старые записи) —
 * updatedAt записи. Есть, но без этого поля — поле не правили с создания: createdAt (а не updatedAt,
 * иначе поздняя правка ДРУГОГО поля «состарит» чужую настоящую правку этого поля).
 */
function fieldTime(r: RecordLike, field: string): string {
  const own = r.fieldUpdatedAt?.[field];
  if (own !== undefined) return own;
  if (r.fieldUpdatedAt && Object.keys(r.fieldUpdatedAt).length) return r.createdAt ?? '';
  return r.updatedAt ?? '';
}

function deletionTime(r: RecordLike): string {
  return r.fieldUpdatedAt?.deleted ?? r.updatedAt ?? '';
}

function maxStr(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a >= b ? a : b;
}

interface Ctx {
  collection: Collection;
  at: string;
  conflicts: Conflict[];
}

/** Выбрать одну из двух целых версий записи детерминированно (по updatedAt, потом по JSON). */
function pickWhole<T extends RecordLike>(a: T, b: T): T {
  const c = cmpStr(a.updatedAt ?? '', b.updatedAt ?? '');
  if (c !== 0) return c > 0 ? a : b;
  return cmpStr(stableStringify(a), stableStringify(b)) >= 0 ? a : b;
}

function mergeRecord<T extends RecordLike>(
  id: string,
  base: T | undefined,
  local: T | undefined,
  remote: T | undefined,
  ctx: Ctx,
): T | undefined {
  if (!local) return remote;
  if (!remote) return local;
  if (deepEqual(local, remote)) return local;

  // «Изменила только одна сторона» НЕ означает, что надо слепо брать эту сторону: отличие от base может
  // быть не правкой, а откатом — другое устройство перезаписало файл в Drive устаревшей версией (запись
  // в Drive не атомарна, см. drive.ts). Поэтому записи, отличающиеся с обеих сторон, всегда сливаются
  // по полям, и поле одной стороны берётся, только если оно не старее поля другой стороны.
  const localChanged = !base || !deepEqual(local, base);
  const remoteChanged = !base || !deepEqual(remote, base);
  // Конфликт — только когда обе стороны правили запись после общей base.
  const logConflicts = base !== undefined && localChanged && remoteChanged;

  // Удаление против правки (и против устаревшей не удалённой версии): правка побеждает, только если
  // она строго позже удаления.
  if (Boolean(local.deleted) !== Boolean(remote.deleted)) {
    const del = local.deleted ? local : remote;
    const edit = local.deleted ? remote : local;
    const editWins = cmpStr(edit.updatedAt ?? '', deletionTime(del)) > 0;
    const winner = editWins ? edit : del;
    const loser = editWins ? del : edit;
    if (logConflicts) {
      ctx.conflicts.push({
        at: ctx.at,
        collection: ctx.collection,
        id,
        field: 'deleted',
        lostValue: editWins ? true : stripMeta(loser),
        keptValue: editWins ? stripMeta(winner) : true,
      });
    }
    return winner;
  }

  // Слияние по полям.
  const keys = new Set<string>([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base ?? {})]);
  const out: Record<string, unknown> = {};
  const b = (base ?? {}) as Record<string, unknown>;
  const l = local as unknown as Record<string, unknown>;
  const r = remote as unknown as Record<string, unknown>;
  for (const k of [...keys].sort()) {
    if (META_FIELDS.has(k)) continue;
    const lv = l[k];
    const rv = r[k];
    let v: unknown;
    if (deepEqual(lv, rv)) v = lv;
    else {
      const lc = base === undefined || !deepEqual(lv, b[k]);
      const rc = base === undefined || !deepEqual(rv, b[k]);
      const c = cmpStr(fieldTime(local, k), fieldTime(remote, k));
      if (lc !== rc && base) {
        // Поле поменяла одна сторона (у другой оно равно base). Настоящая правка двигает метку поля
        // вперёд относительно base; если метка изменившей стороны СТАРЕЕ метки в base — это откат
        // (файл в Drive перетёрт устаревшей версией), оставляем значение base = значение другой стороны.
        // Сравнение с base, а не с другой стороной: у записей без fieldUpdatedAt (контакты, settings)
        // метка поля — updatedAt записи, и честные правки разных полей не должны отбрасывать друг друга.
        const changer = lc ? local : remote;
        const rollback = cmpStr(fieldTime(changer, k), fieldTime(base, k)) < 0;
        v = lc !== rollback ? lv : rv;
      } else {
        const localWins = c !== 0 ? c > 0 : cmpStr(stableStringify(lv), stableStringify(rv)) >= 0;
        v = localWins ? lv : rv;
        if (logConflicts && base !== undefined) {
          ctx.conflicts.push({
            at: ctx.at,
            collection: ctx.collection,
            id,
            field: k,
            lostValue: localWins ? rv : lv,
            keptValue: v,
          });
        }
      }
    }
    if (v !== undefined) out[k] = v;
  }
  if (local.id !== undefined) out.id = local.id;
  out.updatedAt = maxStr(local.updatedAt, remote.updatedAt);
  if (local.fieldUpdatedAt || remote.fieldUpdatedAt) {
    const fua: Record<string, string> = {};
    const fk = new Set([...Object.keys(local.fieldUpdatedAt ?? {}), ...Object.keys(remote.fieldUpdatedAt ?? {})]);
    for (const k of [...fk].sort()) {
      const t = maxStr(local.fieldUpdatedAt?.[k], remote.fieldUpdatedAt?.[k]);
      if (t !== undefined) fua[k] = t;
    }
    out.fieldUpdatedAt = fua;
  }
  return out as unknown as T;
}

function stripMeta(r: RecordLike): unknown {
  const { fieldUpdatedAt: _f, ...rest } = r;
  return rest;
}

// ---------------------------------------------------------------- коллекции

function byId<T extends RecordLike>(list: T[] | undefined): Map<string, T> {
  const m = new Map<string, T>();
  for (const x of list ?? []) {
    if (!x || typeof x.id !== 'string') continue;
    const prev = m.get(x.id);
    // Дубликат id внутри одного документа — оставляем детерминированно одну версию.
    m.set(x.id, prev ? pickWhole(prev, x) : x);
  }
  return m;
}

function isExpiredTombstone(r: RecordLike, cutoff: string): boolean {
  return Boolean(r.deleted) && deletionTime(r) < cutoff;
}

function mergeCollection<T extends RecordLike>(
  collection: Collection,
  base: T[] | undefined,
  local: T[],
  remote: T[],
  at: string,
  cutoff: string,
  conflicts: Conflict[],
): T[] {
  const b = byId(base);
  const l = byId(local);
  const r = byId(remote);
  const ids = new Set<string>([...l.keys(), ...r.keys()]);
  const ctx: Ctx = { collection, at, conflicts };
  const out: T[] = [];
  for (const id of ids) {
    const merged = mergeRecord(id, b.get(id), l.get(id), r.get(id), ctx);
    if (!merged || isExpiredTombstone(merged, cutoff)) continue;
    out.push(merged);
  }
  out.sort((x, y) => cmpStr(x.createdAt ?? '', y.createdAt ?? '') || cmpStr(x.id!, y.id!));
  return out;
}

// ---------------------------------------------------------------- документ

export function merge(
  base: TrackerDoc | undefined,
  local: TrackerDoc,
  remote: TrackerDoc,
  opts: MergeOptions = {},
): MergeResult {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const cutoff = new Date(now.getTime() - TOMBSTONE_TTL_DAYS * 86_400_000).toISOString();
  const conflicts: Conflict[] = [];

  const entries = mergeCollection<Entry & RecordLike>(
    'entries',
    base?.entries as (Entry & RecordLike)[] | undefined,
    local.entries as (Entry & RecordLike)[],
    remote.entries as (Entry & RecordLike)[],
    at,
    cutoff,
    conflicts,
  );
  const contacts = mergeCollection<Contact & RecordLike>(
    'contacts',
    base?.contacts,
    local.contacts,
    remote.contacts,
    at,
    cutoff,
    conflicts,
  );
  const sources = mergeCollection<Source & RecordLike>(
    'sources',
    base?.sources,
    local.sources,
    remote.sources,
    at,
    cutoff,
    conflicts,
  );
  const settings = mergeRecord<Settings & RecordLike>(
    'settings',
    base?.settings,
    local.settings,
    remote.settings,
    { collection: 'settings', at, conflicts },
  ) as Settings;

  return {
    doc: { schemaVersion: 1, entries, contacts, sources, settings },
    conflicts,
  };
}
