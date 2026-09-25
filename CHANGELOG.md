# Changelog

## 1.3.3 — 2026

- Однотонный белый, чёрный, зелёный или синий фон в режиме «ИИ» теперь автоматически обрабатывается быстрым точным контуром без запуска нейросети на каждом кадре.
- Нейросетевое выделение ограничено двумя CPU-потоками, чтобы окно программы не зависало во время сложной обработки.
- Снижен объём кэша кадров и памяти Sharp при работе с длинными роликами.
- В строке прогресса различаются быстрая очистка фона и настоящее нейросетевое выделение.

## 1.3.0 — 2026

- Added fully local U²-Net subject segmentation through ONNX Runtime.
- Added an AI mask editor with erase/protect brushes, undo and per-frame or whole-series corrections.
- Bundled the compact verified model inside the single-file portable EXE.

## 1.2.1 — 2026

- Added batch processing for multiple videos with shared settings and automatic names.
- Added black-background removal with a protected contour.
- Added source samples, automatic recommendations, trim controls, live comparison, frame diagnostics, and safe export profiles.
- Added the authorship window and GitHub Release updater with SHA-256 verification.
- Added a single-file Windows x64 portable release.
