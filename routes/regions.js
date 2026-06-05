/**
 * @fileoverview Маршруты для работы с разметкой вопросов.
 * 
 * Предоставляет API для:
 * - Получения регионов из Qdrant (предварительно извлечённых)
 * - Получения и сохранения пользовательской разметки в evidence_regions.json
 * - Отдачи PDF-файлов для просмотра в браузере
 * - Получения статистики разметки
 * 
 * Регионы из Qdrant и пользовательская разметка объединяются на фронтенде
 * для отображения полной картины разметки документа.
 * 
 * @module routes/regions
 * @requires express
 * @requires ../services/samplesService
 * @requires ../services/qdrantService
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const config = require('../config');
const samplesService = require('../services/samplesService');
const qdrantService = require('../services/qdrantService');

// ===========================================================================
// Вспомогательные функции
// ===========================================================================

/**
 * Вычисляет MD5-хеш PDF-файла документа.
 * Используется как идентификатор документа в Qdrant.
 * 
 * @async
 * @param {string} docId - Идентификатор документа (имя файла)
 * @returns {Promise<string>} MD5-хеш файла
 * @throws {Error} Если файл не найден или не может быть прочитан
 */
async function getFileHash(docId) {
  const filePath = path.join(config.paths.documentsDir, docId);
  const fileContent = await fs.readFile(filePath);
  return qdrantService.calculateFileHash(fileContent);
}

/**
 * Обогащает вопросы (samples) информацией о пользовательской разметке.
 * Добавляет флаги наличия аннотаций и даты обновления.
 * 
 * @param {Array<Object>} samples - Вопросы из датасета
 * @param {string} docId - Идентификатор документа
 * @returns {Array<Object>} Вопросы с информацией о разметке
 */
function enrichSamplesWithAnnotations(samples, docId) {
  const allEvidence = samplesService.getAllEvidenceForDocument(docId);
  
  return samples.map(sample => ({
    question: sample.question,
    answer: sample.answer,
    evidence_pages: sample.evidence_pages,
    evidence_sources: sample.evidence_sources,
    evidence_regions: allEvidence[sample.question]?.regions || [],
    has_annotations: !!allEvidence[sample.question],
    annotation_updated_at: allEvidence[sample.question]?.updated_at || null
  }));
}

// ===========================================================================
// GET /api/regions/:docId/page/:pageNumber
// ===========================================================================

/**
 * @route GET /api/regions/:docId/page/:pageNumber
 * @description Получает все регионы для конкретной страницы документа.
 * Объединяет три источника данных:
 * 1. Предварительно извлечённые регионы из Qdrant (автоматические)
 * 2. Пользовательскую разметку из evidence_regions.json (ручную)
 * 3. Связанные вопросы из samples.json (контекст)
 * 
 * @param {string} docId - Идентификатор документа (имя PDF-файла)
 * @param {number} pageNumber - Номер страницы (начиная с 1)
 * 
 * @returns {Object} Комплексные данные о регионах на странице
 * @returns {string} doc_id - Идентификатор документа
 * @returns {number} page - Номер страницы
 * @returns {Array<Region>} qdrant_regions - Автоматически извлечённые регионы
 * @returns {Array<UserRegion>} user_regions - Пользовательская разметка
 * @returns {Array<EnrichedSample>} samples - Вопросы для этой страницы
 * @returns {boolean} has_qdrant_data - Найдены ли регионы в Qdrant
 * @returns {boolean} has_user_annotations - Есть ли пользовательская разметка
 * 
 * @throws {404} Если PDF-файл не найден
 * 
 * @example
 * // GET /api/regions/document.pdf/page/5
 * // Response 200:
 * {
 *   "doc_id": "document.pdf",
 *   "page": 5,
 *   "qdrant_regions": [
 *     { "id": "abc123", "bbox": [100, 200, 300, 400], "page": 5, "text": "..." }
 *   ],
 *   "user_regions": [
 *     { "page": 5, "bbox": [150, 250, 350, 450], "question": "What is..." }
 *   ],
 *   "samples": [
 *     {
 *       "question": "What is shown?",
 *       "answer": "The diagram...",
 *       "evidence_regions": [...],
 *       "has_annotations": true
 *     }
 *   ],
 *   "has_qdrant_data": true,
 *   "has_user_annotations": true
 * }
 */
