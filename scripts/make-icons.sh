#!/usr/bin/env bash
# Regenerates every app icon from assets/icons/source/simplex.png (1024px, white
# glyph on a black rounded square). Needs ImageMagick 7 (`magick`) and macOS's
# iconutil. Usage: scripts/make-icons.sh
#
# macOS gets a Liquid Glass-style tile on Apple's icon grid (824px body inside a
# 1024px canvas), so macOS 26+ shows it as-is instead of boxing it. True layered
# Liquid Glass (.icon compiled by actool) needs Xcode 26, which this does not use.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=assets/icons/source/simplex.png
OUT=assets/icons
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Glyph as white-on-transparent, taken from the source's luminance so edges stay antialiased.
magick "$SRC" -background black -alpha remove -colorspace gray "$TMP/glyph-mask.png"
magick -size 1024x1024 xc:white "$TMP/glyph-mask.png" -alpha off -compose CopyOpacity -composite "$TMP/glyph.png"

# Body: Apple grid squircle (approximated by a 185px-radius rounded rect).
magick -size 1024x1024 xc:none -fill white -draw "roundrectangle 100,100 923,923 185,185" "$TMP/body-mask.png"

# 1. Dark glass fill, lit from above.
magick -size 1024x1024 gradient:'#3a3a3e'-'#060607' "$TMP/body-mask.png" -compose CopyOpacity -composite "$TMP/fill.png"
# 2. Sheen over the top half.
magick -size 1024x512 gradient:'rgba(255,255,255,0.22)'-'rgba(255,255,255,0)' -alpha set -background none -extent 1024x1024 \
  "$TMP/body-mask.png" -compose DstIn -composite "$TMP/sheen.png"
# 3. Rim light: a hairline that is bright on top and fades toward the bottom.
magick -size 1024x1024 xc:none -fill none -stroke white -strokewidth 5 -draw "roundrectangle 103,103 920,920 182,182" "$TMP/rim-shape.png"
magick -size 1024x1024 gradient:'rgba(255,255,255,0.75)'-'rgba(255,255,255,0.08)' -alpha set "$TMP/rim-shape.png" -compose DstIn -composite "$TMP/rim.png"
# 4. Tile shadow, as macOS draws under Dock icons.
magick "$TMP/body-mask.png" -fill black -colorize 100 -channel A -evaluate multiply 0.45 -blur 0x18 +channel \
  -roll +0+14 "$TMP/shadow.png"

# 5. Glyph at grid scale, frosted white with a soft drop shadow for depth.
magick "$TMP/glyph.png" -resize 80.47% "$TMP/glyph-small.png"
magick -size 1024x1024 xc:none "$TMP/glyph-small.png" -geometry +100+100 -composite "$TMP/glyph-placed.png"
magick -size 1024x1024 gradient:'#ffffff'-'#d4d6dc' -alpha set "$TMP/glyph-placed.png" -compose DstIn -composite "$TMP/glyph-fill.png"
magick "$TMP/glyph-placed.png" -fill black -colorize 100 -channel A -evaluate multiply 0.55 -blur 0x10 +channel \
  -roll +0+8 "$TMP/glyph-shadow.png"

magick -size 1024x1024 xc:none \
  "$TMP/shadow.png" -composite \
  "$TMP/fill.png" -composite \
  "$TMP/sheen.png" -composite \
  "$TMP/glyph-shadow.png" -composite \
  "$TMP/glyph-fill.png" -composite \
  "$TMP/rim.png" -composite \
  -depth 8 "$OUT/png/favicon.png"

# macOS .icns with every size iconutil expects.
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  magick "$OUT/png/favicon.png" -resize ${size}x${size} "$ICONSET/icon_${size}x${size}.png"
  magick "$OUT/png/favicon.png" -resize $((size * 2))x$((size * 2)) "$ICONSET/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$OUT/mac/favicon.icns"

# Windows: the tile cropped to its body, since Windows does not use the macOS grid.
magick "$OUT/png/favicon.png" -crop 824x824+100+100 +repage -define icon:auto-resize=256,128,64,48,32,24,16 "$OUT/win/icon.ico"

# macOS menu bar: a template image (black + alpha) that macOS tints for light and dark menu bars.
for scale in 1 2; do
  px=$((18 * scale))
  suffix=$([ "$scale" = 2 ] && echo "@2x" || echo "")
  magick "$TMP/glyph.png" -trim +repage -fill black -colorize 100 -resize ${px}x${px} \
    -background none -gravity center -extent ${px}x${px} "$OUT/png/trayTemplate${suffix}.png"
done

# The bare glyph, no tile: Perplexity's sidebar and the tab bar draw it in the
# current text colour (CSS mask / invert), so it reads in light and dark.
magick "$TMP/glyph.png" -trim +repage -fill black -colorize 100 -resize 128x128 \
  -background none -gravity center -extent 128x128 "$OUT/png/glyph.png"

echo "Icons written: png/favicon.png mac/favicon.icns win/icon.ico png/trayTemplate{,@2x}.png png/glyph.png"
