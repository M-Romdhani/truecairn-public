# Landing screen recordings — parked assets

**Nothing on the site plays these right now.** They were made for a "product in
motion" carousel that sat directly under the hero on `/`; that carousel was
removed on 2026-07-29 (see the comment above the light sheet in
`apps/web/src/screens/Landing.tsx`). The recordings are kept here, unreferenced,
because the capture work is real and a product tour is likely to come back —
just not there, and probably not as a carousel.

Why it was removed, so a rebuild doesn't repeat it:

1. **It fired before the visitor knew what problem we solve.** The "When you go
   silent…" section is the argument that earns a product tour. A tour that
   precedes the argument reads as noise.
2. **Dense app UI shrunk to ~40% is unreadable.** Nobody could read
   `email channel · 2 attempts · 0 delivered` at that size. Unreadable proof is
   worse than no proof.
3. **A carousel hides most of what it shows.** Engagement with slides 2+ is very
   low, and a slider immediately under the hero competes with the scroll the
   hero just asked for.

So: put any future tour **below** the problem section, and prefer a layout that
shows its frames at once (a stepped scroll sequence, a tall stack, one crop per
claim) over one that hides them behind arrows. Crop to the ONE control being
demonstrated instead of shrinking a whole screen.

## What's in this folder

| File                         | What it shows                | Poster still in `../` |
| ---------------------------- | ---------------------------- | --------------------- |
| `continuity-checkin.mp4`     | Your continuity home         | `dashboard-preview.png` |
| `unlock-vault.mp4`           | Unlock your vault            | `vault-preview.png`     |
| `create-vault-item.mp4`      | Add a vault item             | `vault-preview.png`     |
| `ai-assistant.mp4`           | The AI assistant             | `plans-preview.png`     |
| `contact-opens-ceremony.mp4` | A contact opens a ceremony   | `ceremony-preview.png`  |

The poster PNGs live one level up in `apps/web/public/assets/landing/` and are
still used by the feature cards on the ink sheet, so don't delete those with the
recordings if you ever decide these should go.

## If you re-record

Export at **16:9 (e.g. 1920×1080)** to match the poster PNGs. `.mp4` (H.264) is
preferred over GIF for a screen capture — far smaller, sharper, hardware-decoded,
and it's what the hero already ships. Keep each clip a few seconds and ≲ 3–4 MB.

Convert a GIF to a web-friendly looping MP4:

```bash
ffmpeg -i truecairn_continuity_checkin.gif \
  -movflags +faststart -pix_fmt yuv420p \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  continuity-checkin.mp4
```

Whatever renders these next must stay muted, `playsInline`, and honour
`prefers-reduced-motion` (hold the poster frame, no auto-advance) — the old
implementation did, and that part was right.
