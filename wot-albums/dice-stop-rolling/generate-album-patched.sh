#!/bin/bash
set -euo pipefail

# =============================================================================
# generate-album.sh — Reusable WoT album generation pipeline
# Location: ~/bin/generate-album.sh (desktop)
#
# Full pipeline per track:
#   1. Qwen3-TTS (port 5050) → spoken-word vocals
#   2. Convert to WAV, check/boost volume
#   3. ACE-Step cover cycle 1 @ 0.8 strength → pick louder variant
#   4. ACE-Step cover cycle 2 @ 0.8 strength → keep both variants
#   5. Convert to MP3, upload to B2, send to Telegram
#
# Usage:
#   generate-album.sh <album-config.json>
#
# Config JSON format:
# {
#   "album": "slug-name",
#   "album_title": "Display Name",
#   "b2_folder": "album-slug-name",
#   "voice_instruct": "Voice description for Qwen TTS...",
#   "performer": "Character Name",
#   "cover_strength": 0.8,
#   "audio_duration": 180,
#   "tracks": [
#     {
#       "num": 1,
#       "title": "Track Title",
#       "slug": "track-slug",
#       "prompt": "ACE-Step style prompt...",
#       "lyrics": "[verse 1]\nLyrics with structure tags...",
#     },
#     ...
#   ]
# }
# =============================================================================

CONFIG="$1"

if [ ! -f "$CONFIG" ]; then
  echo "ERROR: Config file not found: $CONFIG"
  exit 1
fi

# Parse config
ALBUM=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d['album'])")
ALBUM_TITLE=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d['album_title'])")
B2_FOLDER=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d['b2_folder'])")
VOICE_INSTRUCT=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d.get('voice_instruct', ''))")
PERFORMER=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d.get('performer', d['album_title']))")
COVER_STRENGTH=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d.get('cover_strength', 0.8))")
AUDIO_DURATION_TARGET=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d.get('audio_duration', 180))")
# NOTE: AUDIO_DURATION is set per-track from Qwen TTS output duration
AUDIO_DURATION="${AUDIO_DURATION_TARGET}"  # default, overridden per-track
NUM_TRACKS=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(len(d['tracks']))")

TGBOT="8516158841:AAEiuEc956VdL0i6NIRqJ8o606ZYGV4AmDU"
CHAT_ID="6644666619"
ACE_API="http://localhost:8000"
QWEN_API="http://localhost:5050"
WORKDIR="/tmp/album-${ALBUM}"
B2_BASE="s3://adas-storage/music/${B2_FOLDER}"
PUBLIC_URL="https://f004.backblazeb2.com/file/adas-storage/music/${B2_FOLDER}"

mkdir -p "$WORKDIR"

echo "============================================================"
echo "  ALBUM: ${ALBUM_TITLE}"
echo "  Tracks: ${NUM_TRACKS}"
echo "  Work dir: ${WORKDIR}"
echo "  B2: ${B2_BASE}"
echo "  Started: $(date)"
echo "============================================================"

# Helper: get mean volume in dB
get_volume() {
  ffmpeg -i "$1" -af volumedetect -f null /dev/null </dev/null 2>&1 | grep mean_volume | awk '{print $5}'
}

