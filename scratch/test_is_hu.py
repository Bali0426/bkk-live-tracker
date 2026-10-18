import re

HU_KEYWORDS = [
    "budapest", "keleti", "nyugati", "déli", "kelenföld", "kőbánya",
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

def is_hungarian_train(item):
    if not item or not isinstance(item, dict):
        return False
        
    zeme = str(item.get('zeme', '')).upper().strip()
    # 1. Domestic Hungarian operators
    if zeme in ['START', 'MÁV', 'MÁV-START', 'MAV', 'GYSEV']:
        return True
        
    # 2. Number code contains MÁV/START/GYSEV
    cislo = str(item.get('cislo', ''))
    if any(k in cislo.upper() for k in ['MÁV', 'START', 'GYSEV']):
        return True
        
    # 3. For foreign operators, route or train name MUST touch Hungary
    trasa = str(item.get('trasa', '')).lower()
    nazev = str(item.get('nazev', '')).lower()
    combined = f"{trasa} {nazev}"
    
    if any(city in combined for city in HU_KEYWORDS):
        return True
        
    return False

# Test cases
samples = [
    {"zeme": "START", "cislo": "560", "nazev": "Tokaj", "trasa": "Budapest-Keleti - Miskolc"},
    {"zeme": "MÁV", "cislo": "2412", "nazev": "S70", "trasa": "Budapest-Nyugati - Vác"},
    {"zeme": "ÖBB", "cislo": "149", "nazev": "Hortobágy", "trasa": "Wien Hbf - Hegyeshalom - Budapest-Keleti - Debrecen"},
    {"zeme": "ČD", "cislo": "2814", "nazev": "Os", "trasa": "Praha hl.n. - Beroun"},  # SHOULD BE FALSE!
    {"zeme": "ÖBB", "cislo": "2814", "nazev": "REX4", "trasa": "Wien FJB - Gmünd"},    # SHOULD BE FALSE!
    {"zeme": "ZSSK", "cislo": "2011", "nazev": "Os", "trasa": "Bratislava - Trnava"}, # SHOULD BE FALSE!
    {"zeme": "SBB", "cislo": "560", "nazev": "IC 3", "trasa": "Chur - Zürich"},       # SHOULD BE FALSE!
    {"zeme": "ČD", "cislo": "276", "nazev": "Metropolitan", "trasa": "Budapest-Nyugati - Praha hl.n."} # SHOULD BE TRUE!
]

for s in samples:
    hu = is_hungarian_train(s)
    print(f"[{'PASS' if hu else 'REJECT'}] {s['zeme']} {s['cislo']} ({s['nazev']}): {s['trasa'][:40]}")
