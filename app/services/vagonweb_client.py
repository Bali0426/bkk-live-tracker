import asyncio
import re
import time
import urllib.parse
from datetime import datetime
from typing import Dict, Any, Optional, List
import httpx

VAGONWEB_BASE = "https://www.vagonweb.cz/razeni/"
CACHE_TTL = 7200  # 2 óra memóriabeli gyorsítótár
_vagonweb_cache: Dict[str, Dict[str, Any]] = {}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "hu,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest"
}


HU_OPERATORS = {'START', 'MÁV', 'MÁV-START', 'MAV', 'GYSEV', 'GySEV'}

HU_KEYWORDS = [
    "budapest", "keleti", "nyugati", "déli", "kelenföld", "kőbánya", "ferencváros",
    "győr", "debrecen", "szeged", "miskolc", "pécs", "székesfehérvár",
    "kecskemét", "nyíregyháza", "szombathely", "sopron", "hegyeshalom",
    "szob", "lőkösháza", "kelebia", "biharkeresztes", "hidasnémeti",
    "somoskőújfalu", "záhony", "rajka", "vác", "békéscsaba", "hatvan",
    "tatabánya", "veszprém", "nagykanizsa", "zalaegerszeg", "keszthely",
    "siófok", "fonyód", "szolnok", "eger", "salgótarján", "baja",
    "szekszárd", "dunaújváros", "kaposvár", "komárom", "esztergom",
    "cegléd", "monor", "nagykáta", "gödöllő", "füzesabony",
    "szerencs", "sárospatak", "sátoraljaújhely", "püspökladány",
    "karcag", "kisvárda", "mátészalka", "orosháza", "szentes",
    "hódmezővásárhely", "kiskunfélegyháza", "kiskunhalas", "dombóvár",
    "sárbogárd", "bicske", "tata", "csorna", "kapuvár", "szentgotthárd",
    "balaton", "tapolca", "balatonfüred"
]


def is_hungarian_train(item: Dict[str, Any]) -> bool:
    """Megvizsgálja, hogy a vonat Magyarországon közlekedik-e (hazai vagy nemzetközi)."""
    if not item or not isinstance(item, dict):
        return False
        
    zeme = str(item.get('zeme', '')).upper().strip()
    if zeme in HU_OPERATORS:
        return True
        
    cislo = str(item.get('cislo', '')).upper()
    if any(k in cislo for k in ['MÁV', 'START', 'GYSEV']):
        return True
        
    # Külföldi társaság (ÖBB, ČD, ZSSK, PKP, CFR, DB, stb.)
    # KIZÁRÓLAG akkor fogadjuk el, ha az útvonal érinti Magyarországot!
    trasa = str(item.get('trasa', '')).lower()
    nazev = str(item.get('nazev', '')).lower()
    combined = f"{trasa} {nazev}"
    
    return any(kw in combined for kw in HU_KEYWORDS)


def clean_train_number(raw_num: str) -> Optional[str]:
    """Kitisztítja a vonatszámot (eltávolítja a UIC 55/43 előtagot, betűket, kiszűri a HÉV-et)."""
    if not raw_num:
        return None
    s = str(raw_num).strip()
    
    # Ha HÉV (36H5, H5, H6, H7, H8, H9, stb.), arra a vagonWEB-en nincs összeállítás
    if "36H" in s or (s.startswith("H") and len(s) <= 3) or "HÉV" in s.upper():
        return None
        
    # UIC előtag levágása (pl. 55149 -> 149, 552071 -> 2071)
    if len(s) >= 5 and s.startswith("55"):
        s = s[2:]
    elif len(s) >= 5 and s.startswith("43"):
        s = s[2:]
        
    # Számok kinyerése (pl. "IC 560" -> "560")
    digits_m = re.findall(r"\d+", s)
    if digits_m:
        for d in digits_m:
            if 1 <= len(d) <= 5:
                return d
    return s if s.isdigit() else None