# Helper: submit ACE-Step cover task
submit_cover() {
  local SRC_PATH="$1"
  local LYRICS_FILE="$2"
  local PROMPT="$3"
  local PAYLOAD_FILE="${WORKDIR}/cover-payload-$$.json"

  local PROMPT_FILE="${WORKDIR}/cover-prompt-$$.txt"
  printf '%s' "$PROMPT" > "$PROMPT_FILE"
  python3 -c "
import json, sys
lyrics = open('$LYRICS_FILE').read().strip()
prompt = open('$PROMPT_FILE').read().strip()
payload = {
    'prompt': prompt,
    'lyrics': lyrics,
    'audio_duration': $AUDIO_DURATION,
    'thinking': True,
    'src_audio_path': '$SRC_PATH',
    'audio_cover_strength': $COVER_STRENGTH
}
json.dump(payload, open('$PAYLOAD_FILE', 'w'))
"
  rm -f "$PROMPT_FILE"
  local RESP
  RESP=$(curl -s -X POST "${ACE_API}/release_task" -H 'Content-Type: application/json' -d @"${PAYLOAD_FILE}")
  local TASK_ID
  TASK_ID=$(echo "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("data",{}).get("task_id",""))' 2>/dev/null)
  rm -f "$PAYLOAD_FILE"
  echo "$TASK_ID"
}

# Helper: poll ACE-Step task until completion, return file list (newline-separated)
poll_task() {
  local TASK_ID="$1"
  local MAX_WAIT="${2:-1200}"  # 20 minutes default
  local START=$(date +%s)

  while true; do
    local ELAPSED=$(( $(date +%s) - START ))
    if [ "$ELAPSED" -gt "$MAX_WAIT" ]; then
      echo "TIMEOUT"
      return 1
    fi

    local RESP
    RESP=$(curl -s -X POST "${ACE_API}/query_result" -H 'Content-Type: application/json' \
      -d "{\"task_id_list\":[\"${TASK_ID}\"]}")

    local STATUS
    STATUS=$(echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tasks = d.get('data', {})
# Handle both list and dict formats
if isinstance(tasks, list):
    for t in tasks:
        if t.get('task_id') == '$TASK_ID':
            print(t.get('status', 'unknown'))
            break
    else:
        # If task_id not found, check first item
        if tasks:
            print(tasks[0].get('status', 'unknown'))
        else:
            print('unknown')
elif isinstance(tasks, dict):
    t = tasks.get('tasks', {}).get('$TASK_ID', {})
    print(t.get('status', 'unknown'))
else:
    print('unknown')
" 2>/dev/null || echo "unknown")

    # ACE-Step uses status=1 for completed
    if [ "$STATUS" = "1" ] || [ "$STATUS" = "completed" ]; then
      # Extract file paths
      echo "$RESP" | python3 -c "
import sys, json, urllib.parse
d = json.load(sys.stdin)
tasks = d.get('data', {})
files = []
if isinstance(tasks, list):
    for t in tasks:
        if t.get('task_id') == '$TASK_ID':
            results = json.loads(t.get('result', '[]'))
            for r in results:
                raw = r.get('file', '')
                if 'path=' in raw:
                    path = raw.split('path=')[1]
                else:
                    path = raw
                files.append(urllib.parse.unquote(path))
            break
elif isinstance(tasks, dict):
    t = tasks.get('tasks', {}).get('$TASK_ID', {})
    file_list = t.get('file_list', [])
    files = file_list
for f in files:
    print(f)
" 2>/dev/null
      return 0
    fi

    echo "  ... generating (${ELAPSED}s elapsed)" >&2
    sleep 15
  done
}

# Helper: send audio to Telegram
send_telegram() {
  local FILE="$1"
  local TITLE="$2"
  curl -s -X POST "https://api.telegram.org/bot${TGBOT}/sendAudio" \
    -F chat_id="${CHAT_ID}" \
    -F audio=@"${FILE}" \
    -F "title=${TITLE}" \
    -F "performer=${PERFORMER}" > /dev/null 2>&1
}

# Helper: send audio to Telegram with custom performer
send_telegram_perf() {
  local FILE="$1"
  local TITLE="$2"
  local PERF="$3"
  curl -s -X POST "https://api.telegram.org/bot${TGBOT}/sendAudio" \
    -F chat_id="${CHAT_ID}" \
    -F audio=@"${FILE}" \
    -F "title=${TITLE}" \
    -F "performer=${PERF}" > /dev/null 2>&1
}

# =============================================================================
# MAIN LOOP — process each track
# =============================================================================

FAILED_TRACKS=""
COMPLETED=0

for IDX in $(seq 0 $((NUM_TRACKS - 1))); do
  # Extract track info from config
  TRACK_NUM=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d['tracks'][$IDX]['num'])")
  TRACK_TITLE=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d['tracks'][$IDX]['title'])")
  TRACK_SLUG=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d['tracks'][$IDX]['slug'])")
  TRACK_PROMPT=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d['tracks'][$IDX]['prompt'])")
  TRACK_PERFORMER=$(python3 -c "import json; d=json.load(open('$CONFIG')); t=d['tracks'][$IDX]; print(t.get('performer', d.get('performer', d['album_title'])))")

  # Write lyrics to file (with structure tags for ACE-Step)
  LYRICS_FILE="${WORKDIR}/track${TRACK_NUM}-lyrics.txt"
  python3 -c "import json; d=json.load(open('$CONFIG')); open('$LYRICS_FILE','w').write(d['tracks'][$IDX]['lyrics'])"

  # Write clean lyrics for Qwen (strip tags, replace ! with .)
  QWEN_TEXT_FILE="${WORKDIR}/track${TRACK_NUM}-qwen-text.txt"
  python3 -c "
