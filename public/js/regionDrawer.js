/**
 * @fileoverview Компонент для отрисовки и взаимодействия с регионами на Canvas поверх PDF.
 * 
 * Все регионы (Qdrant и пользовательские) хранятся в нормализованной системе
 * координат 0-1000 относительно размера страницы PDF.
 * Преобразование в canvas-координаты — только в момент отрисовки через
 * {@link RegionDrawer#normalizedToCanvas}. 
 * 
 * @module regionDrawer
 */

class RegionDrawer {
    /**
     * @param {string} canvasId - ID canvas-элемента
     */
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');

        /** @type {Array<Object>} Qdrant-регионы в нормализованных координатах */
        this.qdrantRegions = [];
        
        /** @type {Array<Object>} Пользовательские регионы в нормализованных координатах */
        this.userDrawnRegions = [];
        
        /** @type {Set<string>} ID выделенных регионов */
        this.selectedIds = new Set();
        
        /** @type {Object|null} Регион под курсором */
        this.hoveredRegion = null;
        
        /** @type {boolean} Режим рисования */
        this.drawMode = false;
        
        /** @type {{x: number, y: number}|null} Начальная точка рисования (canvas) */
        this.startPoint = null;
        /** @type {{x: number, y: number}|null} Текущая позиция при рисовании (canvas) */
        this.currentPoint = null;
        
        /** @type {PDFViewer|null} */
        this.pdfViewer = null;
        
        /**
         * Колбэк при изменении выделения региона.
         * @type {function(string, boolean, string):void|null}
         * @param {string} regionId - ID региона
         * @param {boolean} isSelected - выделен или снято выделение
         * @param {string} regionType - тип региона (text, title, ...)
         */
        this.onSelectionChange = null;
        
        /**
         * Колбэк при создании пользовательского региона.
         * @type {function(Object):void|null}
         * @param {Object} region - {id, bbox, element_type}
         */
        this.onUserRegionCreated = null;

        /** @type {Object<string, {fill: string, stroke: string, label: string}>} */
        this.typeColors = {
            text:       { fill: 'rgba(0,100,255,0.08)',  stroke: '#4a90d9', label: 'Текст' },
            title:      { fill: 'rgba(255,200,0,0.10)',   stroke: '#d4a017', label: 'Заголовок' },
            image:      { fill: 'rgba(255,0,100,0.08)',   stroke: '#d94a7a', label: 'Изображение' },
            table:      { fill: 'rgba(0,180,100,0.10)',   stroke: '#2d9d5a', label: 'Таблица' },
            chart:      { fill: 'rgba(200,100,0,0.10)',   stroke: '#b8650a', label: 'График' },
            formula:    { fill: 'rgba(150,50,200,0.08)',  stroke: '#8b3fcf', label: 'Формула' },
            list:       { fill: 'rgba(0,150,200,0.08)',   stroke: '#3a8fb5', label: 'Список' },
            user_drawn: { fill: 'rgba(0,255,0,0.15)',     stroke: '#0c0',     label: 'Пользовательский' },
            unknown:    { fill: 'rgba(128,128,128,0.08)', stroke: '#888888',   label: 'Прочее' }
        };

