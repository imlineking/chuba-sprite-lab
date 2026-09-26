export const petSize = { width: 112, height: 128 };

export function clampPet(point, areas, size = petSize) {
  const area = areas.find((item) => point.x >= item.x && point.x < item.x + item.width && point.y >= item.y && point.y < item.y + item.height) || areas[0];
  return { x: Math.round(Math.max(area.x, Math.min(point.x, area.x + area.width - size.width))), y: Math.round(Math.max(area.y, Math.min(point.y, area.y + area.height - size.height))) };
}

export function bubbleBounds(pet, size, area) {
  const width = Math.min(size.width, area.width); const height = Math.min(size.height, area.height);
  const left = pet.x - width - 8;
  return { x: Math.round(Math.max(area.x, Math.min(left >= area.x ? left : pet.x + pet.width + 8, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(pet.y + pet.height - height, area.y + area.height - height))), width, height };
}

export function greeting(name) {
  const clean = String(name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80);
  return clean ? `Привет, ${clean}! Давай начнём работу.` : "Привет! Давай начнём работу.";
}
