// Packet timestamps belong to the selected video stream; container Duration may include longer audio.
export function parseVideoMetadata(stderr, progress = "") {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/i);
  const containerDuration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  const line = stderr.split(/\r?\n/).find(value => /Video:/i.test(value)) || "";
  const size = line.match(/(?:^|\D)(\d{2,5})x(\d{2,5})(?:\D|$)/);
  const fps = Number(line.match(/([\d.]+)\s+fps\b/i)?.[1] || 0);
  const times = [...progress.matchAll(/^out_time_us=(\d+)\s*$/gm)].map(value => Number(value[1]) / 1000000);
  const videoDuration = Math.max(0, ...times);
  const duration = videoDuration || containerDuration;
  return { width: Number(size?.[1] || 0), height: Number(size?.[2] || 0), duration, containerDuration,
    durationSource: videoDuration ? "video-packets" : "container", fps, estimatedFrames: Math.round(duration * fps) };
}
