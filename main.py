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
# Item selection:   fal-ai/any-llm → google/gemini-2.5-flash
# ============================================================

FAL_KEY        = os.environ.get("FAL_KEY", "")
os.environ["FAL_KEY"] = FAL_KEY

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")

# Image model — gpt-image-2 (state of the art) with automatic fallback to
# gpt-image-1 when the account/org doesn't have access yet. Override with the
# OPENAI_IMAGE_MODEL env var on Railway.
OPENAI_IMAGE_MODEL = os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-2")

# medium ≈ 60-80s and fits the mobile apps' 90s client timeout; set
# OPENAI_IMAGE_QUALITY=high on Railway once clients with longer timeouts roll out.
OPENAI_IMAGE_QUALITY = os.environ.get("OPENAI_IMAGE_QUALITY", "medium")


def _image_edit_call(client, image_param, prompt: str, size: str):
    """
    images.edit with the configured model; falls back to gpt-image-1 once if the
    configured model is unavailable. Returns (response, model_used).
    gpt-image-2 processes all inputs at high fidelity automatically and rejects
    the input_fidelity parameter — only send it for gpt-image-1.
    """
    def _call(model: str):
        kwargs = dict(model=model, image=image_param, prompt=prompt, n=1, size=size, quality=OPENAI_IMAGE_QUALITY)
        if model.startswith("gpt-image-1"):
            kwargs["extra_body"] = {"input_fidelity": "high"}
        return client.images.edit(**kwargs)

    try:
        return _call(OPENAI_IMAGE_MODEL), OPENAI_IMAGE_MODEL
    except Exception as e:
        if OPENAI_IMAGE_MODEL != "gpt-image-1":
            print(f"[image-edit] {OPENAI_IMAGE_MODEL} failed ({e}); falling back to gpt-image-1")
            return _call("gpt-image-1"), "gpt-image-1"
        raise

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


class DetectItemsRequest(BaseModel):
    image_url: Optional[str] = None
    image_base64: Optional[str] = None


class SkuCandidate(BaseModel):
    sku_code: str
    category: str = ""
    subcategory: str = ""
    color: str = ""
    finish: str = ""
    size_inches: float = 0
    shape: str = ""
    per_unit_cost: float = 0
    selling_price_per_unit: float = 0


class MatchSkusRequest(BaseModel):
    detection: dict       # { type, color, finish, size, shape, quantity, ... }
    candidates: List[SkuCandidate] = []


class GenerateTagsRequest(BaseModel):
    occasion: str = ""
    theme: str = ""
    setup_type: str = ""
    detected_items_summary: str = ""


class ValidateRoomRequest(BaseModel):
    """Pre-generation check that the customer's photo is a decoratable space."""
    image_base64: str


class GenerateItemImageRequest(BaseModel):
    """Attributes of a master_inventory SKU → clean product-shot image."""
    category: str = ""
    subcategory: str = ""
    color: str = ""
    finish: str = ""
    shape: str = ""
    size_inches: float = 0
    material: str = ""


class ReferenceStyleTransferRequest(BaseModel):
    """Customer's room + reference image → decorated room (multi-image gpt-image-1)."""
    room_image_base64: str       # data URL or raw base64 of customer's room photo
    reference_image_url: str     # ImageKit URL of the reference design
    occasion: str = ""
    theme: str = ""
    room_type: str = ""
    description: str = ""        # optional special request


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


def _best_output_size(image_bytes: bytes) -> str:
    """
    Match the output canvas to the room photo's orientation so gpt-image-1
    does not crop/recompose the room into a square. Supported sizes:
    1024x1024 (square), 1024x1536 (portrait), 1536x1024 (landscape).
    """
    from PIL import Image
    try:
        img = Image.open(io.BytesIO(image_bytes))
        w, h = img.size
        ratio = w / h
        if ratio <= 0.85:
            return "1024x1536"   # portrait (phone photos)
        if ratio >= 1.18:
            return "1536x1024"   # landscape
        return "1024x1024"
    except Exception:
        return "1024x1024"


async def run_gpt_image_edit(prompt: str, image_bytes: bytes) -> str:
    """
    gpt-image-1 — edits room photo to add decorations (single image mode).
    image_bytes: already compressed JPEG bytes (not base64).

    Fidelity settings (the difference between "a decorated room" and
    "THE CUSTOMER'S room decorated"):
      • input_fidelity=high — preserves the input photo's walls, furniture,
        faces and layout instead of re-imagining the room.
      • size matched to the photo's orientation — no square recomposition
        of portrait phone photos.
      • quality=high — best texture/detail rendering.
    Returns base64 data URL of the decorated image.
    """
    from openai import OpenAI
    client = OpenAI(api_key=OPENAI_API_KEY)

    response, model_used = await asyncio.to_thread(
        _image_edit_call, client,
        ("room.jpg", image_bytes, "image/jpeg"),
        prompt, _best_output_size(image_bytes),
    )
    print(f"[image-edit] single-image via {model_used}")
    b64 = response.data[0].b64_json
    return f"data:image/png;base64,{b64}"


