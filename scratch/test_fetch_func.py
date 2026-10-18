import urllib.request
import urllib.parse
import json
import re
from datetime import datetime

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest'
}

def fetch_vagonweb_composition(train_num, year=None):
    if not year:
        year = datetime.now().year
    
    clean_num = str(train_num).strip()
    # Strip any UIC prefix like 55
    if len(clean_num) > 4 and clean_num.startswith('55'):
        clean_num = clean_num[2:]
    
    # 1. Search json_vlaky.php
    years_to_try = [year, year - 1]
    matched_train = None
    target_year = year
    
    for y in years_to_try:
        url = f"https://www.vagonweb.cz/razeni/json_vlaky.php?jmeno={clean_num}&rok={y}"
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode('utf-8-sig', errors='ignore'))
                if not data:
                    continue
                # Find matching Hungarian / international train
                # Sort priorities: exact cislo match with zeme in ['MÁV', 'START', 'GYSEV', 'ÖBB']
                exact_hu = [x for x in data if str(x.get('cislo')) == clean_num and x.get('zeme') in ['MÁV', 'START', 'GYSEV', 'ÖBB']]
                if exact_hu:
                    matched_train = exact_hu[0]
                    target_year = y
                    break
                # Or any containing cislo
                containing_hu = [x for x in data if clean_num in str(x.get('cislo')) and (x.get('zeme') in ['MÁV', 'START', 'GYSEV', 'ÖBB', 'ČD', 'ZSSK'] or 'Budapest' in x.get('trasa', ''))]
                if containing_hu:
                    matched_train = containing_hu[0]
                    target_year = y
                    break
                # Fallback to first item if cislo matches
                first_match = [x for x in data if str(x.get('cislo')) == clean_num]
                if first_match:
                    matched_train = first_match[0]
                    target_year = y
                    break
        except Exception as e:
            print(f"Error querying json_vlaky for {clean_num} year {y}: {e}")
            continue
    
    if not matched_train:
        return {"success": False, "message": f"Nem található vagonWEB összeállítás a(z) {clean_num} vonathoz."}
    
    zeme = matched_train.get('zeme', 'START')
    kategorie = matched_train.get('druh', '')
    cislo = matched_train.get('cislo', clean_num)
    nazev = matched_train.get('nazev', '')
    trasa = matched_train.get('trasa', '')
    
    vagonweb_page_url = f"https://www.vagonweb.cz/razeni/vlak.php?zeme={urllib.parse.quote(zeme)}&kategorie={urllib.parse.quote(kategorie)}&cislo={urllib.parse.quote(cislo)}&rok={target_year}&lang=hu"
    
    # 2. Try fetching both actual (skutecne) and planned (planovane) compositions
    ajax_url = "https://www.vagonweb.cz/razeni/ajax_dalsi_razeni_vlak.php"
    
    import sys
    sys.path.insert(0, 'scratch')
    from test_parser import parse_vagonweb_html
    
    actual_comps = []
    # Fetch actual
    try:
        post_data_skut = urllib.parse.urlencode({
            'rok': str(target_year),
            'zeme': zeme,
            'cislo': cislo,
            'nazev': '_n_',
            'styl': 'r',
            'aktualni_rok': str(year),
            'cislo_vozu': '',
            'datum': 'vse',
            'lang': 'hu'
        }).encode('utf-8')
        req = urllib.request.Request(ajax_url, data=post_data_skut, headers=headers)
        with urllib.request.urlopen(req, timeout=6) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
            actual_comps = parse_vagonweb_html(html, 'actual')
    except Exception as e:
        print(f"Actual error for {clean_num}: {e}")
        
    planned_comps = []
    # Fetch planned
    try:
        post_data_plan = urllib.parse.urlencode({
            'rok': str(target_year),
            'zeme': zeme,
            'cislo': cislo,
            'nazev': '_n_',
            'styl': 'r',
            'aktualni_rok': str(year),
            'cislo_vozu': '',
            'vsechny_planovane': '1',
            'lang': 'hu'
        }).encode('utf-8')
        req = urllib.request.Request(ajax_url, data=post_data_plan, headers=headers)
        with urllib.request.urlopen(req, timeout=6) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
            planned_comps = parse_vagonweb_html(html, 'planned')
    except Exception as e:
        print(f"Planned error for {clean_num}: {e}")
        
    return {
        "success": True,
        "trainNumber": clean_num,
        "trainName": nazev,
        "category": kategorie,
        "operator": zeme,
        "route": trasa,
        "year": target_year,
        "vagonwebUrl": vagonweb_page_url,
        "actualCount": len(actual_comps),
        "plannedCount": len(planned_comps),
        "latestActual": actual_comps[0] if actual_comps else None,
        "defaultPlanned": planned_comps[0] if planned_comps else None,
        "actualCompositions": actual_comps[:5], # First 5 recent dates
        "plannedCompositions": planned_comps[:5]
    }

print("Testing 149:")
r149 = fetch_vagonweb_composition("149")
print("149 result:", r149.get("success"), r149.get("trainName"), "Actuals:", r149.get("actualCount"), "Planned:", r149.get("plannedCount"))
if r149.get("latestActual"):
    print("  Latest actual:", r149["latestActual"]["header"], "Cars:", len(r149["latestActual"]["cars"]))
if r149.get("defaultPlanned"):
    print("  Default planned:", r149["defaultPlanned"]["header"], "Cars:", len(r149["defaultPlanned"]["cars"]))
