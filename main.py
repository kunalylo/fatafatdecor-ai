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
#   POST /smart-generate      — Gemini selects items → gpt-image-1 decorates photo
#   POST /generate            — direct generation (fallback / legacy)
#   POST /analyze-decoration  — fal.ai vision → decoration item list (admin only)
#
# Image generation: gpt-image-1 via Emergent proxy (with photo) / fal flux/schnell (no photo)
# Item selection:   fal-ai/any-llm → google/gemini-flash-1-5
# ============================================================

FAL_KEY           = os.environ.get("FAL_KEY", "")
os.environ["FAL_KEY"] = FAL_KEY

EMERGENT_API_KEY  = os.environ.get("EMERGENT_LLM_KEY", "sk-emergent-e1b3859D8366151216")
EMERGENT_BASE_URL = "https://integrations.emergentagent.com/llm"

NO_TEXT = (
    "Do NOT add any text, words, letters, numbers, or labels anywhere in the image — "
    "no text on balloons, banners, backdrops, walls, or any surface. Completely text-free."
)


# ── Request models ──────────────────────────────────────────

class SmartGenerateRequest(BaseModel):
    budget_min: int
    budget_max: int
    occasion: str
    room_type: str
    description: Optional[str] = ""
    image_base64: Optional[str] = None
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
    text = re.sub(r'^```(?:json)?\s*', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\s*```$', '', text)
    if text.lower().startswith('json'):
        text = text[4:].lstrip()
    return json_lib.loads(text.strip())


def _compress_image(image_base64: str, max_px: int = 1024, quality: int = 88) -> bytes:
    """
    Resize image to max_px on longest side and convert to JPEG.
    Reduces payload from potentially 5MB+ → ~150-300KB.
    Faster transfer to Emergent → OpenAI → faster total time.
    """
    from PIL import Image
    img_data = image_base64
    if "," in img_data:
        img_data = img_data.split(",", 1)[1]
    raw = base64.b64decode(img_data)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = img.size
    if max(w, h) > max_px:
        scale = max_px / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


async def run_gpt_image_edit(prompt: str, image_bytes: bytes) -> str:
    """
    gpt-image-1 via Emergent proxy — edits room photo to add decorations.
    image_bytes: already compressed JPEG bytes (not base64).
    Returns base64 data URL of the decorated image.
    """
    from openai import OpenAI
    client = OpenAI(api_key=EMERGENT_API_KEY, base_url=EMERGENT_BASE_URL)

    response = await asyncio.to_thread(
        client.images.edit,
        model="gpt-image-1",
        image=("room.jpg", image_bytes, "image/jpeg"),
        prompt=prompt,
        n=1,
        size="1024x1024",
    )
    b64 = response.data[0].b64_json
    return f"data:image/png;base64,{b64}"


async def run_flux_schnell(prompt: str, fal_client) -> str:
    """fal flux/schnell text-to-image — used when no room photo uploaded."""
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


# ── Decoration prompt builder ────────────────────────────────

_TOOL_KEYWORDS = {
    "glue dot", "glue", "tape", "ribbon roll", "ribbon",
    "fishing string", "zip tie", "wire", "nail", "hook",
    "clip", "adhesive", "string roll", "tools", "supplies",
    "fastener", "mount", "bracket",
}

def _is_visual_item(name: str) -> bool:
    n = name.lower()
    return not any(kw in n for kw in _TOOL_KEYWORDS)


def _item_to_visual(name: str, color: str = "") -> str:
    """Map a decoration item name → specific visual description for gpt-image-1."""
    n = name.lower()
    c = f"{color.strip()} " if color and color.lower() not in ("mixed", "mix", "various", "") else ""

    # ── Balloons ──
    if "confetti balloon" in n or ("confetti" in n and "balloon" in n):
        return f"transparent balloons filled with colorful confetti floating throughout the space"
    if "heart balloon" in n:
        return f"large {c}heart-shaped foil balloons floating in clusters near the ceiling"
    if "foil number" in n or ("number" in n and "balloon" in n and "foil" in n):
        return f"giant shiny {c}foil number balloons standing prominently at eye level"
    if "foil letter" in n or ("letter" in n and "balloon" in n):
        return f"large {c}foil letter balloons spelling a festive message"
    if "jumbo" in n and "balloon" in n:
        return f"oversized jumbo {c}balloons placed as dramatic focal points around the room"
    if "chrome" in n and "balloon" in n:
        return f"shiny metallic chrome {c}balloons in clusters across the ceiling and walls"
    if "pastel" in n and "balloon" in n:
        return f"hundreds of soft pastel {c}balloons covering the walls and ceiling densely"
    if "latex balloon" in n or ("balloon" in n and "foil" not in n):
        return f"hundreds of colorful {c}latex balloons densely covering every wall and the entire ceiling from floor to ceiling"

    # ── Backdrops ──
    if "foil backdrop" in n or ("backdrop" in n and "foil" in n) or ("backdrop" in n and "curtain" in n):
        col = "silver" if "silver" in n else ("gold" if "gold" in n else c.strip() or "silver")
        return f"a stunning full-wall {col} metallic foil curtain backdrop covering the entire back wall from floor to ceiling, shimmering brilliantly"
    if "disco" in n and "backdrop" in n:
        return f"a full-wall holographic disco foil backdrop creating a dazzling reflective effect"
    if "net backdrop" in n or "backdrop" in n:
        return f"a large {c}decorative net backdrop covering the main wall completely"

    # ── Lights ──
    if "led curtain" in n:
        return f"a sparkling LED curtain light canopy draped across the entire ceiling, glowing warmly"
    if "fairy light" in n or "string light" in n:
        return f"warm glowing fairy lights strung across the ceiling and along the walls"
    if "neon" in n:
        return f"a vibrant glowing neon sign mounted prominently on the main wall"
    if "candle" in n or "led candle" in n:
        return f"elegant LED flameless candles glowing on every surface and table"

    # ── Floral ──
    if "marigold" in n:
        return f"lush traditional marigold garlands draped along the walls and ceiling"
    if "rose petal" in n or "petal" in n:
        return f"thousands of rose petals scattered across the floor forming a beautiful petal carpet"
    if "flower" in n or "floral" in n or "artificial flower" in n:
        return f"lush {c}floral arrangements placed as centerpieces and wall accents"

    # ── Structural ──
    if "arch" in n or "balloon stand" in n:
        return f"a grand full-height balloon arch framing the main focal wall"
    if "marquee" in n or "led letter" in n:
        return f"large glowing illuminated marquee letters on the main wall"
    if "streamer" in n:
        return f"thick colorful {c}streamers cascading down from the ceiling"
    if "banner" in n:
        return f"a large festive celebration banner displayed prominently on the main wall"
    if "garland" in n:
        return f"decorative {c}garlands strung wall-to-wall across the room"
    if "drape" in n or ("curtain" in n and "foil" not in n and "led" not in n):
        return f"elegant {c}fabric draping along the walls"
    if "table" in n or "centerpiece" in n:
        return f"beautifully decorated table centerpieces with {c}festive arrangements"

    return f"{name} placed prominently as part of the festive decoration"


def _build_decoration_prompt(
    occasion: str,
    room_type: str,
    description: str,
    kit_obj: dict | None,
    sel_items: list,
    sel_rents: list,
    has_image: bool,
) -> str:
    """
    Build a gpt-image-1 optimised prompt.
    Describes the FINAL decorated state (not instructions) — works much better with gpt-image-1.
    """
    visuals: list[str] = []
    seen: set[str] = set()

    if kit_obj:
        bom = kit_obj.get("bom") or kit_obj.get("kit_items") or []
        for bi in bom:
            name = bi.get("item") or bi.get("name") or ""
            if name and name.lower() not in seen and _is_visual_item(name):
                visuals.append(_item_to_visual(name))
                seen.add(name.lower())

    for item in sel_items:
        name  = item.get("name", "")
        color = item.get("color") or item.get("type_finish") or ""
        if name and name.lower() not in seen and _is_visual_item(name):
            visuals.append(_item_to_visual(name, color))
            seen.add(name.lower())

    for r in sel_rents:
        name = r.get("name", "")
        if name and name.lower() not in seen and _is_visual_item(name):
            visuals.append(_item_to_visual(name))
            seen.add(name.lower())

    if not visuals:
        visuals = [
            "hundreds of colorful balloons densely covering every wall and ceiling",
            "a glittering silver foil curtain backdrop on the main wall",
            "colorful streamers cascading from the ceiling",
            "festive garlands strung across the room",
        ]

    special = f"\nSpecial request: {description}." if description else ""
    bullet_list = "\n".join(f"• {v}" for v in visuals)

    item_count = len(visuals)

    if has_image:
        return (
            f"A professional event decorator has fully decorated this {room_type} for a {occasion} celebration.\n\n"
            f"The decorator has placed ALL {item_count} of these items inside the room — every single one must be clearly visible:\n"
            f"{bullet_list}\n\n"
            f"CRITICAL: Each and every item listed above MUST appear in the image. "
            f"Do not skip or omit any item. All {item_count} decorations are present and clearly visible. "
            f"Every item is placed realistically with professional density and arrangement — "
            f"exactly as a real decorator would set it up. "
            f"The room's original furniture, walls, floor, and ceiling structure are completely unchanged — "
            f"only the listed decorations have been added on top. "
            f"The result looks like a genuine photograph of a professionally decorated venue.{special}\n\n"
            f"{NO_TEXT}"
        )
    else:
        return (
            f"A photorealistic photograph of a {room_type} professionally decorated for a {occasion} celebration.\n\n"
            f"ALL {item_count} of these decorations are present and clearly visible in the room:\n"
            f"{bullet_list}\n\n"
            f"Every single decoration listed above must appear. Dense, vibrant, realistically placed. "
            f"Warm festive lighting throughout.{special}\n\n"
            f"{NO_TEXT}"
        )


# ── Routes ───────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "fal_key_configured": bool(FAL_KEY),
        "image_model": "gpt-image-1 via Emergent proxy",
        "selection_model": "gemini-flash-1-5 via fal any-llm",
        "endpoints": ["/smart-generate", "/generate", "/analyze-decoration"],
    }


@app.post("/smart-generate")
async def smart_generate(req: SmartGenerateRequest):
    """
    Pipeline:
      1. Gemini selects best kit + items within budget  ─┐ (run in parallel)
      2. Room photo compressed to JPEG 1024px           ─┘
      3. IDs validated + budget enforced
      4. Prompt built from selected items (tool-filtered, gpt-image-1 optimised)
      5. gpt-image-1 edits the compressed room photo (with photo)
         OR fal flux/schnell generates from text (no photo)
    """
    import fal_client

    if not FAL_KEY:
        raise HTTPException(status_code=500, detail="FAL_KEY not configured on server")

    has_user_image = bool(req.image_base64 and "base64" in req.image_base64)

    # ── STEP 1: Prepare data for Gemini ─────────────────────────────────────
    kits_for_ai = [
        {
            "id": k.get("id", ""),
            "name": k.get("name", ""),
            "occasion_tags": k.get("occasion_tags", ""),
            "selling_total": k.get("selling_total", 0),
            "color_theme": k.get("color_theme", ""),
        }
        for k in req.kits if k.get("id")
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
        for i in req.items if i.get("id")
    ]
    rent_for_ai = [
        {
            "id": r.get("id", ""),
            "name": r.get("name", ""),
            "category": r.get("category", ""),
            "price": r.get("price", 0),
        }
        for r in req.rent_items if r.get("id")
    ]

    selection_system = (
        "You are a professional Indian event decoration planner for FatafatDecor. "
        "Select the best decoration kit + items within the customer's budget. "
        "You MUST only use IDs exactly as given — never invent IDs. "
        "You MUST ensure total cost (kit + items + rent) does not exceed budget_max. "
        "Respond ONLY with valid JSON, no markdown, no explanation."
    )
    selection_prompt = f"""Customer requirements:
- Occasion: {req.occasion}
- Room type: {req.room_type}
- Budget: Rs {req.budget_min} to Rs {req.budget_max}
- Special request: {req.description or 'none'}

AVAILABLE KITS (pick ONE kit whose selling_total <= {req.budget_max}, or null if none fit):
{json_lib.dumps(kits_for_ai)}

AVAILABLE ITEMS (pick items to fill remaining budget — total of kit + items must be <= {req.budget_max}):
{json_lib.dumps(items_for_ai)}

RENT ITEMS (optional — pick max 2 only if budget > 5000 and remaining budget allows):
{json_lib.dumps(rent_for_ai)}

Rules:
1. selected_kit_id must be an exact id from AVAILABLE KITS, or null
2. selected_item_ids must be exact ids from AVAILABLE ITEMS only
3. selected_rent_ids must be exact ids from RENT ITEMS only (max 2)
4. Total cost = kit selling_total + sum of item prices + sum of rent prices — must be <= {req.budget_max}

Respond ONLY with this exact JSON:
{{
  "selected_kit_id": "exact_id_or_null",
  "selected_item_ids": ["id1", "id2"],
  "selected_rent_ids": ["id1"]
}}"""

    # ── STEP 2: Run Gemini selection + image compression IN PARALLEL ─────────
    async def run_gemini():
        result = await asyncio.to_thread(
            fal_client.run,
            "fal-ai/any-llm",
            arguments={
                "model": "google/gemini-flash-1-5",
                "system_prompt": selection_system,
                "prompt": selection_prompt,
            },
        )
        return parse_json_safe(result["output"])

    async def compress_image():
        if not has_user_image:
            return None
        return await asyncio.to_thread(_compress_image, req.image_base64)

    try:
        selections, compressed_bytes = await asyncio.gather(
            run_gemini(),
            compress_image(),
        )
    except (json_lib.JSONDecodeError, KeyError, Exception) as e:
        print(f"[smart-generate] gemini/compress failed: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"AI selection failed: {str(e)}")

    # ── STEP 3: Validate IDs ─────────────────────────────────────────────────
    valid_kit_ids  = {k["id"] for k in kits_for_ai}
    valid_item_ids = {i["id"] for i in items_for_ai}
    valid_rent_ids = {r["id"] for r in rent_for_ai}

    sel_kit_id   = selections.get("selected_kit_id")
    sel_item_ids = selections.get("selected_item_ids", [])
    sel_rent_ids = selections.get("selected_rent_ids", [])

    sel_kit_id   = sel_kit_id if sel_kit_id in valid_kit_ids else None
    sel_item_ids = [i for i in sel_item_ids if i in valid_item_ids]
    sel_rent_ids = [r for r in sel_rent_ids if r in valid_rent_ids][:2]

    # ── STEP 4: Budget enforcement ───────────────────────────────────────────
    kit_price_map  = {k["id"]: k.get("selling_total", 0) for k in kits_for_ai}
    item_price_map = {i["id"]: i.get("price", 0) for i in items_for_ai}
    rent_price_map = {r["id"]: r.get("price", 0) for r in rent_for_ai}

    total_ai = (
        (kit_price_map.get(sel_kit_id, 0) if sel_kit_id else 0)
        + sum(item_price_map.get(i, 0) for i in sel_item_ids)
        + sum(rent_price_map.get(r, 0) for r in sel_rent_ids)
    )
    if total_ai > req.budget_max:
        sel_rent_ids = []
        total_ai = (
            (kit_price_map.get(sel_kit_id, 0) if sel_kit_id else 0)
            + sum(item_price_map.get(i, 0) for i in sel_item_ids)
        )
    if total_ai > req.budget_max:
        sel_item_ids_sorted = sorted(sel_item_ids, key=lambda i: item_price_map.get(i, 0), reverse=True)
        trimmed, running = [], (kit_price_map.get(sel_kit_id, 0) if sel_kit_id else 0)
        for iid in sel_item_ids_sorted:
            p = item_price_map.get(iid, 0)
            if running + p <= req.budget_max:
                trimmed.append(iid)
                running += p
        sel_item_ids = trimmed

    # ── STEP 5: Build prompt (gpt-image-1 optimised) ────────────────────────
    prompt = _build_decoration_prompt(
        occasion    = req.occasion,
        room_type   = req.room_type,
        description = req.description or "",
        kit_obj     = next((k for k in req.kits if k.get("id") == sel_kit_id), None),
        sel_items   = [i for i in req.items      if i.get("id") in set(sel_item_ids)],
        sel_rents   = [r for r in req.rent_items if r.get("id") in set(sel_rent_ids)],
        has_image   = has_user_image,
    )
    print(f"\n{'='*60}\n[PROMPT SENT TO MODEL]\n{prompt}\n{'='*60}\n")

    # ── STEP 6: Generate image ───────────────────────────────────────────────
    try:
        if has_user_image and compressed_bytes:
            image_url = await run_gpt_image_edit(prompt, compressed_bytes)
        else:
            image_url = await run_flux_schnell(prompt, fal_client)
    except Exception as e:
        print(f"[smart-generate] generation error:\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Image generation failed: {str(e)}")

    return {
        "success": True,
        "image_url": image_url,
        "selected_kit_id": sel_kit_id,
        "selected_item_ids": sel_item_ids,
        "selected_rent_ids": sel_rent_ids,
        "prompt_used": prompt,
    }


@app.post("/generate")
async def generate_decoration(req: GenerateRequest):
    """Direct generation — fallback endpoint."""
    import fal_client
    try:
        if req.image_base64:
            compressed = await asyncio.to_thread(_compress_image, req.image_base64)
            image_url  = await run_gpt_image_edit(req.prompt, compressed)
        else:
            image_url = await run_flux_schnell(req.prompt, fal_client)
        return {"image_url": image_url, "success": True}
    except Exception as e:
        print(f"[generate] error:\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze-decoration")
async def analyze_decoration(req: AnalyzeRequest):
    """
    Admin-only: Upload a decoration photo → gemini-flash vision analyzes it →
    returns full item list with Indian pricing + kit name.
    """
    import fal_client
    result_text = ""
    try:
        img_data = req.image_base64
        if ',' in img_data:
            img_data = img_data.split(',', 1)[1]
        image_bytes = base64.b64decode(img_data)
        image_url = await asyncio.to_thread(
            fal_client.upload, image_bytes, content_type="image/jpeg"
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