router.get('/:docId/page/:pageNumber', async (req, res) => {
  try {
    const { docId, pageNumber } = req.params;
    const page = parseInt(pageNumber, 10);
    
    if (isNaN(page) || page < 1) {
      return res.status(400).json({ error: 'Invalid page number' });
    }
    
    // Проверяем наличие PDF и получаем хеш
    let fileHash;
    try {
      fileHash = await getFileHash(docId);
    } catch (error) {
      return res.status(404).json({ 
        error: 'PDF file not found',
        message: `Document "${docId}" not found in documents directory`
      });
    }

    // Получаем регионы из Qdrant
    let qdrantRegions = [];
    if (qdrantService.isInitialized()) {
      try {
        qdrantRegions = await qdrantService.getRegionsByDocAndPage(fileHash, page);
      } catch (error) {
        console.error(`[Regions] Qdrant error for ${docId} page ${page}:`, error.message);
        // Продолжаем без регионов Qdrant
      }
    }
    
    // Получаем пользовательскую разметку
    const userRegions = samplesService.getRegionsForPage(docId, page);

    // Получаем ВСЕ вопросы документа
    const allSamples = samplesService.findSamplesByDocId(docId);
    const enrichedSamples = enrichSamplesWithAnnotations(allSamples, docId);


    res.json({
      doc_id: docId,
      page: page,
      qdrant_regions: qdrantRegions,
      user_regions: userRegions,
      samples: enrichedSamples,
      has_qdrant_data: qdrantRegions.length > 0,
      has_user_annotations: userRegions.length > 0
    });
  } catch (error) {
    console.error(`[Regions] Error in GET /:docId/page/:pageNumber:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================================================
// GET /api/regions/:docId/all
// ===========================================================================
/**
 * @route GET /api/regions/:docId/all
 * @description Получает все регионы документа со всех страниц, где есть данные.
 * Объединяет автоматические регионы из Qdrant и пользовательскую разметку.
 * Возвращает ВСЕ вопросы документа (не фильтруя по страницам).
 * 
 * @param {string} docId - Идентификатор документа
 * 
 * @returns {Object} Все регионы документа
 * @returns {string} doc_id - Идентификатор документа
 * @returns {string} file_hash - MD5-хеш PDF-файла
 * @returns {Object<string, Array<Region>>} regions_by_page - Регионы Qdrant по страницам
 * @returns {Object} user_annotations - Пользовательская разметка по вопросам
 * @returns {Array<EnrichedSample>} samples - ВСЕ вопросы документа с информацией о разметке
 * @returns {DocumentStats} stats - Статистика разметки
 * 
 * @throws {404} Если документ не найден в датасете или PDF отсутствует
 * 
 * @example
 * // GET /api/regions/document.pdf/all
 * // Response 200:
 * {
 *   "doc_id": "document.pdf",
 *   "file_hash": "a1b2c3d4...",
 *   "regions_by_page": {
 *     "1": [{ "id": "...", "bbox": [...], ... }],
 *     "3": [{ "id": "...", "bbox": [...], ... }]
 *   },
 *   "user_annotations": {
 *     "Question 1": { "regions": [...], "updated_at": "..." },
 *     "Question 2": { "regions": [], "updated_at": null }
 *   },
 *   "samples": [
 *     {
 *       "question": "Question 1",
 *       "answer": "Answer 1",
 *       "evidence_pages": [1, 3],
 *       "evidence_regions": [...],
 *       "has_annotations": true
 *     }
 *   ],
 *   "stats": {
 *     "total_questions": 2,
 *     "total_regions": 5,
 *     "pages_with_regions": [1, 3],
 *     "last_updated": "2026-05-20T10:30:00.000Z"
 *   }
 * }
 */
router.get('/:docId/all', async (req, res) => {
  try {
    const { docId } = req.params;
    
    // Проверяем наличие документа в датасете
    const samples = samplesService.findSamplesByDocId(docId);
    if (samples.length === 0) {
      return res.status(404).json({ error: 'Document not found in dataset' });
    }

    // Проверяем наличие PDF и получаем хеш
    let fileHash;
    try {
      fileHash = await getFileHash(docId);
    } catch (error) {
      return res.status(404).json({ error: 'PDF file not found' });
    }

    // Получаем пользовательскую разметку
    const userAnnotations = samplesService.getAllEvidenceForDocument(docId);

    // Получаем все регионы из Qdrant для всех страниц
    const regionsByPage = {};
    
    if (qdrantService.isInitialized()) {
      try {
        const allQdrantRegions = await qdrantService.getAllRegionsByHash(fileHash);
        
        // Группируем по страницам
        for (const region of allQdrantRegions) {
          const page = region.page;
          if (!regionsByPage[page]) {
            regionsByPage[page] = [];
          }
          regionsByPage[page].push(region);
        }
      } catch (error) {
        console.error(`[Regions] Qdrant error for ${docId}:`, error.message);
      }
    }

    // Добавляем страницы из пользовательской разметки (если есть регионы без Qdrant)
    for (const questionData of Object.values(userAnnotations)) {
      if (questionData.regions) {
        for (const region of questionData.regions) {
          if (region.page && !regionsByPage[region.page]) {
            regionsByPage[region.page] = [];
          }
        }
      }
    }

    // Обогащаем ВСЕ вопросы документа
    const enrichedSamples = enrichSamplesWithAnnotations(samples, docId);

    res.json({
      doc_id: docId,
      file_hash: fileHash,
      regions_by_page: regionsByPage,
      user_annotations: userAnnotations,
      samples: enrichedSamples,
      stats: samplesService.getDocumentStats(docId)
    });
  } catch (error) {
    console.error(`[Regions] Error in GET /:docId/all:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================================================
// POST /api/regions/:docId/save
// ===========================================================================

/**
 * @route POST /api/regions/:docId/save
 * @description Сохраняет регионы для вопроса в evidence_regions.json.
 * Если регионы для этого вопроса уже существуют — перезаписывает их.
 * 
 * @param {string} docId - Идентификатор документа
 * @param {Object} body - Тело запроса
 * @param {string} body.question - Текст вопроса (обязательно, непустая строка)
 * @param {Array<UserRegion>} body.regions - Массив регионов (обязательно, минимум 1 элемент)
 * @param {number} body.regions[].page - Номер страницы
 * @param {number[]} body.regions[].bbox - Координаты [x1, y1, x2, y2]
 * 
 * @returns {Object} Результат сохранения
 * @returns {boolean} success - Успешность операции
 * @returns {string} message - Описание результата
 * @returns {Object} saved_data - Сохранённые данные
 * 
 * @throws {400} Если вопрос отсутствует, регионы пустые или некорректный формат
 * @throws {400} Если документ не найден в датасете
 * 
 * @example
 * // POST /api/regions/document.pdf/save
 * // Body:
 * {
 *   "question": "What is the main finding?",
 *   "regions": [
 *     { "page": 5, "bbox": [100, 200, 300, 400] },
 *     { "page": 5, "bbox": [400, 200, 600, 400] }
 *   ]
 * }
 * // Response 200:
 * {
 *   "success": true,
 *   "message": "Evidence regions saved successfully",
 *   "saved_data": {
 *     "regions": [...],
 *     "updated_at": "2026-05-20T10:30:00.000Z"
 *   }
 * }
 */
router.post('/:docId/save', async (req, res) => {
  try {
    const { docId } = req.params;
    const { question, regions } = req.body;

    // Валидация вопроса
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ 
        error: 'Validation error',
        message: 'Question is required and must be a non-empty string' 
      });
    }

    // Валидация регионов
    if (!regions || !Array.isArray(regions) || regions.length === 0) {
      return res.status(400).json({ 
        error: 'Validation error',
        message: 'Regions array is required and must not be empty' 
      });
    }

    // Проверка каждого региона
    for (const [index, region] of regions.entries()) {
      if (!region.page || typeof region.page !== 'number' || region.page < 1) {
        return res.status(400).json({
          error: 'Validation error',
          message: `Region at index ${index} must have a valid page number (≥ 1)`
        });
      }
      
      if (!region.bbox || !Array.isArray(region.bbox) || region.bbox.length !== 4) {
        return res.status(400).json({
          error: 'Validation error',
          message: `Region at index ${index} must have bbox as [x1, y1, x2, y2]`
        });
      }
      
      if (!region.bbox.every(coord => typeof coord === 'number' && isFinite(coord))) {
        return res.status(400).json({
          error: 'Validation error',
          message: `All bbox coordinates in region ${index} must be finite numbers`
        });
      }
    }

    // Проверка существования документа в датасете
    if (!samplesService.hasDocument(docId)) {
      return res.status(400).json({
        error: 'Document not found',
        message: `Document "${docId}" not found in samples.json`
      });
    }

    // Сохраняем разметку
    const savedData = await samplesService.saveEvidenceRegions(docId, question, regions);

    res.json({
      success: true,
      message: 'Evidence regions saved successfully',
      saved_data: savedData
    });
  } catch (error) {
    console.error(`[Regions] Error in POST /:docId/save:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================================================
// DELETE /api/regions/:docId/save
// ===========================================================================

/**
 * @route DELETE /api/regions/:docId/save
 * @description Удаляет сохранённые регионы для вопроса.
 * 
 * @param {string} docId - Идентификатор документа
 * @param {Object} body - Тело запроса
 * @param {string} body.question - Текст вопроса для удаления
 * 
 * @returns {Object} Результат удаления
 * @returns {boolean} success - Успешность операции
 * @returns {boolean} deleted - Были ли данные фактически удалены
 * @returns {string} message - Описание результата
 * 
 * @throws {400} Если вопрос не указан
 * 
 * @example
 * // DELETE /api/regions/document.pdf/save
 * // Body: { "question": "What is the main finding?" }
 * // Response 200: { "success": true, "deleted": true, "message": "Regions deleted successfully" }
 */
router.delete('/:docId/save', async (req, res) => {
  try {
    const { docId } = req.params;
    const { question } = req.body;

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ 
        error: 'Validation error',
        message: 'Question is required and must be a string' 
      });
    }

    const deleted = await samplesService.deleteEvidenceRegions(docId, question);

    res.json({
      success: true,
      deleted: deleted,
      message: deleted ? 'Regions deleted successfully' : 'No regions found to delete'
    });
  } catch (error) {
    console.error(`[Regions] Error in DELETE /:docId/save:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================================================
// GET /api/regions/:docId/pdf
// ===========================================================================

/**
 * @route GET /api/regions/:docId/pdf
 * @description Отдаёт PDF-файл для просмотра в браузере.
 * Файл отправляется с заголовком Content-Disposition: inline.
 * 
 * @param {string} docId - Идентификатор документа (имя файла)
 * @returns {Buffer} Бинарные данные PDF с Content-Type: application/pdf
 * 
 * @throws {404} Если PDF-файл не найден
 * 
 * @example
 * // GET /api/regions/document.pdf/pdf
 * // Response 200: binary PDF data
 */
router.get('/:docId/pdf', async (req, res) => {
  try {
    const { docId } = req.params;
    const filePath = path.join(config.paths.documentsDir, docId);
    
    // Проверяем существование файла перед отправкой
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ 
        error: 'PDF file not found',
        message: `File "${docId}" not found in documents directory`
      });
    }

    // Отправляем файл с правильными заголовками для отображения в браузере
    res.sendFile(filePath, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${docId}"`
      }
    });
  } catch (error) {
    console.error(`[Regions] Error sending PDF for ${req.params.docId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================================================
// GET /api/regions/:docId/stats
// ===========================================================================

/**
 * @route GET /api/regions/:docId/stats
 * @description Получает статистику пользовательской разметки для документа.
 * 
 * @param {string} docId - Идентификатор документа
 * @returns {DocumentStats} Статистика разметки
 * 
 * @example
 * // GET /api/regions/document.pdf/stats
 * // Response 200:
 * {
 *   "total_questions": 3,
 *   "total_regions": 12,
 *   "pages_with_regions": [1, 3, 5],
 *   "last_updated": "2026-05-20T10:30:00.000Z"
 * }
 */
router.get('/:docId/stats', async (req, res) => {
  try {
    const { docId } = req.params;
    const stats = samplesService.getDocumentStats(docId);
    res.json(stats);
  } catch (error) {
    console.error(`[Regions] Error getting stats for ${req.params.docId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;