async def run_gpt_image_edit_with_reference(
    prompt: str,
    room_bytes: bytes,
    reference_bytes: bytes,
) -> str:
    """
    gpt-image-1 multi-image — applies the decoration STYLE of the reference image
    to the customer's room. The room is the canvas; the reference is the style guide.
    Both inputs are pre-compressed JPEG bytes.
    Returns base64 data URL of the decorated image.
    """
    from openai import OpenAI
    client = OpenAI(api_key=OPENAI_API_KEY)

    response, model_used = await asyncio.to_thread(
        _image_edit_call, client,
        [
            ("room.jpg",      room_bytes,      "image/jpeg"),
            ("reference.jpg", reference_bytes, "image/jpeg"),
        ],
        prompt, _best_output_size(room_bytes),
    )
    print(f"[image-edit] style-transfer via {model_used}")
    b64 = response.data[0].b64_json
    return f"data:image/png;base64,{b64}", model_used


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
            f"A professional event decorator has fully decorated this exact {room_type} for a {occasion} celebration.\n\n"
            f"THIS IS THE CUSTOMER'S REAL ROOM — it must remain unmistakably the SAME room:\n"
            f"• Walls, floor, ceiling, doors, windows: identical colour, texture, trim and materials.\n"
            f"• Every piece of existing furniture and every object stays exactly where it is — "
            f"same position, orientation, scale and condition.\n"
            f"• Existing fixtures (lights, fans, switches, frames, appliances) are untouched.\n"
            f"• Camera angle, perspective, framing and proportions are IDENTICAL to the photo — "
            f"do not rotate, crop, zoom, or re-render the room from a different viewpoint.\n"
            f"• Any people or pets in the photo keep their exact faces, poses and clothing.\n\n"
            f"The decorator has ADDED all {item_count} of these items on top of the existing room — "
            f"every single one must be clearly visible:\n"
            f"{bullet_list}\n\n"
            f"CRITICAL: Each and every item listed above MUST appear in the image. "
            f"Do not skip or omit any item. All {item_count} decorations are present and clearly visible, "
            f"placed realistically with professional density and arrangement — "
            f"exactly as a real decorator would set them up in this specific room. "
            f"The result looks like a genuine photograph taken in the customer's own room "
            f"after the decorator finished.{special}\n\n"
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

VALIDATE_ROOM_PROMPT = """You check whether a customer's photo can be used to plan event decoration of their room or space.

USABLE (usable=true): any indoor space where at least one wall AND some floor or ceiling context is visible — even if empty, cluttered, small, or imperfectly lit. Outdoor gardens, terraces, and halls with clear ground and background also count. Be lenient: when in doubt, mark usable.

NOT USABLE (usable=false) — reason codes:
- "close_up": an extreme close-up of a curtain, window, door, or wall texture filling the whole frame with no floor/ceiling context of the room
- "screen_photo": a photograph of a phone/TV/computer screen that is showing a room
- "no_room": sky, trees, street, vehicles, documents, food, or a person/selfie/pet with no interior space visible
- "too_dark": too dark or blurry to make out the space at all

Respond ONLY with JSON:
{"usable": true|false, "reason": "<code or empty>", "message": "<one friendly sentence telling the customer HOW to retake the photo, e.g. 'Please step back and capture the full wall you want decorated, with some floor and ceiling visible.'>"}"""


