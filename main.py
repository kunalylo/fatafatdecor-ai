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
import struct
import zlib

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

# ── gpt-image-1 via Emergent proxy ───────────────────────────
EMERGENT_API_KEY  = os.environ.get("EMERGENT_LLM_KEY", "sk-emergent-e1b3859D8366151216")
EMERGENT_BASE_URL = "https://integrations.emergentagent.com/llm"
OPENAI_API_KEY    = os.environ.get("OPENAI_API_KEY", "")

def _openai_client():
    from openai import OpenAI
    if OPENAI_API_KEY:
        return OpenAI(api_key=OPENAI_API_KEY)
    return OpenAI(api_key=EMERGENT_API_KEY, base_url=EMERGENT_BASE_URL)

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


def _make_mask_png(width: int = 512, height: int = 512) -> bytes:
    """
    Generate a decoration mask PNG in pure Python (struct + zlib, no PIL).

    FLUX Pro Fill mask convention:  white (255) = fill area,  black (0) = preserve.
    Gradient zones (top → bottom):
      0 – 15 %   ceiling          255  ← place ceiling decorations here
      15 – 75 %  walls / beams    220  ← place wall decorations here
      75 – 88 %  lower walls      140  ← moderate decoration
      88 – 100 % floor / furn.     30  ← preserve almost entirely
    """
    def _png_chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    rows = bytearray()
    for y in range(height):
        f = y / height
        if   f < 0.15: v = 255
        elif f < 0.75: v = 220
        elif f < 0.88: v = 140
        else:          v = 30
        rows += b"\x00" + bytes([v] * width)   # filter-type 0 + pixel row

    png  = b"\x89PNG\r\n\x1a\n"
    png += _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
    png += _png_chunk(b"IDAT", zlib.compress(bytes(rows), 9))
    png += _png_chunk(b"IEND", b"")
    return png


async def run_gpt_image_edit(prompt: str, image_base64: str, fal_client) -> str:
    """
    gpt-image-1 via Emergent proxy — the correct model for decoration editing.
    Takes the room photo + decoration instructions → returns a decorated image.
    After generation, uploads result to fal storage so route.js gets a URL.
    """
    import requests as http_requests

    img_data = image_base64
    if "," in img_data:
        img_data = img_data.split(",", 1)[1]
    image_bytes = base64.b64decode(img_data)

    def _edit():
        client    = _openai_client()
        img_file  = io.BytesIO(image_bytes)
        img_file.name = "room.png"
        response  = client.images.edit(
            model  = "gpt-image-1",
            image  = img_file,
            prompt = prompt,
            n      = 1,
            size   = "1024x1024",
        )
        img = response.data[0]
        if hasattr(img, "b64_json") and img.b64_json:
            return base64.b64decode(img.b64_json)
        if hasattr(img, "url") and img.url:
            return http_requests.get(img.url, timeout=60).content
        raise Exception("No image returned from gpt-image-1")

    result_bytes = await asyncio.to_thread(_edit)

    # Upload result to fal storage → return a permanent URL
    result_url = await asyncio.to_thread(
        fal_client.upload, result_bytes, content_type="image/png"
    )
    return result_url


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


# ── Decoration prompt builder ────────────────────────────────