import json, re
d = json.load(open('$CONFIG'))
lyrics = d['tracks'][$IDX]['lyrics']
clean = re.sub(r'\[.*?\]\n?', '', lyrics).strip()
clean = clean.replace('!', '.')
open('$QWEN_TEXT_FILE', 'w').write(clean)
"

  TPREFIX="${WORKDIR}/track${TRACK_NUM}"

  echo ""
  echo "========================================================"
  echo "  TRACK ${TRACK_NUM}/${NUM_TRACKS}: ${TRACK_TITLE}"
  echo "========================================================"

  # --- Resume support: skip if final MP3s already exist ---
  if [ -f "${TPREFIX}-${TRACK_SLUG}-a.mp3" ] && [ -f "${TPREFIX}-${TRACK_SLUG}-b.mp3" ]; then
    echo "  [SKIP] Final MP3s already exist. Skipping track."
    COMPLETED=$((COMPLETED + 1))
    continue
  fi

  # =========================================================
  # STEP 1: Qwen3-TTS (with duration enforcement loop)
  # =========================================================
  QWEN_OGG="${TPREFIX}-qwen.ogg"
  CYCLE0_RAW="${TPREFIX}-cycle0-raw.wav"
  CYCLE0_WAV="${TPREFIX}-cycle0.wav"
  TTS_MIN=60
  TTS_MAX=300

  if [ -f "$CYCLE0_WAV" ] && [ "$(stat -c%s "$CYCLE0_WAV" 2>/dev/null || echo 0)" -gt 10000 ]; then
    echo "  [RESUME] Qwen WAV already exists, skipping TTS."
    TTS_DURATION=$(ffprobe -i "${CYCLE0_WAV}" -show_entries format=duration -v quiet -of csv="p=0" 2>/dev/null | cut -d. -f1)
    echo "  Existing TTS duration: ${TTS_DURATION}s"
  else
    TTS_ATTEMPT=0
    TTS_MAX_ATTEMPTS=3
    TTS_OK=false

    while [ "$TTS_ATTEMPT" -lt "$TTS_MAX_ATTEMPTS" ]; do
      TTS_ATTEMPT=$((TTS_ATTEMPT + 1))
      echo "  [1/5] Generating Qwen TTS (attempt ${TTS_ATTEMPT}/${TTS_MAX_ATTEMPTS})..."

      # Regenerate qwen-text from current lyrics (may have been updated by Claude)
      python3 -c "
import json, re
d = json.load(open('$CONFIG'))
lyrics = d['tracks'][$IDX]['lyrics']
clean = re.sub(r'\[.*?\]\n?', '', lyrics).strip()
clean = clean.replace('!', '.')
open('$QWEN_TEXT_FILE', 'w').write(clean)
"

      # Write TTS payload to file to avoid shell escaping issues
      TTS_PAYLOAD="${WORKDIR}/tts-payload-${TRACK_NUM}.json"
      python3 -c "
