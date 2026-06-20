# SpeakEasy

Локальный MVP сервиса для тренировки публичных выступлений SpeakEasy

## Что нужно

- Python 3.12
- Доступ к локальным портам `8000` и `5500`
- Браузер Chrome, Яндекс или Edge для записи аудио/видео

Фронтенд не требует npm-сборки: это статические HTML/CSS/JS-файлы.

## Первый запуск бэкенда

Из корня проекта:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Если PowerShell не разрешает запуск `Activate.ps1`, можно запустить без активации окружения:

```powershell
cd backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

API будет доступен здесь:

```text
http://127.0.0.1:8000
```

Документация FastAPI:

```text
http://127.0.0.1:8000/docs
```

Проверка, что бэкенд жив:

```text
http://127.0.0.1:8000/api/health
```

## Запуск фронтенда

Во втором терминале из корня проекта:

```powershell
python -m http.server 5500
```

После этого открыть:

```text
http://127.0.0.1:5500/frontend/main.html
```

Важно: лучше использовать именно `127.0.0.1:5500`, потому что CORS и `FRONTEND_URL` настроены под этот адрес. `localhost:5500` тоже разрешен на бэке, но разрешения камеры/микрофона в браузере могут храниться отдельно для `localhost` и `127.0.0.1`.
