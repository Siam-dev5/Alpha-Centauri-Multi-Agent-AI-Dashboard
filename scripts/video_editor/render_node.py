"""Alpha-Centauri Video Editor render node.

Renders one short vertical clip for a cloud workflow run that waits at stage "video_awaiting_render",
checks the real file, and (only with --publish) hands it to the Worker, which posts it ONCE to the Facebook Page.

Pipeline: keyframe from Graphic Design -> character cut-out from the reference photo (kept identical in every frame)
-> Thai voice-over (Microsoft Edge neural voice th-TH-NiwatNeural via the edge-tts package) -> Thai text rendered by
Microsoft Edge (correct Thai shaping, Kanit font) -> ffmpeg composite (push-in, glitch, neon rim light, impact sound)
-> QC with ffprobe -> contact sheet for human review.

Requirements: Python 3.10+, Pillow, numpy, edge-tts, ffmpeg + ffprobe, Microsoft Edge, a Thai font file.
Environment: VIDEO_RENDER_TOKEN (Worker secret of the same name). Nothing is posted without --publish.

Usage:
  python render_node.py --character ref.jpg --font Kanit-Black.ttf --ffmpeg-dir C:/ffmpeg/bin --out out/ [--run ID] [--publish]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import uuid
from pathlib import Path

API = "https://social-api.siamhrbp.com/api/social-commerce"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
VOICE = "th-TH-NiwatNeural"
W, H, FPS, DURATION = 1080, 1920, 30, 6.0
VO_START = 0.45


# ---------- Worker API ----------
def api(method: str, path: str, token: str, data: bytes | None = None, ctype: str | None = None):
    req = urllib.request.Request(API + path, data=data, method=method, headers={"X-Render-Token": token, "User-Agent": "alpha-centauri-render-node/1.0"})
    if ctype:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            body = r.read()
            return r.status, body, r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "")


def api_json(method, path, token, payload=None):
    status, body, _ = api(method, path, token, json.dumps(payload).encode() if payload is not None else None, "application/json" if payload is not None else None)
    try:
        return status, json.loads(body.decode() or "{}")
    except ValueError:
        return status, {"raw": body[:300].decode(errors="replace")}


def log_event(token, run_id, message, status="WORKING", detail=None):
    api_json("POST", f"/video-jobs/{run_id}/events", token, {"status": status, "message": message, "detail": detail})


# ---------- assets ----------
def cutout_character(src: Path, dst: Path) -> None:
    """Removes the plain white studio background by flood-filling from the borders (interior whites such as the
    shirt pattern are kept because they are not connected to the border)."""
    import numpy as np
    from PIL import Image, ImageFilter

    img = Image.open(src).convert("RGB")
    a = np.asarray(img).astype(int)
    near_white = (a.min(axis=2) > 196) & ((a.max(axis=2) - a.min(axis=2)) < 34)
    h, w = near_white.shape
    # Background = near-white pixels connected to the image border (4-connected region growing).
    bg = np.zeros_like(near_white)
    bg[0, :], bg[-1, :], bg[:, 0], bg[:, -1] = near_white[0, :], near_white[-1, :], near_white[:, 0], near_white[:, -1]
    while True:
        grown = bg.copy()
        grown[1:, :] |= bg[:-1, :]
        grown[:-1, :] |= bg[1:, :]
        grown[:, 1:] |= bg[:, :-1]
        grown[:, :-1] |= bg[:, 1:]
        grown &= near_white
        if (grown == bg).all():
            break
        bg = grown
    alpha = np.where(bg, 0, 255).astype("uint8")
    # Watermark of the source app in the bottom-right corner (on the background) must not survive.
    alpha[int(h * 0.92):, int(w * 0.86):] = 0
    al = Image.fromarray(alpha, "L").filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.1))
    out = img.convert("RGBA")
    out.putalpha(al)
    bbox = al.point(lambda v: 255 if v > 20 else 0).getbbox()
    out.crop(bbox).save(dst)


async def _tts(text: str, out: Path) -> None:
    import edge_tts
    await edge_tts.Communicate(text, VOICE, rate="+6%", pitch="-4Hz").save(str(out))


def text_png(html_body: str, size: tuple[int, int], font: Path, out: Path, work: Path) -> None:
    """Renders Thai text with Microsoft Edge (proper Thai shaping) to a transparent PNG."""
    page = work / (out.stem + ".html")
    page.write_text(f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:K;src:url('{font.resolve().as_uri()}');}}
html,body{{margin:0;width:{size[0]}px;height:{size[1]}px;background:transparent;overflow:hidden}}
body{{display:flex;align-items:center;justify-content:center;font-family:K,'Leelawadee UI',sans-serif}}
</style></head><body>{html_body}</body></html>""", encoding="utf-8")
    # Old headless mode exits after the screenshot (the new mode can keep running); all paths absolute.
    profile = (work / ("edge-profile-" + uuid.uuid4().hex[:8])).resolve()
    out = out.resolve()
    subprocess.run([EDGE, "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", f"--user-data-dir={profile}",
                    "--default-background-color=00000000", "--force-device-scale-factor=1", f"--window-size={size[0]},{size[1]}",
                    f"--screenshot={out}", page.resolve().as_uri()], check=True, capture_output=True, timeout=90)
    shutil.rmtree(profile, ignore_errors=True)
    if not out.exists():
        raise RuntimeError("Edge did not render " + out.name)