import json
text = open('$QWEN_TEXT_FILE').read().strip()
d = json.load(open('$CONFIG'))
track = d['tracks'][$IDX]
voice = track.get('voice_instruct', d.get('voice_instruct', ''))
json.dump({'text': text, 'instruct': voice}, open('$TTS_PAYLOAD', 'w'))
"
      # Clean old TTS outputs before regenerating
      rm -f "${QWEN_OGG}" "${CYCLE0_RAW}" "${CYCLE0_WAV}"

      curl -s -X POST "${QWEN_API}/tts" \
        -H 'Content-Type: application/json' \
        -d @"${TTS_PAYLOAD}" \
        --output "${QWEN_OGG}" \
        --max-time 1800 || true

      if [ ! -s "$QWEN_OGG" ]; then
        echo "  ERROR: Qwen TTS failed for track ${TRACK_NUM}. Skipping."
        FAILED_TRACKS="${FAILED_TRACKS} ${TRACK_NUM}"
        break
      fi

      # Convert to WAV
      ffmpeg -y -i "${QWEN_OGG}" -ar 48000 -ac 2 "${CYCLE0_RAW}" </dev/null 2>/dev/null

      # Check and boost volume if needed
      VOL=$(get_volume "${CYCLE0_RAW}")
      echo "  Qwen volume: ${VOL} dB"

      VOL_INT=$(python3 -c "print(int(float('${VOL}') * 100))")
      if [ "$VOL_INT" -lt "-3000" ]; then
        BOOST=$(python3 -c "print(min(15, -20 - float('${VOL}')))")
        echo "  Boosting by ${BOOST} dB..."
        ffmpeg -y -i "${CYCLE0_RAW}" -af "volume=${BOOST}dB" "${CYCLE0_WAV}" </dev/null 2>/dev/null
      else
        cp "${CYCLE0_RAW}" "${CYCLE0_WAV}"
      fi

      echo "  Input volume: $(get_volume "${CYCLE0_WAV}") dB"
      rm -f "${TTS_PAYLOAD}"

      # Measure TTS duration
      TTS_DURATION=$(ffprobe -i "${CYCLE0_WAV}" -show_entries format=duration -v quiet -of csv="p=0" 2>/dev/null | cut -d. -f1)
      echo "  TTS duration: ${TTS_DURATION}s (target: ${TTS_MIN}-${TTS_MAX}s)"

      # Check if duration is within acceptable range
      if [ "$TTS_DURATION" -ge "$TTS_MIN" ] && [ "$TTS_DURATION" -le "$TTS_MAX" ]; then
        echo "  TTS duration OK."
        TTS_OK=true
        break
      fi

      # If this was the last attempt, bail out with warning
      if [ "$TTS_ATTEMPT" -ge "$TTS_MAX_ATTEMPTS" ]; then
        echo "  WARNING: TTS still ${TTS_DURATION}s after ${TTS_MAX_ATTEMPTS} attempts. Proceeding anyway."
        TTS_OK=true  # proceed with what we have
        break
      fi

      # Use Claude to adjust lyrics
      echo "  Attempt ${TTS_ATTEMPT}/${TTS_MAX_ATTEMPTS}: TTS was ${TTS_DURATION}s, target ${TTS_MIN}-${TTS_MAX}s. Adjusting lyrics..."
      CURRENT_LYRICS=$(cat "$LYRICS_FILE")
      ADJUST_PROMPT_FILE="${WORKDIR}/adjust-prompt-${TRACK_NUM}.txt"

      if [ "$TTS_DURATION" -lt "$TTS_MIN" ]; then
        DIRECTION="too short"
        INSTRUCTION="Add more content: another verse, extend the chorus, add a bridge, or expand existing sections. The TTS needs to be longer."
      else
        DIRECTION="too long"
        INSTRUCTION="Trim the lyrics: remove a verse, shorten sections, or cut repetition. Keep the best and most impactful parts. The TTS needs to be shorter."
      fi

      python3 -c "
