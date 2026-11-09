// Общие ошибки модулей синхронизации.

/** Нет сети / запрос не дошёл до скрипта Google. */
export class OfflineError extends Error {
  constructor(message = 'Нет сети') {
    super(message);
  }
}

/**
 * Скрипт ответил ошибкой или ответил не так, как ожидается.
 * code: коды протокола (forbidden, bad_request, internal), плюс
 *  - 'not_public' — вместо JSON пришла страница (скрипт развёрнут не с доступом «Все» или ссылка неверна);
 *  - 'not_configured' — подключение не настроено.
 */
export class ScriptCallError extends Error {
  constructor(
    public code: 'forbidden' | 'bad_request' | 'internal' | 'conflict' | 'not_public' | 'not_configured',
    message: string,
  ) {
    super(message);
  }
}