def _item_to_visual(name: str, color: str = "") -> str:
    """Map a decoration item name → specific visual placement instruction."""
    n = name.lower()
    c = f"{color.strip()} " if color and color.lower() not in ("mixed", "mix", "various", "") else ""

    # ── Balloons ──
    if "confetti balloon" in n or ("confetti" in n and "balloon" in n):
        return f"transparent confetti-filled balloons floating throughout the space, confetti visible inside each balloon"
    if "heart balloon" in n:
        return f"large {c}heart-shaped foil balloons floating in clusters"
    if "foil number" in n or ("number" in n and "balloon" in n and "foil" in n):
        return f"giant shiny {c}foil number balloons prominently displayed at center height"
    if "foil letter" in n or ("letter" in n and "balloon" in n):
        return f"large {c}foil letter balloons arranged as a festive message"
    if "jumbo" in n and "balloon" in n:
        return f"oversized jumbo {c}balloons as dramatic focal points"
    if "chrome" in n and "balloon" in n:
        return f"shiny chrome {c}balloons in clusters covering the walls and ceiling"
    if "pastel" in n and "balloon" in n:
        return f"soft pastel {c}balloons densely covering the walls from floor to ceiling"
    if "latex balloon" in n or ("balloon" in n and "foil" not in n):
        return f"hundreds of colorful {c}latex balloons in mix palette densely covering every wall and the entire ceiling, clustered from floor to ceiling"

    # ── Backdrops ──
    if "foil backdrop" in n or ("backdrop" in n and "foil" in n) or ("backdrop" in n and "curtain" in n):
        col = "silver" if "silver" in n else ("gold" if "gold" in n else c.strip() or "silver")
        return f"a full-wall floor-to-ceiling glittering {col} foil curtain backdrop shimmering as the main focal point behind the celebration area"
    if "net backdrop" in n or "backdrop" in n:
        return f"a large {c}net backdrop covering the main wall completely"
    if "disco" in n and "backdrop" in n:
        return f"a full-wall holographic disco foil backdrop creating a dazzling light show effect"

    # ── Lights ──
    if "led curtain" in n:
        return f"sparkling LED curtain light strings draped across the entire ceiling like a glowing canopy"
    if "fairy light" in n or "string light" in n:
        return f"warm fairy lights strung across the ceiling and walls"
    if "neon" in n:
        return f"a vibrant glowing neon sign mounted prominently on the main wall"
    if "candle" in n or "led candle" in n:
        return f"elegant LED flameless candles as glowing centerpieces on every surface"

    # ── Floral ──
    if "marigold" in n:
        return f"lush marigold garlands draped along the walls and ceiling in traditional style"
    if "rose petal" in n or "petal" in n:
        return f"thousands of rose petals scattered on the floor forming a beautiful carpet"
    if "flower" in n or "floral" in n or "artificial flower" in n:
        return f"lush {c}floral arrangements as centerpieces and wall accents"

    # ── Structural ──
    if "arch" in n or "balloon stand" in n:
        return f"a grand full-height balloon arch framing the main entrance or focal wall"
    if "marquee" in n or "led letter" in n:
        return f"large illuminated marquee letters glowing on the main wall"
    if "streamer" in n:
        return f"thick clusters of {c}streamers cascading from the ceiling"
    if "banner" in n:
        return f"a large festive celebration banner prominently displayed on the main wall"
    if "garland" in n:
        return f"decorative {c}garlands strung wall-to-wall across the space"
    if "drape" in n or ("curtain" in n and "foil" not in n and "led" not in n):
        return f"elegant {c}fabric draping along the walls"
    if "table" in n or "centerpiece" in n:
        return f"beautifully decorated table centerpieces with {c}festive arrangements"

    # Generic fallback
    return f"{name} prominently displayed as part of the festive decoration"


def _build_decoration_prompt(
    occasion: str,
    room_type: str,
    description: str,
    kit_obj: dict | None,
    sel_items: list,
    sel_rents: list,
    has_image: bool,
) -> str:
    """Build a precise, guaranteed-coverage FLUX decoration prompt from actual selected items."""

    # Collect visual instructions for every selected item
    visuals: list[str] = []
    seen: set[str] = set()

    # Kit BOM items (structural items inside the kit)
    if kit_obj:
        bom = kit_obj.get("bom") or kit_obj.get("kit_items") or []
        for bi in bom:
            name = bi.get("item") or bi.get("name") or ""
            if name and name.lower() not in seen:
                v = _item_to_visual(name)
                visuals.append(v)
                seen.add(name.lower())

    # Individually selected add-on items
    for item in sel_items:
        name  = item.get("name", "")
        color = item.get("color") or item.get("type_finish") or ""
        if name and name.lower() not in seen:
            v = _item_to_visual(name, color)
            visuals.append(v)
            seen.add(name.lower())

    # Rental items
    for r in sel_rents:
        name = r.get("name", "")
        if name and name.lower() not in seen:
            v = _item_to_visual(name)
            visuals.append(v)
            seen.add(name.lower())

    # Fallback if nothing selected
    if not visuals:
        visuals = [
            "hundreds of colorful balloons densely covering every wall and ceiling",
            "glittering foil backdrop curtain on the main wall",
            "colorful streamers cascading from ceiling",
            "festive garlands and banners",
        ]

    decoration_lines = "\n".join(f"- {v}" for v in visuals)
    special = f" Special customer request: {description}." if description else ""

    # Build natural flowing scene description for kontext
    decoration_sentence = ", ".join(visuals) if visuals else f"colorful {occasion} party decorations"

    if has_image:
        return (
            f"Decorate this {room_type} for a {occasion} celebration. "
            f"Add ONLY these exact decoration items — nothing else:\n"
            f"{decoration_sentence}.\n"
            f"Place every item realistically as a professional decorator would. "
            f"Keep all furniture, floor and walls exactly as they are — "
            f"only add the listed decorations on top. "
            f"Make it look like a real professionally decorated space.{special} {NO_TEXT}"
        )
    else:
        return (
            f"Professional photorealistic {room_type} decorated for a {occasion} celebration. "
            f"Decorations: {decoration_sentence}. "
            f"Every item prominently placed, dense and vibrant, warm festive lighting.{special} {NO_TEXT}"
        )


