/**
 * @fileoverview Сервис для работы с датасетом samples.json.
 * 
 * Обеспечивает чтение и запись данных датасета.
 * samples.json содержит вопросы, ответы и evidence-регионы для PDF-документов.
 * 
 * После разметки каждая запись дополняется полями:
 * - evidence_regions: массив регионов, выбранных пользователем
 * - annotation_updated_at: дата последнего сохранения разметки
 * 
 * @module services/samplesService
 */

const fs = require('fs').promises;
const config = require('../config');

class SamplesService {
    constructor() {
        /** @private */
        this.samplesPath = config.paths.samplesJson;
        /** @type {Array<Object>|null} */
        this.samples = null;
    }

    // ===========================================================================
    // Загрузка и сохранение
    // ===========================================================================

    /**
     * Загружает данные из samples.json.
     * @async
     * @throws {Error} При ошибке чтения или парсинга
     */
    async loadSamples() {
        try {
            const data = await fs.readFile(this.samplesPath, 'utf8');
            this.samples = JSON.parse(data);
            console.log(`[Samples] Loaded ${this.samples.length} samples from ${this.samplesPath}`);
        } catch (error) {
            console.error('[Samples] Error loading:', error.message);
            this.samples = [];
            throw new Error(`Failed to load samples.json: ${error.message}`);
        }
    }

    /**
     * Сохраняет данные в samples.json.
     * @async
     * @private
     * @throws {Error} При ошибке записи
     */
    async _saveSamples() {
        try {
            const path = require('path');
            const dir = path.dirname(this.samplesPath);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(this.samplesPath, JSON.stringify(this.samples, null, 2), 'utf8');
        } catch (error) {
            console.error('[Samples] Error saving:', error.message);
            throw new Error(`Failed to save samples.json: ${error.message}`);
        }
    }

    // ===========================================================================
    // Поиск
    // ===========================================================================

    /** @param {string} docId @returns {boolean} */
    hasDocument(docId) {
        if (!this.samples) return false;
        return this.samples.some(s => s.doc_id === docId);
    }

    /**
     * Находит все записи для документа.
     * @param {string} docId
     * @returns {Array<Object>}
     */
    findSamplesByDocId(docId) {
        if (!this.samples) return [];
        return this.samples.filter(s => s.doc_id === docId);
    }

    /** @returns {Array<string>} */
    getAllDocIds() {
        if (!this.samples) return [];
        return [...new Set(this.samples.map(s => s.doc_id))];
    }

    /**
     * Находит запись по документу и вопросу.
     * @param {string} docId
     * @param {string} question
     * @returns {Object|undefined}
     */
    findSampleByDocAndQuestion(docId, question) {
        if (!this.samples) return undefined;
        return this.samples.find(s => s.doc_id === docId && s.question === question);
    }

    /**
     * Возвращает страницы с evidence для документа.
     * @param {string} docId
     * @returns {number[]}
     */
    getEvidencePages(docId) {
        if (!this.samples) return [];
        
        const pages = new Set();
        for (const sample of this.findSamplesByDocId(docId)) {
            const samplePages = this._parseEvidencePages(sample.evidence_pages);
            for (const p of samplePages) pages.add(p);
        }
        return [...pages].sort((a, b) => a - b);
    }

    // ===========================================================================
    // Evidence-регионы
    // ===========================================================================

    /**
     * Сохраняет evidence-регионы для вопроса в документе.
     * Обновляет запись в this.samples и сохраняет в файл.
     * 
     * @async
     * @param {string} docId - Идентификатор документа
     * @param {string} question - Текст вопроса
     * @param {Array<Object>} regions - Массив регионов
     * @returns {Promise<Object>} Обновлённая запись
     * @throws {Error} Если запись не найдена или ошибка сохранения
     */
    async saveEvidenceRegions(docId, question, regions) {
        const sample = this.findSampleByDocAndQuestion(docId, question);
        
        if (!sample) {
            throw new Error(`Sample not found: doc="${docId}", question="${question}"`);
        }

        sample.evidence_regions = regions;
        sample.annotation_updated_at = new Date().toISOString();

        await this._saveSamples();

        return {
            regions: sample.evidence_regions,
            updated_at: sample.annotation_updated_at
        };
    }