        this.setupEvents();
    }

    // ===========================================================================
    // События мыши
    // ===========================================================================

    /** @private */
    setupEvents() {
        this.canvas.addEventListener('mousedown', (e) => {
            if (this.drawMode) {
                this.startPoint = this.getCanvasPos(e);
                this.currentPoint = this.startPoint;
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            const pos = this.getCanvasPos(e);
            
            if (this.drawMode && this.startPoint) {
                this.currentPoint = pos;
                this.redraw();
                this.drawTempRect();
                return;
            }
            
            const regionUnderCursor = this.findRegionAtPos(pos);
            if (regionUnderCursor !== this.hoveredRegion) {
                this.hoveredRegion = regionUnderCursor;
                this.redraw();
                this.canvas.style.cursor = regionUnderCursor ? 'pointer' : 
                    (this.drawMode ? 'crosshair' : 'default');
            }
        });

        this.canvas.addEventListener('mouseup', (e) => {
            if (!this.drawMode || !this.startPoint) return;

            const endPos = this.getCanvasPos(e);
            const canvasBbox = this.normalizeRect(this.startPoint, endPos);

            const minSize = 5;
            if (canvasBbox[2] - canvasBbox[0] > minSize && canvasBbox[3] - canvasBbox[1] > minSize) {
                const normalizedBbox = this.canvasToNormalized(canvasBbox);

                const region = {
                    id: 'user_' + Date.now(),
                    bbox: normalizedBbox,
                    element_type: 'user_drawn'
                };

                this.userDrawnRegions.push(region);
                this.redraw();

                if (this.onUserRegionCreated) {
                    this.onUserRegionCreated(region);
                }
            }

            this.startPoint = null;
            this.currentPoint = null;
            this.redraw();
        });

        this.canvas.addEventListener('click', (e) => {
            if (this.drawMode) return;

            const region = this.findRegionAtPos(this.getCanvasPos(e));
            if (region) {
                this.toggleSelection(region);
            }
        });
    }

    // ===========================================================================
    // Координаты и преобразования
    // ===========================================================================

    /**
     * Экранные координаты мыши → координаты canvas.
     * Учитывает разницу между CSS-размерами и внутренним разрешением canvas.
     * @private
     */
    getCanvasPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (this.canvas.width / rect.width),
            y: (e.clientY - rect.top) * (this.canvas.height / rect.height)
        };
    }

    /**
     * Нормализованные координаты (0-1000) → canvas-координаты.
     * 
     * Использует оригинальный размер страницы PDF (originalPageSize) для точного
     * масштабирования. При отсутствии — fallback на размер canvas.
     * Устойчиво к зуму: использует текущие размеры canvas, которые меняются при зуме.
     * 
     * @private
     * @param {number[]} normalizedBbox - [x1, y1, x2, y2] в системе 0-1000
     * @returns {number[]} [x1, y1, x2, y2] в системе canvas
     */
    normalizedToCanvas(normalizedBbox) {
        if (!this.canvas.width || !this.canvas.height) return normalizedBbox;
        
        if (this.pdfViewer && this.pdfViewer.originalPageSize) {
            const ow = this.pdfViewer.originalPageSize.width;
            const oh = this.pdfViewer.originalPageSize.height;
            const cw = this.canvas.width;
            const ch = this.canvas.height;
            
            return [
                (normalizedBbox[0] / 1000) * ow * (cw / ow),
                (normalizedBbox[1] / 1000) * oh * (ch / oh),
                (normalizedBbox[2] / 1000) * ow * (cw / ow),
                (normalizedBbox[3] / 1000) * oh * (ch / oh)
            ];
        }
        
        return [
            (normalizedBbox[0] / 1000) * this.canvas.width,
            (normalizedBbox[1] / 1000) * this.canvas.height,
            (normalizedBbox[2] / 1000) * this.canvas.width,
            (normalizedBbox[3] / 1000) * this.canvas.height
        ];
    }

    /**
     * Canvas-координаты → нормализованные координаты (0-1000).
     * Используется при создании пользовательских регионов.
     * @private
     */
    canvasToNormalized(canvasBbox) {
        if (!this.canvas.width || !this.canvas.height) return canvasBbox;
        
        if (this.pdfViewer && this.pdfViewer.originalPageSize) {
            return [
                (canvasBbox[0] / this.canvas.width) * 1000,
                (canvasBbox[1] / this.canvas.height) * 1000,
                (canvasBbox[2] / this.canvas.width) * 1000,
                (canvasBbox[3] / this.canvas.height) * 1000
            ];
        }
        
        return [
            (canvasBbox[0] / this.canvas.width) * 1000,
            (canvasBbox[1] / this.canvas.height) * 1000,
            (canvasBbox[2] / this.canvas.width) * 1000,
            (canvasBbox[3] / this.canvas.height) * 1000
        ];
    }

    /** @private */
    transformBBox(bbox) {
        return this.normalizedToCanvas(bbox);
    }

    /** @private */
    normalizeRect(p1, p2) {
        return [
            Math.min(p1.x, p2.x),
            Math.min(p1.y, p2.y),
            Math.max(p1.x, p2.x),
            Math.max(p1.y, p2.y)
        ];
    }

    /** @private */
    isPointInRect(pos, bbox) {
        return pos.x >= bbox[0] && pos.x <= bbox[2] &&
               pos.y >= bbox[1] && pos.y <= bbox[3];
    }

    /**
     * Находит регион под курсором.
     * Пользовательские проверяются первыми (рисуются поверх Qdrant).
     * Внутри каждой группы — от последнего к первому (верхние в стопке).
     * @private
     */
    findRegionAtPos(pos) {
        for (let i = this.userDrawnRegions.length - 1; i >= 0; i--) {
            const canvasBbox = this.normalizedToCanvas(this.userDrawnRegions[i].bbox);
            if (this.isPointInRect(pos, canvasBbox)) {
                return this.userDrawnRegions[i];
            }
        }

        for (let i = this.qdrantRegions.length - 1; i >= 0; i--) {
            const canvasBbox = this.normalizedToCanvas(this.qdrantRegions[i].bbox);
            if (this.isPointInRect(pos, canvasBbox)) {
                return this.qdrantRegions[i];
            }
        }

        return null;
    }

    // ===========================================================================
    // Выделение
    // ===========================================================================

    /**
     * Переключает выделение региона.
     * Вызывает {@link RegionDrawer#onSelectionChange}.
     */
    toggleSelection(region) {
        const rid = String(region.id);
        const wasSelected = this.selectedIds.has(rid);

        if (wasSelected) {
            this.selectedIds.delete(rid);
        } else {
            this.selectedIds.add(rid);
        }

        this.redraw();

        if (this.onSelectionChange) {
            this.onSelectionChange(rid, !wasSelected, region.element_type || 'unknown');
        }
    }

    /** @returns {boolean} */
    isSelected(region) {
        return this.selectedIds.has(String(region.id));
    }

    // ===========================================================================
    // Отрисовка
    // ===========================================================================

    /** Полностью перерисовывает все регионы. */
    redraw() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        for (const region of this.qdrantRegions) {
            this.drawRegion(region);
        }

        for (const region of this.userDrawnRegions) {
            this.drawRegion(region);
        }
    }

    /**
     * Рисует один регион.
     * Состояния: selected (зелёный + галочка), hovered (синяя рамка), обычный (цвет типа).
     * @private
     */
    drawRegion(region) {
        const typeStyle = this.typeColors[region.element_type] || this.typeColors.unknown;
        const isSel = this.isSelected(region);
        const isHover = region === this.hoveredRegion;

        const canvasBbox = this.normalizedToCanvas(region.bbox);

        let fillColor, strokeColor, lineWidth;

        if (isSel) {
            fillColor = 'rgba(0,200,100,0.30)';
            strokeColor = '#0a8';
            lineWidth = 3;
        } else if (isHover) {
            fillColor = typeStyle.fill.replace(/[\d.]+\)$/, '0.25)');
            strokeColor = '#26b';
            lineWidth = 2;
        } else {
            fillColor = typeStyle.fill;
            strokeColor = typeStyle.stroke;
            lineWidth = region.element_type === 'user_drawn' ? 2 : 1;
        }

        const [x, y, w, h] = [
            canvasBbox[0],
            canvasBbox[1],
            canvasBbox[2] - canvasBbox[0],
            canvasBbox[3] - canvasBbox[1]
        ];

        this.ctx.fillStyle = fillColor;
        this.ctx.fillRect(x, y, w, h);
        this.ctx.strokeStyle = strokeColor;
        this.ctx.lineWidth = lineWidth;
        this.ctx.strokeRect(x, y, w, h);

        if (isSel) {
            this.drawCheckmark(x + w - 16, y + 6);
        }
    }

    /** @private */
    drawCheckmark(cx, cy) {
        this.ctx.fillStyle = '#0a8';
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.strokeStyle = '#fff';
        this.ctx.lineWidth = 2.5;
        this.ctx.beginPath();
        this.ctx.moveTo(cx - 4, cy);
        this.ctx.lineTo(cx - 1, cy + 4);
        this.ctx.lineTo(cx + 5, cy - 4);
        this.ctx.stroke();
    }

    /** @private */
    drawTempRect() {
        if (!this.startPoint || !this.currentPoint) return;

        const canvasBbox = this.normalizeRect(this.startPoint, this.currentPoint);

        this.ctx.fillStyle = 'rgba(0,255,0,0.10)';
        this.ctx.strokeStyle = '#0c0';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([5, 5]);
        this.ctx.fillRect(canvasBbox[0], canvasBbox[1],
            canvasBbox[2] - canvasBbox[0], canvasBbox[3] - canvasBbox[1]);
        this.ctx.strokeRect(canvasBbox[0], canvasBbox[1],
            canvasBbox[2] - canvasBbox[0], canvasBbox[3] - canvasBbox[1]);
        this.ctx.setLineDash([]);
    }

    // ===========================================================================
    // Загрузка регионов
    // ===========================================================================

    /**
     * Загружает Qdrant-регионы для текущей страницы.
     * Сохраняет в нормализованных координатах (0-1000).
     * @param {Array<Object>} regions - Регионы из Qdrant API
     */
    loadQdrantRegions(regions) {
        this.qdrantRegions = [];
        if (!regions) return;

        for (const r of regions) {
            if (!r.bbox || r.bbox.length !== 4) continue;

            this.qdrantRegions.push({
                id: String(r.region_id || r.id),
                bbox: [...r.bbox],
                element_type: r.element_type || 'unknown',
                text: r.text || '',
                region_id: r.region_id || r.id
            });
        }
    }

    /**
     * Загружает пользовательские регионы для текущей страницы.
     * @param {Array<Object>} regions
     */
    loadUserRegions(regions) {
        this.userDrawnRegions = [];
        if (!regions) return;

        for (const r of regions) {
            this.userDrawnRegions.push({
                id: r.id,
                bbox: [...r.bbox],
                element_type: 'user_drawn'
            });
        }
    }

    /**
     * Устанавливает ссылку на PDFViewer для доступа к originalPageSize.
     * @param {PDFViewer} viewer
     */
    setPDFViewer(viewer) {
        this.pdfViewer = viewer;
    }

    // ===========================================================================
    // Публичное API
    // ===========================================================================

    /** Очищает все регионы. */
    clearAll() {
        this.qdrantRegions = [];
        this.userDrawnRegions = [];
        this.hoveredRegion = null;
    }

    /**
     * Устанавливает выделенные регионы по ID.
     * @param {Array<string|number>} ids
     */
    setSelectedIds(ids) {
        this.selectedIds = new Set([...ids].map(String));
        this.redraw();
    }

    /**
     * Возвращает все выделенные регионы.
     * @returns {Array<Object>}
     */
    getAllSelected() {
        const all = [...this.qdrantRegions, ...this.userDrawnRegions];
        return all.filter(r => this.selectedIds.has(String(r.id)));
    }

    /**
     * Возвращает копию пользовательских регионов.
     * @returns {Array<Object>}
     */
    getUserRegions() {
        return [...this.userDrawnRegions];
    }

    /**
     * Удаляет пользовательский регион по ID.
     * @param {string} id
     */
    removeUserRegion(id) {
        this.userDrawnRegions = this.userDrawnRegions.filter(r => r.id !== id);
        this.selectedIds.delete(id);
        this.redraw();
    }

    /**
     * Включает/выключает режим рисования.
     * В режиме рисования клики создают регионы, а не выделяют.
     * @param {boolean} on
     */
    setDrawMode(on) {
        this.drawMode = on;
        this.canvas.style.cursor = on ? 'crosshair' : 'default';
        if (!on) {
            this.startPoint = null;
            this.currentPoint = null;
            this.redraw();
        }
    }

    /**
     * Устанавливает размеры canvas.
     * @param {number} width
     * @param {number} height
     */
    setSize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.canvas.style.width = width + 'px';
        this.canvas.style.height = height + 'px';
    }

    /**
     * Возвращает легенду типов регионов (без user_drawn).
     * @returns {Array<{type: string, label: string, color: string}>}
     */
    getLegend() {
        return Object.entries(this.typeColors)
            .filter(([key]) => key !== 'user_drawn')
            .map(([type, style]) => ({
                type,
                label: style.label,
                color: style.stroke
            }));
    }
}