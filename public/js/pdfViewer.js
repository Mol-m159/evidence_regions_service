/**
 * @fileoverview Компонент для рендеринга PDF-страниц на Canvas.
 * 
 * Использует PDF.js для отображения страниц документа.
 * Поддерживает навигацию, масштабирование и подгонку по ширине.
 * Уведомляет о смене страницы и состоянии загрузки через колбэки.
 * 
 * @module pdfViewer
 * @requires pdfjsLib
 */

class PDFViewer {
    /**
     * Создаёт экземпляр просмотрщика PDF.
     * 
     * @param {string} canvasId - ID canvas-элемента для рендеринга PDF
     * 
     * @example
     * const viewer = new PDFViewer('pdfCanvas');
     * viewer.onPageChange = (page) => console.log('Страница:', page);
     * await viewer.loadPDF('document.pdf');
     */
    constructor(canvasId) {
        /**
         * Canvas-элемент для рендеринга PDF.
         * @type {HTMLCanvasElement}
         */
        this.canvas = document.getElementById(canvasId);
        
        /**
         * Контекст рендеринга canvas.
         * @type {CanvasRenderingContext2D}
         */
        this.ctx = this.canvas.getContext('2d');
        
        /**
         * Текущий загруженный PDF-документ.
         * @type {Object|null}
         */
        this.pdfDoc = null;
        
        /**
         * Номер текущей отображаемой страницы (начиная с 1).
         * @type {number}
         */
        this.currentPage = 1;
        
        /**
         * Текущий масштаб отображения (1.0 = 72 DPI, оригинальный размер).
         * @type {number}
         */
        this.scale = 1.5;
        
        /**
         * Общее количество страниц в документе.
         * @type {number}
         */
        this.totalPages = 0;
        
        /**
         * Оригинальные размеры текущей страницы в PDF-поинтах (при scale=1).
         * Обновляется при каждом рендере страницы.
         * @type {{width: number, height: number}|null}
         */
        this.originalPageSize = null;
        
        /**
         * Колбэк, вызываемый после смены страницы.
         * @type {function(number):void|null}
         * @param {number} pageNumber - Номер новой страницы
         * 
         * @example
         * viewer.onPageChange = (pageNumber) => {
         *   updatePageControls(pageNumber);
         * };
         */
        this.onPageChange = null;
        
        /**
         * Колбэк, вызываемый при начале и завершении загрузки страницы.
         * @type {function(boolean):void|null}
         * @param {boolean} loading - true если загрузка началась, false если завершилась
         * 
         * @example
         * viewer.onPageLoad = (loading) => {
         *   toggleSpinner(loading);
         * };
         */
        this.onPageLoad = null;
    }

    // ===========================================================================
    // Загрузка PDF
    // ===========================================================================

    /**
     * Загружает PDF из URL или Blob.
     * После загрузки рендерит первую страницу.
     * 
     * @async
     * @param {string|Blob} source - URL или Blob PDF-файла
     * @throws {Error} При ошибке загрузки или повреждённом PDF
     * 
     * @example
     * // Из URL
     * await viewer.loadPDF('/api/regions/document.pdf/pdf');
     * 
     * // Из Blob
     * const blob = await api.getPDF('document.pdf');
     * await viewer.loadPDF(URL.createObjectURL(blob));
     */
    async loadPDF(source) {
        try {
            const loadingTask = pdfjsLib.getDocument(source);
            this.pdfDoc = await loadingTask.promise;
            this.totalPages = this.pdfDoc.numPages;
            this.currentPage = 1;
            
            await this.renderPage(this.currentPage);
        } catch (error) {
            console.error('[PDFViewer] Error loading PDF:', error);
            throw new Error('Failed to load PDF: ' + error.message);
        }
    }

    /**
     * Загружает PDF из Blob-объекта.
     * Создаёт временный URL, загружает PDF и очищает URL.
     * 
     * @async
     * @param {Blob} blob - PDF-файл как Blob (обычно из API-запроса)
     * 
     * @example
     * const blob = await api.getPDF('document.pdf');
     * await viewer.loadPDFFromBlob(blob);
     */
    async loadPDFFromBlob(blob) {
        const url = URL.createObjectURL(blob);
        await this.loadPDF(url);
        URL.revokeObjectURL(url);
    }

    // ===========================================================================
    // Рендеринг
    // ===========================================================================

