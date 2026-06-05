/**
 * @fileoverview Сервис для взаимодействия с векторной базой данных Qdrant.
 * 
 * Предоставляет методы для получения предварительно извлечённых регионов документов.
 * Коллекция Qdrant содержит точки с payload, включающим:
 * - file_hash: MD5-хеш PDF-файла
 * - page_idx: индекс страницы (начиная с 0)
 * - bbox: координаты региона [x1, y1, x2, y2]
 * - text: текстовое содержимое региона
 * - element_type: тип элемента (text, title, image, table, chart)
 * 
 * @module services/qdrantService
 * @requires @qdrant/js-client-rest
 * @requires crypto
 * @requires ../config
 * 
 * @example
 * const qdrantService = require('./services/qdrantService');
 * await qdrantService.initialize();
 * const regions = await qdrantService.getRegionsByDocAndPage(fileHash, 1);
 */

const { QdrantClient } = require('@qdrant/js-client-rest');
const crypto = require('crypto');
const config = require('../config');

/**
 * Сервис для работы с Qdrant — векторной базой данных, хранящей регионы документов.
 * Реализует паттерн Singleton.
 * 
 * @class
 * @classdesc Инкапсулирует логику подключения к Qdrant и получения данных о регионах.
 */
class QdrantService {
  /**
   * Создаёт экземпляр сервиса Qdrant.
   * Не выполняет подключение — используйте {@link QdrantService#initialize}.
   */
  constructor() {
    /** 
     * Клиент для взаимодействия с Qdrant API.
     * @private
     * @type {QdrantClient} 
     */
    this.client = new QdrantClient({ url: config.qdrant.url });

    /** 
     * Название коллекции Qdrant, содержащей регионы документов.
     * @private
     * @type {string} 
     */
    this.collectionName = config.qdrant.collectionName;

    /** 
     * Флаг успешной инициализации подключения.
     * @type {boolean} 
     */
    this.initialized = false;
  }

  // ===========================================================================
  // Публичные методы инициализации и утилит
  // ===========================================================================

  /**
   * Подключается к Qdrant и проверяет существование коллекции.
   * Должен быть вызван перед использованием методов получения регионов.
   * 
   * При отсутствии коллекции выбрасывает ошибку — сервис не создаёт коллекции автоматически,
   * предполагается что коллекция уже создана и заполнена данными.
   * 
   * @async
   * @returns {Promise<boolean>} true если инициализация успешна
   * @throws {Error} Если коллекция не найдена или Qdrant недоступен
   * 
   * @example
   * try {
   *   await qdrantService.initialize();
   *   console.log('Qdrant готов к работе');
   * } catch (error) {
   *   console.error('Qdrant недоступен:', error.message);
   * }
   */
  async initialize() {
    try {
      console.log(`[Qdrant] Connecting to ${config.qdrant.url}...`);

      const collections = await this.client.getCollections();
      const collectionExists = collections.collections.some(
        c => c.name === this.collectionName
      );

      if (!collectionExists) {
        throw new Error(
          `Collection "${this.collectionName}" not found in Qdrant. ` +
          `Please ensure the collection exists and is properly configured.`
        );
      }

      const collectionInfo = await this.client.getCollection(this.collectionName);
      const pointsCount = collectionInfo.points_count || 0;

      console.log(`[Qdrant] ✓ Collection "${this.collectionName}" ready (${pointsCount} points)`);

      this.initialized = true;
      return true;

    } catch (error) {
      console.error('[Qdrant] Initialization failed:', error.message);
      this.initialized = false;
      throw error;
    }
  }

  /**
   * Проверяет, инициализирован ли сервис и готов к запросам.
   * 
   * @returns {boolean} true если сервис инициализирован
   */
  isInitialized() {
    return this.initialized;
  }

  /**
   * Вычисляет MD5-хеш содержимого файла.
   * Используется как идентификатор документа в коллекции Qdrant.
   * 
   * @param {Buffer} fileContent - Содержимое файла
   * @returns {string} MD5-хеш в hex-формате (32 символа)
   * 
   * @example
   * const hash = qdrantService.calculateFileHash(fs.readFileSync('doc.pdf'));
   * // => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
   */
  calculateFileHash(fileContent) {
    return crypto.createHash('md5').update(fileContent).digest('hex');
  }

