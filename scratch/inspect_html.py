import urllib.request
import re

headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

url = 'https://www.vagonweb.cz/razeni/vlak.php?zeme=START&cislo=149&rok=2025'
req = urllib.request.Request(url, headers=headers)
with urllib.request.urlopen(req, timeout=8) as resp:
    html = resp.read().decode('utf-8', errors='ignore')

print("Length:", len(html))
# Let's find main div or tables
with open("scratch/sample_vagonweb.html", "w", encoding="utf-8") as f:
    f.write(html)

print("Saved to scratch/sample_vagonweb.html")
# Print some text around cislo or Hortobagy
idx = html.find("149")
while idx != -1:
    print("--- 149 context ---")
    print(html[max(0, idx-100):min(len(html), idx+300)])
    idx = html.find("149", idx+300)
    if idx > 15000:
        break