@app.post("/validate-room")
async def validate_room(req: ValidateRoomRequest):
    """
    Fast, cheap vision pre-check (gpt-4o-mini, low detail) before the expensive
    generation call. Fail-open: any validator problem returns usable=true so
    generation is never blocked by the validator itself.
    """
    if not OPENAI_API_KEY:
        return {"usable": True, "reason": "validator_unavailable", "message": ""}
    try:
        jpeg = await asyncio.to_thread(_compress_image, req.image_base64, 512, 80)
        data_url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("utf-8")
        from openai import OpenAI
        client = OpenAI(api_key=OPENAI_API_KEY)
        resp = await asyncio.to_thread(
            client.chat.completions.create,
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": VALIDATE_ROOM_PROMPT},
                {"role": "user", "content": [
                    {"type": "text", "text": "Classify this photo."},
                    {"type": "image_url", "image_url": {"url": data_url, "detail": "low"}},
                ]},
            ],
            max_tokens=150,
            temperature=0,
        )
        parsed = parse_json_safe(resp.choices[0].message.content)
        return {
            "usable":  bool(parsed.get("usable", True)),
            "reason":  parsed.get("reason", ""),
            "message": parsed.get("message", ""),
        }
    except Exception as e:
        print(f"[validate-room] error (fail-open): {e}")
        return {"usable": True, "reason": "validator_error", "message": ""}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "fal_key_configured": bool(FAL_KEY),
        "openai_key_configured": bool(OPENAI_API_KEY),
        "image_model": "gpt-image-1 via OpenAI direct",
        "selection_model": "gemini-2.5-flash via fal any-llm",
        "endpoints": [
            "/smart-generate", "/generate", "/analyze-decoration",
            "/detect-items", "/match-skus", "/generate-tags", "/generate-item-image",
            "/style-transfer-from-reference",
        ],
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
                "model": "google/gemini-2.5-flash",
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
                "model": "google/gemini-2.5-flash",
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


# ============================================================
# NEW: Reference design pipeline endpoints
# ============================================================

DETECT_SYSTEM_PROMPT = (
    "You are an expert event-decoration analyst for FatafatDecor. "
    "Look at the decoration photo and identify EVERY visible balloon, foil, prop, "
    "backdrop, light and decorative item — be GENEROUS with counts, not conservative. "
    "Decoration photos typically have HUNDREDS of balloons, not dozens.\n\n"
    "COUNTING RULES (be aggressive — undercounting is the #1 mistake):\n"
    "• A balloon garland or arch typically contains 100-300 balloons.\n"
    "• A small visible cluster of balloons = at least 20-30 balloons.\n"
    "• A medium cluster (covers ~half a wall) = 50-100 balloons.\n"
    "• A large/dense cluster (covers a whole wall or full garland) = 150-300+ balloons.\n"
    "• Balloon walls covering an entire wall = 200-500 balloons.\n"
    "• ALWAYS round UP for clusters — if you think 40, say 60. If 100, say 150.\n"
    "• Split a multi-color cluster into separate entries by color+size+finish.\n"
    "• Within a single garland, balloons come in MULTIPLE sizes (5\", 10\", 12\", 18\") —\n"
    "  list each size as a separate entry with its own estimated quantity.\n\n"
    "SHAPE DISTINCTION (critical):\n"
    "• 'number' = digit 0-9 (record character e.g. '5')\n"
    "• 'letter' = A-Z (record character)\n"
    "• 'bottle' = champagne / wine / beer bottle shape (large foil)\n"
    "• 'heart' = heart shape\n"
    "• 'star' = star shape\n"
    "• 'round' = standard sphere balloon\n"
    "• 'other' = anything else (cake, crown, butterfly, etc.)\n\n"
    "FINISH DISTINCTION:\n"
    "• Matte = soft non-shiny\n"
    "• Chrome = highly reflective shiny metallic\n"
    "• Metallic = shimmery but less mirror-like than Chrome\n"
    "• Pearl = soft pearlescent sheen\n"
    "• Pastel = soft muted color\n"
    "• Confetti = transparent latex with confetti inside\n"
    "• Foil = mylar/foil material (usually for shapes, numbers, letters)\n"
    "• Holographic = iridescent rainbow shimmer\n\n"
    "COLOR: use specific names — White, Ivory, Cream, Champagne Gold, Gold, Rose Gold, "
    "Silver, Black, Pink, Hot Pink, Baby Pink, Red, Maroon, Blue, Navy, Pastel Blue, etc.\n\n"
    "SCAN THE WHOLE IMAGE ZONE BY ZONE before answering — ceiling, backdrop wall, "
    "left edge, right edge, floor, tables, background. Balloons are never the only "
    "items: also check for lights (fairy/LED/neon signs), drapes/curtains/net fabric, "
    "flowers (real or artificial), foil fringe curtains, banners, streamers, table "
    "decor, candles, lanterns, stands/arch frames, welcome boards and floor props.\n\n"
    "BALLOON SIZE CALIBRATION (standard sizes: 5, 10, 12, 18, 24, 36 inches):\n"
    "• 5\" = small filler (fist-sized) · 10-12\" = standard (human-head-sized)\n"
    "• 18\" = large (~1.5× a head) · 24\" = very large (2× a standard balloon)\n"
    "• 36\" = GIANT statement balloon (torso-sized or bigger)\n"
    "• Compare every balloon to the STANDARD balloons around it: if its diameter is\n"
    "  clearly 2-3× theirs, it is 24\" or 36\" — NEVER tag oversized statement\n"
    "  balloons as 12\" or 18\". Premium designs often feature giant 24\"/36\" balloons.\n\n"
    "NEON/LED SIGNS vs FOIL SHAPES (do not confuse):\n"
    "• Glowing outline text or numbers = type 'light', subtype 'neon_sign' — NOT a\n"
    "  foil number/letter balloon.\n"
    "• Report each piece of visible text exactly ONCE — never list the same words or\n"
    "  digits as both a sign AND a balloon.\n"
    "• Only report number/letter BALLOONS when an inflated balloon shaped like that\n"
    "  character is clearly visible — and ALWAYS fill text_content with the character.\n"
    "• Giant plain metallic spheres/orbs with no character on them are ROUND balloons\n"
    "  (shape 'round', usually 24\"/36\") — never numbers or letters.\n\n"
    "NEVER skip an item type that is clearly visible. Look at the image multiple times."
)

