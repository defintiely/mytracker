// Текст Google Apps Script, который пользователь один раз вставляет на script.google.com и разворачивает
// как веб-приложение. Скрипт — единственный «сервер» трекера: хранит tracker.json в Drive владельца,
// ведёт ревизию и бэкапы, а календарную часть (handleCalendar_) поставляет src/calendar/calendarGs.ts.
//
// Скрипт — чистый JavaScript для Apps Script (V8): без import/export и TypeScript, только DriveApp,
// PropertiesService, LockService, ContentService, Session, Utilities (+ CalendarApp в календарной части).
// Протокол — src/sync/scriptApi.ts.
import { CALENDAR_GS } from '../calendar/calendarGs';
import { SCRIPT_PROTOCOL_VERSION } from './scriptApi';

/** Ключ вшивается в текст скрипта в одинарных кавычках — допускаем только безопасные символы. */
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

const HEADER = `/*
 * Трекер съёмок — скрипт синхронизации с вашим Google Drive.
 *
 * Как установить (один раз):
 *  1. Удалите всё в этом редакторе, вставьте этот код и нажмите «Сохранить» (значок дискеты).
 *  2. Выдайте разрешения: в списке функций рядом с Run («Выполнить») выберите setup и нажмите Run.
 *     Review permissions → ваш аккаунт → Advanced («Дополнительные настройки») → Go to … (unsafe)
 *     → отметьте ВСЕ галочки (Drive и Calendar) → Allow («Разрешить»). Это ваш собственный скрипт.
 *  3. Deploy («Развернуть») → New deployment → шестерёнка → Web app («Веб-приложение»).
 *     Execute as: Me («Я»). Who has access: Anyone («Все»). Нажмите Deploy.
 *  4. Скопируйте Web app URL (оканчивается на /exec) и вставьте его в трекер.
 *
 * Как обновить скрипт: вставьте новый код, сохраните, снова запустите setup (Run), затем
 * Deploy → Manage deployments → карандаш → Version: New version → Deploy. Ссылка останется прежней.
 *
 * Данные лежат в папке «Трекер» в корне вашего Drive: tracker.json и папка «Бэкапы».
 * Доступ «Все» означает, что скрипт отвечает без входа в Google, но без ключа ниже он ничего не отдаёт
 * и ничего не меняет. Никому не показывайте этот код и не публикуйте его.
 */
`;

