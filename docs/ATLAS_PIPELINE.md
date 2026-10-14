# Сборка атласа из папки картинок (scripts/atlas.mjs)

Отдельный от окна приложения, полностью автоматический конвейер. Код: `src/pipeline/`.

Конвейер: импорт (PNG, JPEG, BMP, GIF и WebP покадрово, TIFF, AVIF; папки рекурсивно, папка `not used` пропускается)
-> фон в прозрачность (`auto`: цвет по углам и заливка от краёв; `key`: цветовой ключ с допуском)
-> нарезка листов (`grid` по колонкам/строкам или размеру ячейки; `auto` по непрозрачным островам)
-> обрезка прозрачных полей -> группировка анимаций по имени (`walk_01`, `walk-2` -> `walk`), теги
-> дедупликация одинаковых кадров по хешу -> MaxRects (поворот, степень двойки, несколько страниц), padding, extrude
-> экспорт.

## Форматы

| формат | файлы |
|---|---|
| texturepacker-hash / texturepacker-array | `name.json` / `name.array.json` (на страницу) |
| phaser-hash / phaser-array | `name.phaser-hash.json` / `name.phaser-array.json`, `name.phaser-anims.json`, при нескольких страницах `name.phaser-multiatlas.json` |
| godot-spriteframes | `name.tres` (SpriteFrames с AtlasTexture) |
| godot-atlastexture | `name/<кадр>.tres` для каждого кадра |
| unity-meta | `name.png.meta` (Sprite Mode: Multiple, нарезка готова) |
| unity-json | `name.unity.json` (координаты Unity, для своего импортёра) |

Unity: `.meta` получает детерминированный GUID. Если текстура уже импортирована в проект и на неё есть ссылки, используйте `unity-json` или существующий экспорт приложения (`unity-slicer.cs`), чтобы не потерять ссылки.
Godot и Unity не поддерживают повёрнутые кадры, поэтому с ними `rotate` запрещён.

## Команды

```
npm run atlas -- --input sprites --output atlas --format phaser-hash,godot-spriteframes
npm run atlas -- presets/example.preset.json          # пакетная сборка нескольких атласов
npm run atlas:watch -- presets/example.preset.json    # пересборка при изменениях
node scripts/atlas.mjs init my.preset.json            # пресет с настройками по умолчанию
node scripts/atlas.mjs formats
```

Пути в пресете считаются от папки пресета. Коды выхода: 0 успех, 1 ошибка использования, 2 сбой сборки.

## Тесты

`test/pipeline-units.test.mjs`, `test/pipeline-exports.test.mjs` (round-trip всех экспортёров и golden-файл
`test/golden/pipeline-demo.json`). Обновить golden: `UPDATE_GOLDEN=1 node --test test/pipeline-exports.test.mjs`.
