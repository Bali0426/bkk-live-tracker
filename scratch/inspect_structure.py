import re

with open('scratch/planovane_560.html', encoding='utf-8') as f:
    html = f.read()

# Let's inspect the top-level divs/tables in planovane_560
print("Length:", len(html))

# Look for table or div structure representing one composition
# Let's see how each composition is grouped
blocks = re.findall(r'<div[^>]*class=[\'"]([^\'"]*)[\'"][^>]*>', html)
print("Div classes in planovane:", set(blocks))

# Look for class="vlacek" or class="razeni" or similar
matches = re.findall(r'(<div[^>]*class=[\'"][^\'"]*(?:vlacek|razeni|vlak|obsah|bunka)[^\'"]*[\'"][^>]*>.*?</div>)', html[:10000], re.DOTALL)
print("Matched class elements count:", len(matches))

# Let's extract the first composition table/container
pos1 = html.find('<table')
pos2 = html.find('</table>', pos1)
print("First table:\n", html[pos1:pos2+8][:1200])

# Let's see how the date/validity is written above each composition
date_headers = re.findall(r'<div[^>]*class=[\'"]([^\'"]*platnost[^\'"]*)[\'"][^>]*>(.*?)</div>', html, re.DOTALL)
print("Date headers:", len(date_headers))
if date_headers:
    print("First date header:", date_headers[0])