  // ===========================================================================
  // Публичные методы получения регионов
  // ===========================================================================

  /**
   * Получает все регионы для конкретной страницы документа.
   * 
   * @async
   * @param {string} fileHash - MD5-хеш PDF-файла
   * @param {number} pageNumber - Номер страницы (начиная с 1)
   * @returns {Promise<Array<Region>>} Массив регионов страницы, отсортированных сверху вниз, слева направо.
   *                                   Возвращает пустой массив если сервис не инициализирован или произошла ошибка.
   * 
   * @typedef {Object} Region
   * @property {string|number} id - Идентификатор точки в Qdrant
   * @property {number[]} bbox - Координаты [x1, y1, x2, y2]
   * @property {number} page - Номер страницы (начиная с 1)
   * @property {string} element_type - Тип элемента (text, title, image, table, chart, unknown)
   * @property {string} text - Текстовое содержимое (обрезано до 200 символов)
   * @property {string} [region_id] - Идентификатор региона
   * @property {number} [element_index] - Индекс элемента
   * 
   * @example
   * const regions = await qdrantService.getRegionsByDocAndPage(fileHash, 1);
   * regions.forEach(r => console.log(r.text, r.bbox));
   */
  async getRegionsByDocAndPage(fileHash, pageNumber) {
    if (!this.initialized) {
      console.warn('[Qdrant] Not initialized. Call initialize() first.');
      return [];
    }

    const qdrantPageIndex = pageNumber - 1;

    try {
      let allPoints = [];
      let offset = null;

      do {
        const searchResult = await this.client.scroll(this.collectionName, {
          filter: {
            must: [{ key: 'file_hash', match: { value: fileHash } }]
          },
          with_payload: true,
          with_vector: false,
          offset: offset
        });

        allPoints = allPoints.concat(searchResult.points || []);
        offset = searchResult.next_page_offset;
      } while (offset !== null && offset !== undefined);
      
      const pagePoints = allPoints.filter(point => {
        const origEl = point.payload?.original_element || {};
        return origEl.page_idx === qdrantPageIndex;
      });

      console.log(`[Qdrant] Page ${pageNumber}: found ${pagePoints.length} regions (total doc points: ${allPoints.length})`);

      const regions = pagePoints.map(point => this._mapPointToRegion(point, pageNumber));

      return this._sortRegions(regions);

    } catch (error) {
      console.error(`[Qdrant] Error fetching regions for page ${pageNumber}:`, error.message);
      return [];
    }
  }

  /**
   * Получает все регионы документа со всех страниц.
   * 
   * @async
   * @param {string} fileHash - MD5-хеш PDF-файла
   * @returns {Promise<Array<Region>>} Массив всех регионов документа со всех страниц.
   *                                   Каждый регион содержит номер страницы в поле page.
   * 
   * @example
   * const allRegions = await qdrantService.getAllRegionsByHash(fileHash);
   * // Группировка по страницам:
   * const byPage = allRegions.reduce((acc, r) => {
   *   acc[r.page] = acc[r.page] || [];
   *   acc[r.page].push(r);
   *   return acc;
   * }, {});
   */
  async getAllRegionsByHash(fileHash) {
    if (!this.initialized) {
      console.warn('[Qdrant] Not initialized. Call initialize() first.');
      return [];
    }

    try {
      let allPoints = [];
      let offset = null;

      do {
        const searchResult = await this.client.scroll(this.collectionName, {
          filter: {
            must: [{ key: 'file_hash', match: { value: fileHash } }]
          },
          with_payload: true,
          with_vector: false,
          offset: offset
        });

        allPoints = allPoints.concat(searchResult.points || []);
        offset = searchResult.next_page_offset;
      } while (offset !== null && offset !== undefined);

      console.log(`[Qdrant] Document ${fileHash}: found ${allPoints.length} total regions`);

      const regions = allPoints.map(point => {
        const origEl = point.payload?.original_element || {};
        const pageNumber = (origEl.page_idx ?? 0) + 1;
        return this._mapPointToRegion(point, pageNumber);
      });

      return this._sortRegions(regions);

    } catch (error) {
      console.error(`[Qdrant] Error fetching all regions for ${fileHash}:`, error.message);
      return [];
    }
  }

