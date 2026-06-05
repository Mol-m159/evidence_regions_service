/**
 * @fileoverview Главный класс приложения для разметки вопросов в PDF-документах.
 * 
 * Управляет:
 * - Загрузкой и отображением PDF-документов через PDFViewer
 * - Отрисовкой и выделением регионов через RegionDrawer
 * - Списком документов и вопросов из датасета
 * - Сохранением/удалением пользовательской разметки через API
 * - Переключением вкладок, клавиатурными сокращениями, UI-состоянием
 * 
 * @module app
 * @requires PDFViewer
 * @requires RegionDrawer
 * @requires api
 */

class App {
    /**
     * Инициализирует приложение.
     * Создаёт экземпляры PDFViewer и RegionDrawer, устанавливает колбэки и загружает данные.
     */
    constructor() {
        /** 
         * Просмотрщик PDF-документов.
         * @type {PDFViewer} 
         */
        this.pdfViewer = new PDFViewer('pdfCanvas');
        
        /** 
         * Отрисовщик регионов поверх PDF.
         * @type {RegionDrawer} 
         */
        this.regionDrawer = new RegionDrawer('drawCanvas');
        
        /** 
         * Текущий загруженный документ.
         * @type {{doc_id: string, file_hash: string, evidence_pages: number[]}|null}
         */
        this.currentDocument = null;
        
        /** 
         * Текущий выбранный вопрос.
         * @type {Object|null}
         */
        this.currentQuestion = null;
        
        /** 
         * Все документы из API.
         * @type {Array<Object>}
         */
        this.allDocuments = [];
        
        /** 
         * Все вопросы текущего документа.
         * @type {Array<Object>}
         */
        this.allSamples = [];
        
        /** 
         * Множество ID выбранных регионов (и Qdrant, и пользовательских).
         * @type {Set<string>}
         */
        this.selectedIds = new Set();
        
        /** 
         * Метаданные выбранных Qdrant-регионов.
         * @type {Array<{id: string, type: string, page: number}>}
         */
        this.selectedQdrantRegions = [];
        
        /** 
         * Пользовательские регионы (созданные вручную).
         * @type {Array<{id: string, bbox: number[], page: number}>}
         */
        this.userRegions = [];
        
        this.init();
    }

    /**
     * Инициализирует приложение: настраивает колбэки, UI, загружает данные.
     * @async
     * @private
     */
    async init() {
        this.regionDrawer.setPDFViewer(this.pdfViewer);
        this.setupPDFViewerCallbacks();
        this.setupRegionCallbacks();
        this.setupTabs();
        this.setupUIEventListeners();
        this.setupKeyboardShortcuts();
        this.renderLegend();
        await this.checkConnection();
        await this.loadDocumentsList();
    }

    // ===========================================================================
    // Вкладки 
    // ===========================================================================

