with open('scratch/planovane_560.html', encoding='utf-8') as f:
    html = f.read()

import re

# Find all occurrences of class='vlacek'
vlacek_indices = [m.start() for m in re.finditer(r"<table class=['\"]vlacek['\"]", html)]
print(f"Total vlacek tables: {len(vlacek_indices)}")

for i, idx in enumerate(vlacek_indices[:3]):
    print(f"\n--- VLACEK #{i+1} PRECEDING HTML (1000 chars before) ---")
    print(html[max(0, idx-1000):idx])
    
    print(f"--- VLACEK #{i+1} TABLE HEAD (first 600 chars of table) ---")
    print(html[idx:idx+600])
