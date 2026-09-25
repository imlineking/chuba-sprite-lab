// Validation of a built atlas against the contract an engine actually reads. It runs
// on the manifest that was just produced, so a mismatch between the JSON and the pages
// is reported to the user instead of surfacing later as a broken sprite in the game.
//
// The hitbox is checked in cell coordinates on purpose: that is the space the build
// writes it in, and a hitbox that silently switched to atlas coordinates is exactly
// the kind of defect this inspector exists to catch.

function overlaps(left, right) {
  // The same rectangle is reused when one frame appears twice in the timeline.
  if (left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height) return false;
  return left.x < right.x + right.width && right.x < left.x + left.width
    && left.y < right.y + right.height && right.y < left.y + left.height;
}

// The blocking subset of an inspector report: what a strict build must refuse.
export function collectAtlasErrors(report) {
  return (Array.isArray(report?.atlasIssues) ? report.atlasIssues : []).filter((issue) => issue?.severity === "error");
}

export function inspectAtlas(manifest, { maxSize = 0 } = {}) {
  const issues = [];
  const frames = Array.isArray(manifest?.frames) ? manifest.frames : [];
  const pages = Array.isArray(manifest?.pages) ? manifest.pages : [];
  const tags = Array.isArray(manifest?.animations) ? manifest.animations : [];
  // An issue that points at a frame also carries the source index, so a caller can jump
  // to that frame without knowing how the manifest happens to order its entries.
  const add = (severity, code, message, extra = {}) => {
    const frameIndex = extra.frameIndex ?? null;
    issues.push({
      severity, code, message, ...extra,
      ...(frameIndex == null ? {} : { sourceFrameIndex: frames[frameIndex]?.sourceFrameIndex ?? null }),
    });
  };

  if (!frames.length) add("error", "no-frames", "В манифесте нет ни одного кадра.");
  if (!pages.length) add("error", "no-pages", "В манифесте нет ни одной страницы атласа.");

  const limit = Number(maxSize) || 0;
  const pageImages = new Map();
  pages.forEach((page, index) => {
    // A page that names no file, or two pages naming the same file, means the atlas and
    // the manifest disagree about which image holds which frame.
    if (typeof page?.image !== "string" || !page.image.trim()) {
      add("error", "page-image", `Страница ${index + 1} не ссылается на файл изображения.`, { page: index });
    } else if (pageImages.has(page.image)) {
      add("error", "duplicate-page-image", `Страницы ${pageImages.get(page.image) + 1} и ${index + 1} ссылаются на один файл «${page.image}».`, { page: index });
    } else {
      pageImages.set(page.image, index);
    }
    if (!(page?.width > 0) || !(page?.height > 0)) {
      add("error", "empty-page", `Страница ${index + 1} не имеет размера.`, { page: index });
    } else if (limit && (page.width > limit || page.height > limit)) {
      add("error", "page-over-limit", `Страница ${index + 1} — ${page.width}×${page.height} px, это больше лимита ${limit} px.`, { page: index });
    }
  });

  const nameAt = new Map();
  frames.forEach((frame, index) => {
    const label = frame?.name || `#${index + 1}`;
    const page = pages[frame?.page];
    if (!page) {
      add("error", "frame-page", `Кадр ${label} ссылается на несуществующую страницу.`, { frameIndex: index });
    } else if (!(frame.width > 0) || !(frame.height > 0)) {
      add("error", "frame-size", `Кадр ${label} не имеет размера.`, { frameIndex: index });
    } else if (frame.x < 0 || frame.y < 0 || frame.x + frame.width > page.width || frame.y + frame.height > page.height) {
      add("error", "frame-outside-page", `Кадр ${label} выходит за пределы страницы ${frame.page + 1}.`, { frameIndex: index });
    }

    const source = frame?.sourceSize;
    if (!source || !(source.w > 0) || !(source.h > 0)) {
      add("error", "frame-source-size", `Кадр ${label} не имеет исходного размера ячейки.`, { frameIndex: index });
    } else {
      const box = frame.spriteSourceSize;
      if (frame.trimmed) {
        if (!box || box.x < 0 || box.y < 0 || box.x + box.w > source.w || box.y + box.h > source.h) {
          add("error", "frame-trim-box", `Кадр ${label}: обрезанная область выходит за пределы ячейки ${source.w}×${source.h}.`, { frameIndex: index });
        }
      } else if (frame.width !== source.w || frame.height !== source.h) {
        add("warning", "frame-cell-mismatch", `Кадр ${label}: размер ${frame.width}×${frame.height} не совпадает с ячейкой ${source.w}×${source.h}.`, { frameIndex: index });
      }
      const hitbox = frame.hitbox;
      const pivot = frame.pivot || manifest?.pivot;
      if (!hitbox) {
        add("warning", "hitbox-missing", `Кадр ${label}: хитбокс не посчитан — движку не с чем сравнивать столкновения.`, { frameIndex: index });
      } else if (hitbox.x < 0 || hitbox.y < 0 || hitbox.width < 1 || hitbox.height < 1
        || hitbox.x + hitbox.width > source.w || hitbox.y + hitbox.height > source.h) {
        add("error", "hitbox-outside-cell", `Кадр ${label}: хитбокс (${frame.hitboxSpace || "cell"}) выходит за пределы ячейки ${source.w}×${source.h}.`, { frameIndex: index });
      } else if (pivot) {
        // A pivot that lands outside the silhouette means the character stands on empty
        // space. One pixel of slack: a ground pivot sits exactly on the bottom row of the
        // silhouette, which is the coordinate the hitbox ends at.
        const pivotX = pivot.x * source.w;
        const pivotY = pivot.y * source.h;
        if (pivotX < hitbox.x - 1 || pivotX > hitbox.x + hitbox.width + 1
          || pivotY < hitbox.y - 1 || pivotY > hitbox.y + hitbox.height + 1) {
          add("warning", "pivot-outside-hitbox", `Кадр ${label}: точка опоры вне хитбокса — персонаж может стоять на пустоте.`, { frameIndex: index });
        }
      }
    }

    if (!(Number(frame?.durationMs) > 0)) {
      add("error", "frame-duration", `Кадр ${label}: длительность должна быть больше нуля.`, { frameIndex: index });
    }
    if (frame?.name) {
      if (nameAt.has(frame.name)) {
        add("error", "duplicate-frame-name", `Имя кадра «${frame.name}» встречается дважды (кадры ${nameAt.get(frame.name) + 1} и ${index + 1}).`, { frameIndex: index });
      } else {
        nameAt.set(frame.name, index);
      }
    }
  });

  const pivot = manifest?.pivot;
  if (pivot && (pivot.x < 0 || pivot.x > 1 || pivot.y < 0 || pivot.y > 1)) {
    add("error", "pivot-range", `Точка опоры (${pivot.x}; ${pivot.y}) вне диапазона 0…1.`);
  }
  if (Number.isFinite(Number(manifest?.frameCount)) && Number(manifest.frameCount) !== frames.length) {
    add("error", "frame-count", `frameCount = ${manifest.frameCount}, а кадров в манифесте ${frames.length}.`);
  }

  tags.forEach((tag, index) => {
    const name = tag?.name || `#${index + 1}`;
    if (!Number.isInteger(tag?.from) || !Number.isInteger(tag?.to) || tag.from < 0 || tag.to < tag.from || tag.to >= frames.length) {
      add("error", "tag-range", `Анимация «${name}»: диапазон кадров ${tag?.from}…${tag?.to} некорректен.`);
      return;
    }
    const expected = tag.to - tag.from + 1;
    if (Number.isFinite(Number(tag.frameCount)) && Number(tag.frameCount) !== expected) {
      add("error", "tag-count", `Анимация «${name}»: frameCount = ${tag.frameCount}, а в диапазоне ${expected} кадр(ов).`);
    }
  });

  pages.forEach((_page, pageIndex) => {
    const rects = frames.filter((frame) => frame?.page === pageIndex);
    for (let left = 0; left < rects.length; left += 1) {
      for (let right = left + 1; right < rects.length; right += 1) {
        if (overlaps(rects[left], rects[right])) {
          add("error", "frame-overlap", `Кадры «${rects[left].name}» и «${rects[right].name}» перекрываются на странице ${pageIndex + 1}.`, { page: pageIndex, frameIndex: right });
        }
      }
    }
  });

  return {
    issues,
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    frames: frames.length,
    pages: pages.length,
    tags: tags.length,
  };
}
