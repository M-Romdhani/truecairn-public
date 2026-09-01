# Landing media

The `.png` and `.mp4` files here are **masters**. The `.avif`, `.webp` and
`hero-loop-720.mp4` beside them are **derivatives** — they are what the page
actually references, and they are committed so the build stays a plain `vite
build` with no image pipeline and no native dependency in `package.json`.

Regenerate a derivative when its master changes, with the commands below. If you
add a new master, add its derivatives in the same commit: `Landing.css` and
`Landing.tsx` reference the derivative names only, so a missing one is a broken
image, not a fallback to the PNG.

## Why the page does not just ship the masters

Measured 2026-08-12 on the deployed landing (PageSpeed Insights, Lighthouse
13.4.1): the three photographs and the hero video were **~96% of a 13.5 MB
page**. The photographs are ~1 byte per pixel — photographs stored losslessly,
which is what PNG is for and what it should not be used for here.

## Photographs → AVIF + WebP

Rendered ~700 px wide, so 1400 covers a 2× DPR display.

```js
// node, with `npm i sharp` in a scratch directory — deliberately NOT a repo
// dependency; this runs by hand a few times a year.
await sharp(src).resize({ width: 1400, withoutEnlargement: true })
  .avif({ quality: 55, effort: 6 }).toFile(dst + '.avif');
await sharp(src).resize({ width: 1400, withoutEnlargement: true })
  .webp({ quality: 78, effort: 6 }).toFile(dst + '.webp');
```

PSNR is measured against the master resized to the same width, so it reports the
compression loss alone and not the downscale.

| master | PNG | AVIF | WebP | PSNR avif / webp |
|---|---|---|---|---|
| `photo-vault-drawer` | 1,791 KiB | 38 KiB | 52 KiB | 40.4 / 38.7 dB |
| `photo-cairn-dusk` | 1,762 KiB | 46 KiB | 58 KiB | 39.8 / 38.5 dB |
| `photo-notebook` | 1,470 KiB | 25 KiB | 31 KiB | 43.3 / 40.8 dB |

## Preview screenshots → AVIF + WebP

Same commands at `width: 1280` — they render into a `16/10` card a few hundred
pixels wide, so the 1920 px masters were ~4× larger than any display needs.

| master | PNG | AVIF | WebP | PSNR avif / webp |
|---|---|---|---|---|
| `vault-preview` | 84 KiB | 14 KiB | 16 KiB | 43.2 / 39.0 dB |
| `contacts-preview` | 107 KiB | 23 KiB | 26 KiB | 40.9 / 37.1 dB |
| `plans-preview` | 190 KiB | 22 KiB | 26 KiB | (re-shot — see below) |
| `ceremony-preview` | 59 KiB | 10 KiB | 12 KiB | 43.6 / 40.8 dB |

## Hero poster → WebP

`hero-poster.jpg` 70 KiB → `hero-poster.webp` **21 KiB** (`width: 1600`,
`webp quality 74`).

WebP and not AVIF, deliberately: the `poster` attribute takes a **single** URL
with no `<source>` negotiation, and `prerender.tsx` emits a
`<link rel="preload">` for that same file — so the poster and the preload must
be the identical url or the browser fetches both. WebP is universal; AVIF would
need feature detection to be safe as a poster, which is not worth 13 KiB.

`HERO_POSTER_SRC` in `screens/Landing.tsx` is the one place that name is written.

## Hero video → 720p

`hero-loop.mp4` is 1920×1080 at 3.23 Mbps. It is `aria-hidden`, cropped by
`object-fit: cover`, and sits under `.mk-hero-scrim` (a gradient at 18–85%
opacity) — none of that detail reaches an eye.

```bash
ffmpeg -y -i hero-loop.mp4 -vf "scale=1280:-2" \
       -c:v libx264 -profile:v main -crf 30 -preset slow \
       -pix_fmt yuv420p -an -movflags +faststart hero-loop-720.mp4
```

4,041,428 B → 1,002,220 B. `-an` is correct: the master has no audio stream.
`+faststart` puts `moov` ahead of `mdat` so playback can start before the file
finishes downloading — verified on the output (`ftyp@0 → moov@32 → free@3617 →
mdat@3625`).

VP9/WebM was measured and **rejected**: 1,163 KiB, i.e. larger than the H.264 at
this content and resolution. One `.mp4` is the right call.

## The preview screenshots show product COPY, so they go stale silently

`plans-preview.png` was re-shot on 2026-08-12. The old one showed the in-app
sentence *"adds SMS & WhatsApp verification"* — copy that was corrected in the
app when WhatsApp was withdrawn from enrolment on 2026-08-01, but the screenshot
kept advertising it on the public landing page for eleven days.
`withdrawn-channels.test.ts` gates the withdrawn channel out of every TEXT
surface and cannot read an image, so nothing failed.

**So: when you change copy that appears in one of these four screenshots, re-shoot
it in the same change.** No test will tell you. The current one was produced by
rendering the real `<AppShell><Plans/></AppShell>` against stubbed API responses
(free plan, empty account) and screenshotting at 1774×846 with
`deviceScaleFactor: 2`, then downscaling to 1774 wide — a genuine render of the
current code, not an edited image.

## `dashboard-preview.png`

Not used by the landing — it is in the press kit on `/company`
(`screens/public/company.tsx`). Do not delete it as unreferenced; a 2026-08-12
audit did exactly that and was wrong.
