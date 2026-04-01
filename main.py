from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Any
import base64
import os
import io
import json as json_lib
import traceback
import asyncio
import re

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# FatafatDecor AI Service
#
# Endpoints:
#   GET  /health              — status check
#   POST /smart-generate      — AI reads DB → selects kit+items → writes prompt → FLUX
#   POST /generate            — direct FLUX (fallback / legacy)
#   POST /analyze-decoration  — fal.ai vision → decoration item list (admin only)
#
# Provider: fal.ai only (FAL_KEY env var required)
# ============================================================

FAL_KEY = os.environ.get("FAL_KEY", "")
os.environ["FAL_KEY"] = FAL_KEY

NO_TEXT = (
    "CRITICAL: Do NOT write any text, words, letters, numbers, or labels anywhere "
    "in the image — no text on balloons, banners, backdrops, walls, floors, or any "
    "surface. The image must be completely text-free. No written words of any kind."
)


# ── Request models ──────────────────────────────────────────

class SmartGenerateRequest(BaseModel):
    # User inputs
    budget_min: int
    budget_max: int
    occasion: str
    room_type: str
    description: Optional[str] = ""
    image_base64: Optional[str] = None   # customer's room photo (base64)
    # DB data — sent by API so AI can make intelligent selections
    kits: List[Any] = []
    items: List[Any] = []
    rent_items: List[Any] = []


class GenerateRequest(BaseModel):
    prompt: str
    image_base64: Optional[str] = None


class AnalyzeRequest(BaseModel):
    image_base64: str
    name: str = ""


# ── Helpers ──────────────────────────────────────────────────

