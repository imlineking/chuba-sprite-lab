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

// Move the two surfaces as one group: preserve their relative position and
// stop the whole group at a work-area edge rather than parking the bubble.
export function moveCompanionPair(pet, bubble, delta, areas, bubbleVisible = true) {
  const requested = { x: pet.x + delta.x, y: pet.y + delta.y };
  const area = areas.find(item => requested.x + pet.width / 2 >= item.x && requested.x + pet.width / 2 < item.x + item.width && requested.y + pet.height / 2 >= item.y && requested.y + pet.height / 2 < item.y + item.height)
    || areas.find(item => pet.x >= item.x && pet.x < item.x + item.width && pet.y >= item.y && pet.y < item.y + item.height) || areas[0];
  if (!bubbleVisible) {
    const nextPet = { ...pet, ...clampPet(requested, [area], pet) };
    return { pet: nextPet, bubble: bubbleBounds(nextPet, bubble, area) };
  }
  let offset = { x: bubble.x - pet.x, y: bubble.y - pet.y };
  let size = { width: Math.min(bubble.width, area.width), height: Math.min(bubble.height, area.height) };
  const union = () => ({ left: Math.min(0, offset.x), top: Math.min(0, offset.y), right: Math.max(pet.width, offset.x + size.width), bottom: Math.max(pet.height, offset.y + size.height) });
  let bounds = union();
  if (bounds.right - bounds.left > area.width || bounds.bottom - bounds.top > area.height) {
    const anchor = clampPet(requested, [area], pet);
    const attached = bubbleBounds({ ...pet, ...anchor }, size, area);
    offset = { x: attached.x - anchor.x, y: attached.y - anchor.y }; size = { width: attached.width, height: attached.height }; bounds = union();
  }
  const x = Math.round(Math.max(area.x - bounds.left, Math.min(requested.x, area.x + area.width - bounds.right)));
  const y = Math.round(Math.max(area.y - bounds.top, Math.min(requested.y, area.y + area.height - bounds.bottom)));
  return { pet: { ...pet, x, y }, bubble: { ...size, x: x + offset.x, y: y + offset.y } };
}

export function greeting(name) {
  const clean = String(name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80);
  return clean ? `Привет, ${clean}! Давай начнём работу.` : "Привет! Давай начнём работу.";
}
