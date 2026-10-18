import urllib.request
import json
import time

headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}

train_numbers = ['149', '165', '500', '560', '804', '1844', '9204', '2814', '4931']

for num in train_numbers:
    time.sleep(1.2) # Avoid rate limit
    url = f"https://www.vagonweb.cz/razeni/json_vlaky.php?jmeno={num}&rok=2025"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8-sig', errors='ignore'))
            # Filter for Hungary / MAV / START / GySEV / OBB (rjx/EC)
            hu_matches = [x for x in data if x.get('zeme') in ['MÁV', 'START', 'GYSEV', 'ÖBB', 'ČD', 'ZSSK', 'PKP'] or 'Budapest' in x.get('trasa', '') or 'Győr' in x.get('trasa', '') or 'Szeged' in x.get('trasa', '') or 'Debrecen' in x.get('trasa', '')]
            print(f"Train {num}: {len(data)} results, HU matches: {len(hu_matches)}")
            for m in hu_matches[:2]:
                print(f"   -> zeme={m.get('zeme')}, druh={m.get('druh')}, cislo={m.get('cislo')}, nazev={m.get('nazev')}, trasa={m.get('trasa')[:60]}")
    except Exception as e:
        print(f"Train {num} error: {e}")