# Second-pass sweep: given what pass 1 found, hunt ONLY for what it missed.
# Single-pass vision fixates on the dominant balloons and skips secondary items.
DETECT_SWEEP_PROMPT = """A first analysis of this decoration photo already found these items:

{found}

Now re-examine the ENTIRE image and list ONLY items that are MISSING from that list.
Check specifically (zone by zone — ceiling, backdrop, edges, floor, tables, background):
- lights: fairy/string lights, LED curtains, neon signs, spotlights, lamps
- fabric: drapes, curtains, net/tulle, table skirts, carpets/mats
- flowers: real or artificial arrangements, garlands, petals
- foil fringe curtains, banners, streamers, tassels, hanging swirls
- props: welcome boards, cake stands, letter blocks, teddy bears, pedestals, crowns
- structures: arch frames, backdrop stands, pillars
- balloon clusters in the BACKGROUND or at the EDGES the first pass may have missed
- any balloon size/color variant not in the list above

Return strict JSON. EVERY item MUST use exactly this schema — all fields:
{{
  "items": [
    {{
      "type": "latex_balloon" | "foil_balloon" | "backdrop" | "light" | "prop" | "flower" | "other",
      "color": "Pink",
      "finish": "Matte",
      "size_inches": 12,
      "shape": "round" | "heart" | "star" | "number" | "letter" | "bottle" | "butterfly" | "other",
      "text_content": "exact words/characters if the item shows any text, else empty",
      "subtype": "foil_curtain" | "led_curtain" | "fairy_lights" | "butterfly" | "letter_banner" | "...",
      "quantity": 20,
      "confidence": "high" | "medium" | "low",
      "description": "REQUIRED — one short sentence: what this exact item is in THIS photo",
      "placement": "REQUIRED — where it is in the scene"
    }}
  ]
}}
If truly nothing was missed, return {{"items": []}}."""

DETECT_USER_PROMPT = """Analyze this decoration photo VERY thoroughly. Count balloons aggressively.

Return strict JSON:

{
  "is_screenshot": false,
  "is_decoration_photo": true,
  "items": [
    {
      "type": "latex_balloon" | "foil_balloon" | "backdrop" | "light" | "prop" | "flower" | "other",
      "color": "Pink",
      "finish": "Chrome",
      "size_inches": 12,
      "shape": "round" | "heart" | "star" | "number" | "letter" | "bottle" | "butterfly" | "other",
      "character": "5",
      "text_content": "HAPPY BIRTHDAY",
      "subtype": "foil_curtain" | "led_curtain" | "fairy_lights" | "butterfly" | "letter_banner" | "...",
      "quantity": 150,
      "confidence": "high" | "medium" | "low",
      "description": "REQUIRED — one short sentence: what this exact item is IN THIS PHOTO",
      "placement": "REQUIRED — where it is in the scene, e.g. 'backdrop center', 'left arch', 'ceiling', 'floor right', 'on table'"
    }
  ],
  "color_palette": ["gold", "silver", "white"],
  "dominant_mood": "vibrant, premium, romantic, ...",
  "setup_complexity": "easy" | "medium" | "hard",
  "estimated_setup_minutes": 60
}

REMEMBER:
1. A garland visible in image = at least 100-200 balloons total split across sizes.
2. List EACH size of balloon as a SEPARATE entry (5\", 10\", 12\", 18\").
3. Big foil shapes (bottles, numbers, letters, butterflies) = type \"foil_balloon\" + appropriate shape.
4. Look for backdrops, lights, foil curtains, neon signs, confetti props — list them all.
5. Round quantities UP, not down.
6. TEXT ITEMS: for ANY letters, numbers or words visible (banners, script signs,
   letter/number balloons) you MUST fill \"text_content\" with the EXACT text as
   written (e.g. \"HAPPY BIRTHDAY\", \"5\"). A letter banner is ONE entry with
   quantity = number of letters and text_content = the words. NEVER output a
   letter/number item without its actual text.
7. \"description\" and \"placement\" are REQUIRED on EVERY item — a person who
   cannot see the photo must understand exactly what the item is and where it
   goes, e.g. description: \"gold cursive foil banner spelling 'Happy Birthday'
   hung across the fringe curtain\", placement: \"backdrop center\"."""


