import urllib.request
import json
import time

headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

def get_train_json(train_no, year=2025):
    url = f"https://www.vagonweb.cz/razeni/json_vlaky.php?jmeno={train_no}&rok={year}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read()
            text = raw.decode('utf-8-sig', errors='ignore')
            data = json.loads(text)
            return data
    except Exception as e:
        return f"Error: {e}"

print("149 (2025):", get_train_json("149", 2025))
time.sleep(1)
print("149 (2024):", get_train_json("149", 2024))
time.sleep(1)
print("560 (2025):", get_train_json("560", 2025))