import json
lyrics = open('$LYRICS_FILE').read().strip()
prompt = '''You are adjusting song lyrics so the spoken TTS duration falls between ${TTS_MIN}s and ${TTS_MAX}s.

Track title: ${TRACK_TITLE}
Current TTS duration: ${TTS_DURATION}s (${DIRECTION})
Target range: ${TTS_MIN}-${TTS_MAX}s

${INSTRUCTION}

Current lyrics:
---
''' + lyrics + '''
---

Output ONLY the adjusted lyrics with their [verse], [chorus], [bridge] etc. structure tags. No explanations, no commentary, just the lyrics.'''
open('$ADJUST_PROMPT_FILE', 'w').write(prompt)
"
      # Call Claude CLI to adjust lyrics
      ADJUSTED_LYRICS=$(source ~/.nvm/nvm.sh && claude -p "$(cat "$ADJUST_PROMPT_FILE")" --dangerously-skip-permissions 2>/dev/null) || true
      rm -f "$ADJUST_PROMPT_FILE"

      if [ -z "$ADJUSTED_LYRICS" ]; then
        echo "  WARNING: Claude lyrics adjustment failed. Proceeding with current lyrics."
        TTS_OK=true
        break
      fi

      # Update lyrics file
      echo "$ADJUSTED_LYRICS" > "$LYRICS_FILE"

      # Update config JSON with new lyrics
      python3 -c "
