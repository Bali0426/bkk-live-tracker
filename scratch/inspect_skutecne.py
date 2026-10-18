with open('scratch/skutecne_560.html', encoding='utf-8') as f:
    html = f.read()

import re

# Find all occurrences of class='vlacek'
vlacek_indices = [m.start() for m in re.finditer(r"<table class=['\"]vlacek['\"]", html)]
print(f"Total skutecne vlacek tables: {len(vlacek_indices)}")

for i, idx in enumerate(vlacek_indices[:3]):
    print(f"\n--- SKUTECNE VLACEK #{i+1} PRECEDING HTML (600 chars before) ---")
    print(html[max(0, idx-600):idx])
    
    print(f"--- SKUTECNE VLACEK #{i+1} TABLE (first 600 chars) ---")
    print(html[idx:idx+600])
