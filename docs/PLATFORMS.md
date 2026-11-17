# Platform values and their sources

Checked on 2026-11-17. The presets live in `src/presets.js`; every value there is listed here with its
source and how well it is backed.

| Backing | Meaning |
|---|---|
| official | stated in the platform's own documentation |
| official-ads | the platform's ad specification, applied here to normal posts |
| third-party | not published by the platform; taken from a third party |
| unverified | could not be confirmed on the check date |

## What the code enforces

| | YouTube Short | Instagram Reel | TikTok |
|---|---|---|---|
| Length cap | 180 s | 180 s | 180 s |
| Safe area top / bottom / left / right (px of 1080×1920) | 288 / 672 / 48 / 192 | 269 / 672 / 65 / 65 | 130 / 404 / 60 / 120 |
| Backing of the safe area | third-party | official-ads | third-party |
| Caption alignment | centred | centred | left |
| Post text limits | title 100, description 5,000 | caption 2,200 | caption 2,200 |
| Hashtag warning above | none | 5 | 5 |
| File | H.264 High, yuv420p, 30 fps constant, AAC-LC 48 kHz stereo, MP4 with the index at the front | same | same |

## YouTube Shorts

| Value | Backing | Source |
|---|---|---|
| Up to 3 minutes, vertical or square, for uploads after 15 Oct 2024 | official | https://support.google.com/youtube/answer/15424877 |
| MP4, moov atom at the front, H.264 High, progressive, 4:2:0, AAC-LC 48 kHz, 24 to 60 fps; 1080p SDR at 8 Mbit/s (12 at 48 to 60 fps) | official | https://support.google.com/youtube/answer/1722171 |
| Title 100 characters, description 5,000 | official | https://support.google.com/youtube/answer/57404 and https://developers.google.com/youtube/v3/docs/videos |
| Custom thumbnail: JPG or PNG, minimum height 640 px | official | https://support.google.com/youtube/answer/72431 |
| Safe area 288 / 672 / 48 / 192 px | third-party | Google shows its Shorts ad safe zone only as an image (https://support.google.com/google-ads/answer/9128498). The pixel values are a third party's reading of it: https://adkit.so/tools/safe-zones/youtube |

There are no official numbers for normal (non-ad) Shorts.

## Instagram Reels

| Value | Backing | Source |
|---|---|---|
| In the app: 3 seconds to 3 minutes. Through the API: up to 15 minutes | official | https://about.instagram.com/blog/tips-and-tricks/how-to-make-instagram-reels and https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| MP4 or MOV, moov at the front, H.264 or HEVC, progressive, 4:2:0, 23 to 60 fps, AAC up to 48 kHz, up to 300 MB | official | same developers.facebook.com page |
| Caption 2,200 characters | official | same page |
| Safe area: keep 14 % at the top, 35 % at the bottom and 6 % on each side free = 269 / 672 / 65 / 65 px | official-ads | https://www.facebook.com/business/ads-guide/update/video/instagram-reels |
| 5 hashtags | third-party | announced in December 2025 according to press reports: https://www.socialmediatoday.com/news/instagram-implements-new-limits-on-hashtag-use/808309/ . The API page still says 30. Pushreel only warns. |
| Cover crop in the profile grid (3:4, centre) | unverified | help.instagram.com could not be read on the check date. The cover keeps its headline in the centre of the picture, which survives a 3:4 and a 1:1 centre crop. |

There are no official numbers for normal (non-ad) Reels.

## TikTok

| Value | Backing | Source |
|---|---|---|
| Every creator can post 3 minutes; 5 and 10 minutes depend on the account. API maximum 10 minutes | official | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide |
| MP4 recommended, H.264 recommended, 23 to 60 fps, 360 to 4096 px per side, up to 4 GB | official | same page |
| Caption 2,200 characters through the API | official | https://developers.tiktok.com/doc/content-posting-api-reference-direct-post |
| Safe area 130 / 404 / 60 / 120 px | third-party | TikTok publishes no pixel values, only overlay files to download (https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads). A third party gives a key content area of about 960×1386 px (https://posteverywhere.ai/blog/tiktok-aspect-ratio); the split into top and bottom is the value from the product spec. |
| 5 hashtags | third-party | in-app limit reported since August 2025: https://www.socialmediatoday.com/news/tiktok-implements-five-hashtag-limit-per-post/757857/ . Pushreel only warns. |
| 4,000 characters in the app, uploads up to 60 minutes | unverified | support.tiktok.com could not be read on the check date. Not used. |

## Differences from the product spec (ux-copy.md)

| Value in the spec | Result of the check | In the code |
|---|---|---|
| Short 180 s | confirmed | 180 |
| Reel 180 s | confirmed for the app (the API allows 15 min) | 180 |
| TikTok 600 s | not universal: 3 minutes for every account, more only for some | 180 |
| Short safe area 288 / 672 / 192 | only third-party | used, marked third-party |
| Reel safe area 220 / 420 / 120 | no source; Meta's ad spec asks for more | replaced by 269 / 672 / 65 |
| TikTok safe area 130 / 370 / 120 | no source | 130 / 404 / 60 / 120, marked third-party |
| Title 100 | confirmed | 100 |
| Hashtags 5 | press reports only | warning, not an error |
| Instagram caption 2,200 | confirmed | 2,200 |
| TikTok caption 4,000 | not confirmed; the API says 2,200 | 2,200 |

## When a platform changes

Edit `src/presets.js`, set `LAST_CHECKED`, update this file, run `npm test`. A change of a safe area needs no
new recording: `pushreel rerender`.