    /**
     * Настраивает переключение вкладок интерфейса.
     * @private
     */
    setupTabs() {
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchTab(tab.dataset.tab);
            });
        });
    }

    /**
     * Переключает активную вкладку.
     * При открытии просмотрщика сбрасывает выделение, если не выбран вопрос.
     * 
     * @param {string} tabName - Имя вкладки ('viewer', 'questions', 'documents')
     */
    switchTab(tabName) {
        // Обновляем активный класс на кнопках вкладок
        document.querySelectorAll('.tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tabName);
        });
        
        // Показываем содержимое выбранной вкладки
        document.querySelectorAll('.tab-content').forEach(c => {
            c.classList.toggle('active', c.id === `tab-${tabName}`);
        });
        
        // При открытии просмотрщика синхронизируем размеры канвасов
        if (tabName === 'viewer') {
            if (!this.currentQuestion) {
                this.clearCurrentSelectionSilent();
            }
            setTimeout(() => this.syncCanvasSizes(), 100);
        }
    }

    // ===========================================================================
    // Callbacks PDF Viewer
    // ===========================================================================

    /**
     * Настраивает колбэки просмотрщика PDF.
     * @private
     */
    setupPDFViewerCallbacks() {
        // При смене страницы загружаем регионы и обновляем контролы
        this.pdfViewer.onPageChange = async (pageNumber) => {
            this.updatePageControls(pageNumber);
            await this.loadPageRegions(pageNumber);
            this.syncCanvasSizes();
        };
        
        // При загрузке страницы показываем/скрываем индикатор загрузки
        this.pdfViewer.onPageLoad = (loading) => {
            this.toggleLoading(loading);
            if (!loading) {
                setTimeout(() => this.syncCanvasSizes(), 100);
            }
        };
    }

    // ===========================================================================
    // Callbacks Region Drawer
    // ===========================================================================

    /**
     * Настраивает колбэки отрисовщика регионов.
     * Обрабатывает выделение/снятие выделения и создание новых регионов.
     * @private
     */
    setupRegionCallbacks() {
        /**
         * Обработчик изменения выделения региона.
         * Добавляет/удаляет регион из наборов selectedIds и selectedQdrantRegions.
         */
        this.regionDrawer.onSelectionChange = (regionId, isSelected, regionType) => {
            const rid = String(regionId);
            
            if (isSelected) {
                this.selectedIds.add(rid);
                
                const isUser = this.userRegions.find(r => String(r.id) === rid);
                
                if (!isUser) {
                    // Qdrant-регион: добавляем метаданные если ещё не добавлен
                    const exists = this.selectedQdrantRegions.find(r => String(r.id) === rid);
                    if (!exists) {
                        this.selectedQdrantRegions.push({
                            id: rid,
                            type: regionType || 'unknown',
                            page: this.pdfViewer.currentPage
                        });
                    }
                }
            } else {
                this.selectedIds.delete(rid);
                this.selectedQdrantRegions = this.selectedQdrantRegions.filter(
                    r => String(r.id) !== rid
                );
            }
            
            this.updateSelectionUI();
        };

        /**
         * Обработчик создания пользовательского региона.
         * Добавляет регион в массив userRegions без автоматического выделения.
         */
        this.regionDrawer.onUserRegionCreated = (region) => {
            const rid = String(region.id);
            
            if (!this.userRegions.find(r => String(r.id) === rid)) {
                this.userRegions.push({
                    id: rid,
                    bbox: region.bbox,
                    page: this.pdfViewer.currentPage
                });
            }
            
            this.updateSelectionUI();
        };
    }

    // ===========================================================================
    // UI Event Listeners
    // ===========================================================================

    /**
     * Настраивает все обработчики событий интерфейса.
     * @private
     */
    setupUIEventListeners() {
        // Навигация по страницам
        document.getElementById('prevPageBtn').addEventListener('click', () => this.pdfViewer.prevPage());
        document.getElementById('nextPageBtn').addEventListener('click', () => this.pdfViewer.nextPage());
        document.getElementById('pageInput').addEventListener('change', (e) => {
            const page = parseInt(e.target.value, 10);
            if (page) this.pdfViewer.goToPage(page);
        });

        // Управление зумом
        document.getElementById('zoomInBtn').addEventListener('click', async () => {
            await this.pdfViewer.zoom(0.25);
            this.updateZoomLevel();
            setTimeout(() => this.syncCanvasSizes(), 100);
        });
        document.getElementById('zoomOutBtn').addEventListener('click', async () => {
            await this.pdfViewer.zoom(-0.25);
            this.updateZoomLevel();
            setTimeout(() => this.syncCanvasSizes(), 100);
        });
        document.getElementById('fitWidthBtn').addEventListener('click', async () => {
            await this.pdfViewer.fitToWidth();
            this.updateZoomLevel();
            setTimeout(() => this.syncCanvasSizes(), 100);
        });

        // Режим рисования
        document.getElementById('drawModeBtn').addEventListener('click', () => this.toggleDrawMode());
        
        // Удаление последнего пользовательского региона
        document.getElementById('deleteRegionBtn').addEventListener('click', () => {
            if (this.userRegions.length > 0) {
                const last = this.userRegions[this.userRegions.length - 1];
                this.removeUserRegion(last.id);
            }
        });
        
        // Сохранение и очистка
        document.getElementById('saveAnnotationBtn').addEventListener('click', () => this.saveAnnotations());
        document.getElementById('clearSelectionBtn').addEventListener('click', () => this.clearCurrentSelection());
        
        // Цвет пользовательских регионов
        document.getElementById('regionColor').addEventListener('change', (e) => {
            this.regionDrawer.userColor = e.target.value;
        });

        // Навигация по вопросам
        document.getElementById('prevQuestionBtn').addEventListener('click', () => this.navigateQuestion(-1));
        document.getElementById('nextQuestionBtn').addEventListener('click', () => this.navigateQuestion(1));

        // Поиск и фильтрация
        document.getElementById('docSearchInput').addEventListener('input', (e) => {
            this.filterDocuments(e.target.value);
        });
        document.getElementById('questionSearchInput').addEventListener('input', (e) => {
            this.filterQuestions(e.target.value);
        });

        // Кнопка открытия просмотрщика из панели вопросов
        const openViewerBtn = document.getElementById('openViewerBtn');
        if (openViewerBtn) {
            openViewerBtn.addEventListener('click', () => {
                if (this.currentDocument) {
                    this.switchTab('viewer');
                    setTimeout(async () => {
                        this.syncCanvasSizes();
                        await this.loadPageRegions(this.pdfViewer.currentPage);
                        this.updatePageControls(this.pdfViewer.currentPage);
                        this.updateZoomLevel();
                    }, 300);
                } else {
                    this.showToast('Сначала выберите документ', 'error');
                }
            });
        }
    }

    // ===========================================================================
    // Клавиатурные сокращения
    // ===========================================================================

    /**
     * Настраивает горячие клавиши для быстрой работы.
     * Не срабатывают, если фокус в поле ввода.
     * 
     * @private
     */
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Не обрабатываем, если фокус в поле ввода
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            
            switch (e.key.toLowerCase()) {
                case 'r':
                    if (!e.ctrlKey && !e.metaKey) {
                        e.preventDefault();
                        this.toggleDrawMode();
                    }
                    break;
                    
                case 'escape':
                    this.regionDrawer.setDrawMode(false);
                    this.updateDrawModeButton();
                    break;
                    
                case 'delete':
                case 'backspace':
                    if (this.userRegions.length > 0) {
                        const last = this.userRegions[this.userRegions.length - 1];
                        this.removeUserRegion(last.id);
                    }
                    break;
                    
                case 'arrowleft':
                    e.preventDefault();
                    this.pdfViewer.prevPage();
                    break;
                    
                case 'arrowright':
                    e.preventDefault();
                    this.pdfViewer.nextPage();
                    break;
                    
                case 's':
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        this.saveAnnotations();
                    }
                    break;
            }
        });
    }

    // ===========================================================================
    // UI выделения (Selection UI)
    // ===========================================================================

    /**
     * Обновляет панель выделенных регионов.
     * Собирает пользовательские и Qdrant-регионы, которые сейчас выделены,
     * обновляет счётчики и состояние кнопок.
     */
    updateSelectionUI() {
        const items = [];
        
        // Пользовательские регионы (только выделенные)
        this.userRegions.forEach(r => {
            const rid = String(r.id);
            if (this.selectedIds.has(rid)) {
                items.push({
                    id: rid,
                    type: 'user_drawn',
                    label: 'Пользовательский',
                    page: r.page,
                    isUser: true
                });
            }
        });
        
        // Qdrant-регионы (только выделенные)
        this.selectedQdrantRegions.forEach(r => {
            if (this.selectedIds.has(String(r.id))) {
                items.push({
                    id: String(r.id),
                    type: r.type,
                    label: this.regionDrawer.typeColors[r.type]?.label || 'Прочее',
                    page: r.page,
                    isUser: false
                });
            }
        });
        
        // Очищаем невыделенные из метаданных Qdrant
        this.selectedQdrantRegions = this.selectedQdrantRegions.filter(
            r => this.selectedIds.has(String(r.id))
        );
        
        const total = this.selectedIds.size;
        
        // Обновляем UI
        document.getElementById('selectedRegionsCount').textContent = total;
        document.getElementById('saveAnnotationBtn').disabled = total === 0 || !this.currentQuestion;
        document.getElementById('clearSelectionBtn').disabled = total === 0 && this.userRegions.length === 0;
        
        this.renderSelectedList(items);
    }

    /**
     * Отрисовывает список выделенных регионов в боковой панели.
     * 
     * @param {Array<{id: string, type: string, label: string, page: number, isUser: boolean}>} items - Элементы для отображения
     * @private
     */
    renderSelectedList(items) {
        const container = document.getElementById('selectedRegionsList');
        const itemsContainer = document.getElementById('selectedRegionsItems');
        
        if (items.length === 0) {
            container.classList.add('hidden');
            return;
        }
        
        container.classList.remove('hidden');
        items.sort((a, b) => a.page - b.page);
        
        itemsContainer.innerHTML = items.map((item, i) => `
            <div class="selected-region-item ${item.isUser ? 'user-drawn' : ''}">
                <span class="region-number">${i + 1}</span>
                <span class="region-type-badge" 
                      style="background:${this.getTypeBg(item.type)};color:${this.getTypeColor(item.type)}">
                    ${item.label}
                </span>
                <span class="region-page">стр. ${item.page}</span>
                ${item.isUser ? 
                    `<button class="btn-icon-small" 
                             onclick="window.app.removeUserRegion('${item.id}')" 
                             title="Удалить">×</button>` 
                    : ''}
            </div>
        `).join('');
    }

    /**
     * Возвращает цвет обводки для типа региона.
     * @param {string} type - Тип региона
     * @returns {string} CSS-цвет
     */
    getTypeColor(type) {
        const c = this.regionDrawer.typeColors[type];
        return c ? c.stroke : '#888';
    }

    /**
     * Возвращает цвет фона для типа региона.
     * @param {string} type - Тип региона
     * @returns {string} CSS-цвет
     */
    getTypeBg(type) {
        const c = this.regionDrawer.typeColors[type];
        return c ? c.fill : 'rgba(128,128,128,0.1)';
    }

    /**
     * Удаляет пользовательский регион по ID.
     * Обновляет все связанные структуры данных и перерисовывает UI.
     * 
     * @param {string} id - Идентификатор региона
     */
    removeUserRegion(id) {
        const rid = String(id);
        
        this.regionDrawer.removeUserRegion(rid);
        this.userRegions = this.userRegions.filter(r => String(r.id) !== rid);
        this.selectedIds.delete(rid);
        this.selectedQdrantRegions = this.selectedQdrantRegions.filter(
            r => String(r.id) !== rid
        );
        
        this.updateSelectionUI();
    }

    /**
     * Очищает текущее выделение без показа уведомления.
     * Используется при смене вопроса или документа.
     */
    clearCurrentSelectionSilent() {
        this.selectedIds.clear();
        this.userRegions = [];
        this.selectedQdrantRegions = [];
        this.regionDrawer.setSelectedIds([]);
        this.regionDrawer.userDrawnRegions = [];
        this.regionDrawer.redraw();
        this.updateSelectionUI();
    }

    /**
     * Очищает текущее выделение с уведомлением пользователя.
     */
    clearCurrentSelection() {
        this.clearCurrentSelectionSilent();
        this.showToast('Выбор очищен', 'info');
    }

    // ===========================================================================
    // Загрузка регионов страницы
    // ===========================================================================

    /**
     * Загружает и отображает регионы для конкретной страницы.
     * Запрашивает Qdrant-регионы через API и объединяет с пользовательскими.
     * 
     * @async
     * @param {number} page - Номер страницы
     */
    async loadPageRegions(page) {
        if (!this.currentDocument) return;
        
        try {
            const data = await api.getPageRegions(this.currentDocument.doc_id, page);
            
            this.syncCanvasSizes();
            this.regionDrawer.clearAll();
            
            // Загружаем Qdrant-регионы
            if (data.qdrant_regions) {
                this.regionDrawer.loadQdrantRegions(data.qdrant_regions);
            }
            
            // Загружаем пользовательские регионы для этой страницы
            const userOnPage = this.userRegions.filter(r => r.page === page);
            this.regionDrawer.loadUserRegions(userOnPage);
            
            // Восстанавливаем выделение
            this.regionDrawer.setSelectedIds([...this.selectedIds]);
            
            this.updateSelectionUI();
        } catch (e) {
            console.error('[App] Ошибка загрузки регионов страницы:', e);
        }
    }

    // ===========================================================================
    // Сохранение разметки
    // ===========================================================================

    /**
     * Сохраняет выделенные регионы для текущего вопроса.
     * Собирает пользовательские и Qdrant-регионы, отправляет на сервер.
     * Использует getAllRegions для получения данных о Qdrant-регионах одним запросом.
     * 
     * @async
     */
    async saveAnnotations() {
        if (!this.currentDocument || !this.currentQuestion) {
            this.showToast('Выберите вопрос', 'error');
            return;
        }

        const regionsToSave = [];
        
        // Собираем пользовательские регионы (только выделенные)
        this.userRegions.forEach(r => {
            if (this.selectedIds.has(String(r.id))) {
                regionsToSave.push({
                    region_id: String(r.id),
                    bbox: r.bbox,
                    page: r.page,
                    element_type: 'user_drawn',
                    source: 'manual'
                });
            }
        });
        
        // Собираем Qdrant-регионы (только выделенные)
        const qdrantIdsToSave = [...this.selectedIds].filter(
            id => !this.userRegions.find(r => String(r.id) === String(id))
        );
        
        if (qdrantIdsToSave.length > 0) {
            try {
                // Получаем все регионы документа одним запросом
                const allData = await api.getAllRegions(this.currentDocument.doc_id);
                
                // Ищем нужные регионы по region_id во всех страницах
                for (const [pageStr, regions] of Object.entries(allData.regions_by_page || {})) {
                    const page = parseInt(pageStr, 10);
                    
                    for (const region of regions) {
                        const rid = String(region.region_id || region.id);
                        
                        if (qdrantIdsToSave.includes(rid)) {
                            regionsToSave.push({
                                region_id: rid,
                                bbox: region.bbox,
                                page: page,
                                element_type: region.element_type,
                                source: 'qdrant'
                            });
                            
                            // Обновляем метаданные (страница могла определиться только сейчас)
                            const existing = this.selectedQdrantRegions.find(sr => String(sr.id) === rid);
                            if (existing) {
                                existing.page = page;
                                existing.type = region.element_type;
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('[App] Ошибка получения Qdrant-регионов:', e);
            }
        }

        if (regionsToSave.length === 0) {
            this.showToast('Нет выбранных регионов', 'error');
            return;
        }

        try {
            await api.saveRegions(
                this.currentDocument.doc_id, 
                this.currentQuestion.question, 
                regionsToSave
            );
            
            // Обновляем состояние вопроса
            this.currentQuestion.has_annotations = true;
            this.currentQuestion.evidence_regions = regionsToSave;
            
            // Обновляем UI
            this.renderQuestionsList(this.allSamples);
            this.renderQuestionDetail(this.currentQuestion);
            this.updateCurrentQuestionDisplay(this.currentQuestion);
            
            this.showToast(`Сохранено ${regionsToSave.length} регионов`, 'success');
        } catch (e) {
            this.showToast('Ошибка сохранения: ' + e.message, 'error');
        }
    }

    // ===========================================================================
    // Выбор вопроса
    // ===========================================================================

    /**
     * Выбирает вопрос и загружает связанную с ним разметку.
     * Восстанавливает выделение регионов, если вопрос уже был размечен.
     * 
     * @param {Object} sample - Объект вопроса из датасета
     * @param {string} sample.question - Текст вопроса
     * @param {boolean} sample.has_annotations - Есть ли сохранённая разметка
     * @param {Array} [sample.evidence_regions] - Сохранённые регионы
     */
    selectQuestion(sample) {
        this.currentQuestion = sample;
        
        // Сбрасываем текущее выделение
        this.selectedIds = new Set();
        this.userRegions = [];
        this.selectedQdrantRegions = [];
        
        // Восстанавливаем разметку, если она есть
        if (sample.has_annotations && sample.evidence_regions) {
            sample.evidence_regions.forEach(r => {
                const rid = String(r.region_id);
                
                if (r.source === 'manual' || r.element_type === 'user_drawn') {
                    // Пользовательский регион
                    this.userRegions.push({
                        id: rid,
                        bbox: r.bbox,
                        page: r.page
                    });
                    this.selectedIds.add(rid);
                } else {
                    // Qdrant-регион
                    this.selectedIds.add(rid);
                    this.selectedQdrantRegions.push({
                        id: rid,
                        type: r.element_type || 'unknown',
                        page: r.page
                    });
                }
            });
        }
        
        this.updateSelectionUI();
        
        // Загружаем пользовательские регионы для текущей страницы
        const currentPage = this.pdfViewer.currentPage;
        const userOnPage = this.userRegions.filter(r => r.page === currentPage);
        this.regionDrawer.loadUserRegions(userOnPage);
        
        // Загружаем все регионы для текущей страницы
        this.loadPageRegions(currentPage);
        
        // Подсвечиваем активный вопрос в списке
        document.querySelectorAll('.question-card').forEach(c => {
            const idx = parseInt(c.dataset.index, 10);
            c.classList.toggle('active', this.allSamples[idx]?.question === sample.question);
        });
        
        this.renderQuestionDetail(sample);
        this.updateCurrentQuestionDisplay(sample);
    }

    // ===========================================================================
    // Загрузка документов
    // ===========================================================================

    /**
     * Проверяет соединение с сервером через health-check.
     * @async
     */
    async checkConnection() {
        try {
            await api.healthCheck();
            this.setConnectionStatus('connected', 'Подключено');
        } catch {
            this.setConnectionStatus('error', 'Ошибка подключения');
        }
    }

    /**
     * Загружает список документов с сервера и отрисовывает таблицу.
     * @async
     */
    async loadDocumentsList() {
        const grid = document.getElementById('documentsGrid');
        grid.innerHTML = `<div class="documents-empty loading-state">
            <div class="loading-spinner"></div>
            <p>Загрузка списка...</p>
        </div>`;
        
        try {
            const data = await api.getDocuments();
            this.allDocuments = data.documents;
            this.renderDocumentsGrid(this.allDocuments);
            document.getElementById('documentsCount').textContent = 
                `${this.allDocuments.length} документов`;
        } catch (e) {
            grid.innerHTML = `<div class="documents-empty error-state">
                <div class="empty-icon"></div>
                <p>Ошибка загрузки</p>
                <button class="btn btn-small btn-primary" onclick="window.app.loadDocumentsList()">
                    Повторить
                </button>
            </div>`;
            this.showToast('Ошибка загрузки списка', 'error');
        }
    }

    /**
     * Загружает данные документа: PDF, вопросы.
     * 
     * @async
     * @param {string} docId - Идентификатор документа
     */
    async loadDocumentData(docId) {
        // Показываем индикатор загрузки в списке вопросов
        document.getElementById('questionsList').innerHTML = 
            `<div class="questions-empty loading-state">
                <div class="loading-spinner"></div>
                <p>Загрузка вопросов...</p>
            </div>`;
        
        this.switchTab('questions');
        
        try {
            // Загружаем информацию о документе и PDF параллельно
            const [docInfo, pdfBlob] = await Promise.all([
                api.getDocumentInfo(docId),
                api.getPDF(docId)
            ]);
            
            // Сбрасываем состояние
            this.currentQuestion = null;
            this.clearCurrentSelectionSilent();
            
            // Сохраняем метаданные документа
            this.currentDocument = {
                doc_id: docId,
                file_hash: docInfo.file_hash,
                evidence_pages: docInfo.evidence_pages
            };
            
            // Загружаем PDF в просмотрщик
            await this.pdfViewer.loadPDFFromBlob(pdfBlob);
            
            // Обновляем UI
            this.updateDocumentInfo(docInfo);
            this.renderQuestionsList(docInfo.samples);
            this.updateCurrentQuestionDisplay(null);
            this.renderDocumentsGrid(this.allDocuments);
            
        } catch (e) {
            document.getElementById('questionsList').innerHTML = 
                `<div class="questions-empty error-state">
                    <div class="empty-icon">️</div>
                    <p>Ошибка загрузки</p>
                    <p style="font-size:12px;color:var(--text-light)">${e.message}</p>
                </div>`;
            this.showToast('Ошибка загрузки документа: ' + e.message, 'error');
        }
    }

    // ===========================================================================
    // Таблица документов
    // ===========================================================================

    /**
     * Отрисовывает таблицу документов с сортировкой и фильтрацией.
     * 
     * @param {Array<Object>} documents - Массив документов
     */
    renderDocumentsGrid(documents) {
        const grid = document.getElementById('documentsGrid');
        
        if (documents.length === 0) {
            grid.innerHTML = `<div class="documents-empty">
                <div class="empty-icon"></div>
                <p>Документы не найдены</p>
            </div>`;
            return;
        }
        
        grid.innerHTML = `
            <table class="documents-table">
                <thead>
                    <tr>
                        <th class="sortable" data-sort="name">Документ <span class="sort-arrow"></span></th>
                        <th class="sortable" data-sort="questions"> Вопросов <span class="sort-arrow"></span></th>
                        <th class="sortable" data-sort="qdrant_regions"> Регионов Qdrant <span class="sort-arrow"></span></th>
                        <th class="sortable" data-sort="annotated">✓ Размечено <span class="sort-arrow"></span></th>
                        <th>PDF</th>
                    </tr>
                </thead>
                <tbody>
                    ${documents.map(doc => {
                        const annotated = doc.stats?.annotated_questions || 0;
                        const total = doc.stats?.total_questions || 0;
                        const qr = doc.stats?.qdrant_regions || 0;
                        const isActive = this.currentDocument?.doc_id === doc.doc_id;
                        
                        return `
                            <tr class="doc-row ${isActive ? 'active' : ''} ${!doc.pdf_available ? 'unavailable' : ''}"
                                data-doc-id="${this.escapeHtml(doc.doc_id)}">
                                <td class="doc-name">${this.escapeHtml(doc.doc_id)}</td>
                                <td>${total}</td>
                                <td>${qr}</td>
                                <td>
                                    <span class="annotated-badge ${annotated > 0 ? 'has-annotations' : ''}">
                                        ${annotated}/${total}
                                    </span>
                                </td>
                                <td>
                                    <span class="status-badge ${doc.pdf_available ? 'available' : 'unavailable'}">
                                        ${doc.pdf_available ? '✓ Доступен' : '✗ Отсутствует'}
                                    </span>
                                </td>
                            </tr>`;
                    }).join('')}
                </tbody>
            </table>`;
        
        // Обработчики клика по строке документа
        grid.querySelectorAll('.doc-row').forEach(row => {
            row.addEventListener('click', async () => {
                const doc = this.allDocuments.find(d => d.doc_id === row.dataset.docId);
                if (!doc) return;
                
                if (!doc.pdf_available) {
                    this.showToast('PDF отсутствует', 'error');
                    return;
                }
                
                // Подсвечиваем выбранную строку
                grid.querySelectorAll('.doc-row').forEach(r => r.classList.remove('active'));
                row.classList.add('active');
                
                await this.loadDocumentData(doc.doc_id);
            });
        });
        
        // Обработчики сортировки
        grid.querySelectorAll('.sortable').forEach(th => {
            th.addEventListener('click', () => this.sortDocuments(th.dataset.sort, th));
        });
    }

    /**
     * Сортирует документы по выбранному полю.
     * 
     * @param {string} key - Ключ сортировки ('name', 'questions', 'qdrant_regions', 'annotated')
     * @param {HTMLElement} th - Заголовок таблицы, по которому кликнули
     */
    sortDocuments(key, th) {
        const sorted = [...this.allDocuments].sort((a, b) => {
            switch (key) {
                case 'name':
                    return a.doc_id.localeCompare(b.doc_id);
                case 'questions':
                    return (b.stats?.total_questions || 0) - (a.stats?.total_questions || 0);
                case 'qdrant_regions':
                    return (b.stats?.qdrant_regions || 0) - (a.stats?.qdrant_regions || 0);
                case 'annotated':
                    return (b.stats?.annotated_questions || 0) - (a.stats?.annotated_questions || 0);
                default:
                    return 0;
            }
        });
        
        // Обновляем индикатор сортировки
        document.querySelectorAll('.sortable .sort-arrow').forEach(a => a.textContent = '');
        th.querySelector('.sort-arrow').textContent = ' ▼';
        
        this.renderDocumentsGrid(sorted);
    }

    /**
     * Фильтрует документы по поисковому запросу.
     * 
     * @param {string} query - Поисковый запрос
     */
    filterDocuments(query) {
        const filtered = this.allDocuments.filter(d => 
            d.doc_id.toLowerCase().includes(query.toLowerCase())
        );
        this.renderDocumentsGrid(filtered);
    }

    // ===========================================================================
    // Список вопросов
    // ===========================================================================

    /**
     * Отрисовывает список вопросов документа.
     * 
     * @param {Array<Object>} samples - Массив вопросов
     */
    renderQuestionsList(samples) {
        this.allSamples = samples;
        const container = document.getElementById('questionsList');
        
        if (samples.length === 0) {
            container.innerHTML = `<div class="questions-empty"><p>Выберите документ</p></div>`;
            return;
        }
        
        container.innerHTML = samples.map((s, i) => `
            <div class="question-card ${this.currentQuestion?.question === s.question ? 'active' : ''}" 
                 data-index="${i}">
                <div class="question-card-text">${s.question}</div>
                <div class="question-card-meta">
                    <span>Стр: ${s.evidence_pages}</span>
                    <span>Источник: ${s.evidence_sources}</span>
                    <span class="${s.has_annotations ? 'annotated' : 'not-annotated'}">
                        ${s.has_annotations ? '✓ Размечен' : '○ Без разметки'}
                    </span>
                </div>
            </div>
        `).join('');
        
        // Обработчики клика по вопросу
        container.querySelectorAll('.question-card').forEach(card => {
            card.addEventListener('click', () => {
                const index = parseInt(card.dataset.index, 10);
                this.selectQuestion(this.allSamples[index]);
            });
        });
    }

    /**
     * Отрисовывает детальную информацию о вопросе в боковой панели.
     * 
     * @param {Object} sample - Объект вопроса
     */
    renderQuestionDetail(sample) {
        const container = document.getElementById('questionDetail');
        const regions = sample.evidence_regions || [];
        
        const regionsHtml = regions.length > 0 
            ? `<h4>Регионы (${regions.length})</h4>
               <div class="regions-preview">
                   ${regions.map(r => `
                       <div class="region-item">
                           <span class="region-type-label">
                               ${r.element_type === 'user_drawn' ? 'Пользовательский' : 'Qdrant'}
                           </span>
                           Стр. ${r.page}: [${(r.bbox || []).map(v => Math.round(v)).join(', ')}]
                       </div>
                   `).join('')}
               </div>`
            : '<p style="color:var(--text-light);margin-top:8px">Нет сохранённых регионов</p>';
        
        container.innerHTML = `
            <div class="question-detail-content">
                <h3>${sample.question}</h3>
                <div class="answer">${sample.answer}</div>
                <div class="meta-row">
                    <span><strong>Страницы:</strong> ${sample.evidence_pages}</span>
                    <span><strong>Источники:</strong> ${sample.evidence_sources}</span>
                    <span><strong>Статус:</strong> ${sample.has_annotations ? '✓ Размечен' : '○ Не размечен'}</span>
                </div>
                ${regionsHtml}
                <div class="detail-actions">
                    <button class="btn btn-primary" id="goToViewerBtn"> Перейти к документу</button>
                    ${sample.has_annotations ? 
                        `<button class="btn btn-danger" id="deleteAnnotationBtn"> Удалить разметку</button>` 
                        : ''}
                </div>
            </div>
        `;
        
        // Кнопка перехода к просмотрщику
        const goBtn = container.querySelector('#goToViewerBtn');
        if (goBtn) {
            goBtn.addEventListener('click', () => {
                this.switchTab('viewer');
                setTimeout(async () => {
                    this.syncCanvasSizes();
                    await this.loadPageRegions(this.pdfViewer.currentPage);
                    this.updatePageControls(this.pdfViewer.currentPage);
                    this.updateZoomLevel();
                }, 300);
            });
        }
        
        // Кнопка удаления разметки
        const delBtn = container.querySelector('#deleteAnnotationBtn');
        if (delBtn) {
            delBtn.addEventListener('click', () => {
                this.deleteAnnotation(sample);
            });
        }
    }

    /**
     * Удаляет сохранённую разметку для вопроса.
     * 
     * @async
     * @param {Object} sample - Объект вопроса
     */
    async deleteAnnotation(sample) {
        if (!this.currentDocument) return;
        
        const confirmed = confirm(
            `Удалить разметку для вопроса «${sample.question.substring(0, 80)}...»?`
        );
        if (!confirmed) return;
        
        try {
            await api.deleteRegions(this.currentDocument.doc_id, sample.question);
            
            // Обновляем состояние вопроса
            sample.has_annotations = false;
            sample.evidence_regions = [];
            
            // Если удалённый вопрос был текущим — сбрасываем выделение
            if (this.currentQuestion?.question === sample.question) {
                this.clearCurrentSelectionSilent();
            }
            
            // Обновляем UI
            this.renderQuestionsList(this.allSamples);
            this.renderQuestionDetail(sample);
            
            this.showToast('Разметка удалена', 'success');
        } catch (e) {
            this.showToast('Ошибка удаления: ' + e.message, 'error');
        }
    }

    /**
     * Фильтрует вопросы по поисковому запросу (по тексту вопроса и ответа).
     * 
     * @param {string} query - Поисковый запрос
     */
    filterQuestions(query) {
        if (!this.allSamples.length) return;
        
        const filtered = this.allSamples.filter(s => 
            s.question.toLowerCase().includes(query.toLowerCase()) || 
            s.answer.toLowerCase().includes(query.toLowerCase())
        );
        this.renderQuestionsList(filtered);
    }

    /**
     * Переключает текущий вопрос на соседний по списку.
     * 
     * @param {number} dir - Направление: -1 (предыдущий) или +1 (следующий)
     */
    navigateQuestion(dir) {
        if (!this.allSamples.length || !this.currentQuestion) return;
        
        const currentIndex = this.allSamples.findIndex(
            s => s.question === this.currentQuestion.question
        );
        const newIndex = currentIndex + dir;
        
        if (newIndex >= 0 && newIndex < this.allSamples.length) {
            this.selectQuestion(this.allSamples[newIndex]);
        }
    }

    // ===========================================================================
    // UI Helpers
    // ===========================================================================

    /**
     * Обновляет информационную панель документа.
     * 
     * @param {Object} docInfo - Информация о документе
     */
    updateDocumentInfo(docInfo) {
        document.getElementById('docFileName').textContent = docInfo.doc_id;
        document.getElementById('docPages').textContent = this.pdfViewer.totalPages;
        document.getElementById('docQuestions').textContent = docInfo.samples.length;
    }

    /**
     * Обновляет отображение текущего вопроса в панели просмотрщика.
     * 
     * @param {Object|null} sample - Текущий вопрос или null
     */
    updateCurrentQuestionDisplay(sample) {
        const container = document.getElementById('currentQuestion');
        const prevBtn = document.getElementById('prevQuestionBtn');
        const nextBtn = document.getElementById('nextQuestionBtn');
        
        if (sample) {
            container.innerHTML = `
                <div style="font-weight:500;margin-bottom:4px">${sample.question}</div>
                <div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px">
                    Ответ: ${sample.answer}
                </div>
                <div style="font-size:11px;color:var(--text-secondary)">
                    Страницы: ${sample.evidence_pages}
                </div>`;
            prevBtn.disabled = false;
            nextBtn.disabled = false;
        } else {
            container.innerHTML = '<p class="no-question">Вопрос не выбран</p>';
            prevBtn.disabled = true;
            nextBtn.disabled = true;
        }
    }

    /**
     * Обновляет контролы навигации по страницам.
     * 
     * @param {number} page - Текущая страница
     */
    updatePageControls(page) {
        document.getElementById('pageInput').value = page;
        document.getElementById('totalPages').textContent = this.pdfViewer.totalPages;
    }

    /** Обновляет отображение уровня зума. */
    updateZoomLevel() {
        document.getElementById('zoomLevel').textContent = 
            Math.round(this.pdfViewer.scale * 100) + '%';
    }

    /** Переключает режим рисования и обновляет кнопку. */
    toggleDrawMode() {
        this.regionDrawer.setDrawMode(!this.regionDrawer.drawMode);
        document.getElementById('drawModeBtn').classList.toggle('active', this.regionDrawer.drawMode);
    }

    /** Обновляет состояние кнопки режима рисования. */
    updateDrawModeButton() {
        document.getElementById('drawModeBtn').classList.toggle('active', this.regionDrawer.drawMode);
    }

    /**
     * Синхронизирует размеры канваса отрисовщика регионов с канвасом PDF.
     * Вызывается после изменения масштаба или размера окна.
     */
    syncCanvasSizes() {
        const pdfCanvas = document.getElementById('pdfCanvas');
        if (pdfCanvas.width > 0) {
            this.regionDrawer.setSize(pdfCanvas.width, pdfCanvas.height);
        }
    }

    /**
     * Показывает или скрывает индикатор загрузки.
     * 
     * @param {boolean} show - Показать индикатор
     */
    toggleLoading(show) {
        document.getElementById('loadingOverlay').classList.toggle('hidden', !show);
    }

    /**
     * Обновляет индикатор статуса соединения.
     * 
     * @param {string} status - Статус ('connected', 'error')
     * @param {string} text - Текст статуса
     */
    setConnectionStatus(status, text) {
        const dot = document.querySelector('.status-dot');
        const label = document.querySelector('.status-text');
        if (dot) dot.className = 'status-dot ' + status;
        if (label) label.textContent = text;
    }

    /** Отрисовывает легенду типов регионов. */
    renderLegend() {
        document.getElementById('legendList').innerHTML = this.regionDrawer.getLegend()
            .map(item => `
                <div class="legend-item">
                    <span class="legend-color" style="background:${item.color}"></span>
                    <span class="legend-label">${item.label}</span>
                </div>
            `).join('');
    }

    /**
     * Экранирует HTML-спецсимволы в тексте для безопасной вставки в DOM.
     * 
     * @param {string} text - Исходный текст
     * @returns {string} Экранированный текст
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Показывает всплывающее уведомление.
     * Автоматически скрывается через 3 секунды.
     * 
     * @param {string} message - Текст уведомления
     * @param {'info'|'success'|'error'} [type='info'] - Тип уведомления
     */
    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        
        container.appendChild(toast);
        
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

// ===========================================================================
// Запуск приложения при загрузке страницы
// ===========================================================================

window.addEventListener('load', () => {
    if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        window.app = new App();
    }
});