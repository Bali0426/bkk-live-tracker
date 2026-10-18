import urllib.request
import re

headers = {'User-Agent': 'Mozilla/5.0'}

# Let's check the size of 815-a.gif and 415-a.gif
for path in ['START/815-a.gif', 'START/415-a.gif', 'START/425-a.gif', 'START/470-a.gif', 'START/B-2030-h-a.gif']:
    url = f"https://www.vagonweb.cz/popisy/img/{path}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = resp.read()
            # GIF dimensions are at bytes 6..10 (width: little endian 2 bytes, height: little endian 2 bytes)
            w = data[6] + (data[7] << 8)
            h = data[8] + (data[9] << 8)
            print(f"{path:25}: width={w:4}px, height={h:3}px, aspect={w/h:.2f}")
    except Exception as e:
        print(f"{path}: error {e}")