const CORE = `
var PROTOCOL = ${SCRIPT_PROTOCOL_VERSION};
var FOLDER_NAME = 'Трекер';
var FILE_NAME = 'tracker.json';
var BACKUP_FOLDER_NAME = 'Бэкапы';
var BACKUPS_KEEP = 30;
var LOCK_WAIT_MS = 20000;

/**
 * ЗАПУСТИТЕ ЭТУ ФУНКЦИЮ ПЕРВОЙ: выберите setup рядом с Run и нажмите Run.
 * Она делает всё, что потом делает скрипт (создаёт папку и файл в Drive, создаёт и сразу удаляет
 * пробный календарь), поэтому Google спросит сразу все нужные разрешения. Отметьте в окне все галочки.
 */
function setup() {
  var folder = findFolder_(DriveApp.getRootFolder(), FOLDER_NAME, true);
  folder.createFile('проверка-доступа.txt', 'ok').setTrashed(true);
  var probe = CalendarApp.createCalendar('Трекер — проверка доступа');
  probe.deleteCalendar();
  Logger.log('Готово: разрешения на Drive и Календарь выданы. Дальше: Deploy → New deployment → Web app '
    + '(если уже развёрнуто — Deploy → Manage deployments → карандаш → Version: New version → Deploy).');
}

function doPost(e) {
  return respond_(handle_(e && e.postData ? e.postData.contents : ''));
}

function doGet(e) {
  return respond_({ ok: true, message: 'Скрипт трекера работает. Скопируйте адрес этой страницы и вставьте его в трекер.' });
}

var PERMISSION_HELP = 'Скрипту не выданы разрешения. В редакторе скрипта выберите функцию setup → Run → '
  + 'разрешите доступ ко всему (Drive и Calendar), затем Deploy → Manage deployments → карандаш → '
  + 'Version: New version → Deploy.';

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message, extra) {
  var out = { ok: false, code: code, error: message };
  if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
  return out;
}

function handle_(text) {
  var req;
  try {
    req = JSON.parse(text);
  } catch (err) {
    return fail_('bad_request', 'Запрос не в формате JSON');
  }
  if (!req || typeof req !== 'object') return fail_('bad_request', 'Пустой запрос');
  if (req.k !== KEY) return fail_('forbidden', 'Неверный ключ');
  try {
    switch (req.action) {
      case 'ping':
        return ping_();
      case 'load':
        return load_();
      case 'save':
        return save_(req);
      case 'calendar':
        return handleCalendar_(req);
      default:
        return fail_('bad_request', 'Неизвестное действие: ' + req.action);
    }
  } catch (err) {
    var msg = String((err && err.message) || err);
    // Текст ошибки Google зависит от языка аккаунта, а адрес разрешения — нет.
    if (msg.indexOf('googleapis.com/auth/') >= 0) return fail_('internal', PERMISSION_HELP + ' (' + msg + ')');
    return fail_('internal', msg);
  }
}

function ping_() {
  var email = '';
  try {
    email = Session.getEffectiveUser().getEmail() || '';
  } catch (err) {
    email = '';
  }
  var out = { ok: true, protocol: PROTOCOL };
  if (email) out.email = email;
  return out;
}

// ---------- Drive ----------

function findFolder_(parent, name, create) {
  var it = parent.getFoldersByName(name);
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) return f;
  }
  return create ? parent.createFolder(name) : null;
}

function findFile_(folder, name) {
  if (!folder) return null;
  var it = folder.getFilesByName(name);
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) return f;
  }
  return null;
}

function dataFolder_(create) {
  return findFolder_(DriveApp.getRootFolder(), FOLDER_NAME, create);
}

function currentRev_(props) {
  var n = Number(props.getProperty('rev') || 0);
  return isFinite(n) && n > 0 ? n : 0;
}

function load_() {
  var props = PropertiesService.getScriptProperties();
  var file = findFile_(dataFolder_(false), FILE_NAME);
  var rev = currentRev_(props);
  if (!file) return { ok: true, doc: null, rev: rev };
  var text = file.getBlob().getDataAsString('UTF-8');
  var doc = null;
  try {
    doc = text ? JSON.parse(text) : null;
  } catch (err) {
    throw new Error('Файл ' + FILE_NAME + ' повреждён — восстановите его из папки «Бэкапы»');
  }
  return { ok: true, doc: doc, rev: rev };
}

function save_(req) {
  if (!req.doc || typeof req.doc !== 'object') return fail_('bad_request', 'Нет данных для сохранения');
  var baseRev = Number(req.baseRev);
  if (!isFinite(baseRev)) return fail_('bad_request', 'Нет ревизии');
  var json = JSON.stringify(req.doc);
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    var props = PropertiesService.getScriptProperties();
    var rev = currentRev_(props);
    if (baseRev !== rev) return fail_('conflict', 'Данные изменились на другом устройстве', { rev: rev });
    var folder = dataFolder_(true);
    var file = findFile_(folder, FILE_NAME);
    if (file) {
      backupIfNeeded_(folder, file, props);
      file.setContent(json);
    } else {
      folder.createFile(FILE_NAME, json, 'application/json');
    }
    rev = rev + 1;
    props.setProperty('rev', String(rev));
    return { ok: true, rev: rev };
  } finally {
    lock.releaseLock();
  }
}

/** Первая запись за день: копия текущего файла в «Трекер/Бэкапы/backup-YYYY-MM-DD.json», храним 30. */
function backupIfNeeded_(folder, file, props) {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (props.getProperty('backupDate') === today) return;
  var content = file.getBlob().getDataAsString('UTF-8');
  var backups = findFolder_(folder, BACKUP_FOLDER_NAME, true);
  var name = 'backup-' + today + '.json';
  var existing = findFile_(backups, name);
  if (existing) existing.setContent(content);
  else backups.createFile(name, content, 'application/json');
  props.setProperty('backupDate', today);
  rotateBackups_(backups);
}

function rotateBackups_(backups) {
  var list = [];
  var it = backups.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed() && /^backup-\\d{4}-\\d{2}-\\d{2}\\.json$/.test(f.getName())) list.push(f);
  }
  list.sort(function (a, b) {
    return a.getName() < b.getName() ? 1 : a.getName() > b.getName() ? -1 : 0;
  });
  for (var i = BACKUPS_KEEP; i < list.length; i++) list[i].setTrashed(true);
}
`;

/** Полный текст Apps Script с вшитым ключом. */
export function buildScriptSource(key: string): string {
  if (!KEY_RE.test(key)) throw new Error('Некорректный ключ скрипта');
  return [
    HEADER,
    `const KEY = '${key}';`,
    CORE,
    '// ---------- Календарь ----------',
    '',
    CALENDAR_GS,
    '',
  ].join('\n');
}
