import urllib.request
import urllib.parse
import re

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.vagonweb.cz/razeni/vlak.php?zeme=M%C3%81V&kategorie=IC&cislo=560&rok=2025&lang=hu',
    'X-Requested-With': 'XMLHttpRequest'
}

url = 'https://www.vagonweb.cz/razeni/ajax_dalsi_razeni_vlak.php'

# Test 1: Planovane (Tervezett)
post_data = urllib.parse.urlencode({
    'rok': '2025',
    'zeme': 'MÁV',
    'cislo': '560',
    'nazev': '_n_',
    'styl': 'r',
    'aktualni_rok': '2026',
    'cislo_vozu': '',
    'vsechny_planovane': '1',
    'lang': 'hu'
}).encode('utf-8')

req = urllib.request.Request(url, data=post_data, headers=headers)
try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        html = resp.read().decode('utf-8', errors='ignore')
        print("Planovane status:", resp.status, "len:", len(html))
        with open('scratch/planovane_560.html', 'w', encoding='utf-8') as f:
            f.write(html)
        
        # Check images and text in html
        imgs = re.findall(r'<img[^>]+src=[\'"]([^\'"]+)[\'"]', html)
        print("Images found:", len(imgs), imgs[:5])
        
        # Check date/validity
        for line in html.split('\n')[:25]:
            clean = re.sub(r'<[^>]+>', ' ', line).strip()
            if clean:
                print("Line:", clean[:100])
except Exception as e:
    print("Error Planovane:", e)

# Test 2: Skutecne (Tenyleges)
post_data_skut = urllib.parse.urlencode({
    'rok': '2025',
    'zeme': 'MÁV',
    'cislo': '560',
    'nazev': '_n_',
    'styl': 'r',
    'aktualni_rok': '2026',
    'cislo_vozu': '',
    'datum': 'vse',
    'lang': 'hu'
}).encode('utf-8')

req_skut = urllib.request.Request(url, data=post_data_skut, headers=headers)
try:
    with urllib.request.urlopen(req_skut, timeout=10) as resp:
        html_skut = resp.read().decode('utf-8', errors='ignore')
        print("\nSkutecne status:", resp.status, "len:", len(html_skut))
        with open('scratch/skutecne_560.html', 'w', encoding='utf-8') as f:
            f.write(html_skut)
        imgs_skut = re.findall(r'<img[^>]+src=[\'"]([^\'"]+)[\'"]', html_skut)
        print("Images found (skutecne):", len(imgs_skut), imgs_skut[:5])
        for line in html_skut.split('\n')[:25]:
            clean = re.sub(r'<[^>]+>', ' ', line).strip()
            if clean:
                print("Line:", clean[:100])
except Exception as e:
    print("Error Skutecne:", e)
