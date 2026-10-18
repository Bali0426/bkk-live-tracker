with open('scratch/planovane_560.html', encoding='utf-8') as f:
    html = f.read()

import re

# Find all bunka_vozu in entire html
cells = re.findall(r"(<td[^>]*class=['\"][^'\"]*bunka_vozu[^'\"]*['\"][^>]*>.*?)(?=<td[^>]*class=['\"][^'\"]*bunka_vozu|</tr>)", html[:15000], re.DOTALL)
print(f"Total bunka_vozu matched: {len(cells)}")

for i, cell in enumerate(cells[:4]):
    print(f"\n--- CELL {i+1} ---")
    imgs = re.findall(r'<img[^>]+src=[\'"]([^\'"]+)[\'"]', cell)
    print("Images:", imgs)
    clean = re.sub(r'<[^>]+>', ' ', cell).strip()
    clean = re.sub(r'\s+', ' ', clean)
    print("Clean text:", clean)
    print("Raw HTML preview:", cell[:500])
