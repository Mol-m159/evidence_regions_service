# PDF Evidence Annotation Tool

Инструмент для разметки evidence-регионов в PDF-документах. Позволяет просматривать документы, выделять регионы (автоматически извлечённые из Qdrant или нарисованные вручную), связывать их с вопросами и сохранять разметку.

## Возможности

- Просмотр PDF-документов с навигацией по страницам и масштабированием
- Отображение предварительно извлечённых регионов из векторной БД Qdrant
- Ручное рисование регионов на страницах
- Привязка регионов к вопросам из датасета
- Сохранение и удаление пользовательской разметки
- Веб-интерфейс с тремя вкладками: Документы, Вопросы, Просмотр
- API для интеграции с другими сервисами

## Технологический стек

**Бэкенд:**
- Node.js + Express
- Qdrant (векторная БД для хранения регионов)
- Файловое хранилище (JSON)

**Фронтенд:**
- Vanilla JavaScript (ES6+)
- PDF.js для рендеринга документов
- Canvas API для отрисовки регионов

## Структура проекта

```
project/  
├── config.js                    # Конфигурация приложения  
├── index.js                     # Главный файл сервера Express  
├── routes/  
│   ├── documents.js             # API для работы с документами  
│   └── regions.js               # API для работы с регионами и разметкой  
├── services/  
│   ├── samplesService.js        # Сервис работы с датасетом samples.json  
│   └── qdrantService.js         # Сервис взаимодействия с Qdrant  
├── public/  
│   ├── index.html               # Веб-интерфейс  
│   ├── css/  
│   │   └── style.css            # Стили  
│   └── js/  
│       ├── api.js               # API-клиент  
│       ├── pdfViewer.js         # Компонент просмотра PDF  
│       ├── regionDrawer.js      # Компонент отрисовки регионов  
│       └── app.js               # Главный класс приложения  
└── data/  
    ├── samples.json             # Датасет с вопросами и ответами  
    └── documents/               # PDF-документы  
```

## Установка и запуск

### Предварительные требования

- Node.js 16+
- Доступ к Qdrant с предварительно загруженной коллекцией документов
- PDF-документы в директории `data/documents/`
- Датасет `data/samples.json`

### Установка зависимостей

```bash
npm install
```

### Конфигурация

Настройки задаются через переменные окружения (см. `config.js`):

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `PORT` | `3000` | Порт HTTP-сервера |
| `QDRANT_URL` | `http://localhost:6333` | URL Qdrant сервера |
| `QDRANT_COLLECTION` | `documents` | Название коллекции Qdrant |
| `SAMPLES_JSON_PATH` | `./data/samples.json` | Путь к датасету |
| `DOCUMENTS_DIR` | `./data/documents` | Директория с PDF |
| `HOST_ADDRESS` | автоопределение | Адрес хоста для Docker |
| `DOCKER_CONTAINER` | — | Флаг запуска в Docker |

### Запуск

```bash
# Обычный запуск
npm start

# Режим разработки
NODE_ENV=development npm start
```

Сервер будет доступен на `http://localhost:3000`.

## API

### Системные эндпоинты

#### `GET /api/health`
Проверка работоспособности сервера.

**Ответ:**
```json
{
  "status": "ok",
  "timestamp": "2026-05-20T10:30:00.000Z",
  "uptime": 3600,
  "services": {
    "samples_loaded": true,
    "evidence_loaded": true
  }
}
```

#### `GET /api/config`
Публичная конфигурация для фронтенда.

**Ответ:**
```json
{
  "qdrant_url": "http://localhost:6333",
  "collection_name": "documents",
  "max_upload_size": 104857600,
  "version": "1.0.0"
}
```

### Документы

#### `GET /api/documents`
Список всех документов с информацией о разметке.

**Ответ:**
```json
{
  "documents": [
    {
      "doc_id": "document.pdf",
      "pdf_available": true,
      "stats": {
        "total_questions": 5,
        "qdrant_regions": 42,
        "annotated_questions": 3,
        "annotated_regions": 12,
        "last_annotated": "2026-05-20T10:30:00.000Z"
      }
    }
  ]
}
```

#### `GET /api/documents/:docId`
Детальная информация о документе.

#### `POST /api/documents/upload`
Загрузка нового PDF-файла (мультипарт-форма).

### Регионы и разметка

#### `GET /api/regions/:docId/all`
Все регионы документа со всех страниц.

#### `GET /api/regions/:docId/page/:pageNumber`
Регионы конкретной страницы (Qdrant + пользовательские).

#### `POST /api/regions/:docId/save`
Сохранить разметку для вопроса.

**Тело запроса:**
```json
{
  "question": "What is the main finding?",
  "regions": [
    { "page": 5, "bbox": [100, 200, 300, 400] },
    { "page": 5, "bbox": [400, 200, 600, 400] }
  ]
}
```

#### `DELETE /api/regions/:docId/save`
Удалить разметку для вопроса.

#### `GET /api/regions/:docId/pdf`
Получить PDF-файл для просмотра.

#### `GET /api/regions/:docId/stats`
Статистика разметки документа.

## Формат данных

### samples.json

```json
[
  {
    "doc_id": "document.pdf",
    "question": "What is shown in Figure 1?",
    "answer": "The diagram shows...",
    "evidence_pages": "[1, 3]",
    "evidence_sources": "[\"Figure 1\"]",
    "evidence_regions": [
      {
        "region_id": "abc123",
        "bbox": [100, 200, 300, 400],
        "page": 1,
        "element_type": "text",
        "source": "qdrant"
      }
    ],
    "annotation_updated_at": "2026-05-20T10:30:00.000Z"
  }
]
```

### Коллекция Qdrant

Каждая точка в коллекции должна содержать payload:

```json
{
  "file_hash": "a1b2c3d4...",
  "original_element": {
    "page_idx": 0,
    "bbox": [100, 200, 300, 400],
    "text": "Region text content",
    "type": "text"
  },
  "element_type": "text",
  "region_id": "unique_region_id"
}
```

## Горячие клавиши

| Клавиша | Действие |
|---------|----------|
| `←` `→` | Предыдущая/следующая страница |
| `R` | Переключить режим рисования |
| `Delete` / `Backspace` | Удалить последний пользовательский регион |
| `Esc` | Выйти из режима рисования |
| `Ctrl+S` | Сохранить разметку |

## Использование веб-интерфейса

### Вкладка «Документы»
- Просмотр списка документов с сортировкой и поиском
- Клик по строке — загрузка документа и переход к вопросам

### Вкладка «Вопросы»
- Список вопросов для выбранного документа
- Клик по вопросу — загрузка его разметки
- Кнопка «Перейти к документу» для просмотра PDF

### Вкладка «Просмотр»
- PDF-документ с наложенными регионами
- Панель инструментов: навигация, зум, рисование
- Боковая панель: информация о документе, текущий вопрос, выделенные регионы, легенда
- Сохранение разметки для выбранного вопроса

## Разработка

### Добавление новых типов регионов

В `regionDrawer.js` добавить запись в `typeColors`:

```javascript
typeColors: {
  new_type: { 
    fill: 'rgba(...)', 
    stroke: '#...', 
    label: 'Название' 
  }
}
```

### Добавление новых API-эндпоинтов

1. Создать обработчик в соответствующем файле `routes/`
2. При необходимости добавить методы в сервисы
3. Добавить метод в `api.js` на фронтенде
4. Обновить список `available_endpoints` в обработчике 404

## Docker


```bash
docker build -t pdf-annotation-tool .
docker run -p 3000:3000 -e QDRANT_URL=http://host.docker.internal:6333 pdf-annotation-tool
```

