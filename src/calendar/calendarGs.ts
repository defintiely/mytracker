// Часть текста Google Apps Script, которая ведёт календарь (запрос `calendar`, контракт — src/sync/scriptApi.ts).
// Это чистый Apps Script (V8): без import/export и без TypeScript. Шапка скрипта (doPost, ключ, маршрутизация,
// ContentService) собирается в другом модуле и вызывает handleCalendar_(req) → CalendarResponse.
// Все имена верхнего уровня — с префиксом wltCal и суффиксом `_`, чтобы не пересечься со шапкой.
//
// Что делает handleCalendar_:
//  1. Находит свой календарь (id в ScriptProperties 'calendarId'); нет — создаёт; сменилось имя — переименовывает.
//     Основной календарь пользователя не трогает никогда.
//  2. Берёт события календаря в окне [windowStart, windowEnd]. События приложения помечены тегами
//     wltEntry (id записи), wltHash (хэш выгруженного содержимого), wltWhen (время на момент выгрузки).
//  3. Время события ≠ wltWhen → пользователь перенёс событие → moved (время не откатываем).
//     Событие из учёта выгруженного (ScriptProperties 'calPushed' = {entryId: eventId}) пропало → removedByUser.
//  4. Для каждого DesiredEvent: нет события — создать; хэш совпал — не трогать; хэш другой — обновить.
//  5. События приложения, которых нет в req.events (и которые не перенесли только что), — удалить.
//  6. События без тега в окне — foreign (трекер предложит импорт).
//
// Необязательное поле DesiredEvent.adoptEventId (расширение контракта, см. src/calendar/calendarSync.ts):
// id чужого события, из которого импортирована запись. Если события приложения для записи ещё нет,
// скрипт помечает этим тегом само чужое событие, а не создаёт рядом дубль.