def parse_json_safe(text: str) -> dict:
    """Robustly parse JSON from LLM output — strips markdown fences, BOM, whitespace."""
    text = text.strip().lstrip('\ufeff')
    # Strip ```json ... ``` or ``` ... ```
    text = re.sub(r'^```(?:json)?\s*', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\s*```$', '', text)
    # Strip bare "json" prefix
    if text.lower().startswith('json'):
        text = text[4:].lstrip()
    return json_lib.loads(text.strip())


async def run_flux_fill(prompt: str, image_base64: str, fal_client) -> str:
    """Upload room photo to fal storage → run FLUX Dev img2img → return image URL.
    Uses image-to-image (no mask needed) — preserves room structure, adds decorations.
    strength=0.70 keeps 30% of original structure while allowing full decoration changes.
    """
    img_data = image_base64
    if ',' in img_data:
        img_data = img_data.split(',', 1)[1]
    image_bytes = base64.b64decode(img_data)
    image_file = io.BytesIO(image_bytes)
    image_file.name = "room.png"
    fal_image_url = await asyncio.to_thread(
        fal_client.upload, image_file, content_type="image/png"
    )
    result = await asyncio.to_thread(
        fal_client.run,
        "fal-ai/flux/dev/image-to-image",
        arguments={
            "prompt": prompt,
            "image_url": fal_image_url,
            "strength": 0.70,
            "num_inference_steps": 28,
            "guidance_scale": 3.5,
            "num_images": 1,
            "output_format": "jpeg",
            "enable_safety_checker": False,
        },
    )
    return result["images"][0]["url"]


async def run_flux_schnell(prompt: str, fal_client) -> str:
    """Run FLUX Schnell text-to-image → return image URL."""
    result = await asyncio.to_thread(
        fal_client.run,
        "fal-ai/flux/schnell",
        arguments={
            "prompt": prompt,
            "image_size": "square_hd",
            "num_images": 1,
            "num_inference_steps": 4,
            "output_format": "jpeg",
        },
    )
    return result["images"][0]["url"]


# ── Routes ───────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "fal_key_configured": bool(FAL_KEY),
        "endpoints": ["/smart-generate", "/generate", "/analyze-decoration"],
    }


@app.post("/smart-generate")
async def smart_generate(req: SmartGenerateRequest):
    """
    AI-driven generation pipeline:
      1. gemini-flash reads all DB kits + items → selects best combination
         within budget + writes the FLUX prompt
      2. Selected IDs validated against input lists (no hallucinations)
      3. Budget validated (AI total <= budget_max)
      4. FLUX Pro Fill (with room photo) or FLUX Schnell (text-only) generates image

    Returns:
      image_url, selected_kit_id, selected_item_ids, selected_rent_ids, prompt_used
    """
    import fal_client

    if not FAL_KEY:
        raise HTTPException(status_code=500, detail="FAL_KEY not configured on server")

    # ── STEP 1: Prepare simplified data for gemini (minimize tokens) ────────
    kits_for_ai = [
        {
            "id": k.get("id", ""),
            "name": k.get("name", ""),
            "occasion_tags": k.get("occasion_tags", ""),
            "selling_total": k.get("selling_total", 0),
            "color_theme": k.get("color_theme", ""),
        }
        for k in req.kits
        if k.get("id")
    ]

    items_for_ai = [
        {
            "id": i.get("id", ""),
            "name": i.get("name", ""),
            "category": i.get("category", ""),
            "color": i.get("color", ""),
            "price": i.get("price", 0),
            "size": i.get("size", ""),
        }
        for i in req.items
        if i.get("id")
    ]

    rent_for_ai = [
        {
            "id": r.get("id", ""),
            "name": r.get("name", ""),
            "category": r.get("category", ""),
            "price": r.get("price", 0),
        }
        for r in req.rent_items
        if r.get("id")
    ]

    has_user_image = bool(req.image_base64 and "base64" in req.image_base64)

    # ── STEP 2: gemini-flash — select items + write FLUX prompt ─────────────
    selection_system = (
        "You are a professional Indian event decoration planner for FatafatDecor. "
        "Given customer requirements and available inventory, select the best decoration "
        "combination within budget and write a vivid image generation prompt. "
        "You MUST only use IDs exactly as given — never invent IDs. "
        "You MUST ensure total cost (kit + items + rent) does not exceed budget_max. "
        "Respond ONLY with valid JSON, no markdown, no explanation."
    )

    image_context = (
        "The customer has uploaded their room photo. The FLUX prompt must instruct "
        "the AI to keep ALL existing furniture, walls and structure unchanged and "
        "ONLY ADD decorations on top."
        if has_user_image
        else (
            "No room photo uploaded. The FLUX prompt should describe a full "
            "photorealistic decorated room from scratch."
        )
    )

    selection_prompt = f"""Customer requirements:
- Occasion: {req.occasion}
- Room type: {req.room_type}
- Budget: Rs {req.budget_min} to Rs {req.budget_max}
- Special request: {req.description or 'none'}
- {image_context}

AVAILABLE KITS (pick ONE kit whose selling_total <= {req.budget_max}, or null if none fit):
{json_lib.dumps(kits_for_ai)}

AVAILABLE ITEMS (pick items to fill remaining budget after kit — total of kit + items must be <= {req.budget_max}):
{json_lib.dumps(items_for_ai)}

RENT ITEMS (optional — pick max 2 only if budget > 5000 and remaining budget allows):
{json_lib.dumps(rent_for_ai)}

Rules:
1. selected_kit_id must be an exact id from AVAILABLE KITS above, or null
2. selected_item_ids must be exact ids from AVAILABLE ITEMS above only
3. selected_rent_ids must be exact ids from RENT ITEMS above only (max 2)
4. Total cost = kit selling_total + sum of selected item prices + sum of selected rent prices — must be <= {req.budget_max}
5. flux_prompt: vivid, photorealistic, describes colors/arrangement/mood, NO brand names, NO text in image, includes "{NO_TEXT}"

Respond ONLY with this exact JSON structure:
{{
  "selected_kit_id": "exact_id_or_null",
  "selected_item_ids": ["id1", "id2"],
  "selected_rent_ids": ["id1"],
  "flux_prompt": "Full FLUX image generation prompt here..."
}}"""

    try:
        sel_result = await asyncio.to_thread(
            fal_client.run,
            "fal-ai/any-llm",
            arguments={
                "model": "google/gemini-flash-1-5",
                "system_prompt": selection_system,
                "prompt": selection_prompt,
            },
        )
        selections = parse_json_safe(sel_result["output"])
    except (json_lib.JSONDecodeError, KeyError, Exception) as e:
        print(f"[smart-generate] gemini selection failed: {e}\n{traceback.format_exc()}")
        raise HTTPException(
            status_code=500,
            detail=f"AI selection failed: {str(e)}. Please try again.",
        )

    # ── STEP 3: Validate all returned IDs against actual input lists ─────────
    valid_kit_ids   = {k["id"] for k in kits_for_ai}
    valid_item_ids  = {i["id"] for i in items_for_ai}
    valid_rent_ids  = {r["id"] for r in rent_for_ai}

    raw_kit_id    = selections.get("selected_kit_id")
    raw_item_ids  = selections.get("selected_item_ids", [])
    raw_rent_ids  = selections.get("selected_rent_ids", [])
    flux_prompt   = selections.get("flux_prompt", "").strip()

    # Only keep IDs that actually exist
    sel_kit_id   = raw_kit_id if raw_kit_id in valid_kit_ids else None
    sel_item_ids = [i for i in raw_item_ids if i in valid_item_ids]
    sel_rent_ids = [r for r in raw_rent_ids if r in valid_rent_ids][:2]  # hard cap 2

    # ── STEP 4: Validate budget ──────────────────────────────────────────────
    kit_price_map  = {k["id"]: k.get("selling_total", 0) for k in kits_for_ai}
    item_price_map = {i["id"]: i.get("price", 0) for i in items_for_ai}
    rent_price_map = {r["id"]: r.get("price", 0) for r in rent_for_ai}

    total_ai = (
        (kit_price_map.get(sel_kit_id, 0) if sel_kit_id else 0)
        + sum(item_price_map.get(i, 0) for i in sel_item_ids)
        + sum(rent_price_map.get(r, 0) for r in sel_rent_ids)
    )
    # If AI overspent — trim rent items first, then add-ons
    if total_ai > req.budget_max:
        sel_rent_ids = []
        total_ai = (
            (kit_price_map.get(sel_kit_id, 0) if sel_kit_id else 0)
            + sum(item_price_map.get(i, 0) for i in sel_item_ids)
        )
    if total_ai > req.budget_max:
        # Trim add-on items one by one from cheapest
        sel_item_ids_sorted = sorted(sel_item_ids, key=lambda i: item_price_map.get(i, 0), reverse=True)
        trimmed, running = [], (kit_price_map.get(sel_kit_id, 0) if sel_kit_id else 0)
        for iid in sel_item_ids_sorted:
            p = item_price_map.get(iid, 0)
            if running + p <= req.budget_max:
                trimmed.append(iid)
                running += p
        sel_item_ids = trimmed

    # ── STEP 5: Ensure we have a usable prompt ──────────────────────────────
    if not flux_prompt or len(flux_prompt) < 30:
        # Build a safe fallback prompt
        item_names = [
            i.get("name", "") for i in req.items if i.get("id") in set(sel_item_ids)
        ][:8]
        kit_obj = next((k for k in req.kits if k.get("id") == sel_kit_id), None)
        item_desc = ", ".join(item_names) or f"{req.occasion} decorations"
        if has_user_image:
            flux_prompt = (
                f"Decorate this exact {req.room_type} for a {req.occasion} celebration. "
                f"Keep all existing furniture and walls unchanged. Add only: {item_desc}. "
                f"{NO_TEXT} Photorealistic, warm ambient lighting."
            )
        else:
            flux_prompt = (
                f"Professional photorealistic {req.room_type} decorated for {req.occasion}. "
                f"Show: {item_desc}. "
                f"{NO_TEXT} High quality event decoration photography, warm lighting, 4K."
            )

    # Always append NO_TEXT guard (in case gemini forgot it)
    if "text-free" not in flux_prompt.lower() and "no text" not in flux_prompt.lower():
        flux_prompt = f"{flux_prompt} {NO_TEXT}"

    # ── STEP 6: FLUX generates the image ────────────────────────────────────
    try:
        if has_user_image:
            image_url = await run_flux_fill(flux_prompt, req.image_base64, fal_client)
        else:
            image_url = await run_flux_schnell(flux_prompt, fal_client)
    except Exception as e:
        print(f"[smart-generate] FLUX error:\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Image generation failed: {str(e)}")

    return {
        "success": True,
        "image_url": image_url,
        "selected_kit_id": sel_kit_id,
        "selected_item_ids": sel_item_ids,
        "selected_rent_ids": sel_rent_ids,
        "prompt_used": flux_prompt,
    }


@app.post("/generate")
async def generate_decoration(req: GenerateRequest):
    """
    Direct FLUX generation — used as fallback if /smart-generate fails.
    Accepts a pre-built prompt + optional room photo.
    """
    import fal_client
    try:
        if req.image_base64:
            image_url = await run_flux_fill(req.prompt, req.image_base64, fal_client)
        else:
            image_url = await run_flux_schnell(req.prompt, fal_client)
        return {"image_url": image_url, "success": True}
    except Exception as e:
        print(f"[generate] FLUX error:\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze-decoration")
async def analyze_decoration(req: AnalyzeRequest):
    """
    Admin-only: Upload a decoration photo → gemini-flash vision analyzes it →
    returns full item list with Indian pricing + kit name.
    Used in AdminScreen to auto-create kits from reference photos.
    """
    import fal_client
    result_text = ""
    try:
        img_data = req.image_base64
        if ',' in img_data:
            img_data = img_data.split(',', 1)[1]
        image_bytes = base64.b64decode(img_data)
        image_file = io.BytesIO(image_bytes)
        image_file.name = "decoration.jpg"
        image_url = await asyncio.to_thread(
            fal_client.upload, image_file, content_type="image/jpeg"
        )

        system_prompt = """You are an expert event decoration analyst for FatafatDecor India. Count ALL items accurately.

FIRST: Generate a unique creative kit name (e.g., "Rose Gold Birthday Glam Backdrop").

COUNTING RULES:
- Count EVERY single balloon. Walls: 100-500+. Arches: 80-350. Count one row × rows.
- Better to slightly overcount than undercount.

SCREENSHOT DETECTION:
- If image has phone UI/status bar, set "is_screenshot": true and ignore UI elements.

Categories: balloons / neon_signs / backdrop / props / lights / table_decor / banners / flowers / drapes / candles / streamers / confetti / centerpieces / garlands / ribbons / curtains / other

FATAFAT DECOR PRICES (INR):
BALLOONS: Coloured Latex 10-12in Rs10-14, Pastel Rs18, Chrome Rs16, Mix Rs21, Confetti Rs33, Large 20in Rs78, Jumbo 36in Rs650
FOIL BALLOONS: Heart 12in Rs78, Letter/Number 16in Rs195, Letter 32in Rs260, Jumbo 40in Rs390, Teddy Bear Rs260
BACKDROPS: Net Large Rs650, Foil Curtain Rs455, White Net Set Rs462, Colour Net Rs520, Disco Rs5265
LIGHTING: LED Curtain Rs982, LED Candle Set Rs520
NEON SIGNS: Happy Birthday Rs2600, Lets Party Rs2600, Good Vibes Rs2990, Bride To Be Rs2600
PROPS: LED Letter Rs650, Paper Box Set Rs910, Artificial Flowers Rs1560

Respond ONLY with valid JSON (no markdown):
{
  "decoration_type": "Creative unique kit name",
  "is_screenshot": false,
  "color_theme": "dominant colors",
  "occasion_suggestion": "birthday/wedding/anniversary/party/baby_shower/corporate/engagement",
  "room_suggestion": "Living Room/Hall/Garden/Dining Room/Balcony",
  "difficulty": "easy/medium/hard",
  "setup_time_minutes": 60,
  "items": [
    {"name":"...","category":"...","color":"...","size":"...","quantity":0,"estimated_unit_price":0}
  ],
  "total_items_cost": 0,
  "suggested_labor_cost": 500,
  "suggested_travel_cost": 500,
  "suggested_final_price": 0,
  "notes": "setup tips"
}"""

        result = await asyncio.to_thread(
            fal_client.run,
            "fal-ai/any-llm",
            arguments={
                "model": "google/gemini-flash-1-5",
                "system_prompt": system_prompt,
                "prompt": f"Analyze this decoration image{(' named: ' + req.name) if req.name else ''}. Count ALL items. Use FatafatDecor Indian pricing.",
                "image_url": image_url,
            },
        )

        result_text = result["output"].strip()
        analysis = parse_json_safe(result_text)
        analysis["success"] = True
        analysis["image_name"] = req.name
        return analysis

    except (ValueError, json_lib.JSONDecodeError) as e:
        print(f"[analyze-decoration] JSON parse error: {e}")
        return {"success": False, "error": "Failed to parse AI response", "raw": result_text[:500]}
    except Exception as e:
        print(f"[analyze-decoration] error:\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))