  /**
   * Получает количество регионов для документа по его хешу.
   * Использует Count API Qdrant. При ошибке — fallback на резервный метод.
   * 
   * @async
   * @param {string} fileHash - MD5-хеш PDF-файла
   * @returns {Promise<number>} Количество регионов (0 если сервис не инициализирован или ошибка)
   * 
   * @example
   * const count = await qdrantService.getRegionsCountByHash(fileHash);
   * console.log(`Document has ${count} regions in Qdrant`);
   */
  async getRegionsCountByHash(fileHash) {
    if (!this.initialized) return 0;

    try {
      const countResult = await this.client.count(this.collectionName, {
        filter: {
          must: [{ key: 'file_hash', match: { value: fileHash } }]
        }
      });

      return countResult.count || 0;

    } catch (error) {
      console.warn('[Qdrant] Count API failed, using scroll fallback:', error.message);
      return this._countRegionsByScroll(fileHash);
    }
  }

  // ===========================================================================
  // Приватные методы
  // ===========================================================================

  /**
   * Преобразует точку Qdrant в объект региона приложения.
   * Извлекает и нормализует данные из payload точки.
   * 
   * @private
   * @param {Object} point - Точка Qdrant
   * @param {Object} point.payload - Данные точки
   * @param {number|string} point.id - Идентификатор точки
   * @param {number} pageNumber - Номер страницы (начиная с 1)
   * @returns {Region} Объект региона
   */
  _mapPointToRegion(point, pageNumber) {
    const p = point.payload || {};
    const origEl = p.original_element || {};

    // Извлекаем bbox (предпочитаем original_element.bbox)
    const bbox = origEl.bbox || p.bbox || [];

    // Определяем тип элемента
    const elementType = p.element_type || origEl.type || 'unknown';

    // Очищаем текст от префиксов типа "Text: ", "Title: " и т.д.
    let text = (p.text || origEl.text || '').trim();
    const prefixes = ['Text: ', 'Title: ', 'Image: ', 'Table: ', 'Chart: '];
    for (const prefix of prefixes) {
      if (text.startsWith(prefix)) {
        text = text.substring(prefix.length);
        break;
      }
    }

    return {
      id: point.id,
      bbox: Array.isArray(bbox) && bbox.length === 4 ? bbox : [],
      page: pageNumber,
      element_type: elementType,
      text: text.substring(0, 200), // Обрезаем длинный текст
      region_id: p.region_id,
      element_index: p.element_index
    };
  }

  /**
   * Сортирует регионы в порядке чтения: сверху вниз, слева направо.
   * Два региона считаются на одной строке, если их Y-координаты отличаются не более чем на 10 единиц.
   * 
   * @private
   * @param {Region[]} regions - Массив регионов
   * @returns {Region[]} Отсортированный массив (мутирует исходный)
   */
  _sortRegions(regions) {
    return regions.sort((a, b) => {
      const aY = a.bbox[1] || 0;
      const bY = b.bbox[1] || 0;

      // Если разница по Y небольшая — сортируем по X (одна строка)
      if (Math.abs(aY - bY) > 10) {
        return aY - bY;
      }

      return (a.bbox[0] || 0) - (b.bbox[0] || 0);
    });
  }

  /**
   * Запасной метод подсчёта регионов через scroll.
   * Используется, если Count API Qdrant недоступен (старые версии).
   * Проходит по всем точкам документа, суммируя их количество.
   * 
   * @private
   * @async
   * @param {string} fileHash - MD5-хеш PDF-файла
   * @returns {Promise<number>} Количество регионов
   */
  async _countRegionsByScroll(fileHash) {
    try {
      let total = 0;
      let offset = null;

      // Проходим по всем страницам результатов scroll
      do {
        const result = await this.client.scroll(this.collectionName, {
          filter: {
            must: [{ key: 'file_hash', match: { value: fileHash } }]
          },
          limit: 500,
          with_payload: false,
          with_vector: false,
          offset: offset
        });

        total += (result.points || []).length;
        offset = result.next_page_offset;
      } while (offset !== null && offset !== undefined);

      return total;
    } catch (error) {
      console.error('[Qdrant] Scroll count failed:', error.message);
      return 0;
    }
  }
}

/**
 * Экземпляр сервиса Qdrant (синглтон).
 * Используется во всём приложении как единая точка доступа к векторной БД.
 * 
 * @type {QdrantService}
 */
const qdrantService = new QdrantService();

module.exports = qdrantService;