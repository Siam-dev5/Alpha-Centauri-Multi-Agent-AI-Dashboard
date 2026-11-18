"""Local Master Bot planner, bounded Worker runner, and SQLite task ledger."""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException

DATABASE_PATH = Path(os.getenv("ALPHA_CENTAURI_DB", "data/alpha_centauri.sqlite3"))

WORKERS: dict[str, dict[str, str]] = {
    "secretary": {"name": "เลขาส่วนตัว AI", "dept": "ADMIN", "role": "สรุปข้อมูล จัดลำดับงาน และจัดทำรายงาน"},
    "deputy": {"name": "รองผู้จัดการบอท", "dept": "ADMIN", "role": "ตรวจทานคุณภาพ ประเมินความครบถ้วน และเสนอข้อแก้ไข"},
    "prog1": {"name": "โปรแกรมเมอร์ 1", "dept": "DEV", "role": "วิเคราะห์ระบบและจัดทำโค้ด Backend / API"},
    "prog2": {"name": "โปรแกรมเมอร์ 2", "dept": "DEV", "role": "ออกแบบ Frontend, UI และการเชื่อมต่อระบบ"},
    "qa_bot": {"name": "QA / Test Bot", "dept": "DEV", "role": "ออกแบบ Test Case, ตรวจข้อผิดพลาด และวิเคราะห์ผลทดสอบ"},
    "webmaster": {"name": "Webmaster", "dept": "DEV", "role": "วิเคราะห์ Hosting, Cloud, DNS และแนวทาง Deploy"},
    "creative": {"name": "Creative Bot", "dept": "MEDIA", "role": "คิดแนวคิด เนื้อหา บท และ Prompt สำหรับสื่อ"},
    "graphic": {"name": "Graphic Design", "dept": "MEDIA", "role": "จัดทำ Creative Brief, Layout และ Prompt สร้างภาพ"},
    "video": {"name": "Video Editor", "dept": "MEDIA", "role": "จัดทำ Storyboard, Shot List, Subtitle และแผนตัดต่อ"},
    "social": {"name": "แอดมินโซเชียล", "dept": "MEDIA", "role": "เขียน Caption, Metadata และแผนเผยแพร่ Social Media"},
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db() -> None:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DATABASE_PATH, timeout=10) as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                prompt TEXT NOT NULL,
                status TEXT NOT NULL,
                plan_json TEXT NOT NULL DEFAULT '[]',
                results_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"""
        )


def task_count() -> int:
    init_db()
    with sqlite3.connect(DATABASE_PATH, timeout=10) as connection:
        return int(connection.execute("SELECT COUNT(*) FROM tasks").fetchone()[0])


def save_task(task_id: str, prompt: str, status: str,
              plan: list[dict[str, Any]] | None = None,
              results: list[dict[str, Any]] | None = None) -> None:
    """Persist prompts and text results locally, never images or provider credentials."""
    init_db()
    now = utc_now()
    with sqlite3.connect(DATABASE_PATH, timeout=10) as connection:
        connection.execute(
            """INSERT INTO tasks
               (task_id,prompt,status,plan_json,results_json,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(task_id) DO UPDATE SET
                 status=excluded.status,
                 plan_json=excluded.plan_json,
                 results_json=excluded.results_json,
                 updated_at=excluded.updated_at""",
            (task_id, prompt, status,
             json.dumps(plan or [], ensure_ascii=False),
             json.dumps(results or [], ensure_ascii=False), now, now),
        )


def _decode_task(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "task_id": row["task_id"],
        "prompt": row["prompt"],
        "status": row["status"],
        "plan": json.loads(row["plan_json"]),
        "results": json.loads(row["results_json"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_tasks(limit: int = 20) -> list[dict[str, Any]]:
    init_db()
    with sqlite3.connect(DATABASE_PATH, timeout=10) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            "SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?",
            (max(1, min(int(limit), 100)),),
        ).fetchall()
    return [_decode_task(row) for row in rows]


def get_task(task_id: str) -> dict[str, Any] | None:
    init_db()
    with sqlite3.connect(DATABASE_PATH, timeout=10) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            "SELECT * FROM tasks WHERE task_id = ?", (task_id,)
        ).fetchone()
    return _decode_task(row) if row else None


def parse_master_plan(raw: str) -> dict[str, Any] | None:
    """Parse and validate Master JSON, allowing only known, unique worker IDs."""
    text = raw.strip()
    if text.startswith(chr(96) * 3):
        lines = text.splitlines()
        text = "\n".join(line for line in lines if not line.strip().startswith(chr(96) * 3))
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            data = json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            return None
    if not isinstance(data, dict) or not isinstance(data.get("tasks"), list):
        return None

    tasks: list[dict[str, str]] = []
    used: set[str] = set()
    for item in data["tasks"]:
        if not isinstance(item, dict):
            continue
        agent_id = str(item.get("agent_id", "")).strip()
        instruction = str(item.get("instruction", "")).strip()
        if agent_id not in WORKERS or agent_id in used or not instruction:
            continue
        used.add(agent_id)
        spec = WORKERS[agent_id]
        tasks.append({
            "agent_id": agent_id,
            "agent_name": spec["name"],
            "dept": spec["dept"],
            "title": str(item.get("title") or spec["name"])[:160],
            "instruction": instruction[:6000],
        })
        if len(tasks) >= 5:
            break
    return {"summary": str(data.get("summary", "Master Bot จัดทำแผนงานแล้ว"))[:1000], "tasks": tasks}


def build_planner_prompt(user_prompt: str) -> str:
    worker_list = "\n".join(
        f"- {key} ({spec['dept']}): {spec['name']} — {spec['role']}"
        for key, spec in WORKERS.items()
    )
    return f"""วิเคราะห์คำสั่งผู้ใช้ แล้ววางแผนส่งงานให้ Worker 1–5 งานตามความจำเป็น
ตอบ JSON เท่านั้น ห้าม Markdown ตาม schema:
{{"summary":"สรุปแผนภาษาไทย","tasks":[{{"agent_id":"prog1","title":"ชื่องาน","instruction":"คำสั่งเฉพาะ"}}]}}
รายชื่อ Worker ที่อนุญาต:
{worker_list}

ข้อกำหนด:
- เลือกเฉพาะ Worker ที่จำเป็น ห้ามสร้าง agent_id อื่น และห้ามมอบหมายซ้ำ
- ส่งงานที่มีผลลัพธ์เป็นข้อความ โค้ด แผน หรือรายการตรวจสอบ
- Worker ไม่มีเครื่องมืออ่าน/เขียนไฟล์ รัน Shell, โพสต์ Social, อัปโหลด หรือ Deploy จริง
- งาน Publish, ส่งข้อความภายนอก หรือเปลี่ยน Production ให้ทำข้อเสนอและแจ้งว่าต้อง Human Approval เท่านั้น
- คำถามทั่วไปที่ไม่ต้องใช้ทีมให้ tasks เป็น [] และใส่คำตอบใน summary

คำสั่งผู้ใช้:
{user_prompt}
"""


def build_worker_prompt(user_prompt: str, task: dict[str, str],
                        completed: list[dict[str, Any]]) -> str:
    context = "\n".join(
        f"[{row['agent_name']} / {row['status']}] {row.get('output') or row.get('error', '')}"
        for row in completed
    ) or "ยังไม่มีผลลัพธ์จาก Worker ก่อนหน้า"
    return f"""คำสั่งหลักจากผู้ใช้:
{user_prompt}

งานที่ Master มอบหมายให้คุณ:
{task['instruction']}

ผลจาก Worker ก่อนหน้า:
{context}

ตอบภาษาไทยอย่างเป็นระบบ แยกข้อเท็จจริง สมมติฐาน และข้อจำกัด
คุณเป็น Worker LLM เท่านั้น ไม่มีเครื่องมือเข้าถึงไฟล์ ระบบปฏิบัติการ หรือบริการภายนอก
ห้ามอ้างว่ารันโค้ด ทดสอบ โพสต์ อัปโหลด หรือ Deploy สำเร็จ หากไม่มีผลยืนยันจากเครื่องมือจริง
"""


async def run_orchestration(
    *,
    task_id: str,
    prompt: str,
    image_data: str | None,
    bindings: dict[str, Any],
    provider_keys: dict[str, str],
    Binding: Any,
    call_provider: Callable[..., Any],
    emit: Callable[..., Any],
    make_event: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    """Run Master planning -> sequential Worker LLM calls -> Master synthesis."""
    master = bindings.get("master", Binding())
    plan: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    save_task(task_id, prompt, "planning")
    await emit(make_event(task_id, "user", "master", "WORKING", "CORE",
                          "Master Bot กำลังวิเคราะห์และวางแผนงาน"))
    try:
        planner_binding = Binding(
            provider=master.provider,
            model=master.model,
            systemPrompt=(master.systemPrompt + "\n\n" if master.systemPrompt else "")
                         + "คุณคือ Master Bot Orchestrator ต้องจัดแผนเป็น JSON เท่านั้น",
        )
        raw_plan = await call_provider(
            planner_binding, build_planner_prompt(prompt), image_data, provider_keys
        )
        parsed = parse_master_plan(raw_plan)

        if parsed is None or not parsed["tasks"]:
            reply = parsed["summary"] if parsed is not None else raw_plan
            await emit(make_event(task_id, "master", "user", "IDLE", "CORE",
                                  "Master Bot ตอบโดยตรง ไม่ต้องกระจายงาน"))
            save_task(task_id, prompt, "completed_master_only")
            return {
                "task_id": task_id, "status": "completed",
                "execution_mode": "master_only", "reply": reply,
                "plan": [], "results": [], "agents_used": [],
                "provider": master.provider, "model": master.model,
            }

        plan = parsed["tasks"]
        save_task(task_id, prompt, "running", plan, results)

        for task in plan:
            agent_id = task["agent_id"]
            spec = WORKERS[agent_id]
            await emit(make_event(task_id, "master", agent_id, "WORKING",
                                  spec["dept"], f"มอบหมายงาน: {task['title']}"))
            worker_binding = bindings.get(
                agent_id, Binding(provider=master.provider, model=master.model)
            )
            try:
                output = await call_provider(
                    worker_binding, build_worker_prompt(prompt, task, results),
                    image_data, provider_keys,
                )
                results.append({
                    "agent_id": agent_id, "agent_name": spec["name"],
                    "dept": spec["dept"], "title": task["title"],
                    "status": "completed", "output": output,
                })
                await emit(make_event(task_id, agent_id, "master", "IDLE",
                                      spec["dept"], f"{spec['name']} ส่งผลลัพธ์ให้ Master แล้ว"))
            except HTTPException as exc:
                results.append({
                    "agent_id": agent_id, "agent_name": spec["name"],
                    "dept": spec["dept"], "title": task["title"],
                    "status": "blocked", "error": str(exc.detail),
                })
                await emit(make_event(task_id, agent_id, "master", "BLOCKED",
                                      spec["dept"], str(exc.detail)))
            save_task(task_id, prompt, "running", plan, results)

        successful = [item for item in results if item["status"] == "completed"]
        if successful:
            await emit(make_event(task_id, "master", "master", "WORKING", "CORE",
                                  "Master Bot กำลังสังเคราะห์ผลจาก Worker"))
            worker_context = "\n\n".join(
                f"### {item['agent_name']} — {item['title']}\n{item['output']}"
                for item in successful
            )
            final_prompt = f"""คำสั่งผู้ใช้: {prompt}

แผนของ Master: {parsed['summary']}

ผลจาก Worker:
{worker_context}

สังเคราะห์เป็นคำตอบสุดท้ายภาษาไทย ระบุสิ่งที่ Worker ทำได้จริง
และแยกงานที่ยังต้องใช้เครื่องมือหรือ Human Approval ห้ามแต่งผลการรันเครื่องมือ"""
            try:
                final_reply = await call_provider(master, final_prompt, None, provider_keys)
            except HTTPException:
                final_reply = "\n\n".join(
                    f"[{item['agent_name']}]\n{item['output']}" for item in successful
                )
        else:
            final_reply = "Master Bot วางแผนแล้ว แต่ Worker ยังทำงานไม่สำเร็จ\n" + "\n".join(
                f"- {item['agent_name']}: {item.get('error', 'ไม่ทราบสาเหตุ')}"
                for item in results
            )

        await emit(make_event(task_id, "master", "user", "IDLE", "CORE",
                              "Master Bot สรุปผลจาก Worker เรียบร้อย"))
        save_task(task_id, prompt,
                  "completed" if successful else "completed_with_worker_errors",
                  plan, results)
        return {
            "task_id": task_id, "status": "completed",
            "execution_mode": "multi_agent" if successful else "multi_agent_partial",
            "reply": final_reply, "plan": plan, "results": results,
            "agents_used": [item["agent_id"] for item in successful],
            "provider": master.provider, "model": master.model,
        }
    except HTTPException as exc:
        await emit(make_event(task_id, "master", "user", "BLOCKED", "CORE", str(exc.detail)))
        save_task(task_id, prompt, "blocked", plan, results)
        raise
    except Exception as exc:
        await emit(make_event(task_id, "master", "user", "BLOCKED", "CORE", "Gateway internal error"))
        save_task(task_id, prompt, "failed", plan, results)
        raise HTTPException(500, "Gateway internal error; inspect local server logs") from exc
