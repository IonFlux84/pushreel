// Platform presets. Every number here has a source in docs/PLATFORMS.md.
// "status" says how well a value is backed: official, official-ads (an ads spec applied to
// organic posts), third-party or unverified. Last checked: 2026-11-17.

export const FRAME = { width: 1080, height: 1920, fps: 30 };
export const END_CARD_SECONDS = 2;
export const LAST_CHECKED = '2026-11-17';

export const PLATFORMS = {
  short: {
    key: 'short', name: 'YouTube Short', tab: 'Short', suffix: 'short',
    maxSeconds: 180,
    // No official organic numbers. Google publishes its Shorts ad safe zone only as an image;
    // these pixel values are a third-party reading of that image.
    safe: { top: 288, bottom: 672, left: 48, right: 192, status: 'third-party' },
    caption: { align: 'center', softChars: 48 },
    post: { fields: { title: 100, description: 5000 }, hashtags: null },
    hint: 'Caption in the lower middle.',
  },
  reel: {
    key: 'reel', name: 'Instagram Reel', tab: 'Reel', suffix: 'reel',
    maxSeconds: 180,
    // Meta's Reels ad spec: keep 14 % top, 35 % bottom and 6 % on each side free.
    safe: { top: 269, bottom: 672, left: 65, right: 65, status: 'official-ads' },
    caption: { align: 'center', softChars: 44 },
    post: { fields: { caption: 2200 }, hashtags: 5 },
    hint: 'Caption raised above the audio row.',
  },
  tiktok: {
    key: 'tiktok', name: 'TikTok', tab: 'TikTok', suffix: 'tiktok',
    // Every creator can post 3 minutes; 5 and 10 minutes are per-account. 180 is the safe cap.
    maxSeconds: 180,
    // TikTok publishes no pixel values, only downloadable overlay files. Third-party figure.
    safe: { top: 130, bottom: 404, left: 60, right: 120, status: 'third-party' },
    caption: { align: 'left', softChars: 40 },
    post: { fields: { caption: 2200 }, hashtags: 5 },
    hint: 'Caption left of the button column.',
  },
};
export const PLATFORM_KEYS = ['short', 'reel', 'tiktok'];

/** Encoding settings that satisfy all three upload specs at once. */
export const ENCODE = {
  video: ['-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18',
    '-maxrate', '12M', '-bufsize', '24M', '-r', String(FRAME.fps), '-g', String(FRAME.fps * 2), '-bf', '2',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'],
  audio: ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'],
  container: ['-movflags', '+faststart'],
};

/** The rectangle (px, in the 1080×1920 frame) where a caption may sit for one platform. */
export function safeRect(platform, margin = 24) {
  const s = PLATFORMS[platform].safe;
  return { x: s.left + margin, y: s.top + margin, w: FRAME.width - s.left - s.right - margin * 2, h: FRAME.height - s.top - s.bottom - margin * 2 };
}

/** Where the caption box is anchored: its bottom edge sits on the bottom of the safe rectangle. */
export function captionBox(platform) {
  const r = safeRect(platform), p = PLATFORMS[platform];
  return { left: r.x, width: r.w, bottom: FRAME.height - (r.y + r.h), align: p.caption.align, maxHeight: Math.round(r.h * 0.45) };
}

/**
 * Where a click target sits in the 1080×1920 frame, before the zoom and while zoomed in on it.
 * click = { x, y, w, h } as fractions of the frame. Returns rectangles in pixels.
 */
export function clickRects(click, zoom = 1) {
  const W = FRAME.width, H = FRAME.height, out = [];
  for (const z of zoom > 1 ? [1, zoom] : [1]) {
    const ox = Math.min(Math.max(click.x * W * z - W / 2, 0), W * z - W), oy = Math.min(Math.max(click.y * H * z - H / 2, 0), H * z - H);
    const w = (click.w || 0.1) * W * z, h = (click.h || 0.05) * H * z;
    out.push({ x: click.x * W * z - ox - w / 2, y: click.y * H * z - oy - h / 2, w, h });
  }
  return out;
}
// Where a caption sits inside the safe rectangle is decided in src/place.js.

/** True if rect {x,y,w,h} lies fully inside the platform's safe rectangle (margin 0). */
export function insideSafe(platform, rect) {
  const s = PLATFORMS[platform].safe;
  return rect.x >= s.left && rect.y >= s.top && rect.x + rect.w <= FRAME.width - s.right && rect.y + rect.h <= FRAME.height - s.bottom;
}

/** Viewport presets: CSS width × device scale factor always gives 1080 px. */
export const VIEWPORTS = { 360: 3, 432: 2.5, 540: 2 };
export function viewportFor(width = 360) {
  const scale = VIEWPORTS[width];
  if (!scale) throw new Error(`viewport.width must be one of ${Object.keys(VIEWPORTS).join(', ')}`);
  return { width, height: FRAME.height / scale, scale };
}
