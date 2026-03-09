from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import base64
import os
import io
import json as json_lib
import traceback
import requests as http_requests

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# CREDENTIALS
# Uses Emergent proxy (same interface as OpenAI, no special pkg).
# To use your own OpenAI key: set OPENAI_API_KEY env var.
# ============================================================
EMERGENT_API_KEY = os.environ.get("EMERGENT_LLM_KEY", "sk-emergent-e1b3859D8366151216")
EMERGENT_BASE_URL = "https://integrations.emergentagent.com/llm"
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
USE_DIRECT_OPENAI = bool(OPENAI_API_KEY)

def get_client():
    from openai import OpenAI
    if USE_DIRECT_OPENAI:
        return OpenAI(api_key=OPENAI_API_KEY)
    return OpenAI(api_key=EMERGENT_API_KEY, base_url=EMERGENT_BASE_URL)


class GenerateRequest(BaseModel):
    prompt: str
    image_base64: Optional[str] = None


class AnalyzeRequest(BaseModel):
    image_base64: str
    name: str = ""


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "mode": "direct_openai" if USE_DIRECT_OPENAI else "emergent_proxy",
        "api_key_configured": bool(OPENAI_API_KEY or EMERGENT_API_KEY)
    }


@app.post("/generate")
async def generate_decoration(req: GenerateRequest):
    """Generate or edit a decoration image. Uses standard openai package only."""
    try:
        client = get_client()

        if req.image_base64:
            # IMAGE EDITING — place decorations into the customer's actual room photo
            img_data = req.image_base64
            if ',' in img_data:
                img_data = img_data.split(',', 1)[1]

            image_bytes = base64.b64decode(img_data)
            image_file = io.BytesIO(image_bytes)
            image_file.name = "room.png"

            response = client.images.edit(
                model="gpt-image-1",
                image=image_file,
                prompt=req.prompt,
                n=1,
                size="1024x1024"
            )

            if response.data:
                img = response.data[0]
                if hasattr(img, 'b64_json') and img.b64_json:
                    return {"image_base64": img.b64_json, "success": True}
                if hasattr(img, 'url') and img.url:
                    r = http_requests.get(img.url, timeout=30)
                    return {"image_base64": base64.b64encode(r.content).decode(), "success": True}

            raise HTTPException(status_code=500, detail="No image returned from AI")

        else:
            # TEXT-TO-IMAGE — generate a full decorated room scene
            response = client.images.generate(
                model="gpt-image-1",
                prompt=req.prompt,
                n=1,
                size="1024x1024"
            )

            if response.data:
                img = response.data[0]
                if hasattr(img, 'b64_json') and img.b64_json:
                    return {"image_base64": img.b64_json, "success": True}
                if hasattr(img, 'url') and img.url:
                    r = http_requests.get(img.url, timeout=30)
                    return {"image_base64": base64.b64encode(r.content).decode(), "success": True}

            raise HTTPException(status_code=500, detail="No image returned from AI")

    except HTTPException:
        raise
    except Exception as e:
        print(f"AI Generation Error:\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze-decoration")
async def analyze_decoration(req: AnalyzeRequest):
    """Analyze a decoration photo with GPT-4o-mini vision. Returns item list with INR prices."""
    try:
        client = get_client()

        img_data = req.image_base64
        if ',' in img_data:
            img_data = img_data.split(',', 1)[1]
        data_url = f"data:image/jpeg;base64,{img_data}"

        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": """You are an expert event decoration analyst for FatafatDecor India. Count ALL items accurately.

FIRST: Generate a unique creative kit name (e.g., "Rose Gold Birthday Glam Backdrop", "Enchanted Garden Party Setup").

CRITICAL COUNTING RULES:
- For BALLOONS: Count EVERY single balloon. Balloon walls can have 100-500+ balloons. Arches typically 80-350.
- Estimate large quantities: count one row x number of rows, or measure section x total area.
- Better to slightly overcount than undercount.

SCREENSHOT DETECTION:
- If the image has phone UI, status bar, or app interface, set "is_screenshot": true and ONLY analyze the decoration, ignore UI elements.

Categories: balloons / neon_signs / backdrop / props / lights / table_decor / banners / flowers / drapes / candles / streamers / confetti / centerpieces / garlands / ribbons / curtains / other

FATAFAT DECOR REAL PRICES (INR):
BALLOONS: Coloured Latex 10-12in Rs10-14, Pastel Rs18, Chrome Rs16, Mix Rs21, Confetti Rs33, Large 20in Rs78, Jumbo 36in Rs650
FOIL BALLOONS: Heart 12in Rs78, Letter/Number 16in Rs195, Letter 32in Rs260, Jumbo 40in Rs390, Teddy Bear Rs260
BACKDROPS: Net Large Rs650, Foil Curtain Rs455, White Net Set Rs462, Colour Net Rs520, Disco Rs5265
LIGHTING: LED Curtain Rs982, LED Candle Set Rs520
NEON SIGNS: Happy Birthday Rs2600, Lets Party Rs2600, Good Vibes Rs2990, Bride To Be Rs2600
PROPS: LED Letter Rs650, Paper Box Set Rs910, Artificial Flowers Rs1560

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "decoration_type": "Creative unique kit name",
  "is_screenshot": false,
  "color_theme": "dominant colors",
  "occasion_suggestion": "birthday/wedding/anniversary/party/baby_shower/corporate/engagement",
  "room_suggestion": "Living Room/Hall/Garden/Dining Room/Balcony",
  "difficulty": "easy/medium/hard",
  "setup_time_minutes": 60,
  "items": [
    {"name": "...", "category": "...", "color": "...", "size": "...", "quantity": 0, "estimated_unit_price": 0}
  ],
  "total_items_cost": 0,
  "suggested_labor_cost": 500,
  "suggested_travel_cost": 500,
  "suggested_final_price": 0,
  "notes": "setup tips"
}"""
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": f"Analyze this decoration image{(' named: ' + req.name) if req.name else ''}. Count ALL items accurately. Use FatafatDecor Indian market pricing."
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": data_url}
                        }
                    ]
                }
            ],
            max_tokens=2000
        )

        result_text = response.choices[0].message.content.strip()

        # Strip markdown fences if AI wrapped response in them
        if result_text.startswith("```"):
            lines = result_text.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            result_text = "\n".join(lines)
        if result_text.lower().startswith("json"):
            result_text = result_text[4:]

        analysis = json_lib.loads(result_text.strip())
        analysis["success"] = True
        analysis["image_name"] = req.name
        return analysis

    except (ValueError, json_lib.JSONDecodeError) as e:
        print(f"JSON Parse Error: {e}")
        raw = result_text[:500] if 'result_text' in locals() else ""
        return {"success": False, "error": "Failed to parse AI response", "raw": raw}
    except Exception as e:
        print(f"Analysis Error:\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))
