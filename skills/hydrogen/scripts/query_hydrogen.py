#!/usr/bin/env python3
"""
Query Gemini 4 Hydrogen via Gemini Bridge (http://localhost:8765/v1).
"""

import sys
import os
import json
import urllib.request
import subprocess
import time

BRIDGE_URL = "http://localhost:8765/v1/chat/completions"

def find_bridge_dir():
    candidates = [
        os.environ.get("GEMINI_BRIDGE_DIR"),
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
        os.getcwd()
    ]
    for d in candidates:
        if d and os.path.isfile(os.path.join(d, "cli.js")):
            return d
    return None

def is_bridge_up():
    try:
        with urllib.request.urlopen("http://localhost:8765/v1/models", timeout=1) as resp:
            return resp.status == 200
    except Exception:
        return False

def query_hydrogen(prompt, file_paths=None):
    if not is_bridge_up():
        # Attempt to launch the background bridge server
        bridge_dir = find_bridge_dir()
        if bridge_dir:
            try:
                subprocess.Popen(
                    ["node", "cli.js"],
                    cwd=bridge_dir,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True
                )
                time.sleep(2)
            except Exception:
                pass
            
    payload = {
        "model": "gemini-4-hydrogen",
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "stream": False
    }
    if file_paths:
        payload["files"] = file_paths
    
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BRIDGE_URL,
        data=data,
        headers={"Content-Type": "application/json"}
    )
    
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            res_json = json.loads(resp.read().decode("utf-8"))
            if "error" in res_json:
                return f"[Bridge Error]: {res_json['error'].get('message', res_json['error'])}"
            choices = res_json.get("choices", [])
            if choices and "message" in choices[0]:
                return choices[0]["message"].get("content", "")
            return str(res_json)
    except urllib.error.URLError as e:
        return f"[Error connecting to Gemini Bridge on port 8765]: {e}. Please ensure Gemini Bridge is running ('npm start') and your Gemini PWA is open with the extension active."
    except Exception as e:
        return f"[Error]: {e}"

if __name__ == "__main__":
    file_targets = []
    args = sys.argv[1:]
    clean_prompt_parts = []
    
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--file", "-f") and i + 1 < len(args):
            file_targets.append(os.path.abspath(args[i + 1]))
            i += 2
        elif arg.startswith("--file="):
            file_targets.append(os.path.abspath(arg.split("=", 1)[1]))
            i += 1
        else:
            clean_prompt_parts.append(arg)
            i += 1
            
    if clean_prompt_parts:
        user_prompt = " ".join(clean_prompt_parts)
    elif file_targets:
        user_prompt = "Please inspect and analyze this attached file."
    else:
        user_prompt = sys.stdin.read().strip()
        
    if not user_prompt and not file_targets:
        print("Usage: query_hydrogen.py [--file <path>] [prompt]")
        sys.exit(1)
        
    print(query_hydrogen(user_prompt, file_paths=file_targets if file_targets else None))
