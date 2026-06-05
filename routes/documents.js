/**
 * @fileoverview Маршруты для работы с PDF-документами.
 * Предоставляет API для получения списка документов, их метаданных и статистики.
 * 
 * Документы идентифицируются по doc_id, который соответствует имени PDF-файла.
 * Связь с вопросами и регионами осуществляется через samples.json.
 * 
 * @module routes/documents
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
// GET /api/documents
// ===========================================================================

/**
 * @route GET /api/documents
 * @description Получает список всех документов из датасета с информацией о:
 * - Доступности PDF-файла
 * - Количестве вопросов в датасете
 * - Количестве регионов в Qdrant
 * - Статусе пользовательской разметки
 * 
 * @returns {Object} Объект с массивом documents
 * @returns {Array<DocumentSummary>} documents - Список документов
 * 
 * @typedef {Object} DocumentSummary
 * @property {string} doc_id - Идентификатор документа (имя PDF-файла)
 * @property {boolean} pdf_available - Найден ли PDF-файл на диске
 * @property {DocumentStats} stats - Статистика документа
 * 
 * @typedef {Object} DocumentStats
 * @property {number} total_questions - Общее количество вопросов в датасете
 * @property {number} qdrant_regions - Количество регионов в Qdrant (0 если Qdrant недоступен)
 * @property {number} annotated_questions - Количество вопросов с пользовательской разметкой
 * @property {number} annotated_regions - Общее количество размеченных регионов
 * @property {string|null} last_annotated - Дата последней разметки (ISO)
 * 
 * @example
 * // GET /api/documents
 * // Response 200:
 * {
 *   "documents": [
 *     {
 *       "doc_id": "document1.pdf",
 *       "pdf_available": true,
 *       "stats": {
 *         "total_questions": 5,
 *         "qdrant_regions": 42,
 *         "annotated_questions": 3,
 *         "annotated_regions": 12,
 *         "last_annotated": "2026-05-20T10:30:00.000Z"
 *       }
 *     }
 *   ]
 * }
 */