def hook_html(text: str) -> str:
    import html
    parts = text.split("=", 1)
    left = html.escape(parts[0].strip())
    right = html.escape(parts[1].strip()) if len(parts) > 1 else ""
    glow = "0 0 18px rgba(34,211,238,.95),0 0 42px rgba(34,211,238,.6),0 6px 0 rgba(0,0,0,.85)"
    return f"""<div style="text-align:center;line-height:1.08">
<div style="display:inline-block;padding:10px 34px;border:4px solid #22d3ee;border-radius:18px;background:rgba(5,10,30,.72);
box-shadow:0 0 28px rgba(34,211,238,.75),inset 0 0 22px rgba(34,211,238,.35)">
<div style="font-size:92px;color:#fff;text-shadow:{glow};letter-spacing:1px">{left}{' =' if right else ''}</div>
{f'<div style="font-size:104px;color:#f0abfc;text-shadow:0 0 18px rgba(232,121,249,.95),0 0 46px rgba(232,121,249,.6),0 6px 0 rgba(0,0,0,.85)">{right}</div>' if right else ''}
</div></div>"""


def sub_html(text: str) -> str:
    import html
    # One line, never wrapped inside a Thai word: shrink the font until the line fits the frame.
    return f"""<div id="s" style="font-size:100px;color:#fff;text-align:center;white-space:nowrap;line-height:1.15;
-webkit-text-stroke:14px #000;paint-order:stroke fill;text-shadow:0 0 26px rgba(0,0,0,.95),0 9px 0 #000">{html.escape(text)}</div>
<script>const s=document.getElementById('s');let f=100;while(s.scrollWidth>1000&&f>56){{f-=2;s.style.fontSize=f+'px';}}</script>"""


def ffprobe_json(ffprobe: str, path: Path) -> dict:
    out = subprocess.run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def duration_of(ffprobe: str, path: Path) -> float:
    return float(ffprobe_json(ffprobe, path)["format"]["duration"])


