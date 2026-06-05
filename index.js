/**
 * @fileoverview Главный файл сервера для веб-сервиса разметки вопросов в PDF-документах.
 * 
 * Сервис предоставляет API для:
 * - Загрузки и просмотра PDF-документов из датасета
 * - Получения предварительно извлечённых регионов из векторной БД Qdrant
 * - Создания и редактирования пользовательской разметки
 * - Сохранения разметки в файл evidence_regions.json
 * - Визуализации PDF с наложенными регионами через веб-интерфейс
 * 
 * @module index
 * @requires express
 * @requires ./config
 * @requires ./services/samplesService
 * @requires ./services/qdrantService
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const samplesService = require('./services/samplesService');
const qdrantService = require('./services/qdrantService');

/**
 * Экземпляр Express-приложения.
 * @type {express.Application}
 */
const app = express();

// ===========================================================================
// Middleware
// ===========================================================================

/** Разрешает кросс-доменные запросы с любого источника */
app.use(cors());

/**
 * Парсинг JSON и URL-encoded тел запросов.
 * Лимит 50 МБ — для обработки больших массивов регионов.
 */
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

/** Логирование всех запросов в режиме разработки */
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
  });
}

// ===========================================================================
// Статические файлы
// ===========================================================================

/**
 * Раздача файлов из директории data/ для доступа к PDF и JSON.
 * Доступны по URL: /data/documents/file.pdf, /data/samples.json и т.д.
 */
app.use('/data', express.static(path.join(__dirname, 'data')));

/**
 * Раздача статических файлов веб-интерфейса (HTML, CSS, JS).
 */
app.use(express.static(path.join(__dirname, 'public')));

// ===========================================================================
// API-маршруты
// ===========================================================================

/**
 * Маршруты для работы с документами.
 * @see routes/documents
 */
app.use('/api/documents', require('./routes/documents'));

/**
 * Маршруты для работы с регионами разметки вопросов.
 * @see routes/regions
 */
app.use('/api/regions', require('./routes/regions'));

// ===========================================================================
// Служебные 
// ===========================================================================

/**
 * @route GET /api/health
 * @description Проверка работоспособности сервера и состояния сервисов.
 * 
 * @returns {Object} Информация о состоянии сервера
 * @returns {string} status - Всегда 'ok' при рабочем сервере
 * @returns {string} timestamp - Текущее время в ISO-формате
 * @returns {number} uptime - Время непрерывной работы сервера в секундах
 * @returns {Object} services - Статус загруженных сервисов
 * @returns {boolean} services.samples_loaded - Загружен ли датасет образцов
 * @returns {boolean} services.evidence_loaded - Загружена ли evidence-разметка
 * 
 * @example
 * // GET /api/health
 * // Response 200:
 * {
 *   "status": "ok",
 *   "timestamp": "2026-05-20T10:30:00.000Z",
 *   "uptime": 3600,
 *   "services": {
 *     "samples_loaded": true,
 *     "evidence_loaded": true
 *   }
 * }
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      samples_loaded: samplesService.samples !== null,
      evidence_loaded: samplesService.getAllDocIds().length > 0
    }
  });
});

/**
 * @route GET /api/config
 * @description Возвращает публичную часть конфигурации.
 * Используется фронтендом для получения настроек подключения.
 * 
 * @returns {Object} Публичная конфигурация
 * @returns {string} qdrant_url - URL Qdrant сервера
 * @returns {string} collection_name - Название коллекции Qdrant
 * @returns {number} max_upload_size - Максимальный размер загружаемого файла в байтах
 * @returns {string} version - Версия API
 * 
 * @example
 * // GET /api/config
 * // Response 200:
 * {
 *   "qdrant_url": "http://localhost:6333",
 *   "collection_name": "documents",
 *   "max_upload_size": 104857600,
 *   "version": "1.0.0"
 * }
 */
app.get('/api/config', (req, res) => {
  res.json({
    qdrant_url: config.qdrant.url,
    collection_name: config.qdrant.collectionName,
    max_upload_size: config.upload.maxFileSize,
    version: '1.0.0'
  });
});

// ===========================================================================
// Обработчики ошибок
// ===========================================================================