router.get('/', async (req, res) => {
  try {
    const docIds = samplesService.getAllDocIds();
    
    // Собираем информацию о каждом документе параллельно
    const availableDocs = await Promise.all(
      docIds.map(docId => buildDocumentSummary(docId))
    );
    
    res.json({ documents: availableDocs });
  } catch (error) {
    console.error('[Documents] Error fetching document list:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================================================
// GET /api/documents/:docId
// ===========================================================================

/**
 * @route GET /api/documents/:docId
 * @description Получает детальную информацию о конкретном документе, включая:
 * - Список всех вопросов из датасета с их evidence-регионами
 * - Страницы, на которых найдены evidence
 * - Статистику разметки
 * 
 * @param {string} docId - Идентификатор документа (имя PDF-файла)
 * 
 * @returns {Object} Детальная информация о документе
 * @returns {string} doc_id - Идентификатор документа
 * @returns {string|null} file_hash - MD5-хеш PDF-файла (null если PDF не найден)
 * @returns {number[]} evidence_pages - Номера страниц с evidence
 * @returns {EnrichedSample[]} samples - Вопросы с информацией о разметке
 * @returns {DocumentStats} stats - Статистика документа
 * 
 * @typedef {Object} EnrichedSample
 * @property {string} question - Текст вопроса
 * @property {string} answer - Ответ на вопрос
 * @property {number[]} evidence_pages - Страницы с evidence
 * @property {string[]} evidence_sources - Источники evidence
 * @property {Array} evidence_regions - Сохранённые регионы для вопроса
 * @property {boolean} has_annotations - Есть ли пользовательская разметка
 * @property {string|null} annotation_updated_at - Дата обновления разметки
 * 
 * @example
 * // GET /api/documents/document1.pdf
 * // Response 200:
 * {
 *   "doc_id": "document1.pdf",
 *   "file_hash": "a1b2c3d4...",
 *   "evidence_pages": [1, 3],
 *   "samples": [
 *     {
 *       "question": "What is shown in Figure 1?",
 *       "answer": "The diagram shows...",
 *       "evidence_pages": [1],
 *       "evidence_sources": ["Figure 1"],
 *       "evidence_regions": [...],
 *       "has_annotations": true,
 *       "annotation_updated_at": "2026-05-20T10:30:00.000Z"
 *     }
 *   ],
 *   "stats": { ... }
 * }
 * 
 * @throws {404} Если документ не найден в датасете
 */
router.get('/:docId', async (req, res) => {
  try {
    const { docId } = req.params;
    const samples = samplesService.findSamplesByDocId(docId);
    
    if (samples.length === 0) {
      return res.status(404).json({ 
        error: 'Document not found',
        message: `No samples found for document "${docId}" in dataset` 
      });
    }

    // Вычисляем хеш PDF-файла (может быть null)
    const fileHash = await getFileHash(docId);

    // Получаем страницы с регионами и разметку
    const evidencePages = samplesService.getEvidencePages(docId);
    const allEvidence = samplesService.getAllEvidenceForDocument(docId);

    // Обогащаем вопросы информацией о разметке
    const enrichedSamples = samples.map(sample => ({
      question: sample.question,
      answer: sample.answer,
      evidence_pages: sample.evidence_pages,
      evidence_sources: sample.evidence_sources,
      evidence_regions: allEvidence[sample.question]?.regions || [],
      has_annotations: !!allEvidence[sample.question],
      annotation_updated_at: allEvidence[sample.question]?.updated_at || null
    }));

    res.json({
      doc_id: docId,
      file_hash: fileHash,
      evidence_pages: evidencePages,
      samples: enrichedSamples,
      stats: samplesService.getDocumentStats(docId)
    });
  } catch (error) {
    console.error(`[Documents] Error fetching document ${req.params.docId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================================================
// Вспомогательные функции
// ===========================================================================

/**
 * Собирает сводную информацию о документе для списка.
 * Объединяет данные из файловой системы, Qdrant и разметки вопросов.
 * 
 * @async
 * @param {string} docId - Идентификатор документа
 * @returns {Promise<DocumentSummary>} Сводка по документу
 */
async function buildDocumentSummary(docId) {
  // Получаем хеш и проверяем наличие PDF одним чтением
  const fileHash = await getFileHash(docId);
  const pdfAvailable = fileHash !== null;
  
  // Количество вопросов из датасета
  const samplesForDoc = samplesService.findSamplesByDocId(docId);
  const totalQuestions = samplesForDoc.length;
  
  // Количество регионов в Qdrant (только если есть PDF и Qdrant доступен)
  let qdrantRegionsCount = 0;
  if (fileHash && qdrantService.isInitialized()) {
    try {
      qdrantRegionsCount = await qdrantService.getRegionsCountByHash(fileHash);
    } catch (error) {
      console.warn(`[Documents] Failed to get Qdrant count for ${docId}:`, error.message);
    }
  }
  
  // Статистика пользовательской разметки
  const evidenceStats = samplesService.getDocumentStats(docId);
  const evidenceData = samplesService.getAllEvidenceForDocument(docId);
  const annotatedQuestions = Object.keys(evidenceData).length;
  
  return {
    doc_id: docId,
    pdf_available: pdfAvailable,
    stats: {
      total_questions: totalQuestions,
      qdrant_regions: qdrantRegionsCount,
      annotated_questions: annotatedQuestions,
      annotated_regions: evidenceStats.total_regions,
      last_annotated: evidenceStats.last_updated
    }
  };
}

/**
 * Вычисляет MD5-хеш PDF-файла документа.
 * Попутно проверяет существование файла на диске.
 * 
 * @async
 * @param {string} docId - Идентификатор документа (имя файла)
 * @returns {Promise<string|null>} MD5-хеш в hex-формате или null если файл не найден
 */
async function getFileHash(docId) {
  const filePath = path.join(config.paths.documentsDir, docId);
  
  try {
    const fileContent = await fs.readFile(filePath);
    return qdrantService.calculateFileHash(fileContent);
  } catch (error) {
    // Файл не найден или ошибка чтения — возвращаем null
    return null;
  }
}

module.exports = router;