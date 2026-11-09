// Общие ошибки модулей синхронизации.

/** Нет сети / запрос не дошёл до Google. */
export class OfflineError extends Error {
  constructor(message = 'Нет сети') {
    super(message);
  }
}
