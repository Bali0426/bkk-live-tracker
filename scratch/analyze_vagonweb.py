import re

with open('scratch/sample_vagonweb.html', encoding='utf-8') as f:
    text = f.read()

# Headers
for h in re.findall(r'<h[1-4][^>]*>.*?</h[1-4]>', text, re.IGNORECASE | re.DOTALL):
    clean = re.sub(r'<[^>]+>', ' ', h).strip()
    print("Header:", clean)

# Look for form or message
forms = re.findall(r'<form[^>]*>.*?</form>', text, re.IGNORECASE | re.DOTALL)
print(f"Found {len(forms)} forms")
for form in forms:
    print("Form action:", re.findall(r'action="([^"]*)"', form))

# Let's see what text is in the middle of page
lines = [l.strip() for l in text.split('\n') if l.strip()]
print(f"Total non-empty lines: {len(lines)}")
# Look for text lines
for i, l in enumerate(lines):
    if any(k in l.lower() for k in ['řazení', 'vlak', 'hortobágy', 'nevyhovuje', 'vyhledat', 'start', 'máv']):
        print(f"Line {i}: {l[:150]}")
