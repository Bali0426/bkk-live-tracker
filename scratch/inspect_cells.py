with open('scratch/planovane_560.html', encoding='utf-8') as f:
    html = f.read()

import re

# Find the first table class='vlacek'
t_start = html.find("<table class='vlacek'")
t_end = html.find("</table>", t_start)
table_html = html[t_start:t_end+8]

# Find all td.bunka_vozu
cells = re.findall(r"<td[^>]*class=['\"][^'\"]*bunka_vozu[^'\"]*['\"][^>]*>.*?</td>\s*</td>", table_html, re.DOTALL)
print(f"Total bunka_vozu in table 1: {len(cells)}")

for i, cell in enumerate(cells[:4]):
    print(f"\n--- WAGON {i+1} ---")
    imgs = re.findall(r'<img[^>]+src=[\'"]([^\'"]+)[\'"]', cell)
    print("Images:", imgs)
    clean = re.sub(r'<[^>]+>', ' ', cell).strip()
    clean = re.sub(r'\s+', ' ', clean)
    print("Text:", clean[:160])
