import urllib.request
import re
import time

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'hu,en;q=0.9'
}

time.sleep(2)
url = 'https://www.vagonweb.cz/razeni/vlak.php?zeme=M%C3%81V&kategorie=IC&cislo=560&rok=2025&lang=hu'
req = urllib.request.Request(url, headers=headers)
with urllib.request.urlopen(req, timeout=10) as resp:
    html = resp.read().decode('utf-8', errors='ignore')

print("Status 200, length:", len(html))
with open('scratch/vagonweb_ic560.html', 'w', encoding='utf-8') as f:
    f.write(html)

# Find date / validity / planned vs actual in html
# Look for: planned vs actual
print("\n--- Planovany vs skutecny in text ---")
for line in html.split('\n'):
    if any(k in line.lower() for k in ['tervezett', 'tényleges', 'plánov', 'skuteč', 'platnost', 'menetrend', 'érvény', 'összeállítás']):
        print(line.strip()[:140])

# Look for image tags
print("\n--- Car images ---")
imgs = re.findall(r'<img[^>]+src=[\'"]([^\'"]+)[\'"][^>]*>', html)
vagon_imgs = [img for img in imgs if 'vagon' in img or 'miniatury' in img or 'vozy' in img or 'kresby' in img or 'foto' in img]
print(f"Total vagon imgs: {len(vagon_imgs)}")
for img in vagon_imgs[:10]:
    print("  ", img)

# Look for train composition table or divs
tables = re.findall(r'<table[^>]*class=[\'"]([^\'"]*)[\'"][^>]*>', html)
print("\nTable classes:", tables)
divs = re.findall(r'<div[^>]*class=[\'"]([^\'"]*razeni[^\'"]*)[\'"][^>]*>', html)
print("Razeni divs:", divs)