# ---------- render ----------
def render(job: dict, keyframe: Path, character: Path, font: Path, ffdir: Path, out: Path) -> dict:
    ffmpeg, ffprobe = str(ffdir / "ffmpeg.exe"), str(ffdir / "ffprobe.exe")
    work = out / "work"
    work.mkdir(parents=True, exist_ok=True)
    c = job["creative"]
    hook, vo, lines = c["hook_text"], c["voiceover"], c["subtitle_lines"] or [c["voiceover"]]

    char_png = work / "character.png"
    cutout_character(character, char_png)
    vo_mp3 = work / "vo.mp3"
    asyncio.run(_tts(vo, vo_mp3))
    vo_len = duration_of(ffprobe, vo_mp3)
    if vo_len > DURATION - VO_START - 0.5:
        raise RuntimeError(f"voice-over is {vo_len:.2f}s and does not fit a {DURATION:.0f}s clip")
    vo_end = VO_START + vo_len
    impact = min(vo_end + 0.12, DURATION - 0.9)

    text_png(hook_html(hook), (W, 420), font, work / "hook.png", work)
    subs = []
    total = sum(len(s) for s in lines)
    t = VO_START
    for i, line in enumerate(lines):
        p = work / f"sub{i}.png"
        text_png(sub_html(line), (W, 300), font, p, work)
        end = DURATION if i == len(lines) - 1 else t + vo_len * len(line) / total
        subs.append((p, t, end))
        t = end

    # Video graph
    inputs = ["-loop", "1", "-framerate", str(FPS), "-t", str(DURATION), "-i", str(keyframe),
              "-loop", "1", "-framerate", str(FPS), "-t", str(DURATION), "-i", str(char_png),
              "-loop", "1", "-framerate", str(FPS), "-t", str(DURATION), "-i", str(work / "hook.png")]
    for p, _, _ in subs:
        inputs += ["-loop", "1", "-framerate", str(FPS), "-t", str(DURATION), "-i", str(p)]
    ai = 3 + len(subs)
    inputs += ["-i", str(vo_mp3)]
    shake = "(lt(t,0.4)+between(t,{a},{b}))".format(a=impact, b=impact + 0.25)
    glitch = "lt(t,0.32)+between(t,{a},{b})".format(a=impact, b=impact + 0.22)
    v = [
        f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},scale=w='trunc({W}*(1.06+0.07*t/{DURATION})/2)*2':h='trunc({H}*(1.06+0.07*t/{DURATION})/2)*2':eval=frame,"
        f"crop={W}:{H}:x='(iw-{W})/2+14*sin(t*47)*{shake}':y='(ih-{H})/2+10*cos(t*41)*{shake}',eq=brightness=-0.04:saturation=1.15,vignette=PI/5,format=rgba[bg]",
        f"[1:v]scale=-2:1380,format=rgba,split[ch][chg]",
        "[chg]colorchannelmixer=rr=0:rg=0:rb=0:gr=0.4:gg=0.9:gb=0.4:br=1:bg=1:bb=1,boxblur=22:2,colorchannelmixer=aa=0.55[glow]",
        f"[bg][glow]overlay=x='(W-w)/2':y='H-h+30':format=auto[b1]",
        f"[ch]scale=w='trunc(iw*(1+0.05*t/{DURATION})/2)*2':h=-2:eval=frame[chz]",
        f"[b1][chz]overlay=x='(W-w)/2':y='H-h+40':eval=frame:format=auto[b2]",
        f"[b2][2:v]overlay=x=0:y='120-60*max(0,1-(t-0.08)/0.22)':enable='gte(t,0.08)':format=auto[b3]",
    ]
    last = "b3"
    for i, (_, start, end) in enumerate(subs):
        nxt = f"s{i}"
        v.append(f"[{last}][{3 + i}:v]overlay=x=0:y=1250:enable='between(t,{start:.3f},{end:.3f})':format=auto[{nxt}]")
        last = nxt
    v.append(f"[{last}]rgbashift=rh=-14:bh=14:gv=4:enable='{glitch}',eq=brightness=0.22:enable='between(t,{impact:.3f},{impact + 0.07:.3f})',"
             f"fade=t=out:st={DURATION - 0.22}:d=0.22,format=yuv420p[vout]")
    # Audio graph: whoosh at the hook, voice-over, subtle low impact + short noise hit, gentle drone bed.
    a = [
        f"anoisesrc=d=0.5:c=pink:a=0.5,highpass=f=900,afade=t=in:d=0.3,afade=t=out:st=0.3:d=0.2,volume=0.18[wh]",
        f"[{ai}:a]aresample=48000,adelay={int(VO_START * 1000)}|{int(VO_START * 1000)},volume=1.6[vo]",
        f"sine=f=52:d=0.9,afade=t=out:st=0.05:d=0.85,volume=0.9,adelay={int(impact * 1000)}|{int(impact * 1000)}[boom]",
        f"anoisesrc=d=0.2:c=brown:a=0.6,lowpass=f=400,afade=t=out:d=0.2,volume=0.5,adelay={int(impact * 1000)}|{int(impact * 1000)}[hit]",
        f"sine=f=98:d={DURATION},volume=0.035,afade=t=in:d=0.4,afade=t=out:st={DURATION - 0.4}:d=0.4[bed]",
        "[wh][vo][boom][hit][bed]amix=inputs=5:normalize=0:duration=longest,loudnorm=I=-15:TP=-1.5:LRA=11,aresample=48000,"
        f"atrim=0:{DURATION},apad=whole_dur={DURATION}[aout]",
    ]
    video = out / "clip.mp4"
    cmd = [ffmpeg, "-y", "-v", "error", *inputs, "-filter_complex", ";".join(v + a), "-map", "[vout]", "-map", "[aout]",
           "-r", str(FPS), "-t", str(DURATION), "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-maxrate", "8M", "-bufsize", "16M",
           "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(video)]
    subprocess.run(cmd, check=True)
    return {"video": video, "vo_len": vo_len, "impact": impact, "subs": [(s, e) for _, s, e in subs], "ffmpeg": ffmpeg, "ffprobe": ffprobe}


def qc(info: dict, out: Path) -> dict:
    video, ffmpeg, ffprobe = info["video"], info["ffmpeg"], info["ffprobe"]
    meta = ffprobe_json(ffprobe, video)
    vs = next(s for s in meta["streams"] if s["codec_type"] == "video")
    aus = [s for s in meta["streams"] if s["codec_type"] == "audio"]
    vol = subprocess.run([ffmpeg, "-v", "info", "-i", str(video), "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True).stderr
    mean = next((float(l.split(":")[1].split()[0]) for l in vol.splitlines() if "mean_volume" in l), -99.0)
    result = {
        "width": vs["width"], "height": vs["height"], "duration": round(float(meta["format"]["duration"]), 3),
        "fps": vs.get("r_frame_rate"), "video_codec": vs["codec_name"], "audio_codec": aus[0]["codec_name"] if aus else None,
        "has_audio": bool(aus) and mean > -40, "mean_volume_db": mean, "bytes": video.stat().st_size,
        "subtitles_burned_in": True, "character_reference": True, "voice": VOICE,
        "vo_seconds": round(info["vo_len"], 2), "impact_at": round(info["impact"], 2),
        "subtitle_windows": [[round(s, 2), round(e, 2)] for s, e in info["subs"]],
    }
    frames = out / "frames"
    frames.mkdir(exist_ok=True)
    for t in (0.3, 1.2, 2.6, 4.0, 5.2, 5.75):
        subprocess.run([ffmpeg, "-v", "error", "-y", "-ss", str(t), "-i", str(video), "-frames:v", "1", str(frames / f"t{t:.2f}.png")], check=True)
    subprocess.run([ffmpeg, "-v", "error", "-y", "-i", str(video), "-vf", "fps=1,scale=270:-1,tile=6x1", "-frames:v", "1", str(out / "contact.png")], check=True)
    (out / "qc.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def multipart(fields: dict, file_field: str, file_path: Path) -> tuple[bytes, str]:
    boundary = "----alpha" + uuid.uuid4().hex
    parts = []
    for k, val in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{val}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\n'.encode())
    parts.append(file_path.read_bytes())
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), "multipart/form-data; boundary=" + boundary


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run")
    ap.add_argument("--character", required=True, type=Path)
    ap.add_argument("--font", required=True, type=Path)
    ap.add_argument("--ffmpeg-dir", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--publish", action="store_true", help="hand the checked file to the Worker, which posts it once")
    args = ap.parse_args()
    token = os.environ.get("VIDEO_RENDER_TOKEN", "").strip()
    if not token:
        print("VIDEO_RENDER_TOKEN is not set", file=sys.stderr)
        return 2
    args.out.mkdir(parents=True, exist_ok=True)
    if args.run:
        status, data = api_json("GET", f"/video-jobs/{args.run}", token)
        job = data.get("job") if status == 200 else None
    else:
        status, data = api_json("GET", "/video-jobs", token)
        job = (data.get("jobs") or [None])[0] if status == 200 else None
    if not job:
        print("no video job:", status, data, file=sys.stderr)
        return 3
    run_id = job["id"]
    if args.publish:
        info_path = args.out / "qc.json"
        if not (args.out / "clip.mp4").exists() or not info_path.exists():
            print("render and check first (run without --publish)", file=sys.stderr)
            return 4
        result = json.loads(info_path.read_text(encoding="utf-8"))
        body, ctype = multipart({"qc": json.dumps(result)}, "video", args.out / "clip.mp4")
        status, resp, _ = api("POST", f"/video-jobs/{run_id}/publish", token, body, ctype)
        print(status, resp.decode(errors="replace"))
        return 0 if status == 200 else 5
    if job["stage"] != "video_awaiting_render":
        print("job is not waiting for a render:", job["stage"], file=sys.stderr)
        return 3
    (args.out / "job.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    log_event(token, run_id, "Video Editor (render node) เริ่มตัดต่อ: ตัดพื้นหลังตัวละครจากภาพอ้างอิง · เสียงบรรยายไทย " + VOICE + " · ซับไทยตัวหนา · 1080x1920 · 6 วินาที")
    status, kf, ctype = api("GET", f"/video-jobs/{run_id}/keyframe", token)
    if status != 200:
        print("keyframe download failed", status, file=sys.stderr)
        return 3
    keyframe = args.out / "keyframe.jpg"
    keyframe.write_bytes(kf)
    try:
        info = render(job, keyframe, args.character, args.font, args.ffmpeg_dir, args.out)
        result = qc(info, args.out)
    except Exception as e:  # report and stop; nothing is posted
        print("render failed:", e, file=sys.stderr)
        raise
    log_event(token, run_id, "Video Editor ตรวจไฟล์จริงแล้ว: {width}x{height} · {duration}s · {video_codec}/{audio_codec} · เสียง {mean_volume_db} dB · VO {vo_seconds}s · ซับ {n} ช่วง · รอยืนยันก่อนส่งให้แอดมินโซเชียล".format(n=len(result["subtitle_windows"]), **result), "QC", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