def format_vagonweb_date(text: str) -> str:
    """Cseh napnevek és dátumok átalakítása szép magyar szövegre."""
    cz_days = {
        'po': 'Hétfő', 'út': 'Kedd', 'st': 'Szerda', 'čt': 'Csütörtök',
        'pá': 'Péntek', 'so': 'Szombat', 'ne': 'Vasárnap'
    }
    
    clean = text.strip()
    clean = clean.replace('&nbsp;', ' ')
    clean = re.sub(r'\[včera\]', '(tegnap)', clean, flags=re.IGNORECASE)
    clean = re.sub(r'\[dnes\]', '(ma)', clean, flags=re.IGNORECASE)
    clean = re.sub(r've stanici:\s*', '– Állomás: ', clean, flags=re.IGNORECASE)
    clean = re.sub(r'v úseku:\s*', '– Szakasz: ', clean, flags=re.IGNORECASE)
    clean = re.sub(r'Plánované řazení\s*', '', clean, flags=re.IGNORECASE)
    clean = re.sub(r'Skutečné řazení vlaku dne:\s*', '', clean, flags=re.IGNORECASE)
    
    for cz, hu in cz_days.items():
        clean = re.sub(rf'\b{cz}\b', hu, clean, flags=re.IGNORECASE)
    
    # d.m.yyyy -> yyyy.mm.dd.
    clean = re.sub(r'\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b', lambda m: f"{m.group(3)}.{int(m.group(2)):02d}.{int(m.group(1)):02d}.", clean)
    # d.m. -> mm.dd.
    clean = re.sub(r'(?<!\d{4}\.)(?<!\d\.)\b(\d{1,2})\.(\d{1,2})\.(?!\d)', lambda m: f"{int(m.group(2)):02d}.{int(m.group(1)):02d}.", clean)
    clean = re.sub(r'\s+', ' ', clean).strip()
    return clean