# ── Routes ───────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "fal_key_configured": bool(FAL_KEY),
        "endpoints": ["/smart-generate", "/generate", "/analyze-decoration"],
    }


@app.get("/debug-prompt")
async def debug_prompt():
    """
    Returns a real example of the prompt sent to the image model.
    Uses the Boss Baby Blast kit (same as in the app) so you can see exactly
    what instructions the model receives for a Birthday decoration.
    """
    example_kit = {
        "id": "KTS-001", "name": "Boss Baby Blast",
        "bom": [
            {"item": "Latex Balloons (Mix palette)", "qty": 200, "uom": "pcs"},
            {"item": "Foil Backdrop Curtain Silver",  "qty": 1,   "uom": "pcs"},
        ],
    }
    example_items = [
        {"id": "i1", "name": "Foil Number Balloon",          "color": "Silver"},
        {"id": "i2", "name": "Transparent Confetti Balloon", "color": ""},
        {"id": "i3", "name": "Mix Balloon Set",              "color": "Mix"},
        {"id": "i4", "name": "LED Pillar Candle Set (3 pcs)","color": ""},
    ]
    prompt_with_image = _build_decoration_prompt(
        occasion   = "Birthday",
        room_type  = "Rooftop Terrace",
        description= "",
        kit_obj    = example_kit,
        sel_items  = example_items,
        sel_rents  = [],
        has_image  = True,
    )
    prompt_no_image = _build_decoration_prompt(
        occasion   = "Birthday",
        room_type  = "Living Room",
        description= "Pink and gold theme",
        kit_obj    = example_kit,
        sel_items  = example_items,
        sel_rents  = [],
        has_image  = False,
    )
    return {
        "note": "This is the EXACT prompt structure sent to the AI image model",
        "step_1_gemini_vision_asks": (
            "In exactly 2 sentences describe ONLY the physical space: "
            "room/venue type, size, dominant colors, key furniture, "
            "walls, ceiling and architectural features. Facts only, no suggestions."
        ),
        "step_2_final_prompt_WITH_room_photo": (
            "[Gemini room description here] "
            "A professional event decorator has transformed this exact space. "
            + prompt_with_image
        ),
        "step_2_final_prompt_WITHOUT_room_photo": prompt_no_image,
        "model_used": "fal-ai/flux-pro/v1/fill (inpainting) → fallback: fal-ai/flux-pro/kontext/max",
        "mask": "Gradient PNG: ceiling=white(255), walls=220, lower=140, floor=dark(30)",
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

    # ── STEP 2: gemini-flash — item SELECTION only (prompt built by us) ────────
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

    # ── STEP 5: Build FLUX prompt from actual selected items (guaranteed coverage) ──
    flux_prompt = _build_decoration_prompt(
        occasion    = req.occasion,
        room_type   = req.room_type,
        description = req.description or "",
        kit_obj     = next((k for k in req.kits if k.get("id") == sel_kit_id), None),
        sel_items   = [i for i in req.items      if i.get("id") in set(sel_item_ids)],
        sel_rents   = [r for r in req.rent_items if r.get("id") in set(sel_rent_ids)],
        has_image   = has_user_image,
    )

    # Log full prompt so it's visible in Railway logs
    print(f"\n{'='*60}\n[PROMPT SENT TO MODEL]\n{flux_prompt}\n{'='*60}\n")

    # ── STEP 6: Generate the decorated image ────────────────────────────────
    try:
        if has_user_image:
            image_url = await run_gpt_image_edit(flux_prompt, req.image_base64, fal_client)
        else:
            image_url = await run_flux_schnell(flux_prompt, fal_client)
    except Exception as e:
        print(f"[smart-generate] generation error:\n{traceback.format_exc()}")
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
            image_url = await run_gpt_image_edit(req.prompt, req.image_base64, fal_client)
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
    Used in AdminScreen to auto-create kits from reference photos.
    """
    import fal_client
    result_text = ""
    try:
        img_data = req.image_base64
        if ',' in img_data:
            img_data = img_data.split(',', 1)[1]
        image_bytes = base64.b64decode(img_data)
        # fal_client.upload expects raw bytes
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