async def _fetch_image_bytes_for_vision(image_url: Optional[str], image_base64: Optional[str]) -> bytes:
    """Fetch + lightly compress image to JPEG bytes for gpt-4o vision."""
    if image_base64:
        data = image_base64
        if "," in data:
            data = data.split(",", 1)[1]
        raw = base64.b64decode(data)
    elif image_url:
        import requests
        r = await asyncio.to_thread(requests.get, image_url, timeout=30)
        r.raise_for_status()
        raw = r.content
    else:
        raise HTTPException(status_code=400, detail="Provide image_url or image_base64")

    from PIL import Image
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = img.size
    if max(w, h) > 1280:
        scale = 1280 / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90, optimize=True)
    return buf.getvalue()


@app.post("/detect-items")
async def detect_items(req: DetectItemsRequest):
    """
    Use gpt-4o vision to detect every balloon, prop, light, backdrop in a decoration photo.
    Called once per reference upload — result is cached in the reference doc.
    """
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured")

    try:
        jpeg_bytes = await _fetch_image_bytes_for_vision(req.image_url, req.image_base64)
        b64 = base64.b64encode(jpeg_bytes).decode("utf-8")
        data_url = f"data:image/jpeg;base64,{b64}"

        from openai import OpenAI
        client = OpenAI(api_key=OPENAI_API_KEY)

        response = await asyncio.to_thread(
            client.chat.completions.create,
            model="gpt-4o",
            messages=[
                {"role": "system", "content": DETECT_SYSTEM_PROMPT},
                {"role": "user", "content": [
                    {"type": "text", "text": DETECT_USER_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
                ]},
            ],
            max_tokens=4000,
            temperature=0.3,
        )

        raw = response.choices[0].message.content
        parsed = parse_json_safe(raw)

        # ── Pass 2: completeness sweep — catch items pass 1 missed ──
        # Fail-open: any error here keeps the pass-1 result.
        items = parsed.get("items", []) or []
        try:
            found_summary = "\n".join(
                f"- {i.get('quantity', 1)}x {i.get('color', '')} {i.get('finish', '')} "
                f"{i.get('type', '')} {i.get('shape', '')} {i.get('size_inches', '')}\"".strip()
                for i in items
            ) or "(nothing found)"
            sweep = await asyncio.to_thread(
                client.chat.completions.create,
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": DETECT_SYSTEM_PROMPT},
                    {"role": "user", "content": [
                        {"type": "text", "text": DETECT_SWEEP_PROMPT.format(found=found_summary)},
                        {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
                    ]},
                ],
                max_tokens=2000,
                temperature=0.2,
            )
            sweep_parsed = parse_json_safe(sweep.choices[0].message.content)
            extra = sweep_parsed.get("items", []) or []
            if extra:
                def _key(i):
                    return (
                        str(i.get("type", "")).lower(), str(i.get("color", "")).lower(),
                        str(i.get("finish", "")).lower(), str(i.get("shape", "")).lower(),
                        int(i.get("size_inches") or 0),
                    )
                def _text(i):
                    return str(i.get("text_content") or i.get("character") or "").strip().lower()
                seen = {_key(i) for i in items}
                seen_text = {_text(i) for i in items if _text(i)}
                added = [
                    i for i in extra
                    # drop schema-less junk (no type AND no color = unmatchable)
                    if (i.get("type") or i.get("color"))
                    and _key(i) not in seen
                    # same text = same item (e.g. the 'Happy Birthday' banner found twice)
                    and (not _text(i) or _text(i) not in seen_text)
                ]
                if added:
                    print(f"[detect-items] sweep pass added {len(added)} missed item(s): "
                          + ", ".join(f"{i.get('color','')} {i.get('type','')}" for i in added))
                    items = items + added
        except Exception as sweep_err:
            print(f"[detect-items] sweep pass failed (keeping pass-1 items): {sweep_err}")

        return {
            "success": True,
            "is_screenshot":     parsed.get("is_screenshot", False),
            "is_decoration_photo": parsed.get("is_decoration_photo", True),
            "items":              items,
            "color_palette":      parsed.get("color_palette", []),
            "dominant_mood":      parsed.get("dominant_mood", ""),
            "setup_complexity":   parsed.get("setup_complexity", "medium"),
            "estimated_setup_minutes": parsed.get("estimated_setup_minutes", 60),
        }
    except (ValueError, json_lib.JSONDecodeError) as e:
        print(f"[detect-items] JSON parse error: {e}")
        return {"success": False, "error": "Failed to parse vision response"}
    except Exception as e:
        print(f"[detect-items] error:\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/match-skus")
async def match_skus(req: MatchSkusRequest):
    """
    Given a single detected item + candidate SKUs from master_inventory,
    use Gemini to pick the best match with reasoning.
    """
    import fal_client

    if not FAL_KEY:
        raise HTTPException(status_code=500, detail="FAL_KEY not configured")

    if not req.candidates:
        return {"success": False, "matched_sku_code": None, "confidence": "low", "reasoning": "no candidates provided"}

    # Slim down candidates for the prompt
    slim = [
        {
            "sku_code": c.sku_code,
            "category": c.category,
            "subcategory": c.subcategory,
            "color": c.color,
            "finish": c.finish,
            "size": c.size_inches,
            "shape": c.shape,
            "cost": c.per_unit_cost,
        }
        for c in req.candidates[:30]  # cap to keep prompt small
    ]

    system = (
        "You are a decoration inventory matcher. "
        "Given a detected balloon/prop and a list of candidate SKUs, pick the SINGLE best match. "
        "Match priority: color > finish > size > shape > category. "
        "Return strict JSON only."
    )
    user = f"""Detected item:
{json_lib.dumps(req.detection)}

Candidate SKUs:
{json_lib.dumps(slim)}

Return JSON:
{{
  "matched_sku_code": "exact_sku_code_or_null",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one short sentence"
}}"""

    try:
        result = await asyncio.to_thread(
            fal_client.run,
            "fal-ai/any-llm",
            arguments={
                "model": "google/gemini-2.5-flash",
                "system_prompt": system,
                "prompt": user,
            },
        )
        parsed = parse_json_safe(result["output"])
        return {
            "success": True,
            "matched_sku_code": parsed.get("matched_sku_code"),
            "confidence":       parsed.get("confidence", "low"),
            "reasoning":        parsed.get("reasoning", ""),
        }
    except Exception as e:
        print(f"[match-skus] error:\n{traceback.format_exc()}")
        return {"success": False, "matched_sku_code": None, "confidence": "low", "reasoning": str(e)}


STYLE_TRANSFER_NO_TEXT = (
    "Do NOT add any text, words, letters, numbers, or labels anywhere in the image — "
    "no text on balloons, banners, backdrops, walls, or any surface. Completely text-free."
)


def _build_style_transfer_prompt(occasion: str, theme: str, room_type: str, description: str) -> str:
    """
    Build the gpt-image-1 prompt for reference → room style transfer.
    The reference (image 2) is the visual STYLE the customer wants to recreate.
    The customer's room (image 1) is the CANVAS — its structure MUST remain
    pixel-identical except for the added decorations.
    """
    parts = [
        "You are given TWO input images:",
        "• IMAGE 1 = the customer's actual room photograph (the CANVAS).",
        "• IMAGE 2 = a reference decoration photo (the STYLE GUIDE).",
        "",
        "Your job: ADD decorations to the customer's room in the visual style of "
        "the reference. Do NOT modify, replace, remove, restyle, or move ANYTHING "
        "that is already present in image 1.",
        "",
        "═══════════════════════════════════════════════════════════════",
        "ABSOLUTE PRESERVATION RULES (image 1 — the customer's room):",
        "═══════════════════════════════════════════════════════════════",
        "• Walls, floor, ceiling, doors, windows: keep IDENTICAL — same colour, "
        "same texture, same trim, same paint, same materials.",
        "• ALL existing furniture (sofa, bed, table, chairs, dining set, kitchen "
        "counter, TV unit, cabinet, shelf, bar cart, rug, lamps, etc.): keep "
        "EXACTLY in the same position, orientation, scale, and condition.",
        "• Existing fixtures (lights, fans, vents, switches, sockets, picture "
        "frames, mirrors, appliances): preserve completely. Do not turn them "
        "on/off, do not relocate them, do not redecorate them.",
        "• Existing objects on tables, shelves, floor (bottles, books, vases, "
        "plants, cushions, blankets): keep them where they are.",
        "• PEOPLE AND PETS: if any person or pet is visible in image 1, keep "
        "them EXACTLY as photographed — same face, same pose, same clothing, "
        "same position. Never redraw, beautify, move, or remove them.",
        "• The room's lighting can ONLY gain warm decorative glow from the "
        "added decorations — do not change the existing daylight, lamps, "
        "shadows, or time-of-day.",
        "• Camera angle, perspective, lens, focal length, and proportions of "
        "image 1 must remain IDENTICAL. Do not rotate, crop, or re-render the "
        "room from a different angle.",
        "",
        "═══════════════════════════════════════════════════════════════",
        "WHAT YOU MAY ADD (style copied from image 2):",
        "═══════════════════════════════════════════════════════════════",
        "• Balloons (latex, foil, chrome, confetti, etc.) — match the reference's "
        "colour palette, density, and clustering style.",
        "• Backdrops on a clear wall ONLY — foil curtain / net / disco / pleated "
        "fabric / paper fans. Place against an empty wall section of image 1; "
        "never over a window, door, TV, painting, or furniture.",
        "• Foil shapes (hearts, stars, bottles, crowns, butterflies) — drawn from "
        "the reference style. NEVER letter-shaped or number-shaped balloons.",
        "• Light strings, LED curtains, fairy lights, neon signs — draped over "
        "decorations, NOT replacing existing fixtures.",
        "• Floral arrangements, ribbons, drapes, confetti — placed near or on "
        "decorations only.",
        "",
        "═══════════════════════════════════════════════════════════════",
        "STYLE TO MATCH (image 2 — the reference):",
        "═══════════════════════════════════════════════════════════════",
        "• Colour palette: every dominant colour in the reference.",
        "• Density and clustering of balloons and props — but scaled sensibly "
        "to the room (see REALISM below).",
        "• Backdrop type, material, and placement style.",
        "• Decorative composition and focal points.",
        "• Overall mood and warmth of the celebration.",
        "",
        "═══════════════════════════════════════════════════════════════",
        "REALISM — must look like a real decorator's work:",
        "═══════════════════════════════════════════════════════════════",
        "• Concentrate the decoration on ONE main focal area — the largest "
        "clear wall or corner — exactly as a professional decorator would. "
        "Do NOT bury every wall, the ceiling, and the furniture in balloons.",
        "• The setup must be physically achievable by a two-person team in a "
        "few hours: balloons attach to walls and stands, garlands follow "
        "gravity, backdrops stand on the floor against a wall.",
        "• Most of the room should remain clearly recognizable and livable "
        "around the decorated focal area.",
        "",
        "═══════════════════════════════════════════════════════════════",
        "TEXT RULE (STRICT — most common failure, read carefully):",
        "═══════════════════════════════════════════════════════════════",
        "• If the reference (image 2) contains ANY text — 'Happy Birthday' "
        "banners, neon word signs, letter balloons, number balloons, name "
        "cutouts — DO NOT copy them. Replace each with plain round balloons, "
        "a heart/star foil shape, or a floral piece in the SAME colours and "
        "position, so the composition still matches.",
        "• Never invent ages, names, or messages. A wrong number or name "
        "ruins the customer's event.",
        "",
    ]
    if occasion: parts.append(f"Occasion context: {occasion.replace('_', ' ')}.")
    if theme:    parts.append(f"Theme: {theme}.")
    if room_type:parts.append(f"Room type: {room_type}.")
    if description:
        parts.append(f"Customer special request: {description}.")
        parts.append(
            "ONLY if this special request explicitly names a specific number, "
            "name, or word to display, you may render exactly that (and nothing "
            "else) as a foil balloon or sign."
        )
    parts.extend([
        "",
        STYLE_TRANSFER_NO_TEXT,
        "",
        "Output a photorealistic image that looks like a real professional "
        "decorator visited the customer's exact room (image 1) and added the "
        "decorations on top. It must be unmistakably the SAME room — with "
        "every piece of furniture, every wall, every light still there, only "
        "now beautifully decorated.",
    ])
    return "\n".join(parts)


@app.post("/style-transfer-from-reference")
async def style_transfer_from_reference(req: ReferenceStyleTransferRequest):
    """
    Multi-image style transfer:
      - Customer's room photo (the canvas)
      - Reference decoration image (the style guide)
      → Decorated version of customer's room in the reference's style.
    """
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured")
    if not req.room_image_base64:
        raise HTTPException(status_code=400, detail="room_image_base64 required")
    if not req.reference_image_url:
        raise HTTPException(status_code=400, detail="reference_image_url required")

    try:
        # Compress room photo
        room_bytes = await asyncio.to_thread(_compress_image, req.room_image_base64)

        # Download + compress reference image
        import requests
        r = await asyncio.to_thread(requests.get, req.reference_image_url, timeout=30)
        r.raise_for_status()
        ref_data_url = "data:image/jpeg;base64," + base64.b64encode(r.content).decode("utf-8")
        ref_bytes = await asyncio.to_thread(_compress_image, ref_data_url)

        # Build prompt
        prompt = _build_style_transfer_prompt(req.occasion, req.theme, req.room_type, req.description)
        print(f"\n{'='*60}\n[STYLE TRANSFER PROMPT]\n{prompt}\n{'='*60}\n")

        # Multi-image edit (gpt-image-2, falls back to gpt-image-1)
        image_url, model_used = await run_gpt_image_edit_with_reference(prompt, room_bytes, ref_bytes)

        return {
            "success": True,
            "image_url": image_url,
            "model_used": model_used,
            "prompt_used": prompt,
        }
    except Exception as e:
        print(f"[style-transfer] error:\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


def _build_item_image_prompt(req: "GenerateItemImageRequest") -> str:
    """Category-aware e-commerce product-shot prompt for a single inventory SKU."""
    color  = (req.color or "").strip()
    finish = (req.finish or "").strip()
    shape  = (req.shape or "round").strip().lower()
    size   = f'{int(req.size_inches)}-inch ' if req.size_inches else ""
    cat    = (req.category or "").lower()

    if "latex" in cat or ("balloon" in cat and "foil" not in cat and "backdrop" not in cat):
        subject = f"a single inflated {size}{color} {finish} latex balloon"
    elif "backdrop" in cat:
        subject = f"a single {color} {finish} round foil balloon backdrop panel unit"
    elif "foil" in cat:
        shape_txt = {"round": "round", "heart": "heart-shaped", "star": "star-shaped",
                     "bottle": "champagne-bottle-shaped", "number": "number-digit-shaped",
                     "letter": "letter-shaped", "butterfly": "butterfly-shaped"}.get(shape)
        if not shape_txt:
            # unusual shapes (crown, cake, unicorn…) — use the subcategory name
            shape_txt = f"{(req.subcategory or shape or 'round').strip()}-shaped"
        subject = f"a single inflated {size}{color} {shape_txt} foil mylar balloon"
    elif "light" in cat:
        subject = f"a coil of {color or 'warm white'} decorative LED fairy string lights"
    elif "flower" in cat:
        subject = f"a small bunch of artificial {color} decorative flowers"
    else:
        name = (req.subcategory or req.category or "decoration item").strip()
        subject = f"a single {color} {name} party decoration item"

    return (
        f"Professional e-commerce product photograph of {subject}, centered on a seamless "
        "light gray studio background, soft even studio lighting, subtle soft shadow, "
        "high detail, photorealistic. The product must stand out clearly against the "
        "background. No text, no watermark, no logo, no people, no hands, "
        "no other objects — the product only."
    )


@app.post("/generate-item-image")
async def generate_item_image(req: GenerateItemImageRequest):
    """
    Generate a clean product-shot image for an inventory SKU (FLUX schnell via fal —
    ~2-4s, fractions of a cent). Used so every master_inventory item has an image:
    admin bulk-fills missing ones, and auto-created SKUs get one automatically.
    """
    if not FAL_KEY:
        return {"success": False, "error": "FAL_KEY not configured"}
    import fal_client

    prompt = _build_item_image_prompt(req)
    try:
        url = await run_flux_schnell(prompt, fal_client)
        return {"success": True, "image_url": url, "prompt_used": prompt}
    except Exception as e:
        print(f"[item-image] error: {e}")
        return {"success": False, "error": str(e)}


@app.post("/generate-tags")
async def generate_tags(req: GenerateTagsRequest):
    """
    Use Gemini to generate 8-12 search-friendly tags for a reference design.
    """
    import fal_client

    if not FAL_KEY:
        return {"success": False, "tags": []}

    system = "You generate concise search tags for event decoration designs. Output strict JSON only."
    user = f"""Decoration:
Occasion: {req.occasion}
Theme: {req.theme}
Setup: {req.setup_type}
Items summary: {req.detected_items_summary}

Generate 8-12 lowercase search tags (single words or short phrases with underscores).
Include: occasion variants, color tags, style/mood tags, audience tags (kids/adults/girls/boys), setup tags.

Return JSON:
{{
  "tags": ["pink", "gold", "girls_birthday", "balloon_arch", "indoor", "premium"]
}}"""

    try:
        result = await asyncio.to_thread(
            fal_client.run,
            "fal-ai/any-llm",
            arguments={
                "model": "google/gemini-2.5-flash",
                "system_prompt": system,
                "prompt": user,
            },
        )
        parsed = parse_json_safe(result["output"])
        return {"success": True, "tags": parsed.get("tags", [])}
    except Exception as e:
        print(f"[generate-tags] error: {e}")
        return {"success": False, "tags": []}