def parse_vagonweb_html(html: str, comp_type: str = 'planned') -> List[Dict[str, Any]]:
    """Kinyeri a vagonWEB AJAX válaszból az egyes összeállításokat és kocsikat."""
    compositions = []
    
    # Keresünk minden <div id='vlak_...'> fejlécet és a hozzá tartozó <table class='vlacek'> táblát
    vlak_blocks = re.findall(r"<div id=['\"]vlak_(\d+)['\"][^>]*>\s*<h4[^>]*>(.*?)</h4>\s*</div>", html, re.DOTALL)
    
    for vlak_id, header_raw in vlak_blocks:
        clean_header = re.sub(r'<[^>]+>', ' ', header_raw).strip()
        clean_header = re.sub(r'\s+', ' ', clean_header)
        
        # Táblázat keresése
        tbl_pattern = f"<table class=['\"]vlacek['\"][^>]*id=['\"]vlacek{vlak_id}['\"][^>]*>"
        tbl_m = re.search(tbl_pattern, html)
        if not tbl_m:
            continue
            
        tbl_start = tbl_m.start()
        next_vlak = html.find("<div id='vlak_", tbl_start + 50)
        tbl_chunk = html[tbl_start:next_vlak if next_vlak != -1 else tbl_start + 18000]
        
        # Kocsik feldolgozása a <td class='bunka_vozu'> cellákból
        cells = re.split(r"<td class=['\"]bunka_vozu['\"][^>]*>", tbl_chunk)[1:]
        cars = []
        
        for cell in cells:
            img_m = re.search(r"<img[^>]+(?:obrazek_vagonu|vagonek)[^>]+src=['\"]([^'\"]+)['\"]", cell)
            if not img_m:
                img_m = re.search(r"src=['\"]([^'\"]*(?:popisy/img|\.gif|\.png)[^'\"]*)['\"]", cell)
            
            img_url = ""
            if img_m:
                raw_src = img_m.group(1)
                img_url = urllib.parse.urljoin(VAGONWEB_BASE, raw_src)
            
            num_m = re.search(r"class=['\"]?raz-cislo['\"]?>\s*([^<]+)", cell)
            car_num = num_m.group(1).strip() if num_m else ""
            
            type_m = re.search(r"class=['\"]?tab-radam['\"]?>\s*([^<]+)", cell)
            car_type = type_m.group(1).strip() if type_m else ""
            
            small_m = re.search(r"<small>\s*([^<]+)</small>", cell)
            car_sub = small_m.group(1).strip() if small_m else ""
            
            op_m = re.search(r"<span title=['\"][^'\"]*(?:Dráhy|Vasút|START|MÁV|ÖBB|ČD|ZSSK|PKP|GYSEV)[^'\"]*['\"]>\s*([^<]+)</span>", cell, re.IGNORECASE)
            op = op_m.group(1).strip() if (op_m and op_m.group(1)) else ""
            if not op:
                for known_op in ['START', 'MÁVRT', 'MÁV', 'ÖBB', 'ČD', 'ZSSK', 'PKP', 'GYSEV', 'DB', 'RegioJet']:
                    if known_op in cell:
                        op = known_op
                        break
            
            # Piktogramok / felszereltség
            piktos = re.findall(r"<img class=['\"]pikto['\"][^>]+src=['\"]([^'\"]+)['\"][^>]+title=['\"]([^'\"]+)['\"]", cell)
            amenities = []
            for p_src, p_title in piktos:
                amenities.append({
                    "src": urllib.parse.urljoin(VAGONWEB_BASE, p_src),
                    "title": p_title
                })
            
            # Osztály
            car_class = ""
            if 'tab-1tr' in cell or '1. třída' in cell or '1. osztály' in cell:
                car_class = "1"
            elif 'tab-2tr' in cell or '2. třída' in cell or '2. osztály' in cell:
                car_class = "2"
            
            # Motorvonat (EMU/DMU) felismerése (FLIRT, KISS, Talent, Desiro, TramTrain, Bzmot, stb.)
            is_emu = any(x in car_type for x in ['415', '815', '425', '426', '406', '117', 'Bzmot', '136', '5047', '5147', 'FLIRT', 'KISS', 'Talent', 'Desiro', 'TramTrain', 'BDVmot', 'BVmot', 'BVhmot'])
            is_loco = not is_emu and (bool(re.search(r"lokomotiva|mozdony|Taurus|Traxx|V43|470|480|182|380|383|193|vectron", cell, re.IGNORECASE)) or (not car_num and any(x in car_type for x in ['470', '480', '431', '432', '433', '182', '1116', '1216', '383', '380', '193'])))
            
            if img_url or car_type or car_num:
                cars.append({
                    "carNumber": car_num,
                    "carType": car_type,
                    "carSub": car_sub,
                    "operator": op,
                    "imgUrl": img_url,
                    "carClass": car_class,
                    "isLoco": is_loco,
                    "isEmu": is_emu,
                    "amenities": amenities
                })
                
        is_actual = 'skuteč' in clean_header.lower() or 'tényleges' in clean_header.lower()
        formatted_date = format_vagonweb_date(clean_header)
        
        compositions.append({
            "vlakId": vlak_id,
            "rawHeader": clean_header,
            "displayHeader": formatted_date,
            "isActual": is_actual,
            "type": "actual" if is_actual else "planned",
            "typeLabel": "Tényleges összeállítás" if is_actual else "Tervezett menetrendi összeállítás",
            "carsCount": len(cars),
            "cars": cars
        })
        
    return compositions


