with open('scratch/vagonweb_ic560.html', encoding='utf-8') as f:
    text = f.read()

import re

scripts = re.findall(r'<script[^>]*>(.*?)</script>', text, re.DOTALL)
print(f"Found {len(scripts)} scripts")
for s in scripts:
    if 'ajax' in s.lower():
        print("--- AJAX SCRIPT ---")
        print(s)
