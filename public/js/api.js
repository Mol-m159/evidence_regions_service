/**
 * @fileoverview API-клиент для взаимодействия с бэкендом сервиса разметки.
 * 
 * Предоставляет единый интерфейс для всех HTTP-запросов к серверу.
 * Использует fetch API для обычных запросов и XMLHttpRequest для загрузки файлов
 * (для поддержки отслеживания прогресса загрузки).
 * 
 * @module api
 */

/**
 * Клиент для взаимодействия с REST API сервиса разметки.
 * Все методы асинхронные и возвращают Promise.
 * 
 * @class
 * @classdesc Инкапсулирует логику HTTP-запросов, обработку ошибок и сериализацию данных.
 * 
 * @example
 * const api = new ApiClient('/api');
 * const docs = await api.getDocuments();
 */
class ApiClient {
    /**
     * Создаёт экземпляр API-клиента.
     * 
     * @param {string} [baseUrl='/api'] - Базовый URL API. По умолчанию '/api' для относительных запросов.
     */
    constructor(baseUrl = '/api') {
        /** 
         * Базовый URL для всех запросов.
         * @private
         * @type {string} 
         */
        this.baseUrl = baseUrl;
    }

    // ===========================================================================
    // Базовый метод запросов
    // ===========================================================================

    /**
     * Выполняет HTTP-запрос к API.
     * Автоматически добавляет заголовок Content-Type: application/json.
     * Обрабатывает специальный случай PDF-ответов (возвращает Blob вместо JSON).
     * 
     * @async
     * @private
     * @param {string} endpoint - Путь эндпоинта (начинается с /)
     * @param {Object} [options={}] - Дополнительные опции fetch (method, body, headers и т.д.)
     * @returns {Promise<Object|Blob>} Ответ сервера: JSON-объект или Blob для PDF
     * @throws {Error} При сетевой ошибке или HTTP-статусе не 2xx
     * 
     * @example
     * // GET-запрос
     * const data = await this.request('/documents');
     * 
     * // POST-запрос с телом
     * const result = await this.request('/regions/doc.pdf/save', {
     *   method: 'POST',
     *   body: JSON.stringify({ question: '...', regions: [...] })
     * });
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        
        try {
            const response = await fetch(url, {
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                },
                ...options
            });

            if (!response.ok) {
                // Пытаемся извлечь сообщение об ошибке из ответа
                const errorBody = await response.json().catch(() => ({}));
                const errorMessage = errorBody.error || errorBody.message || `HTTP ${response.status}`;
                throw new Error(errorMessage);
            }

            // Для PDF-файлов возвращаем Blob (используется для отображения в просмотрщике)
            if (response.headers.get('content-type')?.includes('application/pdf')) {
                return response.blob();
            }

            // Для всех остальных ответов — парсим JSON
            return response.json();
            
        } catch (error) {
            // Не оборачиваем ошибки, которые уже созданы нами
            if (error.message && !error.message.startsWith('HTTP')) {
                throw error;
            }
            
            console.error(`[API] Request failed: ${endpoint}`, error);
            throw new Error(`Network error: ${error.message}`);
        }
    }

    // ===========================================================================
    // Системные эндпоинты
    // ===========================================================================

    /**
     * Проверяет работоспособность сервера и состояние сервисов.
     * 
     * @async
     * @returns {Promise<HealthCheckResponse>} Статус сервера
     * 
     * @typedef {Object} HealthCheckResponse
     * @property {string} status - По умолчанию 'ok'
     * @property {string} timestamp - Текущее время ISO
     * @property {number} uptime - Время работы в секундах
     * @property {Object} services - Статус сервисов
     * @property {boolean} services.samples_loaded - Загружен ли датасет
     * @property {boolean} services.evidence_loaded - Загружена ли разметка
     * 
     * @example
     * const health = await api.healthCheck();
     * if (health.status === 'ok') {
     *   console.log(`Сервер работает ${health.uptime} секунд`);
     * }
     */
    async healthCheck() {
        return this.request('/health');
    }