import json
d = json.load(open('$CONFIG'))
new_lyrics = open('$LYRICS_FILE').read().strip()
d['tracks'][$IDX]['lyrics'] = new_lyrics
json.dump(d, open('$CONFIG', 'w'), indent=2, ensure_ascii=False)
"
      echo "  Lyrics updated. Retrying TTS..."

      # Clean up old TTS files for retry
      rm -f "${QWEN_OGG}" "${CYCLE0_RAW}" "${CYCLE0_WAV}"
    done

    # If TTS failed entirely (not just duration issues), skip track
    if [ "$TTS_OK" != "true" ]; then
      continue
    fi
  fi

  # =========================================================
  # STEP 2: ACE-Step Cover Cycle 1
  # =========================================================
  CYCLE1_WAV="${TPREFIX}-cycle1.wav"

  if [ -f "$CYCLE1_WAV" ] && [ "$(stat -c%s "$CYCLE1_WAV" 2>/dev/null || echo 0)" -gt 10000 ]; then
    echo "  [RESUME] Cycle 1 WAV already exists, skipping."
  else
  # Set cover duration: use max(TTS + breathing, config target) to enforce minimum song length
  if [ -n "${TTS_DURATION:-}" ] && [ "${TTS_DURATION:-0}" -gt 0 ] 2>/dev/null; then
    BREATHING_PCT=$(python3 -c "import random; print(random.randint(5, 15))")
    TTS_BASED=$(python3 -c "import math; print(math.ceil(${TTS_DURATION} * (1 + ${BREATHING_PCT}/100)))")
    AUDIO_DURATION=$(python3 -c "print(max(${TTS_BASED}, ${AUDIO_DURATION_TARGET}))")
    echo "  TTS duration: ${TTS_DURATION}s + ${BREATHING_PCT}% = ${TTS_BASED}s → using ${AUDIO_DURATION}s (target min: ${AUDIO_DURATION_TARGET}s)"
  fi

    echo "  [2/5] ACE-Step cover cycle 1 (strength ${COVER_STRENGTH})..."
    C1_TASK=$(submit_cover "${CYCLE0_WAV}" "${LYRICS_FILE}" "${TRACK_PROMPT}")

    if [ -z "$C1_TASK" ]; then
      echo "  ERROR: Failed to submit cycle 1. Skipping track."
      FAILED_TRACKS="${FAILED_TRACKS} ${TRACK_NUM}"
      continue
    fi
    echo "  Task ID: ${C1_TASK}"

    C1_FILES=$(poll_task "$C1_TASK" 1200)
    if [ $? -ne 0 ]; then
      echo "  ERROR: Cycle 1 timed out. Skipping track."
      FAILED_TRACKS="${FAILED_TRACKS} ${TRACK_NUM}"
      continue
    fi

    # Pick louder variant
    BEST_VOL=-100
    BEST_FILE=""
    VARIANT_IDX=0
    while IFS= read -r FPATH <&3; do
      [ -z "$FPATH" ] && continue
      WAV_TMP="${TPREFIX}-c1v${VARIANT_IDX}.wav"
      ffmpeg -y -i "$FPATH" -ar 48000 -ac 2 "$WAV_TMP" </dev/null 2>/dev/null
      V=$(get_volume "$WAV_TMP")
      echo "  Cycle 1 variant ${VARIANT_IDX}: ${V} dB"
      V_INT=$(python3 -c "print(int(float('${V}') * 100))")
      B_INT=$(python3 -c "print(int(float('${BEST_VOL}') * 100))")
      if [ "$V_INT" -gt "$B_INT" ]; then
        BEST_VOL="$V"
        BEST_FILE="$WAV_TMP"
      fi
      VARIANT_IDX=$((VARIANT_IDX + 1))
    done 3<<< "$C1_FILES"

    if [ -z "$BEST_FILE" ]; then
      echo "  ERROR: No cycle 1 output files. Skipping track."
      FAILED_TRACKS="${FAILED_TRACKS} ${TRACK_NUM}"
      continue
    fi

    cp "$BEST_FILE" "$CYCLE1_WAV"
    echo "  Best cycle 1: ${BEST_VOL} dB"
  fi

  # =========================================================
  # STEP 3: ACE-Step Cover Cycle 2
  # =========================================================
  CYCLE2A_WAV="${TPREFIX}-cycle2a.wav"
  CYCLE2B_WAV="${TPREFIX}-cycle2b.wav"

  if [ -f "$CYCLE2A_WAV" ] && [ -f "$CYCLE2B_WAV" ]; then
    echo "  [RESUME] Cycle 2 WAVs already exist, skipping."
  else
    echo "  [3/5] ACE-Step cover cycle 2 (strength ${COVER_STRENGTH})..."
    C2_TASK=$(submit_cover "${CYCLE1_WAV}" "${LYRICS_FILE}" "${TRACK_PROMPT}")

    if [ -z "$C2_TASK" ]; then
      echo "  ERROR: Failed to submit cycle 2. Skipping track."
      FAILED_TRACKS="${FAILED_TRACKS} ${TRACK_NUM}"
      continue
    fi
    echo "  Task ID: ${C2_TASK}"

    C2_FILES=$(poll_task "$C2_TASK" 1200)
    if [ $? -ne 0 ]; then
      echo "  ERROR: Cycle 2 timed out. Skipping track."
      FAILED_TRACKS="${FAILED_TRACKS} ${TRACK_NUM}"
      continue
    fi

    VARIANT_IDX=0
    while IFS= read -r FPATH <&3; do
      [ -z "$FPATH" ] && continue
      if [ "$VARIANT_IDX" -eq 0 ]; then
        ffmpeg -y -i "$FPATH" -ar 48000 -ac 2 "$CYCLE2A_WAV" </dev/null 2>/dev/null
        echo "  Cycle 2 variant A: $(get_volume "$CYCLE2A_WAV") dB"
      else
        ffmpeg -y -i "$FPATH" -ar 48000 -ac 2 "$CYCLE2B_WAV" </dev/null 2>/dev/null
        echo "  Cycle 2 variant B: $(get_volume "$CYCLE2B_WAV") dB"
      fi
      VARIANT_IDX=$((VARIANT_IDX + 1))
    done 3<<< "$C2_FILES"

    # If only one variant, duplicate it
    if [ ! -f "$CYCLE2B_WAV" ] && [ -f "$CYCLE2A_WAV" ]; then
      cp "$CYCLE2A_WAV" "$CYCLE2B_WAV"
      echo "  (Only 1 variant returned, duplicated as B)"
    fi
  fi

  # =========================================================
  # STEP 4: Convert to MP3
  # =========================================================
  MP3_A="${TPREFIX}-${TRACK_SLUG}-a.mp3"
  MP3_B="${TPREFIX}-${TRACK_SLUG}-b.mp3"

  echo "  [4/5] Converting to MP3..."
  ffmpeg -y -i "$CYCLE2A_WAV" -b:a 192k "$MP3_A" 2>/dev/null
  ffmpeg -y -i "$CYCLE2B_WAV" -b:a 192k "$MP3_B" 2>/dev/null

  # =========================================================
  # STEP 5: Upload to B2 + Send to Telegram
  # =========================================================
  echo "  [5/5] Uploading to B2 and sending to Telegram..."
  source ~/env.vars

  B2_KEY_A="track${TRACK_NUM}-${TRACK_SLUG}-a.mp3"
  B2_KEY_B="track${TRACK_NUM}-${TRACK_SLUG}-b.mp3"

  aws --endpoint-url "https://${B2_ENDPOINT}" s3 cp "$MP3_A" "${B2_BASE}/${B2_KEY_A}" --acl public-read 2>/dev/null
  aws --endpoint-url "https://${B2_ENDPOINT}" s3 cp "$MP3_B" "${B2_BASE}/${B2_KEY_B}" --acl public-read 2>/dev/null

  echo "  B2: ${PUBLIC_URL}/${B2_KEY_A}"
  echo "  B2: ${PUBLIC_URL}/${B2_KEY_B}"

  TGPERF="${TRACK_PERFORMER}"
  send_telegram_perf "$MP3_A" "Track ${TRACK_NUM} - ${TRACK_TITLE} (A)" "$TGPERF"
  send_telegram_perf "$MP3_B" "Track ${TRACK_NUM} - ${TRACK_TITLE} (B)" "$TGPERF"

  echo "  DONE: Track ${TRACK_NUM} complete."
  COMPLETED=$((COMPLETED + 1))