    /**
     * Рендерит указанную страницу PDF на canvas.
     * 
     * Алгоритм:
     * 1. Получает страницу из PDF-документа
     * 2. Вычисляет viewport с текущим масштабом
     * 3. Устанавливает размеры canvas под viewport
     * 4. Сохраняет оригинальный размер страницы (scale=1) для вычисления scale factor
     * 5. Рендерит страницу
     * 6. Вызывает колбэк onPageChange
     * 
     * @async
     * @param {number} pageNumber - Номер страницы (начиная с 1)
     * @throws {Error} При ошибке рендеринга
     */
    async renderPage(pageNumber) {
        if (!this.pdfDoc) return;

        // Уведомляем о начале загрузки
        if (this.onPageLoad) {
            this.onPageLoad(true);
        }

        try {
            const page = await this.pdfDoc.getPage(pageNumber);
            
            // Сохраняем оригинальный размер страницы (до масштабирования)
            const originalViewport = page.getViewport({ scale: 1 });
            this.originalPageSize = {
                width: originalViewport.width,
                height: originalViewport.height
            };
            
            // Вычисляем viewport с учётом масштаба
            const viewport = page.getViewport({ scale: this.scale });

            // Устанавливаем размеры canvas под viewport
            this.canvas.width = viewport.width;
            this.canvas.height = viewport.height;

            // Рендерим страницу
            await page.render({
                canvasContext: this.ctx,
                viewport: viewport
            }).promise;
            
            this.currentPage = pageNumber;

            // Уведомляем о смене страницы
            if (this.onPageChange) {
                this.onPageChange(pageNumber);
            }
        } catch (error) {
            console.error('[PDFViewer] Error rendering page:', error);
            throw error;
        } finally {
            // Всегда уведомляем о завершении загрузки (даже при ошибке)
            if (this.onPageLoad) {
                this.onPageLoad(false);
            }
        }
    }

    // ===========================================================================
    // Навигация по страницам
    // ===========================================================================

    /**
     * Переходит на следующую страницу.
     * Если достигнут конец документа — ничего не делает.
     * 
     * @async
     */
    async nextPage() {
        if (this.currentPage < this.totalPages) {
            await this.renderPage(this.currentPage + 1);
        }
    }

    /**
     * Переходит на предыдущую страницу.
     * Если достигнуто начало документа — ничего не делает.
     * 
     * @async
     */
    async prevPage() {
        if (this.currentPage > 1) {
            await this.renderPage(this.currentPage - 1);
        }
    }

    /**
     * Переходит на указанную страницу.
     * Если номер страницы вне допустимого диапазона — ничего не делает.
     * 
     * @async
     * @param {number} page - Номер страницы (от 1 до totalPages)
     */
    async goToPage(page) {
        if (page >= 1 && page <= this.totalPages) {
            await this.renderPage(page);
        }
    }

    // ===========================================================================
    // Масштабирование
    // ===========================================================================

    /**
     * Изменяет масштаб на указанную величину.
     * Масштаб ограничен диапазоном от 0.5 до 3.0.
     * 
     * @async
     * @param {number} delta - Изменение масштаба (положительное — увеличение, отрицательное — уменьшение)
     * 
     * @example
     * await viewer.zoom(0.25);  // Увеличить на 25%
     * await viewer.zoom(-0.25); // Уменьшить на 25%
     */
    async zoom(delta) {
        const newScale = Math.max(0.5, Math.min(3.0, this.scale + delta));
        
        // Если масштаб не изменился — не рендерим заново
        if (newScale === this.scale) return;
        
        this.scale = newScale;
        await this.renderPage(this.currentPage);
    }

    /**
     * Устанавливает абсолютное значение масштаба.
     * Масштаб ограничен диапазоном от 0.5 до 3.0.
     * 
     * @async
     * @param {number} scale - Новый масштаб (1.0 = оригинальный размер)
     * 
     * @example
     * await viewer.setScale(2.0);  // Увеличить в 2 раза
     * await viewer.setScale(0.75); // Уменьшить до 75%
     */
    async setScale(scale) {
        const clampedScale = Math.max(0.5, Math.min(3.0, scale));
        
        if (clampedScale === this.scale) return;
        
        this.scale = clampedScale;
        await this.renderPage(this.currentPage);
    }

    /**
     * Подгоняет страницу по ширине контейнера.
     * Вычисляет масштаб так, чтобы ширина страницы соответствовала ширине контейнера
     * (с учётом отступов).
     * 
     * @async
     */
    async fitToWidth() {
        if (!this.pdfDoc) return;
        
        // Получаем ширину контейнера (родитель canvas)
        const container = this.canvas.parentElement.parentElement;
        const containerWidth = container.clientWidth - 40; // Учитываем padding
        
        // Используем кешированный размер страницы
        if (!this.originalPageSize) {
            const page = await this.pdfDoc.getPage(this.currentPage);
            const viewport = page.getViewport({ scale: 1 });
            this.originalPageSize = {
                width: viewport.width,
                height: viewport.height
            };
        }
        
        const newScale = containerWidth / this.originalPageSize.width;
        await this.setScale(newScale);
    }

    // ===========================================================================
    // Утилиты
    // ===========================================================================

    /**
     * Возвращает текущие размеры canvas.
     * 
     * @returns {{width: number, height: number}} Размеры canvas в пикселях
     */
    getCanvasSize() {
        return {
            width: this.canvas.width,
            height: this.canvas.height
        };
    }

    /**
     * Возвращает коэффициент масштабирования из PDF-координат в координаты canvas.
     * Используется для преобразования координат регионов из Qdrant (в PDF-поинтах)
     * в координаты на экране.
     * 
     * @returns {number} Коэффициент масштабирования (canvas_width / original_page_width)
     * 
     * @example
     * const scaleFactor = viewer.getScaleFactor();
     * // Преобразование bbox из PDF-поинтов в экранные координаты:
     * const screenX = bbox[0] * scaleFactor;
     * const screenY = bbox[1] * scaleFactor;
     */
    getScaleFactor() {
        if (!this.originalPageSize || !this.canvas.width) return 1;
        return this.canvas.width / this.originalPageSize.width;
    }
}