    /**
     * Получает публичную конфигурацию сервера.
     * 
     * @async
     * @returns {Promise<Object>} Конфигурация
     * @returns {string} qdrant_url - URL Qdrant
     * @returns {string} collection_name - Название коллекции
     * @returns {number} max_upload_size - Максимальный размер файла
     * @returns {string} version - Версия API
     * 
     * @example
     * const config = await api.getConfig();
     * console.log(`Версия API: ${config.version}`);
     */
    async getConfig() {
        return this.request('/config');
    }

    // ===========================================================================
    // Документы
    // ===========================================================================

    /**
     * Получает список всех доступных документов с информацией о разметке.
     * 
     * @async
     * @returns {Promise<Object>} Объект с массивом documents
     * @returns {Array<DocumentSummary>} documents - Документы с метаданными
     * 
     * @example
     * const { documents } = await api.getDocuments();
     * documents.forEach(doc => {
     *   console.log(`${doc.doc_id}: ${doc.stats.total_questions} вопросов`);
     * });
     */
    async getDocuments() {
        return this.request('/documents');
    }

    /**
     * Загружает PDF-файл на сервер.
     * Использует XMLHttpRequest для поддержки отслеживания прогресса загрузки.
     * 
     * @async
     * @param {File} file - PDF-файл для загрузки
     * @param {function(number):void} [onProgress] - Колбэк прогресса загрузки.
     *   Принимает число от 0 до 100 — процент выполнения.
     * @returns {Promise<Object>} Результат загрузки
     * @throws {Error} При ошибке сети или серверной ошибке
     * 
     * @example
     * const file = document.getElementById('fileInput').files[0];
     * 
     * try {
     *   const result = await api.uploadDocument(file, (percent) => {
     *     console.log(`Загрузка: ${Math.round(percent)}%`);
     *   });
     *   console.log('Файл загружен:', result);
     * } catch (error) {
     *   console.error('Ошибка загрузки:', error.message);
     * }
     */
    async uploadDocument(file, onProgress = null) {
        const formData = new FormData();
        formData.append('pdf', file);

        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            
            // Отслеживание прогресса загрузки
            if (onProgress) {
                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        const percent = (e.loaded / e.total) * 100;
                        onProgress(percent);
                    }
                });
            }

            // Успешное завершение
            xhr.addEventListener('load', () => {
                try {
                    const response = JSON.parse(xhr.responseText);
                    
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve(response);
                    } else {
                        reject(new Error(response.error || response.message || `Upload failed (${xhr.status})`));
                    }
                } catch {
                    reject(new Error(`Upload failed with status ${xhr.status}`));
                }
            });

            // Сетевая ошибка
            xhr.addEventListener('error', () => {
                reject(new Error('Network error during upload'));
            });

            // Таймаут (если сервер не отвечает)
            xhr.addEventListener('timeout', () => {
                reject(new Error('Upload timed out'));
            });

            xhr.open('POST', `${this.baseUrl}/documents/upload`);
            xhr.timeout = 300000; // 5 минут на загрузку большого файла
            xhr.send(formData);
        });
    }

    /**
     * Получает детальную информацию о конкретном документе.
     * Включает все вопросы, страницы и статус разметки.
     * 
     * @async
     * @param {string} docId - Идентификатор документа (имя PDF-файла)
     * @returns {Promise<Object>} Детальная информация о документе
     * 
     * @example
     * const doc = await api.getDocumentInfo('report.pdf');
     * console.log(`Хеш файла: ${doc.file_hash}`);
     * console.log(`Найдено ${doc.samples.length} вопросов`);
     */
    async getDocumentInfo(docId) {
        return this.request(`/documents/${encodeURIComponent(docId)}`);
    }

    // ===========================================================================
    // Регионы и разметка
    // ===========================================================================

    /**
     * Получает все регионы документа со всех страниц.
     * Объединяет автоматические регионы из Qdrant и пользовательскую разметку.
     * 
     * @async
     * @param {string} docId - Идентификатор документа
     * @returns {Promise<Object>} Все регионы документа
     * @returns {Object<string, Array>} regions_by_page - Регионы Qdrant по страницам
     * @returns {Object} user_annotations - Пользовательская разметка
     * @returns {Array} samples - Вопросы документа с регионами
     * 
     * @example
     * const data = await api.getAllRegions('report.pdf');
     * // Группировка регионов по страницам
     * for (const [page, regions] of Object.entries(data.regions_by_page)) {
     *   console.log(`Страница ${page}: ${regions.length} регионов`);
     * }
     */
    async getAllRegions(docId) {
        return this.request(`/regions/${encodeURIComponent(docId)}/all`);
    }

    /**
     * Получает регионы для конкретной страницы документа.
     * 
     * @async
     * @param {string} docId - Идентификатор документа
     * @param {number} page - Номер страницы (начиная с 1)
     * @returns {Promise<Object>} Регионы страницы
     * 
     * @example
     * const pageData = await api.getPageRegions('report.pdf', 5);
     * console.log(`Qdrant-регионов: ${pageData.qdrant_regions.length}`);
     * console.log(`Пользовательских: ${pageData.user_regions.length}`);
     */
    async getPageRegions(docId, page) {
        return this.request(`/regions/${encodeURIComponent(docId)}/page/${page}`);
    }

    /**
     * Сохраняет регионы для вопроса.
     * Если регионы для этого вопроса уже существуют — перезаписывает их.
     * 
     * @async
     * @param {string} docId - Идентификатор документа
     * @param {string} question - Текст вопроса
     * @param {Array<Object>} regions - Массив регионов для сохранения
     * @param {number} regions[].page - Номер страницы
     * @param {number[]} regions[].bbox - Координаты [x1, y1, x2, y2]
     * @returns {Promise<Object>} Результат сохранения
     * 
     * @example
     * const result = await api.saveRegions('report.pdf', 'What is...?', [
     *   { page: 5, bbox: [100, 200, 300, 400] }
     * ]);
     * if (result.success) {
     *   console.log('Регионы сохранены');
     * }
     */
    async saveRegions(docId, question, regions) {
        return this.request(`/regions/${encodeURIComponent(docId)}/save`, {
            method: 'POST',
            body: JSON.stringify({ question, regions })
        });
    }

    /**
     * Удаляет сохранённые регионы для вопроса.
     * 
     * @async
     * @param {string} docId - Идентификатор документа
     * @param {string} question - Текст вопроса
     * @returns {Promise<Object>} Результат удаления
     * @returns {boolean} success - Успешность операции
     * @returns {boolean} deleted - Были ли данные удалены
     * 
     * @example
     * const result = await api.deleteRegions('report.pdf', 'What is...?');
     * if (result.deleted) {
     *   console.log('Разметка удалена');
     * }
     */
    async deleteRegions(docId, question) {
        return this.request(`/regions/${encodeURIComponent(docId)}/save`, {
            method: 'DELETE',
            body: JSON.stringify({ question })
        });
    }

    /**
     * Получает PDF-файл документа для отображения в просмотрщике.
     * Возвращает Blob, который можно использовать для создания URL через URL.createObjectURL().
     * 
     * @async
     * @param {string} docId - Идентификатор документа
     * @returns {Promise<Blob>} PDF-файл как Blob (application/pdf)
     * 
     * @example
     * const pdfBlob = await api.getPDF('report.pdf');
     * const pdfUrl = URL.createObjectURL(pdfBlob);
     * // Использовать pdfUrl в <iframe> или PDF.js
     */
    async getPDF(docId) {
        return this.request(`/regions/${encodeURIComponent(docId)}/pdf`);
    }

    /**
     * Получает статистику пользовательской разметки для документа.
     * 
     * @async
     * @param {string} docId - Идентификатор документа
     * @returns {Promise<DocumentStats>} Статистика разметки
     * 
     * @example
     * const stats = await api.getStats('report.pdf');
     * console.log(`Размечено ${stats.total_regions} регионов на ${stats.pages_with_regions.length} страницах`);
     */
    async getStats(docId) {
        return this.request(`/regions/${encodeURIComponent(docId)}/stats`);
    }
}

/**
 * Глобальный экземпляр API-клиента.
 * Используется во всём фронтенд-приложении как единая точка доступа к API.
 * 
 * @type {ApiClient}
 * 
 * @example
 * // В любом модуле:
 * const documents = await api.getDocuments();
 */
const api = new ApiClient();