/**
 * Middleware для обработки 404 ошибок.
 * Срабатывает, если ни один маршрут не обработал запрос.
 * Возвращает список доступных эндпоинтов для удобства отладки.
 * 
 * @middleware
 * @param {express.Request} req
 * @param {express.Response} res
 */
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.url} not found`,
    available_endpoints: [
      'GET /api/health',
      'GET /api/config',
      'GET /api/documents',
      'POST /api/documents/upload',
      'GET /api/documents/:docId',
      'GET /api/regions/:docId/all',
      'GET /api/regions/:docId/page/:pageNumber',
      'POST /api/regions/:docId/save',
      'DELETE /api/regions/:docId/save',
      'GET /api/regions/:docId/pdf',
      'GET /api/regions/:docId/stats'
    ]
  });
});

/**
 * Глобальный обработчик ошибок Express.
 * 
 * @middleware
 * @param {Error} error - Объект ошибки
 * @param {express.Request} req
 * @param {express.Response} res
 * @param {Function} next
 */
app.use((error, req, res, next) => {
  console.error('[Error]', error);

  // Некорректный JSON в теле запроса
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Invalid JSON',
      message: 'Request body contains invalid JSON'
    });
  }

  // Превышен размер загружаемого файла (multer)
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'File too large',
      message: `Maximum file size is ${config.upload.maxFileSize / 1024 / 1024}MB`
    });
  }

  // Общая ошибка сервера
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// ===========================================================================
// Инициализация и запуск
// ===========================================================================

/**
 * Последовательно инициализирует все сервисы и запускает HTTP-сервер.
 * 
 * Порядок инициализации:
 * 1. Загрузка датасета образцов (samples.json)
 * 2. Загрузка существующей разметки вопросов
 * 3. Подключение к Qdrant (некритично — при ошибке сервер продолжает работу)
 * 
 * @async
 * @function startServer
 * @throws {Error} При критических ошибках загрузки датасета
 */
async function startServer() {
  try {
    console.log('='.repeat(60));
    console.log('PDF Evidence Annotation Service');
    console.log('='.repeat(60));

    const fs = require('fs');
    try {
      await fs.promises.access(config.paths.samplesJson, fs.constants.W_OK);
    } catch (error) {
      console.warn(`[Init] Cannot write to ${config.paths.samplesJson}, attempting chmod...`);
      try {
        await fs.promises.chmod(config.paths.samplesJson, 0o666);
        console.log('[Init] Fixed permissions');
      } catch (chmodError) {
        console.error('[Init] Failed to fix permissions:', chmodError.message);
      }
    }

    // Шаг 1: Загрузка датасета
    console.log('\n[1/3] Loading samples dataset...');
    await samplesService.loadSamples();
    console.log(`✓ Samples loaded: ${samplesService.getAllDocIds().length} documents found`);

    // Шаг 2: Загрузка разметки
    console.log('\n[2/3] Loading existing evidence regions...');
    const evidenceDocs = Object.keys(samplesService.samples).length;
    console.log(`✓ Evidence regions loaded: ${evidenceDocs} documents with annotations`);

    // Шаг 3: Подключение к Qdrant (не блокирует запуск)
    console.log('\n[3/3] Connecting to Qdrant...');
    try {
      await qdrantService.initialize();
      console.log('✓ Qdrant connection established');
    } catch (error) {
      console.warn('⚠ Qdrant initialization failed (non-critical):', error.message);
      console.warn('  The service will work but Qdrant regions will not be available');
    }

    // Запуск HTTP-сервера
    console.log('\n' + '='.repeat(60));
    app.listen(config.port, () => {
      console.log(`Server running on http://localhost:${config.port}`);
      console.log(`API base URL: http://localhost:${config.port}/api`);
      console.log(`Health check: http://localhost:${config.port}/api/health`);
      console.log('='.repeat(60));
    });
  } catch (error) {
    console.error('\nFailed to start server:', error);
    process.exit(1);
  }
}

// ===========================================================================
// Обработчики процесса
// ===========================================================================

/**
 * Обработчик необработанных Promise-ошибок.
 * Логирует ошибку, но не завершает процесс.
 */
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection:', reason);
});

/**
 * Обработчик сигнала SIGTERM (например, от Docker или process manager).
 * Корректно завершает процесс.
 */
process.on('SIGTERM', () => {
  console.log('\n[Process] SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

/**
 * Обработчик сигнала SIGINT (Ctrl+C).
 * Корректно завершает процесс.
 */
process.on('SIGINT', () => {
  console.log('\n[Process] SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

// Запуск сервера
startServer();