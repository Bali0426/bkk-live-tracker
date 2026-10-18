import re
import urllib.parse

def parse_vagonweb_html(html, comp_type='planned'):
    compositions = []
    
    # We find all <div id='vlak_...'> containing the header <h4 ...>...</h4> followed by table class='vlacek'
    # Pattern: <div id='vlak_(\d+)'[^>]*><h4[^>]*>(.*?)</h4></div>.*?<table class=['\"]vlacek['\"][^>]*id=['\"]vlacek\1['\"][^>]*>(.*?)</table>
    
    # Let's find all headers with id='vlak_...'
    vlak_blocks = re.findall(r"<div id=['\"]vlak_(\d+)['\"][^>]*>\s*<h4[^>]*>(.*?)</h4>\s*</div>", html, re.DOTALL)
    print(f"Found {len(vlak_blocks)} vlak blocks")
    
    for vlak_id, header_raw in vlak_blocks:
        clean_header = re.sub(r'<[^>]+>', ' ', header_raw).strip()
        clean_header = re.sub(r'\s+', ' ', clean_header)
        
        # Find table for this vlak_id: <table class='vlacek' id='vlacek{vlak_id}' ...
        tbl_pattern = f"<table class=['\"]vlacek['\"][^>]*id=['\"]vlacek{vlak_id}['\"][^>]*>"
        tbl_m = re.search(tbl_pattern, html)
        if not tbl_m:
            continue
        
        tbl_start = tbl_m.start()
        # Find where this table ends (before next vlak_ or end of file)
        next_vlak = html.find("<div id='vlak_", tbl_start + 50)
        tbl_chunk = html[tbl_start:next_vlak if next_vlak != -1 else tbl_start + 15000]
        
        # Extract cars from td.bunka_vozu
        # In each td.bunka_vozu:
        # 1. Car image: <img class='...obrazek_vagonu...' ... src='([^']*)'
        # 2. Car number: <span class=raz-cislo>(\d+)</span>
        # 3. Series / Type: <span class=tab-radam>(.*?)</span> <small>(.*?)</small>
        # 4. Operator: <span title='[^']*START[^']*'>START</span>
        
        # Split tbl_chunk by td class='bunka_vozu'
        cells = re.split(r"<td class=['\"]bunka_vozu['\"][^>]*>", tbl_chunk)[1:]
        cars = []
        for cell in cells:
            img_m = re.search(r"<img[^>]+(?:obrazek_vagonu|vagonek)[^>]+src=['\"]([^'\"]+)['\"]", cell)
            if not img_m:
                # Try any gif/png/svg in vagonek
                img_m = re.search(r"src=['\"]([^'\"]*(?:popisy/img|\.gif|\.png)[^'\"]*)['\"]", cell)
            
            img_url = ""
            if img_m:
                raw_src = img_m.group(1)
                img_url = urllib.parse.urljoin("https://www.vagonweb.cz/razeni/", raw_src)
            
            num_m = re.search(r"class=['\"]?raz-cislo['\"]?>\s*([^<]+)", cell)
            car_num = num_m.group(1).strip() if num_m else ""
            
            type_m = re.search(r"class=['\"]?tab-radam['\"]?>\s*([^<]+)", cell)
            car_type = type_m.group(1).strip() if type_m else ""
            
            small_m = re.search(r"<small>\s*([^<]+)</small>", cell)
            car_sub = small_m.group(1).strip() if small_m else ""
            
            op_m = re.search(r"<span title=['\"][^'\"]*Dráhy|Vasút|START|MÁV|ÖBB|ČD|ZSSK|PKP[^'\"]*['\"]>\s*([^<]+)</span>", cell, re.IGNORECASE)
            op = op_m.group(1).strip() if (op_m and op_m.group(1)) else ""
            if not op:
                # Check for direct word
                for known_op in ['START', 'MÁVRT', 'MÁV', 'ÖBB', 'ČD', 'ZSSK', 'PKP', 'GYSEV', 'DB']:
                    if known_op in cell:
                        op = known_op
                        break
            
            # Pictograms / amenities
            piktos = re.findall(r"<img class=['\"]pikto['\"][^>]+src=['\"]([^'\"]+)['\"][^>]+title=['\"]([^'\"]+)['\"]", cell)
            amenities = []
            for p_src, p_title in piktos:
                amenities.append({
                    "src": urllib.parse.urljoin("https://www.vagonweb.cz/razeni/", p_src),
                    "title": p_title
                })
            
            # Class: 1st, 2nd, etc.
            car_class = ""
            if 'tab-1tr' in cell or '1. třída' in cell or '1. osztály' in cell:
                car_class = "1"
            elif 'tab-2tr' in cell or '2. třída' in cell or '2. osztály' in cell:
                car_class = "2"
            
            is_loco = bool(re.search(r"lokomotiva|mozdony|Taurus|Traxx|V43|470|480|182|380|383|193", cell, re.IGNORECASE)) or (not car_num and ('470' in car_type or '480' in car_type or '431' in car_type or '182' in car_type or '1116' in car_type or '1216' in car_type or '383' in car_type or '380' in car_type))
            
            if img_url or car_type or car_num:
                cars.append({
                    "carNumber": car_num,
                    "carType": car_type,
                    "carSub": car_sub,
                    "operator": op,
                    "imgUrl": img_url,
                    "carClass": car_class,
                    "isLoco": is_loco,
                    "amenities": amenities
                })
        
        # Determine human-friendly date / validity label
        is_actual = 'skuteč' in clean_header.lower() or 'tényleges' in clean_header.lower()
        compositions.append({
            "vlakId": vlak_id,
            "header": clean_header,
            "isActual": is_actual,
            "typeLabel": "Tényleges összeállítás" if is_actual else "Tervezett menetrendi összeállítás",
            "carsCount": len(cars),
            "cars": cars
        })
    return compositions

with open('scratch/planovane_560.html', encoding='utf-8') as f:
    plan = parse_vagonweb_html(f.read(), 'planned')
print(f"Parsed {len(plan)} planned compositions. First composition has {len(plan[0]['cars'])} cars:")
for c in plan[0]['cars']:
    print(f"   [{c['carNumber'] or 'MOZDONY'}] {c['operator']} {c['carType']} {c['carSub']} (class: {c['carClass']}, loco: {c['isLoco']}) -> {c['imgUrl']}")

with open('scratch/skutecne_560.html', encoding='utf-8') as f:
    skut = parse_vagonweb_html(f.read(), 'actual')
print(f"\nParsed {len(skut)} actual compositions. First composition ({skut[0]['header']}) has {len(skut[0]['cars'])} cars:")
for c in skut[0]['cars']:
    print(f"   [{c['carNumber'] or 'MOZDONY'}] {c['operator']} {c['carType']} {c['carSub']} (class: {c['carClass']}, loco: {c['isLoco']}) -> {c['imgUrl']}")