async def fetch_vagonweb_composition(raw_train_num: str) -> Dict[str, Any]:
    """
    Lekéri a vagonWEB.cz-ről a képes összeállítást az adott vonatszámhoz.
    Visszaadja a tervezett és a legutóbbi tényleges összeállítást is dátummal megjelölve.
    """
    clean_num = clean_train_number(raw_train_num)
    if not clean_num:
        return {
            "success": False,
            "message": f"Érvénytelen vonatszám: '{raw_train_num}'",
            "trainNumber": raw_train_num
        }
        
    # Gyorsítótár ellenőrzése
    cache_key = clean_num
    cached = _vagonweb_cache.get(cache_key)
    now = time.time()
    if cached and (now - cached["timestamp"] < CACHE_TTL):
        return cached["data"]
        
    current_year = datetime.now().year
    years_to_try = [current_year, current_year - 1]
    matched_train = None
    target_year = current_year
    
    async with httpx.AsyncClient(timeout=7.0, follow_redirects=True, headers=HEADERS) as client:
        # 1. Vonat keresése a json_vlaky.php végponton
        for y in years_to_try:
            try:
                url = f"{VAGONWEB_BASE}json_vlaky.php?jmeno={clean_num}&rok={y}"
                resp = await client.get(url)
                if resp.status_code == 200:
                    text = resp.content.decode('utf-8-sig', errors='ignore')
                    import json
                    data = json.loads(text)
                    if data and isinstance(data, list):
                        # Kizárólag olyan vonatokat fogadunk el, amik MAGYARORSZÁGON közlekednek!
                        hu_trains = [x for x in data if is_hungarian_train(x)]
                        if not hu_trains:
                            continue
                            
                        # 1. Pontos vonatszám egyezés magyar járatok között
                        exact_hu = [x for x in hu_trains if str(x.get('cislo')) == clean_num]
                        if exact_hu:
                            matched_train = exact_hu[0]
                            target_year = y
                            break
                            
                        # 2. Összetett vonatszámot tartalmazó magyar / nemzetközi járat (pl. ÖBB:149|MÁV:149)
                        containing_hu = [x for x in hu_trains if clean_num in str(x.get('cislo'))]
                        if containing_hu:
                            matched_train = containing_hu[0]
                            target_year = y
                            break
            except Exception:
                continue
                
        if not matched_train:
            res_fail = {
                "success": False,
                "message": f"Nem található vagonWEB összeállítás a(z) {clean_num} vonathoz.",
                "trainNumber": clean_num,
                "vagonwebSearchUrl": f"{VAGONWEB_BASE}vlak.php?cislo={clean_num}"
            }
            _vagonweb_cache[cache_key] = {"data": res_fail, "timestamp": now}
            return res_fail
            
        zeme = matched_train.get('zeme', 'START')
        kategorie = matched_train.get('druh', '')
        cislo = matched_train.get('cislo', clean_num)
        nazev = matched_train.get('nazev', '')
        trasa = matched_train.get('trasa', '')
        
        vagonweb_page_url = f"{VAGONWEB_BASE}vlak.php?zeme={urllib.parse.quote(zeme)}&kategorie={urllib.parse.quote(kategorie)}&cislo={urllib.parse.quote(cislo)}&rok={target_year}&lang=hu"
        ajax_url = f"{VAGONWEB_BASE}ajax_dalsi_razeni_vlak.php"
        
        # 2. Párhuzamos lekérés: Tényleges és Tervezett összeállítások
        async def fetch_actual():
            try:
                data_skut = {
                    'rok': str(target_year),
                    'zeme': zeme,
                    'cislo': cislo,
                    'nazev': '_n_',
                    'styl': 'r',
                    'aktualni_rok': str(current_year),
                    'cislo_vozu': '',
                    'datum': 'vse',
                    'lang': 'hu'
                }
                r = await client.post(ajax_url, data=data_skut)
                if r.status_code == 200:
                    return parse_vagonweb_html(r.text, 'actual')
            except Exception:
                pass
            return []
            
        async def fetch_planned():
            try:
                data_plan = {
                    'rok': str(target_year),
                    'zeme': zeme,
                    'cislo': cislo,
                    'nazev': '_n_',
                    'styl': 'r',
                    'aktualni_rok': str(current_year),
                    'cislo_vozu': '',
                    'vsechny_planovane': '1',
                    'lang': 'hu'
                }
                r = await client.post(ajax_url, data=data_plan)
                if r.status_code == 200:
                    return parse_vagonweb_html(r.text, 'planned')
            except Exception:
                pass
            return []
            
        actual_comps, planned_comps = await asyncio.gather(fetch_actual(), fetch_planned())
        
        result = {
            "success": True,
            "trainNumber": clean_num,
            "trainName": nazev,
            "category": kategorie,
            "operator": zeme,
            "route": trasa,
            "year": target_year,
            "vagonwebUrl": vagonweb_page_url,
            "hasActual": len(actual_comps) > 0,
            "hasPlanned": len(planned_comps) > 0,
            "latestActual": actual_comps[0] if actual_comps else None,
            "defaultPlanned": planned_comps[0] if planned_comps else None,
            "actualCompositions": actual_comps[:6],
            "plannedCompositions": planned_comps[:6]
        }
        
        _vagonweb_cache[cache_key] = {"data": result, "timestamp": now}
        return result