    /**
     * Удаляет evidence-регионы для вопроса.
     * 
     * @async
     * @param {string} docId
     * @param {string} question
     * @returns {Promise<boolean>} true если удалено, false если запись не найдена
     */
    async deleteEvidenceRegions(docId, question) {
        const sample = this.findSampleByDocAndQuestion(docId, question);
        
        if (!sample || !sample.evidence_regions) return false;

        delete sample.evidence_regions;
        delete sample.annotation_updated_at;

        await this._saveSamples();
        return true;
    }

    /**
     * Возвращает evidence-регионы для вопроса.
     * @param {string} docId
     * @param {string} question
     * @returns {Array<Object>|null}
     */
    getEvidenceRegions(docId, question) {
        const sample = this.findSampleByDocAndQuestion(docId, question);
        return sample?.evidence_regions || null;
    }

    /**
     * Возвращает все evidence-регионы для документа.
     * @param {string} docId
     * @returns {Object<string, {regions: Array, updated_at: string}>}
     */
    getAllEvidenceForDocument(docId) {
        const result = {};
        for (const sample of this.findSamplesByDocId(docId)) {
            if (sample.evidence_regions) {
                result[sample.question] = {
                    regions: sample.evidence_regions,
                    updated_at: sample.annotation_updated_at || null
                };
            }
        }
        return result;
    }

    /**
     * Возвращает регионы для конкретной страницы документа.
     * @param {string} docId
     * @param {number} pageNumber
     * @returns {Array<Object>} Регионы с добавленным полем question
     */
    getRegionsForPage(docId, pageNumber) {
        const result = [];
        for (const sample of this.findSamplesByDocId(docId)) {
            if (sample.evidence_regions) {
                for (const region of sample.evidence_regions) {
                    if (region.page === pageNumber) {
                        result.push({ ...region, question: sample.question });
                    }
                }
            }
        }
        return result;
    }

    /**
     * Возвращает статистику разметки для документа.
     * @param {string} docId
     * @returns {Object}
     */
    getDocumentStats(docId) {
        const docSamples = this.findSamplesByDocId(docId);
        
        const pages = new Set();
        let totalRegions = 0;
        let annotatedQuestions = 0;
        let lastUpdated = null;

        for (const sample of docSamples) {
            if (sample.evidence_regions && sample.evidence_regions.length > 0) {
                annotatedQuestions++;
                totalRegions += sample.evidence_regions.length;
                for (const r of sample.evidence_regions) {
                    if (r.page) pages.add(r.page);
                }
                if (sample.annotation_updated_at && (!lastUpdated || sample.annotation_updated_at > lastUpdated)) {
                    lastUpdated = sample.annotation_updated_at;
                }
            }
        }

        return {
            total_questions: docSamples.length,
            annotated_questions: annotatedQuestions,
            total_regions: totalRegions,
            pages_with_regions: [...pages].sort((a, b) => a - b),
            last_updated: lastUpdated
        };
    }

    // ===========================================================================
    // Приватные методы
    // ===========================================================================

    /**
     * Парсит строку evidence_pages в массив чисел.
     * @private
     * @param {string} str - Строка вида "[1, 3, 5]"
     * @returns {number[]}
     */
    _parseEvidencePages(str) {
        try {
            const normalized = str.replace(/'/g, '"');
            const pages = JSON.parse(normalized);
            return Array.isArray(pages) ? pages : [pages];
        } catch {
            return [];
        }
    }
}

const samplesService = new SamplesService();
module.exports = samplesService;