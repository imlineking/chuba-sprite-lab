// Conservative per-image choice for the explicit "no white/grey artwork" cleanup.
// The automatic route only accepts a fragmented pale residue pattern. A single
// painted white feature or an uncertain image keeps the protected route.
export function measureLightArtworkRgba(data, { width, height, channels }) {
  if (channels !== 4 || data.length !== width * height * 4) throw new Error("Для проверки светлых деталей нужен RGBA-кадр.");
  const count = width * height;
  const pale = new Uint8Array(count);
  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  let visible = 0, palePixels = 0, largest = 0, fragments = 0;
  for (let at = 0; at < count; at += 1) {
    const offset = at * 4;
    if (data[offset + 3] < 200) continue;
    visible += 1;
    const red = data[offset], green = data[offset + 1], blue = data[offset + 2];
    if (Math.min(red, green, blue) >= 170 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 55) {
      pale[at] = 1;
      palePixels += 1;
    }
  }
  for (let seed = 0; seed < count; seed += 1) {
    if (!pale[seed] || visited[seed]) continue;
    let head = 0, tail = 0;
    queue[tail++] = seed;
    visited[seed] = 1;
    while (head < tail) {
      const at = queue[head++], x = at % width, y = Math.floor(at / width);
      for (const next of [x > 0 ? at - 1 : -1, x + 1 < width ? at + 1 : -1,
        y > 0 ? at - width : -1, y + 1 < height ? at + width : -1]) {
        if (next < 0 || !pale[next] || visited[next]) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    if (tail >= 30) fragments += 1;
    largest = Math.max(largest, tail);
  }
  return { visible, palePixels, paleShare: visible ? palePixels / visible : 0,
    largestShare: visible ? largest / visible : 0, fragments };
}

export function chooseLightArtworkPolicy(measurements, request = "auto") {
  if (request === "none") return { policy: "none", confidence: "explicit", reason: "Пользователь указал, что белого и серого в рисунке нет." };
  if (request === "protect") return { policy: "protect", confidence: "explicit", reason: "Пользователь защитил светлые детали рисунка." };
  if (!measurements || measurements.edgeMeasurement !== "native" || !measurements.hasTransparency) {
    return { policy: "protect", confidence: "uncertain", reason: "Не хватает точных данных для безопасного удаления светлых деталей." };
  }
  if (measurements.lightLargestShare >= .003 || measurements.lightPaleShare >= .12) {
    return { policy: "protect", confidence: "high", reason: "Найдены крупные или многочисленные светлые части самого изображения." };
  }
  if (measurements.lightLargestShare > 0 && measurements.lightLargestShare < .002
    && measurements.lightPaleShare < .09 && measurements.lightFragments >= 50
    && measurements.transparentShare >= .15) {
    return { policy: "none", confidence: "medium", reason: "Светлые участки дробные и рассеяны по уже прозрачному изображению; похоже на остатки фона." };
  }
  return { policy: "protect", confidence: "uncertain", reason: "Не удалось надёжно отличить светлую деталь от остатка фона; сохраняем детали." };
}