export const CALENDAR_GS: string = String.raw`
// ===================== Календарь (handleCalendar_) =====================

var WLT_CAL_ID_PROP_ = 'calendarId';
var WLT_CAL_PUSHED_PROP_ = 'calPushed';
/** Значение свойства скрипта — не больше 9 КБ, поэтому учёт выгруженного режем на куски. */
var WLT_CAL_CHUNK_ = 8000;
/** Запас до лимита 6 минут: дальше новые события не создаём, остаток доделает следующий вызов. */
var WLT_CAL_DEADLINE_MS_ = 4.5 * 60 * 1000;
var WLT_CAL_MAX_REMINDERS_ = 5;

function handleCalendar_(req) {
  var t0 = Date.now();
  var tz = req.timeZone || Session.getScriptTimeZone();
  var props = PropertiesService.getScriptProperties();
  var opened = wltCalOpen_(req, props, tz);
  var cal = opened.cal;
  var pushed = opened.fresh ? {} : wltCalLoadPushed_(props);

  var stats = { created: 0, updated: 0, deleted: 0 };
  var moved = [];
  var movedIds = {};
  var removedByUser = [];
  var foreign = [];

  try {
    var desired = {};
    var events = req.events || [];
    for (var i = 0; i < events.length; i++) desired[events[i].entryId] = events[i];

    // 1. события в окне
    var winStart = wltCalParse_(req.windowStart, '00:00', tz);
    var winEnd = wltCalParse_(wltCalAddDays_(req.windowEnd, 1), '00:00', tz);
    var list = cal.getEvents(winStart, winEnd);
    var byEntry = {};
    var seenForeign = {};
    for (var j = 0; j < list.length; j++) {
      var ev = list[j];
      var entryId = ev.getTag('wltEntry');
      var evId = ev.getId();
      if (!entryId) {
        if (seenForeign[evId]) continue; // экземпляры повторяющегося события — один раз
        seenForeign[evId] = true;
        foreign.push(wltCalForeign_(ev, tz));
        continue;
      }
      var prev = byEntry[entryId];
      if (prev) {
        if (prev.getId() === evId) continue;
        // дубль события одной записи: оставляем то, что в учёте, второе удаляем
        var keep = pushed[entryId] === evId ? ev : prev;
        var drop = keep === ev ? prev : ev;
        drop.deleteEvent();
        stats.deleted++;
        byEntry[entryId] = keep;
        continue;
      }
      byEntry[entryId] = ev;
    }

    // 2. выгруженное раньше, но не найденное в окне
    for (var pid in pushed) {
      if (!pushed.hasOwnProperty(pid) || byEntry[pid]) continue;
      if (!desired[pid]) {
        // вне окна и трекеру больше не нужно (запись ушла в прошлое) — просто забываем
        delete pushed[pid];
        continue;
      }
      var found = wltCalById_(cal, pushed[pid]);
      if (found && found.getTag('wltEntry') === pid) {
        byEntry[pid] = found; // событие за пределами окна
        continue;
      }
      removedByUser.push(pid);
      delete pushed[pid];
      delete desired[pid]; // не пересоздаём: трекер не выгружает запись, пока она не изменится
    }

    // 3. перенос пользователем
    for (var mid in byEntry) {
      if (!byEntry.hasOwnProperty(mid)) continue;
      var mev = byEntry[mid];
      var tagged = mev.getTag('wltWhen');
      var actual = wltCalWhen_(mev, tz);
      if (tagged && tagged !== actual.key) {
        moved.push({ entryId: mid, allDay: actual.allDay, start: actual.start, end: actual.end });
        movedIds[mid] = true;
        mev.setTag('wltWhen', actual.key);
        mev.setTag('wltHash', 'moved'); // следующий вызов обязательно обновит событие
      }
    }

    // 4. создать / обновить
    var adopted = {};
    for (var k = 0; k < events.length; k++) {
      var d = events[k];
      if (!desired[d.entryId] || desired[d.entryId] !== d) continue; // снят в шаге 2 или повтор entryId
      var cur = byEntry[d.entryId];
      if (!cur && d.adoptEventId) {
        var adopt = wltCalById_(cal, d.adoptEventId);
        if (adopt && !adopt.getTag('wltEntry')) {
          wltCalApply_(adopt, d, tz, true);
          stats.updated++;
          byEntry[d.entryId] = adopt;
          pushed[d.entryId] = adopt.getId();
          adopted[adopt.getId()] = true;
          continue;
        }
      }
      if (!cur) {
        if (Date.now() - t0 > WLT_CAL_DEADLINE_MS_) continue; // доделаем в следующий раз
        cur = wltCalCreate_(cal, d, tz);
        wltCalApply_(cur, d, tz, false);
        stats.created++;
        byEntry[d.entryId] = cur;
        pushed[d.entryId] = cur.getId();
        continue;
      }
      pushed[d.entryId] = cur.getId();
      if (cur.getTag('wltHash') === d.hash) continue;
      if (Date.now() - t0 > WLT_CAL_DEADLINE_MS_) continue;
      // только что перенесённое пользователем время не откатываем: трекер пришлёт новое следующим циклом
      wltCalApply_(cur, d, tz, !movedIds[d.entryId]);
      stats.updated++;
    }

    // 5. лишние события приложения
    for (var did in byEntry) {
      if (!byEntry.hasOwnProperty(did)) continue;
      if (desired[did] || movedIds[did]) continue;
      byEntry[did].deleteEvent();
      delete pushed[did];
      stats.deleted++;
    }

    // чужое событие, ставшее событием записи, больше не предлагаем
    foreign = foreign.filter(function (f) {
      return !adopted[f.eventId];
    });
  } finally {
    wltCalSavePushed_(props, pushed);
  }

  return {
    ok: true,
    calendarId: cal.getId(),
    moved: moved,
    removedByUser: removedByUser,
    foreign: foreign,
    stats: stats
  };
}

/** Свой календарь: по id из свойств; нет, удалён или вдруг основной — создать новый. */
function wltCalOpen_(req, props, tz) {
  var name = req.calendarName || 'Трекер';
  var id = props.getProperty(WLT_CAL_ID_PROP_);
  var cal = null;
  if (id) {
    try {
      cal = CalendarApp.getCalendarById(id);
    } catch (e) {
      cal = null;
    }
  }
  if (cal && cal.isMyPrimaryCalendar()) cal = null;
  if (!cal) {
    cal = CalendarApp.createCalendar(name, { timeZone: tz });
    props.setProperty(WLT_CAL_ID_PROP_, cal.getId());
    return { cal: cal, fresh: true };
  }
  if (cal.getName() !== name) cal.setName(name);
  return { cal: cal, fresh: false };
}

function wltCalById_(cal, eventId) {
  if (!eventId) return null;
  try {
    return cal.getEventById(eventId) || null;
  } catch (e) {
    return null;
  }
}

/** 'YYYY-MM-DD' + 'HH:mm' в поясе tz → Date. */
function wltCalParse_(date, time, tz) {
  return Utilities.parseDate(date + ' ' + time, tz, 'yyyy-MM-dd HH:mm');
}

function wltCalAddDays_(date, n) {
  var d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Дата дня all-day события. Apps Script отдаёт полночь в поясе скрипта, а он может отличаться от tz:
 * сдвиг на полдня даёт верную дату при любой разнице поясов в пределах ±12 часов.
 */
function wltCalDay_(d, tz) {
  return Utilities.formatDate(new Date(d.getTime() + 12 * 3600 * 1000), tz, 'yyyy-MM-dd');
}

/** Фактическое время события в формате DesiredEvent и отпечаток для тега wltWhen. */
function wltCalWhen_(ev, tz) {
  var allDay = ev.isAllDayEvent();
  var start, end;
  if (allDay) {
    start = wltCalDay_(ev.getAllDayStartDate(), tz);
    end = wltCalDay_(ev.getAllDayEndDate(), tz); // день после последнего дня
    if (end <= start) end = wltCalAddDays_(start, 1);
  } else {
    start = Utilities.formatDate(ev.getStartTime(), tz, "yyyy-MM-dd'T'HH:mm");
    end = Utilities.formatDate(ev.getEndTime(), tz, "yyyy-MM-dd'T'HH:mm");
  }
  return { allDay: allDay, start: start, end: end, key: start + '|' + end + '|' + allDay };
}

function wltCalForeign_(ev, tz) {
  var w = wltCalWhen_(ev, tz);
  var f = { eventId: ev.getId(), title: ev.getTitle(), allDay: w.allDay, start: w.start, end: w.end };
  var loc = ev.getLocation();
  if (loc) f.location = loc;
  return f;
}

function wltCalTimes_(d, tz) {
  if (d.allDay) {
    // полдень вместо полуночи — дата не съедет при любом поясе скрипта
    return { start: wltCalParse_(d.start, '12:00', tz), end: wltCalParse_(d.end, '12:00', tz) };
  }
  return {
    start: wltCalParse_(d.start.slice(0, 10), d.start.slice(11, 16), tz),
    end: wltCalParse_(d.end.slice(0, 10), d.end.slice(11, 16), tz)
  };
}

function wltCalCreate_(cal, d, tz) {
  var t = wltCalTimes_(d, tz);
  var opts = { description: d.description || '', location: d.location || '' };
  if (d.allDay) return cal.createAllDayEvent(d.title, t.start, t.end, opts); // конец — исключительный
  return cal.createEvent(d.title, t.start, t.end, opts);
}

/** Поля, напоминания и теги события из DesiredEvent. withTime — выставить и время. */
function wltCalApply_(ev, d, tz, withTime) {
  if (withTime) {
    var t = wltCalTimes_(d, tz);
    if (d.allDay) ev.setAllDayDates(t.start, t.end);
    else ev.setTime(t.start, t.end);
  }
  if (ev.getTitle() !== d.title) ev.setTitle(d.title);
  if ((ev.getDescription() || '') !== (d.description || '')) ev.setDescription(d.description || '');
  if ((ev.getLocation() || '') !== (d.location || '')) ev.setLocation(d.location || '');
  if (d.colorId && ev.getColor() !== String(d.colorId)) ev.setColor(String(d.colorId));
  ev.removeAllReminders();
  var rem = d.reminders || [];
  for (var i = 0; i < rem.length && i < WLT_CAL_MAX_REMINDERS_; i++) ev.addPopupReminder(rem[i]);
  ev.setTag('wltEntry', d.entryId);
  var movedNow = !withTime && ev.getTag('wltHash') === 'moved';
  if (!movedNow) {
    ev.setTag('wltHash', d.hash);
    ev.setTag('wltWhen', wltCalWhen_(ev, tz).key);
  }
}

function wltCalLoadPushed_(props) {
  var raw = props.getProperty(WLT_CAL_PUSHED_PROP_);
  if (!raw) return {};
  try {
    if (raw.charAt(0) === '#') {
      var n = parseInt(raw.slice(1), 10);
      var parts = [];
      for (var i = 0; i < n; i++) parts.push(props.getProperty(WLT_CAL_PUSHED_PROP_ + '.' + i) || '');
      raw = parts.join('');
    }
    var obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return {};
  }
}

function wltCalSavePushed_(props, pushed) {
  var json = JSON.stringify(pushed);
  var old = props.getProperty(WLT_CAL_PUSHED_PROP_) || '';
  var oldChunks = old.charAt(0) === '#' ? parseInt(old.slice(1), 10) || 0 : 0;
  var newChunks = 0;
  if (json.length <= WLT_CAL_CHUNK_) {
    props.setProperty(WLT_CAL_PUSHED_PROP_, json);
  } else {
    var all = {};
    for (var p = 0; p * WLT_CAL_CHUNK_ < json.length; p++) {
      all[WLT_CAL_PUSHED_PROP_ + '.' + p] = json.slice(p * WLT_CAL_CHUNK_, (p + 1) * WLT_CAL_CHUNK_);
      newChunks++;
    }
    all[WLT_CAL_PUSHED_PROP_] = '#' + newChunks;
    props.setProperties(all);
  }
  for (var i = newChunks; i < oldChunks; i++) props.deleteProperty(WLT_CAL_PUSHED_PROP_ + '.' + i);
}
`;
