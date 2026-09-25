function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function magentaScore(data, offset) {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  return Math.min(red, blue) - green;
}

export function cleanMagentaFringe(data, info, strength = 55) {
  const amount = clamp(Number(strength) || 0, 0, 100);
  if (amount <= 0) return data;
  const { width, height, channels } = info;
  const source = Buffer.from(data);
  const threshold = 68 - amount * 0.46;
  const blend = 0.42 + amount / 100 * 0.58;
  const edgeRadius = amount >= 70 ? 3 : 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * channels;
      if (source[offset + 3] < 18 || magentaScore(source, offset) < threshold) continue;
      let nearTransparent = false;
      for (let dy = -edgeRadius; dy <= edgeRadius && !nearTransparent; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) { nearTransparent = true; break; }
        for (let dx = -edgeRadius; dx <= edgeRadius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || source[(ny * width + nx) * channels + 3] < 18) { nearTransparent = true; break; }
        }
      }
      if (!nearTransparent) continue;

      let red = 0; let green = 0; let blue = 0; let weight = 0;
      for (let radius = 1; radius <= 5 && weight < 2; radius += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -radius; dx <= radius; dx += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const neighbour = (ny * width + nx) * channels;
            if (source[neighbour + 3] < 200 || magentaScore(source, neighbour) >= threshold * 0.55) continue;
            const localWeight = 1 / Math.max(1, Math.hypot(dx, dy));
            red += source[neighbour] * localWeight;
            green += source[neighbour + 1] * localWeight;
            blue += source[neighbour + 2] * localWeight;
            weight += localWeight;
          }
        }
      }
      if (weight > 0) {
        data[offset] = Math.round(source[offset] * (1 - blend) + red / weight * blend);
        data[offset + 1] = Math.round(source[offset + 1] * (1 - blend) + green / weight * blend);
        data[offset + 2] = Math.round(source[offset + 2] * (1 - blend) + blue / weight * blend);
      } else {
        const neutral = Math.max(source[offset + 1], Math.round((source[offset] + source[offset + 2]) / 3));
        data[offset] = Math.round(source[offset] * (1 - blend) + neutral * blend);
        data[offset + 2] = Math.round(source[offset + 2] * (1 - blend) + neutral * blend);
      }
    }
  }
  return data;
}
