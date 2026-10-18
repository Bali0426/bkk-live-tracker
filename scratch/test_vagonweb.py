import urllib.request
import re
from datetime import datetime

headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
current_year = datetime.now().year

def test_train(train_num):
    print(f"\n=================== TESTING TRAIN {train_num} ===================")
    # Try different search / direct URLs
    # vagonweb search URL: https://www.vagonweb.cz/razeni/vlak.php?zeme=START&cislo=149&rok=2025
    urls_to_try = [
        f"https://www.vagonweb.cz/razeni/vlak.php?zeme=START&cislo={train_num}&rok={current_year}",
        f"https://www.vagonweb.cz/razeni/vlak.php?zeme=MAV&cislo={train_num}&rok={current_year}",
        f"https://www.vagonweb.cz/razeni/vlak.php?zeme=START&cislo={train_num}&rok={current_year-1}",
        f"https://www.vagonweb.cz/razeni/vlak.php?zeme=MAV&cislo={train_num}&rok={current_year-1}",
        f"https://www.vagonweb.cz/razeni/vlak.php?cislo={train_num}&rok={current_year}"
    ]
    
    for url in urls_to_try:
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                html = resp.read().decode('utf-8', errors='ignore')
                if "Žádný vlak nevyhovuje" in html or "Nenalezeno" in html or "Nem található" in html:
                    continue
                # Check if it has composition table
                if 'class="razeni' in html or 'class="vagon' in html or 'razeni_vlak' in html or 'vagon_img' in html or 'popis_vozu' in html:
                    print(f"SUCCESS with {url} (size: {len(html)})")
                    # Extract date / validity / planned vs actual info
                    # Let's inspect relevant sections
                    matches = re.findall(r'<div[^>]*class="[^"]*(?:popis|razeni|platnost|info|datum)[^"]*"[^>]*>.*?</div>', html, re.DOTALL | re.IGNORECASE)
                    print(f"Found {len(matches)} info blocks")
                    for m in matches[:5]:
                        clean = re.sub(r'<[^>]+>', ' ', m).strip()
                        if clean:
                            print(f"  Info: {clean[:120]}")
                    
                    # Look for image URLs
                    img_matches = re.findall(r'<img[^>]+src="([^"]+)"[^>]*>', html)
                    car_imgs = [img for img in img_matches if any(k in img for k in ['miniatury', 'vagon', 'vozy', 'foto', 'kresby'])]
                    print(f"Found {len(car_imgs)} car images: {car_imgs[:5]}")
                    
                    # Also look for table / composition rows
                    rows = re.findall(r'<tr[^>]*>.*?</tr>', html, re.DOTALL)
                    print(f"Found {len(rows)} table rows in HTML")
                    return html
        except Exception as e:
            print(f"Error {url}: {e}")
    print(f"No result found for train {train_num}")
    return None

test_train("149")
test_train("560")
test_train("500")
test_train("6204")
