/**
 * @fileoverview Централизованная конфигурация сервиса разметки вопросов.
 * 
 * Все настройки могут быть переопределены через переменные окружения.
 * Для локальной разработки используются значения по умолчанию.
 * 
 * @module config
 * @example
 * // Использование в сервисах
 * const config = require('./config');
 * const client = new QdrantClient({ url: config.qdrant.url });
 */

const path = require('path');

/**
 * Определяет хост в зависимости от окружения выполнения.
 * В Docker-контейнерах используется специальный DNS-адрес для доступа к хост-машине.
 * 
 * @returns {string} Адрес хоста (localhost, host.docker.internal или значение HOST_ADDRESS)
 * 
 * @example
 * // Локальный запуск → 'localhost'
 * // Docker-контейнер → 'host.docker.internal'
 * // Явное указание → значение HOST_ADDRESS
 */
const getHostAddress = () => {
  if (process.env.HOST_ADDRESS) {
    return process.env.HOST_ADDRESS;
  }
  if (process.env.DOCKER_CONTAINER === 'true' || process.env.RUNNING_IN_DOCKER === 'true') {
    return 'host.docker.internal';
  }
  return 'localhost';
};

/**
 * Адрес хоста, определённый автоматически или через переменную окружения.
 * @type {string}
 */
const HOST = getHostAddress();

/**
 * Основной конфигурационный объект приложения.
 * 
 * @type {{
 *   port: number,
 *   qdrant: {
 *     url: string,
 *     collectionName: string,
 *     snapshotPath: string|undefined
 *   },
 *   paths: {
 *     samplesJson: string,
 *     evidenceRegionsJson: string,
 *     documentsDir: string
 *   },
 *   upload: {
 *     maxFileSize: number
 *   }
 * }}
 */
const config = {
  /**
   * Порт HTTP-сервера Express.
   * @default 3000
   * @env PORT
   */
  port: process.env.PORT || 3000,

  /**
   * Настройки подключения к векторной базе данных Qdrant.
   */
  qdrant: {
    /**
     * URL Qdrant сервера.
     * @default 'http://localhost:6333'
     * @env QDRANT_URL
     */
    url: process.env.QDRANT_URL || `http://${HOST}:6333`,

    /**
     * Название коллекции с векторными представлениями документов.
     * @default 'documents'
     * @env QDRANT_COLLECTION
     */
    collectionName: process.env.QDRANT_COLLECTION || 'documents'
  },

  /**
   * Пути к файлам данных и документам.
   */
  paths: {
    /**
     * Путь к JSON-файлу с образцами.
     * Используется только для чтения.
     * @default './data/samples.json'
     * @env SAMPLES_JSON_PATH
     */
    samplesJson: process.env.SAMPLES_JSON_PATH || 
      path.join(__dirname, 'data', 'samples.json'),
    /**
     * Директория с исходными PDF-документами.
     * @default './data/documents'
     * @env DOCUMENTS_DIR
     */
    documentsDir: process.env.DOCUMENTS_DIR || 
      path.join(__dirname, 'data', 'documents')
  },

  /**
   * Настройки загрузки файлов через API.
   */
  upload: {
    /**
     * Максимальный допустимый размер загружаемого файла.
     * @default 104857600 (100 МБ)
     */
    maxFileSize: 100 * 1024 * 1024 // 100MB
  }
};

module.exports = config;