done

# =========================================================
# SUMMARY
# =========================================================
echo ""
echo "============================================================"
echo "  ALBUM COMPLETE: ${ALBUM_TITLE}"
echo "  Completed: ${COMPLETED}/${NUM_TRACKS} tracks"
if [ -n "$FAILED_TRACKS" ]; then
  echo "  Failed tracks:${FAILED_TRACKS}"
fi
echo "  B2 folder: ${PUBLIC_URL}/"
echo "  Finished: $(date)"
echo "============================================================"

# Upload lyrics file to B2
LYRICS_ALL="${WORKDIR}/lyrics.txt"
python3 -c "
import json
d = json.load(open('$CONFIG'))
with open('$LYRICS_ALL', 'w') as f:
    f.write(d['album_title'] + '\n')
    f.write('=' * len(d['album_title']) + '\n\n')
    for t in d['tracks']:
        f.write('Track ' + str(t['num']) + ': ' + t['title'] + '\n')
        f.write('-' * 40 + '\n')
        f.write(t['lyrics'] + '\n\n')
"
source ~/env.vars
aws --endpoint-url "https://${B2_ENDPOINT}" s3 cp "$LYRICS_ALL" "${B2_BASE}/lyrics.txt" --acl public-read 2>/dev/null
echo "  Lyrics: ${PUBLIC_URL}/lyrics.txt"

# Send completion notification
curl -s -X POST "https://api.telegram.org/bot${TGBOT}/sendMessage" \
  -d chat_id="${CHAT_ID}" \
  -d "text=Album complete: ${ALBUM_TITLE} (${COMPLETED}/${NUM_TRACKS} tracks)" \
  -d parse_mode=Markdown > /dev/null 2>&1
