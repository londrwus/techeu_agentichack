"""Modal app "orbit-web": serves the Orbit FastAPI backend + frontend from the orbit-data Volume.

    .\\.venv\\Scripts\\modal serve modal_app/web.py    # dev URL
    .\\.venv\\Scripts\\modal deploy modal_app/web.py   # stable URL
"""
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend_react"  # the React build (web/ -> npm run build): "/" and "/landing"

app = modal.App("orbit-web")
vol = modal.Volume.from_name("orbit-data", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi==0.141.1", "uvicorn==0.53.0", "google-genai==2.24.0", "typesafe-sdk==0.7.0",
                 "python-dotenv==1.2.3", "httpx==0.28.1", "modal==1.5.5")
    .env({"ORBIT_DATA": "/data/built", "ORBIT_FRONTEND": "/root/frontend", "ORBIT_VOLUME": "orbit-data"})
    .add_local_python_source("backend", "orbit")
)
if FRONTEND.exists():
    image = image.add_local_dir(FRONTEND, "/root/frontend")


@app.function(image=image, volumes={"/data": vol}, secrets=[modal.Secret.from_name("orbit-secrets")],
              max_containers=1, scaledown_window=1200, timeout=600)
@modal.concurrent(max_inputs=100)
@modal.asgi_app()
def web():
    from backend.main import app as fastapi_app
    return fastapi_app
