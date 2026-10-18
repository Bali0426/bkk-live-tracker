import re

def format_vagonweb_date(text):
    # Translate Czech words
    cz_days = {
        'po': 'Hétfő', 'út': 'Kedd', 'st': 'Szerda', 'čt': 'Csütörtök',
        'pá': 'Péntek', 'so': 'Szombat', 'ne': 'Vasárnap'
    }
    
    clean = text.strip()
    clean = re.sub(r've stanici:\s*', '– Állomás: ', clean, flags=re.IGNORECASE)
    clean = re.sub(r'v úseku:\s*', '– Szakasz: ', clean, flags=re.IGNORECASE)
    clean = re.sub(r'Plánované řazení\s*', 'Tervezett: ', clean, flags=re.IGNORECASE)
    clean = re.sub(r'Skutečné řazení vlaku dne:\s*', 'Tényleges: ', clean, flags=re.IGNORECASE)
    
    for cz, hu in cz_days.items():
        clean = re.sub(rf'\b{cz}\b', hu, clean, flags=re.IGNORECASE)
    
    # Format dates d.m.yyyy to yyyy.mm.dd
    def replace_date(m):
        d, mth, y = m.group(1), m.group(2), m.group(3)
        return f"{y}.{int(mth):02d}.{int(d):02d}."
    
    clean = re.sub(r'\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b', replace_date, clean)
    clean = re.sub(r'\s+', ' ', clean)
    return clean

samples = [
    "Skutečné řazení vlaku dne: so 13.12.2025 ve stanici: Budapest-Keleti",
    "Plánované řazení 15.12.2024 - 1.1.2025",
    "Skutečné řazení vlaku dne: čt 15.10.2026 ve stanici: Budapest-Keleti"
]

for s in samples:
    print(s, "==>", format_vagonweb_date(s))
